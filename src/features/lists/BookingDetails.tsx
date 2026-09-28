/**
 * A booking's details (One Yonder D12), beside the Bookings list when wide
 * and under its row on a phone: what it is for (the stop or leg, its time
 * and day), when booking opens (and the rule it follows), the reminders,
 * the confirmation, the booking reference, the expense, and Edit · Mark
 * booked · Open the site. A booked stop shows what it is for, its
 * confirmation and its expense.
 */

import {
	CalendarCheck,
	ExternalLink,
	Pencil,
	Undo2,
	Wallet,
	X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { MarkdownText } from "@/components/common/markdown-text";
import { resolveMember } from "@/components/common/person-avatar";
import { Chip, Section } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMoneyData } from "@/features/money/use-money";
import { can, seesMoney } from "@/lib/auth/roles";
import { dueCtxOf, effectiveDue } from "@/lib/engine/due";
import { formatMoney } from "@/lib/engine/money";
import { BOOKING_LEADS } from "@/lib/push/reminders";
import { isRedactedRef } from "@/lib/schemas/legs";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { BookingConfirmation } from "./BookingConfirmation";
import {
	type BookingEntry,
	bookingCategory,
	bookingFor,
	dayBits,
	movesWith,
	nightsAt,
	opensIn,
	opensLabel,
	ruleLabel,
} from "./bookings-model";
import { DueEditor } from "./DueEditor";
import { plainOf } from "./format";
import { itemName, legSelTarget } from "./list-model";
import { LISTS_TESTID } from "./testids";
import { useBookingActions } from "./use-booking-actions";
import { useListActions } from "./use-list-actions";
import { useNow } from "./use-now";

/** "1 day before · 15 min before" (the push reminders a booking window gets). */
export const REMINDERS_LABEL = BOOKING_LEADS.map((l) =>
	l.ms >= 86_400_000
		? `${l.ms / 86_400_000} day${l.ms === 86_400_000 ? "" : "s"} before`
		: `${l.ms / 60_000} min before`,
).join(" · ");

