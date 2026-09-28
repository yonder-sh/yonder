/**
 * The Bookings tab (One Yonder D12): the to-dos whose date says when booking
 * opens, and the stops already booked for their date, over the scope —
 * Opening soon · Later · Booked · No date yet. A row reads when it opens,
 * the rule it follows and its day ("Opens Mon 12 Oct 2026 · 09:00 JST · 355
 * days before · Day 1", "Opens in 15 days"); a booked one its confirmation,
 * nights and day. Selecting one opens its details beside the list when wide,
 * under its row on a phone. "Add a booking…" adds a to-do that opens.
 */

import { CalendarCheck } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { EmptyState } from "@/components/common/empty-state";
import { Chip, type ChipTone } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTripMedia } from "@/features/media/queries";
import { MentionInput } from "@/features/notes/MentionInput";
import {
	type DueCtx,
	dueCtxOf,
	dueState,
	effectiveDue,
} from "@/lib/engine/due";
import type { GraphItem } from "@/lib/engine/types";
import type { BundleTarget } from "@/lib/schemas/targets";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { hasConfirmation } from "./BookingConfirmation";
import { BookingDetails } from "./BookingDetails";
import {
	type BookingEntry,
	bookingDayId,
	bookingFor,
	bookingGroups,
	dayBits,
	isBookedStop,
	nightsAt,
	opensIn,
	opensLabel,
	ruleLabel,
} from "./bookings-model";
import { plainOf } from "./format";
import { PersonFilter } from "./ListBoard";
import {
	isBookingTodo,
	itemName,
	rollupRows,
	type ScopeOptions,
} from "./list-model";
import type { ListItemDto } from "./lists.functions";
import { isGhost } from "./queries";
import { RowCheckbox } from "./RowCheckbox";
import { LISTS_TESTID } from "./testids";
import { useBookingActions } from "./use-booking-actions";
import { useListActions } from "./use-list-actions";
import { useNow } from "./use-now";

