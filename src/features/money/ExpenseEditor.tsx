/**
 * The expense editor (EXTENSIONS §8.6, ADDENDUM §6 "fast mobile entry", One
 * Yonder P13 "add an expense in ten seconds"): the amount big first (decimal
 * keypad) with its currency (the place's, else home) and ≈ in the display
 * currency; What for; Paid by as pills (none picked = not paid yet); Split
 * equally with who was there; the date and place, from where it was opened;
 * Save. "More: itemise, fees, points" reveals the rest: paid or planned, the
 * time, category, exact amounts, pooled payers, private, itemise with % /
 * fixed fees, points (redeemed + source + cash price), tax-free, the manual
 * rate, a receipt and the note. Editing an existing expense shows its
 * payments (deposits), receipts, Mark paid, Refund and Delete. Viewers see
 * everything read-only.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CalendarDays,
	Camera,
	Check,
	Lock,
	Plus,
	Trash2,
	Undo2,
	X,
} from "lucide-react";
import {
	type ComponentProps,
	type ElementType,
	type ReactNode,
	useId,
	useMemo,
	useState,
} from "react";
import { toast } from "sonner";
import { useEditGuard } from "@/components/common/edit-guard";
import {
	assignableMembers,
	MemberPicker,
	PersonAvatar,
	resolveMember,
	useAddPerson,
} from "@/components/common/member";
import { TimeInput } from "@/components/common/time";
import { TreePicker } from "@/components/common/tree-picker";
import { undoToast } from "@/components/common/undo-toast";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { DateInput, FilterPill, Segmented } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { tripListsQuery } from "@/features/lists/queries";
import { ReceiptStrip } from "@/features/media/ReceiptStrip";
import { uploadOne } from "@/features/media/upload/uploader";
import { can } from "@/lib/auth/roles";
import { currencyForCountry } from "@/lib/domain/currency";
import {
	allocate,
	categoryFor,
	convertMinor,
	currencySymbol,
	EXPENSE_CATEGORY_LABEL,
	formatMoney,
	itemize,
	minorDigits,
	minorToInput,
	ownPaymentRate,
	parseMoneyInput,
	remainingInCurrency,
} from "@/lib/engine/money";
import {
	expenseAnchor,
	scopeCountry,
	targetLabel,
} from "@/lib/engine/money-scope";
import { humanError } from "@/lib/errors";
import { formatDayDate } from "@/lib/format";
import { tripKeys } from "@/lib/query/keys";
import { bundleAnchor, useFormPresence } from "@/lib/realtime/form-presence";
import {
	EXPENSE_CATEGORY_VALUES,
	type ExpenseCategory,
} from "@/lib/schemas/enums";
import type { ExpenseInput, PaymentInput } from "@/lib/schemas/money";
import type { BundleTarget } from "@/lib/schemas/targets";
import { cn } from "@/lib/utils";
import { type AddExpenseRequest, useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { CurrencyPicker } from "./CurrencyPicker";
import {
	createExpense,
	deleteExpense,
	type ExpenseDto,
	type MoneyDto,
	markExpensePaid,
	restoreExpense,
	setExpenseRate,
	updateExpense,
} from "./money.functions";
import {
	CategoryIcon,
	MonoNumbers,
	Num,
	paidDate,
	statusText,
} from "./money-ui";
import { PersonSelect } from "./PersonSelect";
import { autoPaymentRate, formatRate } from "./payment-rate";
import { MONEY_TESTID } from "./testids";
import { moneyKeys, useDisplayCurrency, useMoneyData } from "./use-money";

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

type LineDraft = {
	key: string;
	label: string;
	amount: string;
	memberIds: string[];
};
type FeeDraft = {
	key: string;
	label: string;
	kind: "percent" | "fixed";
	value: string;
};
type PayerDraft = { memberId: string; amount: string };
type PaymentDraft = {
	key: string;
	id?: string;
	date: string;
	time: string;
	tz: string;
	currency: string;
	amount: string;
	payers: PayerDraft[];
	method: string;
	/** The payment's OWN manual rate (1 currency = ? home); "" = the cost's rate or the day's. */
	rate: string;
	/**
	 * Pooled payers that added up when loaded: their proportions, which they
	 * keep while only the payment's amount changes (until one is edited).
	 */
	follow?: number[];
};

type Draft = {
	target: BundleTarget;
	title: string;
	category: ExpenseCategory | null;
	/** New expenses: record a payment now (paid) or not (planned). */
	status: "paid" | "planned";
	amount: string;
	currency: string;
	payers: PayerDraft[];
	multiPayer: boolean;
	date: string;
	time: string;
	tz: string;
	expectedOn: string;
	splitMode: "equal" | "exact";
	splitIds: string[];
	exact: Record<string, string>;
	itemize: boolean;
	lines: LineDraft[];
	fees: FeeDraft[];
	isPrivate: boolean;
	taxFreePending: boolean;
	note: string;
	points: boolean;
	program: string;
	pts: string;
	sourceProgram: string;
	sourcePts: string;
	cashValue: string;
	cashValueCurrency: string;
	rate: string;
	/** Existing payments (edit mode). */
	payments: PaymentDraft[];
	refundOfId: string | null;
	listItemId: string | null;
};

let keySeq = 0;
const nextKey = () => `k${++keySeq}`;

function localParts(
	iso: string | Date,
	tz: string,
): { date: string; time: string } {
	const d = typeof iso === "string" ? new Date(iso) : iso;
	try {
		const f = new Intl.DateTimeFormat("en-CA", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).formatToParts(d);
		const g = (t: string) => f.find((p) => p.type === t)?.value ?? "00";
		return {
			date: `${g("year")}-${g("month")}-${g("day")}`,
			time: `${g("hour")}:${g("minute")}`,
		};
	} catch {
		return {
			date: d.toISOString().slice(0, 10),
			time: d.toISOString().slice(11, 16),
		};
	}
}

/** Local date + time in `tz` → an ISO instant with offset. */
function toInstant(date: string, time: string, tz: string): string {
	const guess = new Date(`${date}T${time || "12:00"}:00Z`);
	// Find the offset of `tz` at that wall time (two passes handle DST edges).
	let t = guess.getTime();
	for (let i = 0; i < 2; i++) {
		const p = localParts(new Date(t), tz);
		const shown = Date.parse(`${p.date}T${p.time}:00Z`);
		t += guess.getTime() - shown;
	}
	return new Date(t).toISOString();
}

const deviceTz = () => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
};

function paymentDraft(
	p: ExpenseDto["payments"][number],
	e: ExpenseDto,
): PaymentDraft {
	const { date, time } = localParts(p.paidAt, p.paidTz);
	const own = ownPaymentRate(p, e);
	const parts = p.payers.map((x) => Math.abs(x.amountMinor));
	return {
		key: nextKey(),
		id: p.id,
		date,
		time,
		tz: p.paidTz,
		currency: p.currency,
		amount: minorToInput(Math.abs(p.amountMinor), p.currency),
		payers: p.payers.map((x) => ({
			memberId: x.memberId,
			amount: minorToInput(Math.abs(x.amountMinor), p.currency),
		})),
		method: p.method ?? "",
		rate: own !== undefined ? String(own) : "",
		...(parts.length > 1 &&
		parts.reduce((a, b) => a + b, 0) === Math.abs(p.amountMinor)
			? { follow: parts }
			: {}),
	};
}

/**
 * Pooled payers follow a new payment amount in their loaded proportions
 * (5,000 + 4,000 of 9,000 → 5,500 + 4,400 of 9,900) until one of them is
 * edited by hand (`follow` cleared).
 */
function rescalePayers(p: PaymentDraft, next: string): PayerDraft[] {
	const after = parseMoneyInput(next, p.currency);
	if (!p.follow || after === null) return p.payers;
	const scaled = allocate(Math.abs(after), p.follow);
	return p.payers.map((x, i) => ({
		...x,
		amount: minorToInput(scaled[i] ?? 0, p.currency),
	}));
}

/** A typed rate ("0.0067") → a positive number, else null. */
function parseRate(text: string): number | null {
	const r = Number.parseFloat(text.trim().replace(",", "."));
	return Number.isFinite(r) && r > 0 && r <= 1e9 ? r : null;
}