export function BookingDetails({
	entry,
	canEdit,
	onClose,
}: {
	entry: BookingEntry;
	/** The edit guard allows writes (live, not view-only). */
	canEdit: boolean;
	onClose: () => void;
}) {
	const ws = useWorkspace();
	const { ix, schedule, graph } = ws;
	const actions = useListActions();
	const booking = useBookingActions();
	const openAddExpense = useUi((s) => s.openAddExpense);
	const money = useMoneyData();
	const now = useNow();
	const dueCtx = useMemo(() => dueCtxOf(ix, schedule), [ix, schedule]);
	const f = bookingFor(ix, schedule, entry);
	const row = entry.kind === "todo" ? entry.row : null;
	const title =
		entry.kind === "todo"
			? plainOf(entry.row.text)
			: itemName(ix, entry.item.id);
	const due = row ? effectiveDue(row, dueCtx) : null;
	const booked = !row || row.status === "done";
	const [editing, setEditing] = useState(false);
	const [dueOpen, setDueOpen] = useState(false);
	// A new selection starts out of Edit.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset per booking.
	useEffect(() => setEditing(false), [entry.id]);

	const assignees = (
		entry.kind === "todo" ? entry.row.assigneeIds : entry.item.assigneeIds
	)
		.map((id) => resolveMember(graph.members, id)?.name)
		.filter((n): n is string => !!n);
	const who = assignees.length
		? ` · assigned to ${assignees.slice(0, -1).join(", ")}${assignees.length > 1 ? " and " : ""}${assignees.at(-1)}`
		: "";

	// The linked expense (a to-do's "Add expense", or one on the booked stop).
	const moneyOn = seesMoney(graph.me) && can(graph.me, "manageExpenses");
	const expense = moneyOn
		? money.data?.expenses.find((e) =>
				row
					? e.listItemId === row.id
					: e.target.kind === "item" && e.target.itemId === entry.id,
			)
		: undefined;
	const others = (expense?.shares ?? [])
		.map((s) => s.memberId)
		.filter((id) => id !== ws.access.memberId)
		.map((id) => resolveMember(graph.members, id)?.name)
		.filter((n): n is string => !!n);

	const goFor = () => {
		if (!f) return;
		if (f.target.kind === "item")
			ws.nav.select({ kind: "item", id: f.target.itemId });
		else if (f.target.kind === "leg") {
			const t = legSelTarget(ix, f.target.legId);
			if (t) ws.nav.select({ kind: "leg", target: t });
		}
	};

	return (
		<article
			data-testid={LISTS_TESTID.bookingDetails}
			data-id={entry.id}
			aria-label={title}
			className="flex flex-col"
		>
			<header className="flex items-start gap-2 pb-3">
				<div className="min-w-0 flex-1">
					<h3 className="text-lg leading-6 font-semibold">
						{row ? <MarkdownText md={row.text} inline /> : title}
					</h3>
					<p className="text-meta text-muted-foreground">
						{row ? "Booking" : "Booked for this date"}
						{who}
					</p>
				</div>
				<Button
					variant="ghost"
					size="icon-sm"
					data-testid={LISTS_TESTID.bookingClose}
					aria-label="Close"
					onClick={onClose}
				>
					<X />
				</Button>
			</header>

			{editing && row ? (
				<EditForm
					key={row.id}
					text={row.text}
					url={row.url}
					onCancel={() => setEditing(false)}
					onSave={(p) => {
						actions.update(row.id, p);
						setEditing(false);
					}}
				/>
			) : null}

			<Section title="For" testId={LISTS_TESTID.bookingFor}>
				{f ? (
					<div className="flex flex-col gap-0.5 text-body">
						<button
							type="button"
							onClick={goFor}
							className="self-start text-left font-medium hover:underline hover:underline-offset-2"
						>
							{f.name}
						</button>
						<Line
							bits={[
								f.kind === "leg" ? f.when : null,
								...dayBits(ix, f.dayId),
								f.kind === "item" && f.when ? f.when : null,
								entry.kind === "stop"
									? nightsLabel(nightsAt(ix, entry.item))
									: null,
							]}
						/>
						{f.extra ? <Line bits={[f.extra]} /> : null}
					</div>
				) : (
					<p className="text-meta text-muted-foreground">
						Not linked to a stop yet.
					</p>
				)}
			</Section>

			{row ? (
				<Section
					title="Opens"
					testId={LISTS_TESTID.bookingOpens}
					action={
						canEdit ? (
							<DueEditor
								row={row}
								open={dueOpen}
								onOpenChange={setDueOpen}
								onSave={(p) => actions.update(row.id, p)}
							>
								<Button
									size="xs"
									variant="ghost"
									onClick={() => setDueOpen(true)}
								>
									{due ? "Change" : "Set when it opens"}
								</Button>
							</DueEditor>
						) : undefined
					}
				>
					{due ? (
						<div className="flex flex-col gap-1 text-body">
							<div className="flex flex-wrap items-center gap-2">
								<span className="tnum">{opensLabel(due)}</span>
								{row.status === "open" ? (
									<Chip size="sm">{opensIn(due, now)}</Chip>
								) : null}
							</div>
							{row.dueRule ? (
								<Line
									bits={[
										ruleLabel(row.dueRule),
										`moves with ${movesWith(ix, f, row.dueRule)} if the day changes`,
									]}
								/>
							) : null}
							{row.status === "open" ? (
								<p
									data-testid={LISTS_TESTID.bookingReminders}
									className="text-meta text-muted-foreground"
								>
									Reminders {REMINDERS_LABEL}
								</p>
							) : null}
						</div>
					) : (
						<p className="text-meta text-muted-foreground">
							{row.dueRule ? "Its stop isn't on a day yet." : "No date yet."}
						</p>
					)}
				</Section>
			) : null}

			<Section title="Confirmation">
				{f ? (
					<BookingConfirmation target={f.target} label={f.name} />
				) : (
					<p className="text-meta text-muted-foreground">
						Once it's linked to a stop, its confirmation goes here.
					</p>
				)}
			</Section>

			{row ? (
				<Section title="Booking reference">
					<RefField
						key={`${row.id}:${row.bookingRef ?? ""}`}
						value={row.bookingRef ?? null}
						disabled={!canEdit || isRedactedRef(row.bookingRef)}
						onSave={(bookingRef) => actions.update(row.id, { bookingRef })}
					/>
				</Section>
			) : null}

			{moneyOn ? (
				<Section title="Expense" testId={LISTS_TESTID.bookingExpense}>
					{expense ? (
						<button
							type="button"
							onClick={() => openAddExpense({ expenseId: expense.id })}
							className="self-start text-left text-body tnum hover:underline hover:underline-offset-2"
						>
							{expense.amountMinor != null && expense.currency
								? formatMoney(expense.amountMinor, expense.currency)
								: expense.title}
							{others.length ? (
								<span className="text-muted-foreground">
									{" "}
									· split with {others.join(" and ")}
								</span>
							) : null}
						</button>
					) : ws.mode === "live" && canEdit ? (
						<Button
							size="sm"
							variant="outline"
							className="self-start"
							onClick={() =>
								openAddExpense({
									target: f?.target ?? row?.target ?? { kind: "trip" },
									title: title.slice(0, 120),
									category: bookingCategory(ix, f),
									...(row ? { listItemId: row.id } : {}),
									isPrivate: row?.isPrivate,
								})
							}
						>
							<Wallet /> Add expense
						</Button>
					) : (
						<p className="text-meta text-muted-foreground">No expense yet.</p>
					)}
				</Section>
			) : null}

			{row && (canEdit || row.url) ? (
				<div className="flex flex-wrap gap-2 border-t pt-4">
					{canEdit ? (
						<Button
							size="sm"
							variant="outline"
							data-testid={LISTS_TESTID.bookingEdit}
							aria-pressed={editing}
							onClick={() => setEditing((v) => !v)}
						>
							<Pencil /> Edit
						</Button>
					) : null}
					{canEdit ? (
						booked ? (
							<Button
								size="sm"
								variant="outline"
								data-testid={LISTS_TESTID.bookingMarkBooked}
								onClick={() => booking.notBooked(entry)}
							>
								<Undo2 /> Not booked yet
							</Button>
						) : (
							<Button
								size="sm"
								data-testid={LISTS_TESTID.bookingMarkBooked}
								onClick={() => booking.markBooked(entry, f)}
							>
								<CalendarCheck /> Mark booked
							</Button>
						)
					) : null}
					{row.url ? (
						<Button asChild size="sm" variant="outline">
							<a
								href={row.url}
								target="_blank"
								rel="noopener noreferrer"
								data-testid={LISTS_TESTID.bookingSite}
							>
								<ExternalLink /> Open the site
							</a>
						</Button>
					) : null}
				</div>
			) : null}
		</article>
	);
}

