/**
 * Settle up (EXTENSIONS §8.6, ADDENDUM §7.3): trip-wide minimal transfers,
 * each with "Mark paid" (home currency by default, a currency switch and a
 * method), and the recorded settlements. Settlements in another currency
 * convert at that day's rate; a mismatch stays visible as a small remainder.
 * "Audrey → Dennis $124.00 (≈ C$170)".
 */
import { ArrowRight, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { PersonAvatar, resolveMember } from "@/components/common/member";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { GraphIndex } from "@/lib/engine/graph-index";
import {
	convertMinor,
	formatMoney,
	minorToInput,
	parseMoneyInput,
	type Transfer,
} from "@/lib/engine/money";
import { humanError } from "@/lib/errors";
import { formatDateRange, formatDayDate } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { CurrencyPicker } from "./CurrencyPicker";
import {
	createSettlement,
	deleteSettlement,
	type SettlementDto,
} from "./money.functions";
import { Num, Overline, paidDate } from "./money-ui";
import { usePrimaryMount } from "./single-mount";
import { MONEY_TESTID } from "./testids";
import {
	moneyKeys,
	useDisplayCurrency,
	useMoneyData,
	useMoneyUi,
	useMoneyView,
} from "./use-money";

export function SettleUpDialog() {
	const primary = usePrimaryMount("settle-up");
	return primary ? <SettleUpDialogInner /> : null;
}

function SettleUpDialogInner() {
	const open = useMoneyUi((s) => s.settleOpen);
	const setOpen = useMoneyUi((s) => s.openSettle);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				className="sm:max-w-[480px]"
				data-testid={MONEY_TESTID.settleUpDialog}
			>
				<DialogHeader>
					<DialogTitle>Settle up</DialogTitle>
					<DialogDescription>
						The fewest payments that square the whole trip.
					</DialogDescription>
				</DialogHeader>
				{open ? <SettleUpBody /> : null}
			</DialogContent>
		</Dialog>
	);
}

function SettleUpBody() {
	const view = useMoneyView();
	const { data } = useMoneyData();
	const d = useDisplayCurrency();
	const { graph } = useWorkspace();
	const [recording, setRecording] = useState<number | null>(null);
	if (!view || !data)
		return <p className="text-sm text-muted-foreground">Loading…</p>;
	const name = (id: string) =>
		resolveMember(graph.members, id)?.name ?? "Former member";
	const recent = [...data.settlements].reverse();
	return (
		<div className="grid gap-4">
			{view.transfers.length === 0 ? (
				<p className="font-display text-[17px] leading-6 font-medium">
					Everyone is square.
				</p>
			) : (
				<ul className="grid gap-2">
					{view.transfers.map((t, i) => (
						<li
							key={`${t.from}-${t.to}`}
							data-testid={MONEY_TESTID.transferRow}
							className="rounded-lg border px-3 py-2"
						>
							<div className="flex items-center gap-2 text-sm">
								<span className="flex min-w-0 flex-1 items-center gap-1.5">
									<PersonAvatar memberId={t.from} size={20} />
									<span className="truncate">{name(t.from)}</span>
									<ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
									<PersonAvatar memberId={t.to} size={20} />
									<span className="truncate">{name(t.to)}</span>
								</span>
								<span className="shrink-0 text-right">
									<Num className="font-medium">
										{formatMoney(t.amountMinor, d.home)}
									</Num>
									{d.converted ? (
										<Num className="block text-xs text-muted-foreground">
											{d.fmt(t.amountMinor)}
										</Num>
									) : null}
								</span>
								{recording === i ? null : (
									<EditGuard>
										<Button
											size="xs"
											variant="outline"
											className="shrink-0"
											data-testid={MONEY_TESTID.transferRecord}
											onClick={() => setRecording(i)}
										>
											Mark paid
										</Button>
									</EditGuard>
								)}
							</div>
							{recording === i ? (
								<RecordForm
									transfer={t}
									home={d.home}
									onDone={() => setRecording(null)}
								/>
							) : null}
						</li>
					))}
				</ul>
			)}
			{recent.length ? (
				<div>
					<Overline>Recorded</Overline>
					<ul className="grid">
						{recent.slice(0, 12).map((s) => (
							<SettlementLine key={s.id} id={s.id} />
						))}
					</ul>
				</div>
			) : null}
			{data.ratesAsOf ? (
				<p className="text-xs text-muted-foreground">
					Amounts in {d.home}. Rates: currency-api (daily), as of{" "}
					{formatDateRange(data.ratesAsOf, data.ratesAsOf)}.
				</p>
			) : null}
		</div>
	);
}

