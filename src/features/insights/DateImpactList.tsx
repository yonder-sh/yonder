/**
 * E2 the impact sections (EXTENSIONS §5): Needs rebooking, Timed — check
 * (muted: nothing conflicts yet; each item has Mark booked), New closures
 * (amber: a real conflict) / Resolved, Stays to change, Deadlines and
 * Holidays, each with a count; empty sections are left out. A row selects
 * its entity (`onSelect` closes the dialog but keeps the draft). Used by
 * ShiftTripDialog, the dates dialog and `ProposalOverview` for `trip.*`.
 */
import { cn } from "cn";
import {
	BedDouble,
	CalendarDays,
	Check,
	Clock,
	ListTodo,
	Plane,
	Ticket,
	TrainFront,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { DateImpact } from "@/lib/engine/date-impact";
import { shortDate } from "@/lib/engine/hours";
import { TESTID } from "@/lib/testids";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import type { Sel } from "@/lib/workspace/search";
import { INSIGHTS_TESTID } from "./testids";

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** "3 Oct" (no weekday) for the compact from → to pairs. */
export function dayMonth(date: string): string {
	if (!date) return "Unscheduled";
	const [, m, d] = date.split("-");
	return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ""}`;
}

/** "5–6 Oct", "30 Sep – 2 Oct". */
function nights([a, b]: [string, string]): string {
	if (!a) return "—";
	if (a.slice(0, 7) === b.slice(0, 7))
		return `${Number(a.slice(8))}–${dayMonth(b)}`;
	return `${dayMonth(a)} – ${dayMonth(b)}`;
}

export function impactIsEmpty(i: DateImpact): boolean {
	return (
		!i.bookings.length &&
		!i.timed.length &&
		!i.closures.added.length &&
		!i.closures.resolved.length &&
		!i.stays.length &&
		!i.deadlines.length &&
		!i.holidays.length
	);
}

export function DateImpactList({
	impact,
	onSelect,
	onMarkBooked,
	markGuard,
}: {
	impact: DateImpact;
	/** Called after a row selected its entity (the dialog closes; the draft stays). */
	onSelect?: () => void;
	/** "Mark booked" on a Timed — check item. Without it the button isn't shown. */
	onMarkBooked?: (itemId: string) => void;
	markGuard?: { disabled: boolean; reason: string | null };
}) {
	const ws = useWorkspaceOptional();
	const select = (sel: Sel | null) => {
		if (!ws || !sel) return;
		ws.nav.select(sel);
		onSelect?.();
	};
	const legSel = (legId: string): Sel | null => {
		const leg = ws?.ix.leg(legId);
		if (!leg?.fromItemId || !leg.toItemId) return null;
		return {
			kind: "leg",
			target: {
				kind: "pair",
				fromItemId: leg.fromItemId,
				toItemId: leg.toItemId,
			},
		};
	};
	const itemName = (id: string) => {
		const item = ws?.ix.item(id);
		return item?.title ?? ws?.ix.node(item?.nodeId)?.name ?? "A stop";
	};

	if (impactIsEmpty(impact))
		return (
			<div
				data-testid={TESTID.dateImpactList}
				data-empty
				className="px-1 py-2 text-[13px] text-muted-foreground"
			>
				Nothing booked or timed moves, and no place is closed on its new day.
			</div>
		);

	return (
		<div data-testid={TESTID.dateImpactList} className="grid gap-5">
			{impact.bookings.length ? (
				<Section
					id="bookings"
					title="Needs rebooking"
					count={impact.bookings.length}
				>
					{impact.bookings.map((b) => (
						<Row
							key={`${b.kind}:${b.id}`}
							glyph={
								b.kind === "flight"
									? Plane
									: b.kind === "transit"
										? TrainFront
										: Ticket
							}
							label={b.label}
							meta={
								<>
									{dayMonth(b.from)} → {dayMonth(b.to)}
									{b.ref ? (
										<span className="ml-2 text-muted-foreground max-sm:hidden">
											ref <span className="font-mono">{b.ref}</span>
										</span>
									) : null}
								</>
							}
							onClick={() =>
								select(
									b.kind === "item" ? { kind: "item", id: b.id } : legSel(b.id),
								)
							}
						/>
					))}
				</Section>
			) : null}
			{impact.timed.length ? (
				<Section
					id="timed"
					title="Timed — check"
					count={impact.timed.length}
					hint="Pinned to a time but not marked booked."
				>
					{impact.timed.map((t) => (
						<Row
							key={`${t.kind}:${t.id}`}
							muted
							glyph={t.kind === "flight" ? Plane : Clock}
							label={t.label}
							meta={
								<>
									{dayMonth(t.from)} → {dayMonth(t.to)}
									{t.reason === "flight_no_ref" ? (
										<span className="ml-2 text-muted-foreground max-sm:hidden">
											no booking ref
										</span>
									) : null}
								</>
							}
							onClick={() =>
								select(
									t.kind === "item" ? { kind: "item", id: t.id } : legSel(t.id),
								)
							}
							action={
								t.kind === "item" && onMarkBooked ? (
									<Button
										variant="ghost"
										size="sm"
										data-testid={INSIGHTS_TESTID.markBooked}
										disabled={markGuard?.disabled}
										title={markGuard?.reason ?? undefined}
										onClick={(e) => {
											e.stopPropagation();
											onMarkBooked(t.id);
										}}
										className="h-7 shrink-0 px-2 text-xs"
									>
										Mark booked
									</Button>
								) : null
							}
						/>
					))}
				</Section>
			) : null}
			{impact.closures.added.length || impact.closures.resolved.length ? (
				<Section
					id="closures"
					title={impact.closures.added.length ? "New closures" : "Closures"}
					count={impact.closures.added.length}
				>
					{impact.closures.added.map((c) => (
						<Row
							key={`add:${c.itemId}:${c.issue.kind}`}
							warn
							glyph={Clock}
							label={itemName(c.itemId)}
							meta={
								<>
									<span className="font-sans font-medium text-warning">
										{c.issue.label}
									</span>
									<span className="ml-2">
										{c.date ? shortDate(c.date) : ""}
									</span>
								</>
							}
							onClick={() => select({ kind: "item", id: c.itemId })}
						/>
					))}
					{impact.closures.resolved.map((c) => (
						<Row
							key={`res:${c.itemId}:${c.issue.kind}`}
							muted
							glyph={Check}
							label={itemName(c.itemId)}
							meta={
								<span className="font-sans">
									Resolved · was {c.issue.label.toLowerCase()}
								</span>
							}
							onClick={() => select({ kind: "item", id: c.itemId })}
						/>
					))}
				</Section>
			) : null}
			{impact.stays.length ? (
				<Section id="stays" title="Stays to change" count={impact.stays.length}>
					{impact.stays.map((s) => (
						<Row
							key={`${s.nodeId}:${s.from[0]}`}
							glyph={BedDouble}
							label={s.name}
							meta={
								<>
									{nights(s.from)} → {s.to[0] ? nights(s.to) : "no nights"}
								</>
							}
							onClick={() => select({ kind: "node", id: s.nodeId })}
						/>
					))}
				</Section>
			) : null}
			{impact.deadlines.length ? (
				<Section
					id="deadlines"
					title="Deadlines"
					count={impact.deadlines.length}
				>
					{impact.deadlines.map((d) => (
						<Row
							key={d.listItemId}
							glyph={ListTodo}
							label={d.text}
							meta={
								<>
									due {dayMonth(d.due)}
									<span className="ml-2 font-sans text-muted-foreground">
										{d.reason === "now_past"
											? "now in the past"
											: "now after the visit"}
									</span>
								</>
							}
						/>
					))}
				</Section>
			) : null}
			{impact.holidays.length ? (
				<Section
					id="holidays"
					title="Holidays"
					count={impact.holidays.length}
					hint="Hours may differ on these days."
				>
					{impact.holidays.map((h) => (
						<Row
							key={h.date}
							muted
							glyph={CalendarDays}
							label={h.name}
							meta={shortDate(h.date)}
						/>
					))}
				</Section>
			) : null}
		</div>
	);
}

function Section({
	id,
	title,
	count,
	hint,
	children,
}: {
	id: string;
	title: string;
	count: number;
	hint?: string;
	children: ReactNode;
}) {
	return (
		<section
			data-testid={INSIGHTS_TESTID.impactSection}
			data-section={id}
			className="grid gap-1"
		>
			<header className="flex items-baseline gap-2 px-1">
				<h3 className="text-[11px] leading-[14px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
					{title}
				</h3>
				{count ? (
					<span
						className="font-mono text-[11px] text-muted-foreground tnum"
						data-count={count}
					>
						{count}
					</span>
				) : null}
				{hint ? (
					<span className="ml-auto truncate text-[11px] text-muted-foreground/80">
						{hint}
					</span>
				) : null}
			</header>
			<ul className="grid">{children}</ul>
		</section>
	);
}

function Row({
	glyph: Glyph,
	label,
	meta,
	onClick,
	action,
	muted,
	warn,
}: {
	glyph: typeof Plane;
	label: string;
	meta: ReactNode;
	onClick?: () => void;
	action?: ReactNode;
	muted?: boolean;
	warn?: boolean;
}) {
	const body = (
		<>
			<Glyph
				className={cn(
					"size-3.5 shrink-0",
					warn ? "text-warning" : "text-muted-foreground",
				)}
				strokeWidth={1.75}
				aria-hidden
			/>
			<span
				className={cn(
					"min-w-0 flex-1 truncate",
					muted ? "text-muted-foreground" : "font-medium text-foreground",
				)}
			>
				{label}
			</span>
			<span className="shrink-0 text-[12px] text-foreground/80 tnum max-sm:max-w-[52%] max-sm:truncate">
				{meta}
			</span>
		</>
	);
	return (
		<li
			data-testid={INSIGHTS_TESTID.impactRow}
			className="flex items-center gap-1"
		>
			{onClick ? (
				<button
					type="button"
					onClick={onClick}
					className="flex min-h-9 min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 text-left text-[13px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
				>
					{body}
				</button>
			) : (
				<div className="flex min-h-9 min-w-0 flex-1 items-center gap-2.5 px-1 text-[13px]">
					{body}
				</div>
			)}
			{action}
		</li>
	);
}