function nightsLabel(n: number): string | null {
	return n ? `${n} night${n === 1 ? "" : "s"}` : null;
}

/** One muted line of facts joined by " · ". */
function Line({ bits }: { bits: (string | null | undefined)[] }) {
	const shown = bits.filter((b): b is string => !!b);
	if (!shown.length) return null;
	return (
		<p className="text-meta text-muted-foreground tnum">{shown.join(" · ")}</p>
	);
}

/** The booking reference: saves on Enter or when it loses the focus. */
function RefField({
	value,
	disabled,
	onSave,
}: {
	value: string | null;
	disabled: boolean;
	onSave: (v: string | null) => void;
}) {
	const [draft, setDraft] = useState(value ?? "");
	const save = () => {
		const v = draft.trim() || null;
		if (v !== (value ?? null)) onSave(v);
	};
	return (
		<Input
			data-testid={LISTS_TESTID.bookingRef}
			aria-label="Booking reference"
			placeholder={disabled ? "None yet" : "Add the booking reference"}
			value={draft}
			maxLength={60}
			disabled={disabled}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={save}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") setDraft(value ?? "");
			}}
			className="max-w-64 tnum"
		/>
	);
}

/** Edit: the text and the booking site (when it opens is under Opens). */
function EditForm({
	text,
	url,
	onSave,
	onCancel,
}: {
	text: string;
	url: string | null;
	onSave: (p: { text?: string; url?: string | null }) => void;
	onCancel: () => void;
}) {
	const [t, setT] = useState(text);
	const [u, setU] = useState(url ?? "");
	const cleanUrl = u.trim();
	const badUrl = !!cleanUrl && !/^https?:\/\/\S+$/i.test(cleanUrl);
	return (
		<form
			className="flex flex-col gap-2 border-t py-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (!t.trim() || badUrl) return;
				onSave({
					...(t.trim() !== text ? { text: t.trim() } : {}),
					...((cleanUrl || null) !== url ? { url: cleanUrl || null } : {}),
				});
			}}
		>
			<Field label="What to book">
				<Input value={t} onChange={(e) => setT(e.target.value)} autoFocus />
			</Field>
			<Field label="Booking site">
				<Input
					value={u}
					type="url"
					inputMode="url"
					placeholder="https://"
					aria-invalid={badUrl || undefined}
					onChange={(e) => setU(e.target.value)}
				/>
			</Field>
			<div className="flex justify-end gap-2">
				<Button type="button" size="sm" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" size="sm" disabled={!t.trim() || badUrl}>
					Save
				</Button>
			</div>
		</form>
	);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is the child.
		<label className="flex flex-col gap-1 text-meta text-muted-foreground">
			{label}
			{children}
		</label>
	);
}