function RecordForm({
	transfer,
	home,
	onDone,
}: {
	transfer: Transfer;
	home: string;
	onDone: () => void;
}) {
	const { graph, scope, ix, days } = useWorkspace();
	const d = useDisplayCurrency();
	const tripId = graph.trip.id;
	// ADDENDUM §6: optional context. From a place's view it's tagged there
	// ("settled in Kyoto"); from one day's view, on that day.
	const oneDay = days && days.from === days.to ? ix.dayOfDate(days.from) : null;
	const [tag, setTag] = useState<string>(
		scope ? `n:${scope.id}` : oneDay ? `d:${oneDay.id}` : "none",
	);
	const [currency, setCurrency] = useState(home);
	const [text, setText] = useState(minorToInput(transfer.amountMinor, home));
	const [method, setMethod] = useState("");
	const rate = d.rateTo(currency);
	const amount = parseMoneyInput(text, currency);
	const m = useTripMutation(
		(v: Parameters<typeof createSettlement>[0]["data"]) =>
			createSettlement({ data: v }),
		{
			keys: moneyKeys(tripId),
			onSuccess: () => {
				toast("Settlement recorded");
				onDone();
			},
		},
	);
	const changeCurrency = (c: string) => {
		setCurrency(c);
		const r = d.rateTo(c);
		if (r)
			setText(minorToInput(convertMinor(transfer.amountMinor, home, c, r), c));
	};
	const save = () => {
		if (amount === null || amount <= 0) return;
		m.mutate(
			{
				tripId,
				fromMemberId: transfer.from,
				toMemberId: transfer.to,
				amountMinor: amount,
				currency,
				settledAt: new Date().toISOString(),
				settledTz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
				...(method.trim() ? { method: method.trim() } : {}),
				...(tag.startsWith("n:")
					? { scope: { nodeId: tag.slice(2) } }
					: tag.startsWith("d:")
						? { scope: { dayId: tag.slice(2) } }
						: {}),
			},
			{ onError: (e) => toast.error(humanError(e)) },
		);
	};
	return (
		<form
			className="mt-2 grid gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			<div className="flex gap-2">
				<CurrencyPicker
					value={currency}
					onChange={changeCurrency}
					suggested={[home]}
				/>
				<Input
					aria-label="Amount"
					inputMode="decimal"
					className="font-mono tnum placeholder:font-sans"
					value={text}
					onChange={(e) => setText(e.target.value)}
				/>
			</div>
			<Input
				aria-label="How"
				placeholder="Cash, Venmo, bank…"
				value={method}
				maxLength={60}
				onChange={(e) => setMethod(e.target.value)}
			/>
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<Label htmlFor="settle-tag" className="shrink-0 text-xs font-normal">
					Context
				</Label>
				<Select value={tag} onValueChange={setTag}>
					<SelectTrigger
						id="settle-tag"
						size="sm"
						className="h-8 min-w-0 flex-1 text-xs"
						aria-label="Tag it to a place or a day"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem className="cursor-pointer" value="none">
							No tag
						</SelectItem>
						{scope ? (
							<SelectItem className="cursor-pointer" value={`n:${scope.id}`}>
								Settled in {scope.name}
							</SelectItem>
						) : null}
						{ix.days.map((day) => (
							<SelectItem
								className="cursor-pointer"
								key={day.id}
								value={`d:${day.id}`}
							>
								On Day {ix.dayNumber(day.id)} ·{" "}
								{formatDayDate(day.date, { weekday: false })}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{currency !== home && amount !== null && rate ? (
				<p className="text-xs text-muted-foreground">
					≈ {formatMoney(convertMinor(amount, currency, home, 1 / rate), home)}{" "}
					at today's rate; the settlement's own date sets the final rate.
				</p>
			) : null}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" size="sm" onClick={onDone}>
					Cancel
				</Button>
				<Button
					type="submit"
					size="sm"
					disabled={amount === null || amount <= 0 || m.isPending}
				>
					Record payment
				</Button>
			</div>
		</form>
	);
}

/** A settlement's context tag: "Kyoto" or "Day 6" (nothing once that place or day is gone). */
export function settlementTagLabel(
	ix: Pick<GraphIndex, "node" | "day" | "dayNumber">,
	scope: SettlementDto["scope"],
): string | null {
	if (!scope) return null;
	if ("nodeId" in scope) return ix.node(scope.nodeId)?.name ?? null;
	return ix.day(scope.dayId) ? `Day ${ix.dayNumber(scope.dayId)}` : null;
}

function SettlementLine({ id }: { id: string }) {
	const { data } = useMoneyData();
	const { graph, ix } = useWorkspace();
	const d = useDisplayCurrency();
	const guard = useEditGuard();
	const [confirm, setConfirm] = useState(false);
	const tripId = graph.trip.id;
	const del = useTripMutation(
		(v: { id: string }) => deleteSettlement({ data: v }),
		{
			keys: moneyKeys(tripId),
			onSuccess: () => toast("Settlement deleted"),
		},
	);
	const s = data?.settlements.find((x) => x.id === id);
	if (!s) return null;
	const tagLabel = settlementTagLabel(ix, s.scope);
	const name = (m: string) =>
		resolveMember(graph.members, m)?.name?.split(" ")[0] ?? "Former member";
	return (
		<li
			data-testid={MONEY_TESTID.settlementRow}
			className="flex items-center gap-2 border-t py-1.5 text-[13px]"
		>
			<span className="min-w-0 flex-1 truncate">
				{name(s.fromMemberId)} → {name(s.toMemberId)}
				<span className="text-muted-foreground">
					{" "}
					· {paidDate(s.settledAt, s.settledTz)}
					{s.method ? ` · ${s.method}` : ""}
					{tagLabel ? (
						<span data-testid={MONEY_TESTID.settlementTag}> · {tagLabel}</span>
					) : null}
				</span>
			</span>
			<Num>{formatMoney(s.amountMinor, s.currency)}</Num>
			{s.currency !== d.home && s.homeAmountMinor !== null ? (
				<Num className="text-xs text-muted-foreground">
					≈ {formatMoney(s.homeAmountMinor, d.home)}
				</Num>
			) : null}
			{guard.disabled ? null : confirm ? (
				<Button
					size="xs"
					variant="destructive"
					onClick={() =>
						del.mutate({ id }, { onError: (e) => toast.error(humanError(e)) })
					}
				>
					Delete
				</Button>
			) : (
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label="Delete settlement"
					onClick={() => setConfirm(true)}
				>
					<Trash2 />
				</Button>
			)}
		</li>
	);
}