export function BookingsBoard({
	items,
	scope,
	addTarget,
	who,
	setWho,
	where,
	loading,
	headerStart,
	beside,
	focusAdd = 0,
}: {
	items: readonly ListItemDto[];
	scope: ScopeOptions;
	addTarget: BundleTarget;
	who: string | null;
	setWho: (memberId: string | null) => void;
	where: string;
	loading?: boolean;
	headerStart?: ReactNode;
	/** Wide: the details sit beside the list (else under the selected row). */
	beside: boolean;
	/** A new value focuses the add row ("Add a booking" in the page header). */
	focusAdd?: number;
}) {
	const ws = useWorkspace();
	const { ix, schedule, graph } = ws;
	const editGuard = useEditGuard();
	// The fixture preview has no server: everything reads, nothing writes.
	const canEdit = ws.mode === "live" && !editGuard.disabled;
	const reason = ws.mode === "live" ? editGuard.reason : "Preview only";
	const actions = useListActions();
	const booking = useBookingActions();
	const now = useNow();
	const media = useTripMedia().data;
	const dueCtx = useMemo(() => dueCtxOf(ix, schedule), [ix, schedule]);

	// Booking to-dos and booked stops in view (the rollup decides, like every list).
	const todos = useMemo(() => {
		const out: ListItemDto[] = [];
		const seen = new Set<string>();
		for (const g of rollupRows(ix, items.filter(isBookingTodo), scope))
			for (const s of g.subs)
				for (const r of s.rows)
					if (!seen.has(r.id) && (!who || r.assigneeIds.includes(who))) {
						seen.add(r.id);
						out.push(r);
					}
		return out;
	}, [ix, items, scope, who]);
	const stops = useMemo(() => {
		const booked = graph.items.filter(isBookedStop).map((item) => ({
			id: item.id,
			target: { kind: "item", itemId: item.id } as BundleTarget,
			item,
		}));
		const out = new Map<string, GraphItem>();
		for (const g of rollupRows(ix, booked, scope))
			for (const s of g.subs)
				for (const r of s.rows)
					if (!who || r.item.assigneeIds.includes(who)) out.set(r.id, r.item);
		return [...out.values()];
	}, [ix, graph.items, scope, who]);
	const groups = useMemo(
		() => bookingGroups(ix, todos, stops, { dueCtx, now }),
		[ix, todos, stops, dueCtx, now],
	);

	// "Confirmation attached": a PDF on the stop or leg a booking is for.
	const confirmed = useMemo(() => {
		const out = new Set<string>();
		for (const g of groups)
			for (const e of g.entries) {
				const f = bookingFor(ix, schedule, e);
				if (f && hasConfirmation(media, f.target)) out.add(e.id);
			}
		return out;
	}, [groups, ix, schedule, media]);

	// A suggested booking (a ghost) reads only until it's accepted.
	const editable = (e: BookingEntry) =>
		canEdit && !(e.kind === "todo" && isGhost(e.row));
	const [selId, setSelId] = useState<string | null>(null);
	const selected =
		groups.flatMap((g) => g.entries).find((e) => e.id === selId) ?? null;
	const details = selected ? (
		<BookingDetails
			entry={selected}
			canEdit={editable(selected)}
			onClose={() => setSelId(null)}
		/>
	) : null;

	const [addFocus, setAddFocus] = useState(focusAdd);
	useEffect(() => setAddFocus(focusAdd), [focusAdd]);
	const [text, setText] = useState("");
	const add = (value: string) => {
		const v = value.trim();
		if (!v || !canEdit) return;
		const id = actions.create(
			{ target: addTarget, list: "todo", text: v, dueKind: "opens" },
			{ onError: () => setText((cur) => cur || v) },
		);
		setText("");
		// Its details open, to say when it opens and what it is for.
		setSelId(id);
	};

	const empty = !loading && groups.length === 0;

	return (
		<section
			data-testid={LISTS_TESTID.bookings}
			aria-label="Bookings"
			className="@container flex min-w-0 flex-col"
		>
			<div className="flex flex-wrap items-center gap-2 px-4 py-2">
				{headerStart}
				<div className="ml-auto flex items-center gap-1.5">
					<PersonFilter who={who} setWho={setWho} />
				</div>
			</div>
			<div
				data-testid={LISTS_TESTID.bookingAdd}
				className="flex items-center gap-2 px-4 pb-2"
				title={canEdit ? undefined : (reason ?? undefined)}
			>
				<MentionInput
					key={addFocus}
					value={text}
					onChange={setText}
					onSubmit={add}
					placeholder={canEdit ? "Add a booking…" : (reason ?? "View only")}
					ariaLabel="Add a booking"
					disabled={!canEdit}
					autoFocus={addFocus > 0}
					className="h-8 flex-1"
				/>
			</div>

			{loading && groups.length === 0 ? (
				<div aria-hidden className="flex flex-col gap-3 px-4 py-3">
					{[0, 1, 2].map((i) => (
						<Skeleton
							key={i}
							className="h-4"
							style={{ maxWidth: `${70 - i * 12}%` }}
						/>
					))}
				</div>
			) : null}
			{empty ? (
				<EmptyState
					className="py-8"
					line={
						who
							? "Nothing here with these filters."
							: `No bookings for ${where} yet.`
					}
					action={
						who ? (
							<Button size="sm" variant="outline" onClick={() => setWho(null)}>
								Show everything
							</Button>
						) : canEdit ? (
							<Button size="sm" onClick={() => setAddFocus((t) => t + 1)}>
								Add a booking
							</Button>
						) : undefined
					}
				/>
			) : null}

			<div
				className={cn(
					beside &&
						selected &&
						"grid grid-cols-[minmax(0,1fr)_minmax(0,24rem)] items-start",
				)}
			>
				<div className="flex min-w-0 flex-col">
					{groups.map((g) => (
						<div
							key={g.key}
							data-testid={LISTS_TESTID.group}
							data-group={`book:${g.key}`}
						>
							<div
								data-testid={LISTS_TESTID.groupHead}
								className="sticky top-0 z-20 flex h-8 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur"
							>
								<span className="truncate text-xs font-medium">{g.title}</span>
								<span className="text-xs text-muted-foreground tnum">
									{g.entries.length}
								</span>
							</div>
							<ul className="flex flex-col">
								{g.entries.map((e) => (
									<BookingRow
										key={e.id}
										entry={e}
										group={g.key}
										now={now}
										dueCtx={dueCtx}
										confirmed={confirmed.has(e.id)}
										selected={e.id === selId}
										canEdit={editable(e)}
										onSelect={() => setSelId(e.id === selId ? null : e.id)}
										onToggle={() =>
											e.kind === "todo" && e.row.status === "done"
												? booking.notBooked(e)
												: booking.markBooked(e, bookingFor(ix, schedule, e))
										}
									>
										{beside ? null : details}
									</BookingRow>
								))}
							</ul>
						</div>
					))}
				</div>
				{beside && details ? (
					<aside className="sticky top-0 border-l px-5 py-3">{details}</aside>
				) : null}
			</div>
		</section>
	);
}