/** A payment's payers as minor units (one payer pays it all). */
function payersOf(
	p: PaymentDraft,
	sign: number,
): { memberId: string; amountMinor: number }[] {
	const amt = sign * Math.abs(parseMoneyInput(p.amount, p.currency) ?? 0);
	return p.payers.length === 1
		? [{ memberId: p.payers[0]?.memberId ?? "", amountMinor: amt }]
		: p.payers.map((x) => ({
				memberId: x.memberId,
				amountMinor:
					sign * Math.abs(parseMoneyInput(x.amount, p.currency) ?? 0),
			}));
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export type EditorMode =
	| { kind: "new"; request: AddExpenseRequest }
	| { kind: "edit"; expense: ExpenseDto }
	| { kind: "refund"; original: ExpenseDto };

export function ExpenseEditor({
	mode,
	onClose,
	Title = "h2",
}: {
	mode: EditorMode;
	onClose: () => void;
	/** The dialog's or sheet's title part, so the heading names it. */
	Title?: ElementType<{ className?: string; children?: ReactNode }>;
}) {
	const ws = useWorkspace();
	const qc = useQueryClient();
	const { graph, ix, scope, access } = ws;
	const { data, enabled } = useMoneyData();
	// "Bought" on a shopping item: split with its assignees, else it's mine.
	const lists = useQuery({ ...tripListsQuery(graph.trip.id), enabled });
	const shoppingItem =
		mode.kind === "new" && mode.request.listItemId
			? lists.data?.find((li) => li.id === mode.request.listItemId)
			: undefined;
	const d = useDisplayCurrency();
	const guard = useEditGuard();
	const readOnly = guard.disabled || !can(access, "manageExpenses");
	const tripId = graph.trip.id;
	const meId = graph.me.memberId;
	const home = d.home;
	const people = assignableMembers(graph.members);
	const order = graph.members.map((m) => m.id);

	const defaultPeople = (t: BundleTarget): string[] => {
		const tagged =
			t.kind === "item"
				? (ix.item(t.itemId)?.assigneeIds ?? [])
				: t.kind === "leg"
					? (ix.leg(t.legId)?.assigneeIds ?? [])
					: [];
		const live = tagged.filter((id) => people.some((p) => p.id === id));
		return live.length ? live : people.map((p) => p.id);
	};
	const currencyFor = (t: BundleTarget) => {
		const anchor = expenseAnchor(ix, t).nodeId;
		return currencyForCountry(
			scopeCountry(ix, anchor ?? scope?.id ?? null),
			home,
		);
	};
	// The date of the day it hangs on (a stop's, a leg's, a day's), if any.
	const dayOf = (t: BundleTarget) =>
		ix.day(expenseAnchor(ix, t).dayId)?.date ?? null;

	const [draft, setDraft] = useState<Draft>(() => {
		const now = new Date();
		const tz = deviceTz();
		const { date, time } = localParts(now, tz);
		const blank: Draft = {
			target: { kind: "trip" },
			title: "",
			category: null,
			status: "paid",
			amount: "",
			currency: home,
			payers: meId ? [{ memberId: meId, amount: "" }] : [],
			multiPayer: false,
			date,
			time,
			tz,
			expectedOn: "",
			splitMode: "equal",
			splitIds: [],
			exact: {},
			itemize: false,
			lines: [],
			fees: [],
			isPrivate: false,
			taxFreePending: false,
			note: "",
			points: false,
			program: "",
			pts: "",
			sourceProgram: "",
			sourcePts: "",
			cashValue: "",
			cashValueCurrency: home,
			rate: "",
			payments: [],
			refundOfId: null,
			listItemId: null,
		};
		if (mode.kind === "new") {
			const r = mode.request;
			const target: BundleTarget =
				r.target ??
				(scope ? { kind: "node", nodeId: scope.id } : { kind: "trip" });
			const future = graph.trip.startDate ? graph.trip.startDate > date : false;
			const currency = r.currency ?? currencyFor(target);
			// Opened on a stop or a day: paid that day (never later than today), or expected then.
			const onDay = dayOf(target);
			return {
				...blank,
				target,
				date: onDay && onDay < date ? onDay : date,
				expectedOn: onDay ?? "",
				title: r.title ?? "",
				category: r.category ?? null,
				status: r.listItemId ? "paid" : future ? "planned" : "paid",
				amount:
					r.amountMinor !== undefined
						? minorToInput(r.amountMinor, currency)
						: "",
				currency,
				cashValueCurrency: currency,
				splitIds: shoppingItem
					? shoppingItem.assigneeIds.length
						? shoppingItem.assigneeIds
						: meId
							? [meId]
							: defaultPeople(target)
					: defaultPeople(target),
				listItemId: r.listItemId ?? null,
				// Gift privacy (ADDENDUM §10): the server forces it for a private item too.
				isPrivate: !!r.isPrivate || !!shoppingItem?.isPrivate,
			};
		}
		const e = mode.kind === "edit" ? mode.expense : mode.original;
		const splitIds = e.lines.length
			? [...new Set(e.lines.flatMap((l) => l.memberIds))]
			: e.shares.length
				? e.shares.map((s) => s.memberId)
				: defaultPeople(e.target);
		const fromExpense: Draft = {
			...blank,
			target: e.target,
			title: e.title,
			category: e.category,
			amount:
				e.amountMinor !== null && e.currency
					? minorToInput(Math.abs(e.amountMinor), e.currency)
					: "",
			currency: e.currency ?? home,
			expectedOn: e.expectedOn ?? "",
			splitMode: e.splitMode,
			splitIds,
			exact: Object.fromEntries(
				e.shares
					.filter((s) => s.amountMinor !== null && e.currency)
					.map((s) => [
						s.memberId,
						minorToInput(Math.abs(s.amountMinor ?? 0), e.currency ?? home),
					]),
			),
			itemize: e.lines.length > 0,
			lines: e.lines.map((l) => ({
				key: nextKey(),
				label: l.label,
				amount: minorToInput(l.amountMinor, e.currency ?? home),
				memberIds: [...l.memberIds],
			})),
			fees: e.fees.map((f) => ({
				key: nextKey(),
				label: f.label,
				kind: f.kind,
				value:
					f.kind === "percent"
						? String(f.percent ?? 0)
						: minorToInput(f.amountMinor ?? 0, e.currency ?? home),
			})),
			isPrivate: e.isPrivate,
			taxFreePending: e.taxFreePending,
			note: e.note ?? "",
			points: !!e.points,
			program: e.points?.program ?? "",
			pts: e.points ? String(e.points.points) : "",
			sourceProgram: e.points?.sourceProgram ?? "",
			sourcePts: e.points?.sourcePoints ? String(e.points.sourcePoints) : "",
			cashValue:
				e.points?.cashValueMinor != null && e.points.cashValueCurrency
					? minorToInput(e.points.cashValueMinor, e.points.cashValueCurrency)
					: "",
			cashValueCurrency: e.points?.cashValueCurrency ?? e.currency ?? home,
			rate: e.fxManual && e.fxRate !== null ? String(e.fxRate) : "",
			payments: e.payments.map((p) => paymentDraft(p, e)),
			refundOfId: e.refundOfId,
			listItemId: e.listItemId,
		};
		if (mode.kind === "refund") {
			const firstPayer = e.payments[0]?.payers[0]?.memberId ?? meId;
			return {
				...fromExpense,
				title: "",
				status: "paid",
				amount: "",
				payments: [],
				payers: firstPayer ? [{ memberId: firstPayer, amount: "" }] : [],
				itemize: false,
				lines: [],
				fees: [],
				points: false,
				refundOfId: e.id,
				listItemId: null,
				note: "",
				rate: "",
			};
		}
		return fromExpense;
	});
	const set = (patch: Partial<Draft>) => setDraft((x) => ({ ...x, ...patch }));
	const [moreOpen, setMoreOpen] = useState(
		mode.kind === "edit" &&
			(mode.expense.lines.length > 0 ||
				!!mode.expense.points ||
				mode.expense.isPrivate ||
				mode.expense.fxManual ||
				!!mode.expense.note),
	);
	const [receipt, setReceipt] = useState<File | null>(null);

	const editing = mode.kind === "edit" ? mode.expense : null;
	const isRefund = draft.refundOfId !== null;
	const sign = isRefund ? -1 : 1;
	const amount = parseMoneyInput(draft.amount, draft.currency);
	const cashAmount = amount === null ? null : sign * Math.abs(amount);
	const pointsOnly =
		draft.points && (draft.amount.trim() === "" || amount === 0);
	const inferred = useMemo((): ExpenseCategory => {
		const t = draft.target;
		if (t.kind === "leg")
			return categoryFor({ kind: "leg", mode: ix.leg(t.legId)?.mode ?? null });
		const nodeId =
			t.kind === "node"
				? t.nodeId
				: t.kind === "item"
					? ix.item(t.itemId)?.nodeId
					: null;
		const node = ix.node(nodeId ?? null);
		return node?.category
			? categoryFor({ kind: "place", category: node.category })
			: "fees_other";
	}, [draft.target, ix]);
	const category = draft.category ?? inferred;
	const where = targetLabel(ix, draft.target);
	// FB-24: others see "Dennis is adding an expense…" / "…editing Ramen"; a
	// private expense (a gift) shows nothing at all.
	useFormPresence({
		k: "expense",
		m: mode.kind === "edit" ? "edit" : "add",
		t:
			mode.kind === "edit"
				? `exp:${mode.expense.id}`
				: mode.kind === "refund"
					? `exp:${mode.original.id}`
					: bundleAnchor(draft.target),
		private: draft.isPrivate,
	});
	const defaultTitle =
		draft.target.kind === "trip" ? EXPENSE_CATEGORY_LABEL[category] : where;

	// ---- live checks ----
	const itemized = draft.itemize && !draft.isPrivate;
	const it = useMemo(() => {
		if (!itemized) return null;
		const lines = draft.lines.map((l) => ({
			amountMinor: parseMoneyInput(l.amount, draft.currency) ?? 0,
			memberIds: l.memberIds,
		}));
		const fees = draft.fees.map((f) => ({
			kind: f.kind,
			percent: f.kind === "percent" ? Number.parseFloat(f.value) || 0 : null,
			amountMinor:
				f.kind === "fixed"
					? (parseMoneyInput(f.value, draft.currency) ?? 0)
					: null,
		}));
		return itemize(
			lines,
			fees,
			draft.payers.map((p) => p.memberId),
			order,
		);
	}, [itemized, draft.lines, draft.fees, draft.currency, draft.payers, order]);
	const itemizeLeft =
		it && amount !== null ? Math.abs(amount) - it.total : null;
	const exactSum = draft.splitIds.reduce(
		(a, id) =>
			a + (parseMoneyInput(draft.exact[id] ?? "", draft.currency) ?? 0),
		0,
	);
	const exactLeft =
		draft.splitMode === "exact" && amount !== null
			? Math.abs(amount) - exactSum
			: null;
	const payerSum = draft.payers.reduce(
		(a, p) => a + (parseMoneyInput(p.amount, draft.currency) ?? 0),
		0,
	);
	const payerLeft =
		draft.multiPayer && amount !== null ? Math.abs(amount) - payerSum : null;
	const rateToHome = draft.currency === home ? 1 : d.rateTo(draft.currency);
	/** "Your rate" (1 currency = ? home), when one is typed. */
	const myRate = draft.currency === home ? null : parseRate(draft.rate);
	const homeMinor =
		cashAmount === null
			? null
			: draft.currency === home
				? cashAmount
				: myRate || rateToHome
					? convertMinor(
							cashAmount,
							draft.currency,
							home,
							myRate ?? 1 / (rateToHome as number),
						)
					: null;
	// "≈ $60.00" in the display currency (home when that is the amount's own).
	const shownIn = d.converted && d.code !== draft.currency ? d.code : home;
	const approx =
		homeMinor !== null && shownIn !== draft.currency
			? formatMoney(
					shownIn === home ? homeMinor : d.toDisplay(homeMinor),
					shownIn,
				)
			: null;

	// QA MONEY-01/14: parts, items and payers are typed as positive amounts
	// (a refund's sign comes from the refund itself). A "-500" would add up on
	// screen but flip into money that person is owed, so it is marked instead.
	const isNegative = (v: string) =>
		(parseMoneyInput(v, draft.currency) ?? 0) < 0;
	const negativeExact =
		draft.splitMode === "exact" &&
		draft.splitIds.some((id) => isNegative(draft.exact[id] ?? ""));
	const negativeLine = draft.lines.some((l) => isNegative(l.amount));
	const negativePayer = draft.payers.some((p) => isNegative(p.amount));

	const problems: string[] = [];
	if (!pointsOnly && (amount === null || amount === 0))
		problems.push("Enter an amount.");
	if (draft.points && !(Number.parseInt(draft.pts, 10) > 0))
		problems.push("Enter the points.");
	if (draft.points && !draft.program.trim())
		problems.push("Name the programme.");
	// A refund's split follows its original (the server computes it).
	const ownSplit = !draft.isPrivate && !itemized && !isRefund;
	if (ownSplit && draft.splitIds.length === 0 && !pointsOnly)
		problems.push("Pick who shares it.");
	if (ownSplit && negativeExact)
		problems.push("Exact amounts can't be negative.");
	if (ownSplit && exactLeft !== null && exactLeft !== 0)
		problems.push("Exact amounts must add up.");
	if (itemized && negativeLine)
		problems.push("Item amounts can't be negative.");
	if (itemizeLeft !== null && itemizeLeft !== 0)
		problems.push("Items and fees must add up.");
	if (draft.multiPayer && !draft.isPrivate && negativePayer)
		problems.push("Payer amounts can't be negative.");
	if (itemized && draft.lines.some((l) => !l.memberIds.length))
		problems.push("Every item needs who had it.");
	if (
		payerLeft !== null &&
		payerLeft !== 0 &&
		editing === null &&
		draft.status === "paid"
	)
		problems.push("Payers must add up.");
	// ADDENDUM §6: refunds never add up to more than their original (the server checks too).
	const refundLeft = refundRoom(data, draft.refundOfId, editing?.id ?? null);
	if (
		refundLeft &&
		draft.currency === refundLeft.currency &&
		amount !== null &&
		Math.abs(amount) > refundLeft.minor
	)
		problems.push(
			`Only ${formatMoney(refundLeft.minor, refundLeft.currency)} is left to refund.`,
		);
	if (editing) {
		for (const p of draft.payments) {
			const amt = parseMoneyInput(p.amount, p.currency);
			if (amt === null || amt === 0) problems.push("Enter each payment.");
			else if (p.payers.some((x) => !x.memberId))
				problems.push("Pick who paid.");
			else if (
				p.payers.length > 1 &&
				payersOf(p, 1).reduce((a, x) => a + x.amountMinor, 0) !== Math.abs(amt)
			)
				problems.push("Payers must add up to each payment.");
			if (p.rate.trim() && parseRate(p.rate) === null)
				problems.push("Check the payment's rate.");
		}
	}

	// ---- mutations ----
	const keys = moneyKeys(tripId);
	const create = useTripMutation(
		(v: ExpenseInput) => createExpense({ data: v }),
		// "Bought": the linked list item is ticked off too (server).
		{ keys: draft.listItemId ? [...keys, tripKeys.lists(tripId)] : keys },
	);
	const update = useTripMutation(
		(v: {
			id: string;
			patch: Record<string, unknown>;
			expectedUpdatedAt?: string;
		}) => updateExpense({ data: v }),
		{ keys },
	);
	const del = useTripMutation(
		(v: { id: string }) => deleteExpense({ data: v }),
		{ keys },
	);
	const restore = useTripMutation(
		(v: { id: string }) => restoreExpense({ data: v }),
		{ keys },
	);
	const markPaid = useTripMutation(
		(v: { id: string }) => markExpensePaid({ data: v }),
		{ keys },
	);
	const rateM = useTripMutation(
		(v: { id: string; rate: number | null }) => setExpenseRate({ data: v }),
		{ keys },
	);
	const busy = create.isPending || update.isPending;

	const paymentsOut = (): PaymentInput[] => {
		const now = toInstant(draft.date, draft.time, draft.tz);
		if (editing) {
			return draft.payments.map((p) => {
				const amt = sign * Math.abs(parseMoneyInput(p.amount, p.currency) ?? 0);
				const rate = parseRate(p.rate);
				return {
					...(p.id ? { id: p.id } : {}),
					paidAt: toInstant(p.date, p.time, p.tz),
					paidTz: p.tz,
					currency: p.currency,
					amountMinor: amt,
					payers: payersOf(p, sign),
					...(p.method.trim() ? { method: p.method.trim() } : {}),
					// Its own rate; without one it follows the cost's rate (server).
					...(rate !== null && p.currency !== home ? { fxRate: rate } : {}),
				};
			});
		}
		if (draft.status !== "paid" || cashAmount === null || cashAmount === 0)
			return [];
		const payers = draft.isPrivate
			? [{ memberId: meId ?? "", amountMinor: cashAmount }]
			: draft.multiPayer
				? draft.payers.map((p) => ({
						memberId: p.memberId,
						amountMinor:
							sign * Math.abs(parseMoneyInput(p.amount, draft.currency) ?? 0),
					}))
				: [
						{
							memberId: draft.payers[0]?.memberId ?? meId ?? "",
							amountMinor: cashAmount,
						},
					];
		return [
			{
				paidAt: now,
				paidTz: draft.tz,
				currency: draft.currency,
				amountMinor: cashAmount,
				payers,
			},
		];
	};

	const fieldsOut = () => {
		const pts = Number.parseInt(draft.pts, 10);
		const srcPts = Number.parseInt(draft.sourcePts, 10);
		const cash = parseMoneyInput(draft.cashValue, draft.cashValueCurrency);
		const rate = Number.parseFloat(draft.rate);
		const f = {
			target: draft.target,
			title: draft.title.trim() || null,
			category: draft.category ?? inferred,
			amountMinor: pointsOnly ? null : cashAmount,
			currency: pointsOnly ? null : draft.currency,
			points:
				draft.points && pts > 0 && draft.program.trim()
					? {
							program: draft.program.trim(),
							points: pts,
							...(draft.sourceProgram.trim() && srcPts > 0
								? {
										sourceProgram: draft.sourceProgram.trim(),
										sourcePoints: srcPts,
									}
								: {}),
							...(cash !== null && cash > 0
								? {
										cashValueMinor: cash,
										cashValueCurrency: draft.cashValueCurrency,
									}
								: {}),
						}
					: null,
			expectedOn:
				draft.status === "planned" || editing ? draft.expectedOn || null : null,
			payments: paymentsOut(),
			...(draft.isPrivate
				? {}
				: itemized
					? {
							lines: draft.lines.map((l) => ({
								label: l.label.trim() || "Item",
								amountMinor:
									sign *
									Math.abs(parseMoneyInput(l.amount, draft.currency) ?? 0),
								memberIds: l.memberIds,
							})),
							fees: draft.fees.map((x) =>
								x.kind === "percent"
									? {
											label: x.label.trim() || "Fee",
											kind: "percent" as const,
											percent: Number.parseFloat(x.value) || 0,
										}
									: {
											label: x.label.trim() || "Fee",
											kind: "fixed" as const,
											amountMinor:
												sign *
												Math.abs(parseMoneyInput(x.value, draft.currency) ?? 0),
										},
							),
							split: {
								mode: "equal" as const,
								shares: [
									...new Set(draft.lines.flatMap((l) => l.memberIds)),
								].map((memberId) => ({ memberId })),
							},
						}
					: {
							lines: [],
							fees: [],
							split:
								draft.splitMode === "exact"
									? {
											mode: "exact" as const,
											shares: draft.splitIds.map((memberId) => ({
												memberId,
												amountMinor:
													sign *
													Math.abs(
														parseMoneyInput(
															draft.exact[memberId] ?? "",
															draft.currency,
														) ?? 0,
													),
											})),
										}
									: {
											mode: "equal" as const,
											shares: draft.splitIds.map((memberId) => ({ memberId })),
										},
						}),
			isPrivate: draft.isPrivate,
			taxFreePending: draft.taxFreePending,
			note: draft.note.trim() || null,
			...(Number.isFinite(rate) && rate > 0 && draft.currency !== home
				? { fxRate: rate }
				: {}),
			...(draft.refundOfId ? { refundOfId: draft.refundOfId } : {}),
			...(draft.listItemId ? { listItemId: draft.listItemId } : {}),
		};
		return f;
	};

	const save = async () => {
		if (problems.length || readOnly) return;
		const f = fieldsOut();
		try {
			if (editing) {
				const { refundOfId: _r, listItemId: _l, ...patch } = f;
				// Split/lines of a refund follow the original (server); private rows have none.
				if (isRefund) {
					delete (patch as Record<string, unknown>).split;
					delete (patch as Record<string, unknown>).lines;
					delete (patch as Record<string, unknown>).fees;
				}
				if (!draft.rate.trim() && editing.fxManual)
					(patch as Record<string, unknown>).fxRate = null;
				await update.mutateAsync({
					id: editing.id,
					patch,
					expectedUpdatedAt: editing.updatedAt,
				});
				await uploadReceipt(editing.id);
			} else {
				const input: ExpenseInput = {
					tripId,
					...stripNulls(f),
					...(isRefund
						? { split: undefined, lines: undefined, fees: undefined }
						: {}),
				} as ExpenseInput;
				const r = await create.mutateAsync(input);
				undoToast(isRefund ? "Refund added" : "Expense added", async () => {
					await del.mutateAsync({ id: r.id });
				});
				await uploadReceipt(r.id);
			}
			onClose();
		} catch {
			// The global mutation handler already toasted it (once); stay open.
		}
	};

	const uploadReceipt = async (expenseId: string) => {
		if (!receipt) return;
		try {
			await uploadOne({
				tripId,
				target: { kind: "expense", expenseId },
				blob: receipt,
				type: receipt.type as never,
				name: receipt.name,
			});
			void qc.invalidateQueries({ queryKey: tripKeys.media(tripId) });
			toast("Receipt attached");
		} catch (e) {
			toast.error(`Couldn't attach the receipt. ${humanError(e)}`);
		}
	};

	const onDelete = async () => {
		if (!editing) return;
		try {
			const r = await del.mutateAsync({ id: editing.id });
			// Its refunds go with it (and come back with Undo).
			const refunds = r?.refunds ?? 0;
			undoToast(
				refunds
					? `Expense and ${refunds === 1 ? "its refund" : `its ${refunds} refunds`} deleted`
					: "Expense deleted",
				async () => {
					await restore.mutateAsync({ id: editing.id });
				},
			);
			onClose();
		} catch {
			// Toasted once by the global mutation handler.
		}
	};

	const onMarkPaid = async () => {
		if (!editing) return;
		try {
			await markPaid.mutateAsync({ id: editing.id });
			toast("Marked paid");
			onClose();
		} catch {
			// Toasted once by the global mutation handler.
		}
	};

	const nameOf = (id: string) => {
		const m = resolveMember(graph.members, id);
		return id === meId
			? "You"
			: (m?.firstName ?? m?.name.split(" ")[0] ?? "Former member");
	};

	// ---- render ----
	const uid = useId();
	const addPerson = useAddPerson();
	const title =
		mode.kind === "edit"
			? isRefund
				? "Refund"
				: "Expense"
			: mode.kind === "refund"
				? `Refund · ${mode.original.title}`
				: "Add an expense";
	const planned = !editing && draft.status === "planned";
	const pooled = !editing && draft.multiPayer && !planned;
	const payerId = draft.payers[0]?.memberId ?? meId ?? "";
	const pickPayer = (memberId: string) =>
		set({
			status: "paid",
			multiPayer: false,
			payers: [{ memberId, amount: "" }],
		});
	// You first, then the others; anyone picked who isn't listed (yet) too.
	const choices = (extra: string[]) => {
		const ids = people.map((m) => m.id);
		const all = [...ids, ...extra.filter((id) => id && !ids.includes(id))];
		return meId && all.includes(meId)
			? [meId, ...all.filter((id) => id !== meId)]
			: all;
	};
	const symbol = currencySymbol(draft.currency);
	const firstPayment = draft.payments[0];
	// The date on the line: when it was paid, or when it's expected (clearable).
	const when: {
		value: string;
		label: string;
		onChange?: (v: string) => void;
		expected?: boolean;
	} = editing
		? draft.payments.length === 0
			? {
					value: draft.expectedOn,
					label: "Expected on",
					onChange: (v) => set({ expectedOn: v }),
					expected: true,
				}
			: draft.payments.length === 1 && firstPayment
				? {
						value: firstPayment.date,
						label: isRefund ? "Received on" : "Paid on",
						onChange: (v) => set({ payments: [{ ...firstPayment, date: v }] }),
					}
				: {
						value: draft.payments.at(-1)?.date ?? "",
						label: isRefund ? "Last received on" : "Last paid on",
					}
		: planned
			? {
					value: draft.expectedOn,
					label: "Expected on",
					onChange: (v) => set({ expectedOn: v }),
					expected: true,
				}
			: {
					value: draft.date,
					label: isRefund ? "Received on" : "Paid on",
					onChange: (v) => set({ date: v }),
				};
	const tripYear = (graph.trip.startDate ?? draft.date).slice(0, 4);
	const whenDate = when.value
		? formatDayDate(when.value, { year: when.value.slice(0, 4) !== tripYear })
		: "No date";
	const whenText =
		when.expected && when.value ? `Expected ${whenDate}` : whenDate;
	return (
		<form
			className="flex min-h-0 flex-1 flex-col"
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<div className="flex items-center gap-2 px-5 pt-4 pb-2">
				<Title className="min-w-0 truncate text-lg leading-7 font-semibold">
					{title}
				</Title>
				{editing ? (
					<span className="shrink-0 text-xs text-muted-foreground">
						<MonoNumbers text={statusText(editing)} />
					</span>
				) : null}
				<Button
					type="button"
					size="icon-sm"
					variant="ghost"
					className="-mr-1.5 ml-auto"
					aria-label="Close"
					data-testid={MONEY_TESTID.close}
					onClick={onClose}
				>
					<X />
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
				<div className="grid gap-4">
					<fieldset disabled={readOnly} className="grid gap-4">
						{/* The amount, big (autofocus, decimal keypad), its currency and ≈ */}
						<div className="grid gap-1">
							<div className="flex items-center gap-2.5">
								<div className="flex min-w-0 items-baseline border-b-2 border-transparent font-display text-4xl font-semibold tnum focus-within:border-ring">
									{isRefund ? <span aria-hidden="true">−</span> : null}
									{symbol !== draft.currency ? (
										<span
											aria-hidden="true"
											className={cn(!draft.amount && "text-muted-foreground")}
										>
											{symbol}
										</span>
									) : null}
									{/* Sized to what's typed, so the currency sits right after it. */}
									<span className="inline-grid min-w-0 grid-cols-[minmax(0,max-content)] overflow-hidden">
										<span
											aria-hidden="true"
											className="invisible col-start-1 row-start-1 whitespace-pre"
										>
											{draft.amount || "0"}
										</span>
										<input
											// biome-ignore lint/a11y/noAutofocus: the amount first, keypad up (fast entry)
											autoFocus={mode.kind !== "edit"}
											data-testid={MONEY_TESTID.amount}
											aria-label={
												draft.points ? "Taxes and fees (cash)" : "Amount"
											}
											inputMode="decimal"
											enterKeyHint="done"
											autoComplete="off"
											placeholder="0"
											className="col-start-1 row-start-1 w-full min-w-0 bg-transparent tnum outline-none placeholder:text-muted-foreground disabled:opacity-50"
											value={draft.amount}
											onChange={(e) => set({ amount: e.target.value })}
										/>
									</span>
								</div>
								<CurrencyPicker
									value={draft.currency}
									onChange={(c) =>
										set({
											currency: c,
											cashValueCurrency: draft.points
												? draft.cashValueCurrency
												: c,
										})
									}
									suggested={[
										currencyFor(draft.target),
										home,
										...(data?.expenses
											.map((e) => e.currency)
											.filter((c): c is string => !!c) ?? []),
									]}
									disabled={
										readOnly ||
										(editing !== null &&
											editing.payments.length > 0 &&
											editing.payments.some(
												(p) => p.currency !== editing.currency,
											))
									}
									trigger={
										<Button
											type="button"
											variant="outline"
											size="sm"
											data-testid={MONEY_TESTID.currency}
											aria-label={`Currency: ${draft.currency}`}
											className="tnum"
										>
											{draft.currency}
										</Button>
									}
								/>
								{approx ? (
									<span
										data-testid={MONEY_TESTID.converted}
										title={myRate ? "At your rate" : "At today's rate"}
										className="ml-auto shrink-0 text-sm text-muted-foreground tnum"
									>
										≈ {approx}
									</span>
								) : null}
							</div>
							{draft.points ? (
								<p className="text-xs text-muted-foreground">
									The cash part: taxes and fees.
								</p>
							) : null}
						</div>

						<div className="grid gap-1.5">
							<Label
								htmlFor={`${uid}-title`}
								className="text-meta font-semibold"
							>
								What for
							</Label>
							<Input
								id={`${uid}-title`}
								data-testid={MONEY_TESTID.title}
								placeholder={defaultTitle}
								maxLength={120}
								className="h-11 text-body md:text-body"
								value={draft.title}
								onChange={(e) => set({ title: e.target.value })}
							/>
						</div>

						{/* Paid by: one pill picked (inverted); none = not paid yet */}
						{!editing && !draft.isPrivate ? (
							<fieldset
								aria-labelledby={`${uid}-paid`}
								data-testid={pooled ? undefined : MONEY_TESTID.payer}
								className="grid min-w-0 gap-2"
							>
								<FieldHead
									id={`${uid}-paid`}
									label={isRefund ? "Refunded to" : "Paid by"}
									hint={
										planned
											? isRefund
												? "Not received yet"
												: "Not paid yet"
											: pooled
												? "Several people"
												: null
									}
								/>
								{pooled ? (
									<PooledPayers
										draft={draft}
										set={set}
										nameOf={nameOf}
										isNegative={isNegative}
										left={payerLeft}
										negative={negativePayer}
									/>
								) : (
									<div className="flex flex-wrap gap-1.5">
										{choices([payerId]).map((id) => (
											<FilterPill
												key={id}
												pressed={!planned && id === payerId}
												onPressedChange={(on) =>
													on ? pickPayer(id) : set({ status: "planned" })
												}
												data-testid={MONEY_TESTID.payerPerson}
												data-member-id={id}
											>
												{nameOf(id)}
											</FilterPill>
										))}
										{addPerson ? (
											<PersonSelect
												value={payerId}
												onChange={pickPayer}
												ariaLabel={isRefund ? "Refunded to" : "Paid by"}
												trigger={
													<AddPill data-testid={MONEY_TESTID.payerAdd}>
														Person
													</AddPill>
												}
											/>
										) : null}
									</div>
								)}
							</fieldset>
						) : null}

						{/* Payments (edit) */}
						{editing ? (
							<PaymentsEditor
								draft={draft}
								set={set}
								expense={editing}
								home={home}
								costRate={parseRate(draft.rate)}
								sign={sign}
								onMarkPaid={onMarkPaid}
								readOnly={readOnly}
							/>
						) : null}

						{/* Split equally with who was there */}
						{draft.isPrivate ? (
							<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<Lock className="size-3" aria-hidden="true" /> Only you see
								this. It's not split.
							</p>
						) : isRefund ? (
							<p className="text-xs text-muted-foreground">
								<span>Split back like the original.</span>
								{refundLeft ? (
									<span>
										{" "}
										Up to{" "}
										<Num>
											{formatMoney(refundLeft.minor, refundLeft.currency)}
										</Num>{" "}
										left to refund.
									</span>
								) : null}
							</p>
						) : itemized ? (
							<p className="text-xs text-muted-foreground">
								Split by item: who had what, under More.
							</p>
						) : (
							<fieldset
								aria-labelledby={`${uid}-split`}
								className="grid min-w-0 gap-2"
							>
								<FieldHead
									id={`${uid}-split`}
									testid={MONEY_TESTID.splitToggle}
									label={
										draft.splitMode === "exact"
											? "Split by exact amounts"
											: "Split equally with"
									}
									hint={
										draft.splitMode === "exact" ? (
											<Remainder
												left={exactLeft}
												currency={draft.currency}
												negative={negativeExact}
											/>
										) : (
											"who was there"
										)
									}
								/>
								<SplitPeople
									draft={draft}
									set={set}
									choices={choices(draft.splitIds)}
									nameOf={nameOf}
								/>
							</fieldset>
						)}

						{editing ? (
							<div data-testid={MONEY_TESTID.receipts}>
								<ReceiptStrip expenseId={editing.id} />
							</div>
						) : null}
					</fieldset>

					{/* The date and the place (tap to change), and More (under them when narrow) */}
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
						<div className="flex min-w-0 flex-auto items-center gap-1.5">
							<CalendarDays
								className="mr-0.5 size-4 shrink-0 text-muted-foreground"
								aria-hidden="true"
							/>
							{when.onChange ? (
								<DateInput
									value={when.value}
									onChange={when.onChange}
									clearLabel={when.expected ? "No date" : undefined}
									defaultMonth={graph.trip.startDate}
									trigger={
										<button
											type="button"
											data-testid={MONEY_TESTID.when}
											data-value={when.value || undefined}
											aria-label={`${when.label}: ${whenDate}`}
											disabled={readOnly}
											className={cn(
												"shrink-0 rounded-sm tnum whitespace-nowrap underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
												!when.value && "text-muted-foreground",
											)}
										>
											{whenText}
										</button>
									}
								/>
							) : (
								<span
									data-testid={MONEY_TESTID.when}
									className="shrink-0 tnum whitespace-nowrap"
								>
									<span className="sr-only">{when.label}: </span>
									{whenDate}
								</span>
							)}
							<span aria-hidden="true" className="text-muted-foreground">
								·
							</span>
							<PlaceButton
								target={draft.target}
								onChange={(t) =>
									set({
										target: t,
										splitIds: editing ? draft.splitIds : defaultPeople(t),
									})
								}
								disabled={readOnly}
							/>
						</div>
						<button
							type="button"
							data-testid={MONEY_TESTID.more}
							aria-expanded={moreOpen}
							onClick={() => setMoreOpen((v) => !v)}
							className="ml-auto shrink-0 rounded-sm text-meta font-semibold whitespace-nowrap text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
						>
							{moreOpen
								? "Show less"
								: isRefund
									? "More"
									: "More: itemise, fees, points"}
						</button>
					</div>

					{/* More: every other field */}
					{moreOpen ? (
						<fieldset
							disabled={readOnly}
							data-testid={MONEY_TESTID.moreFields}
							className="grid gap-4 border-t pt-4"
						>
							{!editing ? (
								<MoreRow
									label={isRefund ? "Received or expected" : "Paid or planned"}
								>
									<Segmented
										label={
											isRefund ? "Received or expected" : "Paid or planned"
										}
										testId={MONEY_TESTID.status}
										value={draft.status}
										onValueChange={(v) => set({ status: v })}
										options={[
											{ value: "paid", label: isRefund ? "Received" : "Paid" },
											{
												value: "planned",
												label: isRefund ? "Expected" : "Planned",
											},
										]}
									/>
								</MoreRow>
							) : null}
							{!editing && !planned ? (
								<MoreRow
									label={`${isRefund ? "Time received" : "Time paid"} (${draft.tz.split("/").at(-1)?.replace(/_/g, " ")})`}
								>
									{/* 24-hour like every time field (DESIGN §2.6). */}
									<TimeInput
										aria-label={isRefund ? "Time received" : "Time paid"}
										className="w-24 text-xs"
										value={draft.time}
										onChange={(time) => set({ time })}
									/>
								</MoreRow>
							) : null}
							{editing && draft.payments.length > 0 ? (
								<MoreRow label="Expected on">
									<DateInput
										value={draft.expectedOn}
										onChange={(v) => set({ expectedOn: v })}
										label={`Expected on: ${draft.expectedOn ? formatDayDate(draft.expectedOn, { year: true }) : "No date"}`}
										placeholder="No date"
										clearLabel="No date"
										defaultMonth={graph.trip.startDate}
									/>
								</MoreRow>
							) : null}
							<MoreRow label="Category">
								<CategorySelect
									value={draft.category}
									inferred={inferred}
									onChange={(c) => set({ category: c })}
								/>
							</MoreRow>
							{ownSplit ? (
								<MoreRow label="Split">
									<Segmented
										label="How to split"
										value={draft.splitMode}
										onValueChange={(v) => set({ splitMode: v })}
										options={[
											{ value: "equal", label: "Equally" },
											{
												value: "exact",
												label: "Exact amounts",
												testId: MONEY_TESTID.splitExact,
											},
										]}
									/>
								</MoreRow>
							) : null}
							{!editing && !planned && !draft.isPrivate && !isRefund ? (
								<SwitchRow
									label="Several people paid (pooled cash)"
									checked={draft.multiPayer}
									onChange={(v) =>
										set({
											multiPayer: v,
											payers: v
												? draft.payers.length > 1
													? draft.payers
													: [
															{ memberId: payerId, amount: "" },
															{
																memberId:
																	people.find((m) => m.id !== payerId)?.id ??
																	"",
																amount: "",
															},
														].filter((p) => p.memberId)
												: draft.payers.slice(0, 1),
										})
									}
								/>
							) : null}
							{!isRefund &&
							(!editing || editing.createdBy === graph.me.userId) ? (
								<SwitchRow
									label="Private — only you see it, not split"
									testid={MONEY_TESTID.private}
									checked={draft.isPrivate}
									onChange={(v) =>
										set({
											isPrivate: v,
											multiPayer: false,
											payers: meId ? [{ memberId: meId, amount: "" }] : [],
										})
									}
								/>
							) : null}
							{!draft.isPrivate && !isRefund ? (
								<SwitchRow
									label="Itemise (who had what, tax and tip)"
									testid={MONEY_TESTID.itemize}
									checked={draft.itemize}
									onChange={(v) =>
										set({
											itemize: v,
											lines:
												v && !draft.lines.length
													? [
															{
																key: nextKey(),
																label: "",
																amount: "",
																memberIds: [...draft.splitIds],
															},
														]
													: draft.lines,
										})
									}
								/>
							) : null}
							{itemized ? (
								<ItemizeEditor
									draft={draft}
									set={set}
									left={itemizeLeft}
									negative={negativeLine}
									nameOf={nameOf}
								/>
							) : null}
							{!isRefund ? (
								<SwitchRow
									label="Paid with points or miles"
									testid={MONEY_TESTID.points}
									checked={draft.points}
									onChange={(v) => set({ points: v })}
								/>
							) : null}
							{draft.points ? (
								<PointsEditor draft={draft} set={set} home={home} />
							) : null}
							{category === "shopping" ? (
								<SwitchRow
									label="Tax-free · refund pending"
									checked={draft.taxFreePending}
									onChange={(v) => set({ taxFreePending: v })}
								/>
							) : null}
							{draft.currency !== home ? (
								<div className="grid gap-1">
									<Label
										className="text-xs text-muted-foreground"
										htmlFor={`${uid}-rate`}
									>
										Your rate (1 {draft.currency} = ? {home})
									</Label>
									<div className="flex items-center gap-2">
										<Input
											id={`${uid}-rate`}
											inputMode="decimal"
											className="w-40 text-xs tnum"
											placeholder={
												rateToHome ? (1 / rateToHome).toPrecision(4) : "auto"
											}
											value={draft.rate}
											onChange={(e) => set({ rate: e.target.value })}
										/>
										{editing?.fxManual ? (
											<Button
												type="button"
												size="xs"
												variant="ghost"
												onClick={() =>
													rateM.mutate(
														{ id: editing.id, rate: null },
														{ onSuccess: () => set({ rate: "" }) },
													)
												}
											>
												Use daily rate
											</Button>
										) : null}
									</div>
									{editing?.fxDate && !editing.fxManual ? (
										<p className="text-xs text-muted-foreground">
											Rate from {paidDate(`${editing.fxDate}T12:00:00Z`, "UTC")}{" "}
											· currency-api
										</p>
									) : null}
								</div>
							) : null}
							{!editing && !readOnly ? (
								<label className="flex cursor-pointer items-center gap-2 text-sm">
									<Camera
										className="size-4 shrink-0 text-muted-foreground"
										aria-hidden="true"
									/>
									<span className="min-w-0 flex-1 truncate">
										{receipt ? receipt.name : "Attach a receipt"}
									</span>
									<span className="shrink-0 text-xs text-muted-foreground">
										Photo or PDF
									</span>
									<input
										type="file"
										data-testid={MONEY_TESTID.receipt}
										accept="image/*,application/pdf"
										capture="environment"
										className="sr-only"
										onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
									/>
								</label>
							) : null}
							<Textarea
								aria-label="Note"
								placeholder="Note"
								maxLength={2000}
								className="min-h-16 text-sm"
								value={draft.note}
								onChange={(e) => set({ note: e.target.value })}
							/>
						</fieldset>
					) : null}
				</div>
			</div>
			{!readOnly ? (
				<div className="grid gap-2 px-5 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
					{problems.length && (draft.amount || editing) ? (
						<p
							data-testid={MONEY_TESTID.problems}
							className="text-xs text-muted-foreground"
						>
							{problems[0]}
						</p>
					) : null}
					<div className="flex items-center gap-2">
						{editing ? (
							<>
								{!isRefund &&
								editing.amountMinor !== null &&
								editing.status !== "planned" ? (
									<Button
										type="button"
										size="lg"
										variant="ghost"
										data-testid={MONEY_TESTID.refund}
										onClick={() =>
											useUi
												.getState()
												.openAddExpense({ refundOfId: editing.id })
										}
									>
										<Undo2 /> Refund
									</Button>
								) : null}
								<Button
									type="button"
									size="icon-lg"
									variant="ghost"
									aria-label="Delete expense"
									data-testid={MONEY_TESTID.delete}
									onClick={() => void onDelete()}
								>
									<Trash2 />
								</Button>
							</>
						) : null}
						<Button
							type="submit"
							size="xl"
							className="flex-1"
							data-testid={MONEY_TESTID.save}
							disabled={problems.length > 0 || busy}
						>
							<Check />
							{!editing && isRefund ? "Add refund" : "Save"}
						</Button>
					</div>
				</div>
			) : null}
		</form>
	);
}

/**
 * What is left to refund of an original, in its currency (its amount minus
 * the other refunds I can see), or null when that can't be told (no
 * original, points only, refunds in another currency).
 */
function refundRoom(
	data: MoneyDto | undefined,
	refundOfId: string | null,
	selfId: string | null,
): { minor: number; currency: string } | null {
	if (!data || !refundOfId) return null;
	const orig = data.expenses.find((e) => e.id === refundOfId);
	if (!orig || orig.amountMinor === null || !orig.currency) return null;
	const others = data.expenses.filter(
		(e) =>
			e.refundOfId === orig.id && e.id !== selfId && e.amountMinor !== null,
	);
	if (others.some((e) => e.currency !== orig.currency)) return null;
	const used = others.reduce((a, e) => a + Math.abs(e.amountMinor ?? 0), 0);
	return {
		minor: Math.max(0, Math.abs(orig.amountMinor) - used),
		currency: orig.currency,
	};
}

function stripNulls<T extends Record<string, unknown>>(o: T): Partial<T> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(o))
		if (v !== null && v !== undefined) out[k] = v;
	return out as Partial<T>;
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function Remainder({
	left,
	currency,
	negative = false,
}: {
	left: number | null;
	currency: string;
	/** A part is below zero: never "Adds up ✓" (QA MONEY-01). */
	negative?: boolean;
}) {
	if (left === null) return null;
	if (negative)
		return (
			<span
				data-testid={MONEY_TESTID.remainder}
				data-invalid=""
				className="text-destructive"
			>
				No negative amounts
			</span>
		);
	return (
		<span
			data-testid={MONEY_TESTID.remainder}
			className={cn(left !== 0 ? "text-foreground" : "text-muted-foreground")}
		>
			{left === 0 ? (
				"Adds up ✓"
			) : left > 0 ? (
				<>
					<Num>{formatMoney(left, currency)}</Num> left
				</>
			) : (
				<>
					<Num>{formatMoney(-left, currency)}</Num> too much
				</>
			)}
		</span>
	);
}