function BookingRow({
	entry,
	group,
	now,
	dueCtx,
	confirmed,
	selected,
	canEdit,
	onSelect,
	onToggle,
	children,
}: {
	entry: BookingEntry;
	group: string;
	now: number;
	dueCtx: DueCtx;
	/** A PDF is on the stop or leg it is for. */
	confirmed: boolean;
	selected: boolean;
	canEdit: boolean;
	onSelect: () => void;
	onToggle: () => void;
	/** The details, under the row when it is selected on a phone. */
	children?: ReactNode;
}) {
	const { ix } = useWorkspace();
	const row = entry.kind === "todo" ? entry.row : null;
	const ghost = !!row && isGhost(row);
	const label =
		entry.kind === "todo"
			? plainOf(entry.row.text)
			: itemName(ix, entry.item.id);
	const booked = !row || row.status === "done";
	const due = row ? effectiveDue(row, dueCtx) : null;
	const dayId = bookingDayId(ix, entry);
	const day = dayBits(ix, dayId);
	const meta = booked
		? [
				confirmed ? "Confirmation attached" : null,
				entry.kind === "stop" ? nights(nightsAt(ix, entry.item)) : null,
				...day,
			]
		: [
				due ? opensLabel(due) : null,
				row?.dueRule ? ruleLabel(row.dueRule) : null,
				day.at(-1) ?? null,
			];
	const state = due && !booked ? dueState(due, now, "open") : null;
	const chip: { text: string; tone: ChipTone } | null = booked
		? { text: "Booked", tone: "good" }
		: due
			? {
					text: opensIn(due, now),
					tone:
						state === "open_now"
							? "now"
							: state === "overdue"
								? "warn"
								: state === "today" || state === "soon"
									? "accent"
									: "neutral",
				}
			: null;
	return (
		<li
			data-testid={LISTS_TESTID.bookingRow}
			data-id={entry.id}
			data-kind={entry.kind}
			data-group={group}
			data-selected={selected ? "" : undefined}
			data-ghost={ghost ? "" : undefined}
			aria-label={label}
		>
			<div
				className={cn(
					"flex min-h-11 items-start gap-3 px-4 py-1.5 text-sm md:min-h-9",
					selected ? "bg-accent" : "hover:bg-accent/40",
					ghost && "opacity-80",
				)}
			>
				{row ? (
					<RowCheckbox
						data-testid={LISTS_TESTID.bookingCheck}
						checked={row.status === "done"}
						disabled={!canEdit}
						onCheckedChange={onToggle}
						aria-label={`Booked: ${label}`}
					/>
				) : (
					<CalendarCheck
						aria-hidden
						strokeWidth={1.5}
						className="mt-0.5 size-4 shrink-0 text-good"
					/>
				)}
				<button
					type="button"
					data-testid={LISTS_TESTID.bookingOpen}
					aria-expanded={selected}
					onClick={onSelect}
					className="min-w-0 flex-1 text-left"
				>
					<span
						className={cn(
							"block leading-5",
							row?.status === "done" && "text-muted-foreground",
						)}
					>
						{label}
					</span>
					{meta.some(Boolean) ? (
						<span className="block truncate text-xs leading-4 text-muted-foreground tnum">
							{meta.filter(Boolean).join(" · ")}
						</span>
					) : null}
				</button>
				{chip ? (
					<Chip
						size="sm"
						tone={chip.tone}
						data-testid={LISTS_TESTID.bookingChip}
						className="mt-0.5"
					>
						{chip.text}
					</Chip>
				) : null}
			</div>
			{selected && children ? (
				<div className="border-y bg-background px-4 py-3">{children}</div>
			) : null}
		</li>
	);
}

function nights(n: number): string | null {
	return n ? `${n} night${n === 1 ? "" : "s"}` : null;
}