function SwitchRow({
	label,
	checked,
	onChange,
	testid,
}: {
	label: string;
	checked: boolean;
	onChange: (v: boolean) => void;
	testid?: string;
}) {
	const id = useId();
	return (
		<div className="flex items-center justify-between gap-3 text-sm">
			<Label htmlFor={id} className="cursor-pointer font-normal">
				{label}
			</Label>
			<Switch
				id={id}
				data-testid={testid}
				checked={checked}
				onCheckedChange={onChange}
			/>
		</div>
	);
}

function PayerSelect({
	value,
	onChange,
	label,
}: {
	value: string;
	onChange: (id: string) => void;
	label?: string;
}) {
	return (
		<PersonSelect
			value={value}
			onChange={onChange}
			label={label}
			testid={MONEY_TESTID.payer}
			ariaLabel={label === "to" ? "Refunded to" : "Paid by"}
		/>
	);
}

function CategorySelect({
	value,
	inferred,
	onChange,
}: {
	value: ExpenseCategory | null;
	inferred: ExpenseCategory;
	onChange: (c: ExpenseCategory | null) => void;
}) {
	return (
		<Select
			value={value ?? "auto"}
			onValueChange={(v) =>
				onChange(v === "auto" ? null : (v as ExpenseCategory))
			}
		>
			<SelectTrigger
				size="sm"
				className="h-6 gap-1 rounded-full px-2 text-xs"
				data-testid={MONEY_TESTID.category}
				aria-label="Category"
			>
				<CategoryIcon category={value ?? inferred} />
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem className="cursor-pointer" value="auto">
					{EXPENSE_CATEGORY_LABEL[inferred]} (auto)
				</SelectItem>
				{EXPENSE_CATEGORY_VALUES.map((c) => (
					<SelectItem className="cursor-pointer" key={c} value={c}>
						{EXPENSE_CATEGORY_LABEL[c]}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** A field's name (13px) with a hint on the right ("who was there"). */
function FieldHead({
	id,
	label,
	hint,
	testid,
}: {
	id: string;
	label: string;
	hint?: ReactNode;
	testid?: string;
}) {
	return (
		<div data-testid={testid} className="flex items-baseline gap-2">
			<span id={id} className="text-meta font-semibold">
				{label}
			</span>
			{hint ? (
				<span className="ml-auto text-xs text-muted-foreground">{hint}</span>
			) : null}
		</div>
	);
}

/** One of More's rows: its name on the left, the control on the right. */
function MoreRow({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-sm">
			<span>{label}</span>
			{children}
		</div>
	);
}

/** "+ Person" after a row of pills (a popover trigger). */
function AddPill({ children, className, ...props }: ComponentProps<"button">) {
	return (
		<button
			type="button"
			{...props}
			className={cn(
				"inline-flex h-(--control) shrink-0 items-center gap-1 rounded-full border border-dashed px-3 text-meta text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
				className,
			)}
		>
			<Plus className="size-3.5" aria-hidden="true" />
			{children}
		</button>
	);
}

/** The place it hangs on, as text on the date line; picks a place (or the trip). */
function PlaceButton({
	target,
	onChange,
	disabled,
}: {
	target: BundleTarget;
	onChange: (t: BundleTarget) => void;
	disabled?: boolean;
}) {
	const { ix } = useWorkspace();
	const label = targetLabel(ix, target);
	return (
		<TreePicker
			value={target.kind === "node" ? target.nodeId : null}
			onChange={(nodeId) =>
				onChange(nodeId ? { kind: "node", nodeId } : { kind: "trip" })
			}
			allowRoot
			trigger={
				<button
					type="button"
					data-testid={MONEY_TESTID.place}
					aria-label={`Place: ${label}`}
					disabled={disabled}
					className="min-w-0 truncate rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
				>
					{label}
				</button>
			}
		/>
	);
}

/**
 * Who shares it: a pill per person (a check on each one in), "+ Person"
 * for someone new, and each one's amount when split by exact amounts.
 */
function SplitPeople({
	draft,
	set,
	choices,
	nameOf,
}: {
	draft: Draft;
	set: (p: Partial<Draft>) => void;
	/** Everyone to offer, in order. */
	choices: string[];
	nameOf: (id: string) => string;
}) {
	const toggle = (id: string) =>
		set({
			splitIds: draft.splitIds.includes(id)
				? draft.splitIds.filter((x) => x !== id)
				: [...draft.splitIds, id],
		});
	return (
		<>
			<div className="flex flex-wrap gap-1.5">
				{choices.map((id) => {
					const on = draft.splitIds.includes(id);
					return (
						<FilterPill
							key={id}
							memberId={id}
							pressed={on}
							onPressedChange={() => toggle(id)}
							data-testid={MONEY_TESTID.splitPerson}
							data-member-id={id}
						>
							{nameOf(id)}
							{on ? <Check aria-hidden="true" /> : null}
						</FilterPill>
					);
				})}
				<MemberPicker
					value={draft.splitIds}
					onChange={(ids) => set({ splitIds: ids })}
					trigger={
						<AddPill data-testid={MONEY_TESTID.splitAddPerson}>Person</AddPill>
					}
				/>
			</div>
			{draft.splitMode === "exact" ? (
				<div className="grid gap-1.5">
					{draft.splitIds.map((id) => (
						<div key={id} className="flex items-center gap-2 text-sm">
							<PersonAvatar memberId={id} size={20} />
							<span className="flex-1 truncate">{nameOf(id)}</span>
							<Input
								aria-label={`${nameOf(id)}'s amount`}
								data-testid={MONEY_TESTID.splitExactAmount}
								inputMode="decimal"
								className="w-32 tnum"
								value={draft.exact[id] ?? ""}
								aria-invalid={
									(parseMoneyInput(draft.exact[id] ?? "", draft.currency) ??
										0) < 0 || undefined
								}
								onChange={(e) =>
									set({ exact: { ...draft.exact, [id]: e.target.value } })
								}
							/>
						</div>
					))}
				</div>
			) : null}
		</>
	);
}

/** Paid by several people (pooled cash): each payer and what they put in. */
function PooledPayers({
	draft,
	set,
	nameOf,
	isNegative,
	left,
	negative,
}: {
	draft: Draft;
	set: (p: Partial<Draft>) => void;
	nameOf: (id: string) => string;
	isNegative: (v: string) => boolean;
	/** What the payers still have to add up to. */
	left: number | null;
	/** A payer's amount is below zero. */
	negative: boolean;
}) {
	const { graph } = useWorkspace();
	const people = assignableMembers(graph.members);
	const setPayer = (i: number, p: Partial<PayerDraft>) =>
		set({
			payers: draft.payers.map((x, j) => (j === i ? { ...x, ...p } : x)),
		});
	return (
		<div className="grid gap-1.5" data-testid={MONEY_TESTID.multiPayer}>
			{draft.payers.map((p, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: payer rows are positional
					key={`${p.memberId}-${i}`}
					className="flex items-center gap-2"
				>
					<PayerSelect
						value={p.memberId}
						onChange={(m) => setPayer(i, { memberId: m })}
					/>
					<Input
						aria-label={`${nameOf(p.memberId)} paid`}
						data-testid={MONEY_TESTID.payerAmount}
						aria-invalid={isNegative(p.amount) || undefined}
						inputMode="decimal"
						className="flex-1 tnum"
						value={p.amount}
						onChange={(e) => setPayer(i, { amount: e.target.value })}
					/>
					<Button
						type="button"
						size="icon-sm"
						variant="ghost"
						aria-label="Remove payer"
						onClick={() =>
							set({ payers: draft.payers.filter((_, j) => j !== i) })
						}
					>
						<X />
					</Button>
				</div>
			))}
			<div className="flex items-center justify-between text-xs">
				<Button
					type="button"
					size="xs"
					variant="ghost"
					onClick={() => {
						const next = people.find(
							(m) => !draft.payers.some((p) => p.memberId === m.id),
						);
						if (next)
							set({
								payers: [...draft.payers, { memberId: next.id, amount: "" }],
							});
					}}
				>
					<Plus /> Payer
				</Button>
				<Remainder left={left} currency={draft.currency} negative={negative} />
			</div>
		</div>
	);
}

/** Lines (label, amount, who had it) and fees (% or fixed), with the remainder live. */
function ItemizeEditor({
	draft,
	set,
	left,
	negative,
	nameOf,
}: {
	draft: Draft;
	set: (p: Partial<Draft>) => void;
	left: number | null;
	/** An item's amount is below zero. */
	negative: boolean;
	nameOf: (id: string) => string;
}) {
	const { graph } = useWorkspace();
	const people = assignableMembers(graph.members);
	const setLine = (key: string, p: Partial<LineDraft>) =>
		set({
			lines: draft.lines.map((l) => (l.key === key ? { ...l, ...p } : l)),
		});
	const setFee = (key: string, p: Partial<FeeDraft>) =>
		set({ fees: draft.fees.map((f) => (f.key === key ? { ...f, ...p } : f)) });
	return (
		<div className="grid gap-3 rounded-lg border p-3">
			{draft.lines.map((l) => (
				<div
					key={l.key}
					data-testid={MONEY_TESTID.line}
					className="grid gap-1.5"
				>
					<div className="flex items-center gap-2">
						<Input
							aria-label="Item"
							data-testid={MONEY_TESTID.lineLabel}
							placeholder="Item"
							maxLength={80}
							className="flex-1"
							value={l.label}
							onChange={(e) => setLine(l.key, { label: e.target.value })}
						/>
						<Input
							aria-label="Item amount"
							data-testid={MONEY_TESTID.lineAmount}
							inputMode="decimal"
							className="w-28 tnum"
							value={l.amount}
							aria-invalid={
								(parseMoneyInput(l.amount, draft.currency) ?? 0) < 0 ||
								undefined
							}
							onChange={(e) => setLine(l.key, { amount: e.target.value })}
						/>
						<Button
							type="button"
							size="icon-sm"
							variant="ghost"
							aria-label="Remove item"
							onClick={() =>
								set({ lines: draft.lines.filter((x) => x.key !== l.key) })
							}
						>
							<X />
						</Button>
					</div>
					<div className="flex flex-wrap gap-1.5">
						{people.map((m) => {
							const on = l.memberIds.includes(m.id);
							return (
								<FilterPill
									key={m.id}
									size="sm"
									memberId={m.id}
									pressed={on}
									onPressedChange={() =>
										setLine(l.key, {
											memberIds: on
												? l.memberIds.filter((x) => x !== m.id)
												: [...l.memberIds, m.id],
										})
									}
									data-testid={MONEY_TESTID.linePerson}
								>
									{nameOf(m.id)}
								</FilterPill>
							);
						})}
						<MemberPicker
							value={l.memberIds}
							onChange={(ids) => setLine(l.key, { memberIds: ids })}
							trigger={
								<Button
									type="button"
									size="icon-sm"
									variant="ghost"
									aria-label="Who had it"
									className="rounded-full text-muted-foreground"
								>
									<Plus />
								</Button>
							}
						/>
					</div>
				</div>
			))}
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					size="xs"
					variant="ghost"
					data-testid={MONEY_TESTID.addLine}
					onClick={() =>
						set({
							lines: [
								...draft.lines,
								{ key: nextKey(), label: "", amount: "", memberIds: [] },
							],
						})
					}
				>
					<Plus /> Item
				</Button>
				<Button
					type="button"
					size="xs"
					variant="ghost"
					data-testid={MONEY_TESTID.addFee}
					onClick={() =>
						set({
							fees: [
								...draft.fees,
								{
									key: nextKey(),
									label: "Service",
									kind: "percent",
									value: "10",
								},
							],
						})
					}
				>
					<Plus /> Tax, service or tip
				</Button>
			</div>
			{draft.fees.map((f) => (
				<div key={f.key} className="flex items-center gap-2">
					<Input
						aria-label="Fee"
						className="flex-1"
						maxLength={40}
						value={f.label}
						onChange={(e) => setFee(f.key, { label: e.target.value })}
					/>
					<Input
						aria-label="Fee value"
						data-testid={MONEY_TESTID.feeValue}
						inputMode="decimal"
						className="w-20 tnum"
						value={f.value}
						onChange={(e) => setFee(f.key, { value: e.target.value })}
					/>
					<Segmented
						label="Fee in"
						value={f.kind}
						onValueChange={(v) =>
							v && setFee(f.key, { kind: v as FeeDraft["kind"] })
						}
						options={[
							{ value: "percent", label: "%" },
							{ value: "fixed", label: draft.currency },
						]}
					/>
					<Button
						type="button"
						size="icon-sm"
						variant="ghost"
						aria-label="Remove fee"
						onClick={() =>
							set({ fees: draft.fees.filter((x) => x.key !== f.key) })
						}
					>
						<X />
					</Button>
				</div>
			))}
			<div className="flex justify-between text-xs text-muted-foreground">
				<span>Fees are shared in proportion to what each person had.</span>
				<Remainder left={left} currency={draft.currency} negative={negative} />
			</div>
		</div>
	);
}

/** "2.38¢" (a 2-decimal home), else "¥1.90" (home minor units per point). */
function cppLabel(minorPerPoint: number, home: string): string {
	return minorDigits(home) === 2
		? `${minorPerPoint.toFixed(2)}¢`
		: `${currencySymbol(home)}${minorPerPoint.toFixed(2)}`;
}

/** Redeemed programme + points, the source it came from, and the booking's cash price (cpp). */
function PointsEditor({
	draft,
	set,
	home,
}: {
	draft: Draft;
	set: (p: Partial<Draft>) => void;
	home: string;
}) {
	const pts = Number.parseInt(draft.pts, 10);
	const src = Number.parseInt(draft.sourcePts, 10);
	const cash = parseMoneyInput(draft.cashValue, draft.cashValueCurrency);
	const fees = parseMoneyInput(draft.amount, draft.currency) ?? 0;
	const d = useDisplayCurrency();
	const toHome = (m: number, c: string) => {
		const r = c === home ? 1 : d.rateTo(c);
		return r ? convertMinor(m, c, home, 1 / r) : null;
	};
	const valueHome =
		cash !== null ? toHome(cash, draft.cashValueCurrency) : null;
	const feesHome = toHome(fees, draft.currency) ?? 0;
	const cpp = (n: number) =>
		valueHome !== null && n > 0 ? (valueHome - feesHome) / n : null;
	return (
		<div className="grid gap-2 rounded-lg border p-3">
			<div className="flex gap-2">
				<Input
					aria-label="Programme"
					placeholder="Programme (Aeroplan)"
					list="money-programs"
					maxLength={60}
					className="flex-1"
					value={draft.program}
					onChange={(e) => set({ program: e.target.value })}
				/>
				<Input
					aria-label="Points"
					placeholder="Points"
					inputMode="numeric"
					className="w-28 tnum"
					value={draft.pts}
					onChange={(e) => set({ pts: e.target.value.replace(/[^\d]/g, "") })}
				/>
			</div>
			<div className="flex gap-2">
				<Input
					aria-label="Source programme"
					placeholder="From (Chase UR)"
					list="money-programs"
					maxLength={60}
					className="flex-1"
					value={draft.sourceProgram}
					onChange={(e) => set({ sourceProgram: e.target.value })}
				/>
				<Input
					aria-label="Source points"
					placeholder="Points"
					inputMode="numeric"
					className="w-28 tnum"
					value={draft.sourcePts}
					onChange={(e) =>
						set({ sourcePts: e.target.value.replace(/[^\d]/g, "") })
					}
				/>
			</div>
			<div className="flex items-center gap-2">
				<span className="text-xs text-muted-foreground">Cash price</span>
				<CurrencyPicker
					value={draft.cashValueCurrency}
					onChange={(c) => set({ cashValueCurrency: c })}
					suggested={[home, draft.currency]}
					className="h-8"
				/>
				<Input
					aria-label="Cash price"
					inputMode="decimal"
					className="flex-1 tnum"
					value={draft.cashValue}
					onChange={(e) => set({ cashValue: e.target.value })}
				/>
			</div>
			<datalist id="money-programs">
				{[
					"Aeroplan",
					"Alaska Mileage Plan",
					"ANA Mileage Club",
					"Asia Miles",
					"Chase UR",
					"Amex MR",
					"Capital One",
					"Citi ThankYou",
					"Bilt",
					"Flying Blue",
					"Hyatt",
					"Marriott Bonvoy",
					"Hilton Honors",
					"IHG",
					"United MileagePlus",
					"Virgin Atlantic",
					"Korean Air SKYPASS",
					"JAL Mileage Bank",
				].map((p) => (
					<option key={p} value={p} />
				))}
			</datalist>
			<p className="text-xs text-muted-foreground">
				{cpp(pts) !== null ? (
					<>
						<Num>{cppLabel(cpp(pts) ?? 0, home)}</Num> per point
						{src > 0 && cpp(src) !== null ? (
							<>
								{" · "}
								<Num>{cppLabel(cpp(src) ?? 0, home)}</Num> per{" "}
								{draft.sourceProgram || "source"} point
							</>
						) : null}
						. Points never count in balances.
					</>
				) : (
					"Add the booking's cash price to see cents per point. Points never count in balances."
				)}
			</p>
		</div>
	);
}

/**
 * Payments of an existing expense (ADDENDUM §7.3): each with its date,
 * currency, amount, payer(s) with their amounts (pooled cash, with the
 * remainder live) and its own rate; Add payment; Mark paid.
 */
function PaymentsEditor({
	draft,
	set,
	expense,
	home,
	costRate,
	sign,
	onMarkPaid,
	readOnly,
}: {
	draft: Draft;
	set: (p: Partial<Draft>) => void;
	expense: ExpenseDto;
	home: string;
	/** The cost's manual rate as typed (payments in its currency follow it). */
	costRate: number | null;
	sign: number;
	onMarkPaid: () => void;
	readOnly: boolean;
}) {
	const { graph } = useWorkspace();
	const d = useDisplayCurrency();
	const meId = graph.me.memberId;
	const people = assignableMembers(graph.members);
	const setP = (key: string, p: Partial<PaymentDraft>) =>
		set({
			payments: draft.payments.map((x) => (x.key === key ? { ...x, ...p } : x)),
		});
	const rem = remainingInCurrency(expense);
	return (
		<div data-testid={MONEY_TESTID.payments} className="grid gap-2">
			<div className="flex items-center justify-between">
				<span className="text-xs font-medium text-muted-foreground">
					Payments
				</span>
				{!readOnly &&
				expense.status !== "paid" &&
				expense.amountMinor !== null ? (
					<Button
						type="button"
						size="xs"
						variant="outline"
						data-testid={MONEY_TESTID.markPaid}
						onClick={onMarkPaid}
					>
						Mark paid
						{rem
							? ` · ${formatMoney(Math.abs(rem), expense.currency ?? draft.currency)}`
							: ""}
					</Button>
				) : null}
			</div>
			{draft.payments.length === 0 ? (
				<p className="text-xs text-muted-foreground">Nothing paid yet.</p>
			) : null}
			{draft.payments.map((p) => {
				const amount = parseMoneyInput(p.amount, p.currency);
				const multi = p.payers.length > 1;
				const left =
					multi && amount !== null
						? Math.abs(amount) -
							payersOf(p, 1).reduce((a, x) => a + x.amountMinor, 0)
						: null;
				// Editing a payer by hand stops them following the amount.
				const setPayer = (i: number, x: Partial<PayerDraft>) =>
					setP(p.key, {
						payers: p.payers.map((y, j) => (j === i ? { ...y, ...x } : y)),
						follow: undefined,
					});
				const inherits =
					costRate !== null && p.currency === draft.currency && !p.rate.trim();
				// Each payment converts at its own paid date (ADDENDUM §7.3).
				const auto = autoPaymentRate(
					p,
					expense.payments,
					d.rateTo(p.currency),
					localParts(new Date(), p.tz).date,
				);
				return (
					<div
						key={p.key}
						data-testid={MONEY_TESTID.paymentRow}
						className="grid gap-1.5 rounded-lg border p-2"
					>
						<div className="flex items-center gap-2">
							<Input
								type="date"
								aria-label="Paid on"
								className="w-36 text-xs"
								value={p.date}
								onChange={(e) => setP(p.key, { date: e.target.value })}
							/>
							<CurrencyPicker
								value={p.currency}
								onChange={(c) => setP(p.key, { currency: c })}
								suggested={[expense.currency ?? draft.currency, home]}
								disabled={readOnly}
								testid={MONEY_TESTID.paymentCurrency}
								className="h-8 px-2 text-xs"
							/>
							<Input
								aria-label="Payment amount"
								inputMode="decimal"
								className="flex-1 tnum"
								value={p.amount}
								onChange={(e) => {
									const v = e.target.value;
									setP(
										p.key,
										multi
											? { amount: v, payers: rescalePayers(p, v) }
											: {
													amount: v,
													payers: [
														{
															memberId: p.payers[0]?.memberId ?? "",
															amount: v,
														},
													],
												},
									);
								}}
							/>
							{!readOnly ? (
								<Button
									type="button"
									size="icon-sm"
									variant="ghost"
									aria-label="Remove payment"
									onClick={() =>
										set({
											payments: draft.payments.filter((x) => x.key !== p.key),
										})
									}
								>
									<X />
								</Button>
							) : null}
						</div>
						{multi ? (
							<div className="grid gap-1.5">
								{p.payers.map((x, i) => (
									<div
										// biome-ignore lint/suspicious/noArrayIndexKey: payer rows are positional
										key={`${x.memberId}-${i}`}
										className="flex items-center gap-2"
									>
										<PayerSelect
											value={x.memberId}
											onChange={(m) => setPayer(i, { memberId: m })}
											label={sign < 0 ? "to" : "by"}
										/>
										<Input
											aria-label="Payer amount"
											data-testid={MONEY_TESTID.paymentPayerAmount}
											inputMode="decimal"
											className="flex-1 tnum"
											value={x.amount}
											onChange={(e) => setPayer(i, { amount: e.target.value })}
										/>
										{!readOnly ? (
											<Button
												type="button"
												size="icon-sm"
												variant="ghost"
												aria-label="Remove payer"
												onClick={() => {
													const payers = p.payers.filter((_, j) => j !== i);
													// Back to one payer: they paid it all.
													setP(p.key, {
														follow: undefined,
														payers:
															payers.length === 1
																? [
																		{
																			memberId: payers[0]?.memberId ?? "",
																			amount: p.amount,
																		},
																	]
																: payers,
													});
												}}
											>
												<X />
											</Button>
										) : null}
									</div>
								))}
							</div>
						) : null}
						<div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
							{!multi ? (
								<PayerSelect
									value={p.payers[0]?.memberId ?? ""}
									onChange={(m) =>
										setP(p.key, { payers: [{ memberId: m, amount: p.amount }] })
									}
									label={sign < 0 ? "to" : "by"}
								/>
							) : null}
							{!readOnly ? (
								<Button
									type="button"
									size="xs"
									variant="ghost"
									data-testid={MONEY_TESTID.paymentAddPayer}
									onClick={() => {
										const next = people.find(
											(m) => !p.payers.some((x) => x.memberId === m.id),
										);
										if (!next) return;
										setP(p.key, {
											follow: undefined,
											payers: [
												...p.payers.map((x) =>
													multi ? x : { ...x, amount: p.amount },
												),
												{ memberId: next.id, amount: "" },
											],
										});
									}}
								>
									<Plus /> Payer
								</Button>
							) : null}
							{multi ? (
								<span className="ml-auto">
									<Remainder left={left} currency={p.currency} />
								</span>
							) : null}
						</div>
						{p.currency !== home ? (
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<Label
									htmlFor={`pay-rate-${p.key}`}
									className="text-xs font-normal"
								>
									Rate (1 {p.currency} = ? {home})
								</Label>
								<Input
									id={`pay-rate-${p.key}`}
									data-testid={MONEY_TESTID.paymentRate}
									inputMode="decimal"
									className="h-7 w-28 text-xs tnum"
									placeholder={
										inherits
											? String(costRate)
											: auto.rate !== null
												? formatRate(auto.rate)
												: "auto"
									}
									value={p.rate}
									onChange={(e) => setP(p.key, { rate: e.target.value })}
								/>
								<span data-testid={MONEY_TESTID.paymentRateSource}>
									{p.rate.trim()
										? "your rate"
										: inherits
											? "the expense's rate"
											: auto.label}
								</span>
							</div>
						) : null}
					</div>
				);
			})}
			{!readOnly ? (
				<Button
					type="button"
					size="xs"
					variant="ghost"
					className="justify-self-start"
					data-testid={MONEY_TESTID.addPayment}
					onClick={() => {
						const tz = deviceTz();
						const { date, time } = localParts(new Date(), tz);
						const amt =
							rem !== null && rem !== 0
								? minorToInput(
										Math.abs(rem),
										expense.currency ?? draft.currency,
									)
								: "";
						set({
							payments: [
								...draft.payments,
								{
									key: nextKey(),
									date,
									time,
									tz,
									currency: expense.currency ?? draft.currency,
									amount: amt,
									payers: [{ memberId: meId ?? "", amount: amt }],
									method: "",
									rate: "",
								},
							],
						});
					}}
				>
					<Plus /> Payment
				</Button>
			) : null}
		</div>
	);
}
