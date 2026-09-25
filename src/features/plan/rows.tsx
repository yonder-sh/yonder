import { ChevronDown, ChevronRight } from "lucide-react";
import { useContext, useState } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { CategoryDot, ModeGlyph, TypeGlyph } from "@/components/common/glyphs";
import { LegChips, LegSummary } from "@/components/common/leg-summary";
import { MemberAvatar, presenceColor } from "@/components/common/member";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { flightTimes } from "@/lib/engine/flights";
import { pairKey } from "@/lib/engine/graph-index";
import type { ProposalMark } from "@/lib/engine/proposals";
import { timedLegName } from "@/lib/engine/schedule";
import { localDateOf } from "@/lib/engine/time";
import type { Ghost, GraphLeg, Transition, Visit } from "@/lib/engine/types";
import {
	formatDateRange,
	formatDayDate,
	formatDuration,
	formatTime,
} from "@/lib/format";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useProposalMarks } from "@/lib/workspace/use-proposals";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { Rail, RowFrame } from "./LegRow";
import { PlanUiContext } from "./plan-context";
import { bandSummary, blockSpan } from "./plan-rows";
import { PLAN_TESTID } from "./testids";
import { itemName, usePlanActions } from "./use-plan-actions";

/** "45 min free": a hairline with a centred pill (24px; solid: dashes mean estimates, ADDENDUM §10). */
export function GapRow({ minutes }: { minutes: number }) {
	return (
		<RowFrame height="h-6" rail={null}>
			<span className="relative flex h-full flex-1 items-center justify-center">
				<span
					aria-hidden
					className="absolute inset-x-0 top-1/2 border-t border-border/70"
				/>
				<span
					data-testid={TESTID.freeTime}
					className="relative rounded-full border bg-card px-2 font-mono text-[11px] text-muted-foreground tnum"
				>
					{formatDuration(minutes)} free
				</span>
			</span>
		</RowFrame>
	);
}

/** "· 3 stops in Harajuku ·": out-of-scope items inside a day (click to show them). */
export function StretchFoldRow({
	itemIds,
	labelNodeId,
	open,
	onToggle,
}: {
	itemIds: readonly string[];
	labelNodeId: string | null;
	open: boolean;
	onToggle: () => void;
}) {
	const { ix } = useWorkspace();
	const n = itemIds.length;
	const where = labelNodeId
		? `in ${ix.node(labelNodeId)?.name ?? "elsewhere"}`
		: "elsewhere";
	return (
		<RowFrame height="h-6" rail={<Rail mode="quiet" />}>
			<button
				type="button"
				data-testid={PLAN_TESTID.fold}
				aria-expanded={open}
				onClick={onToggle}
				className="flex h-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
			>
				· {n} {n === 1 ? "stop" : "stops"} {where} ·
			</button>
		</RowFrame>
	);
}

/** A compact read-only line for a folded item that was opened. */
export function FoldedItemLine({ itemId }: { itemId: string }) {
	const { ix, schedule, nav } = useWorkspace();
	const item = ix.item(itemId);
	const s = schedule.items[itemId];
	if (!item) return null;
	return (
		<RowFrame
			height="h-7"
			rail={<Rail mode="quiet" />}
			onClick={() => nav.select({ kind: "item", id: itemId })}
			label={itemName(ix, item)}
		>
			<span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
				{s ? (
					<span className="font-mono tnum">{formatTime(s.start, s.tz)}</span>
				) : null}
				<span className="truncate">{itemName(ix, item)}</span>
			</span>
		</RowFrame>
	);
}

/** "3 days elsewhere ⋯", "2 days before ⋯" (28px, two hairlines). */
export function DaysFoldRow({
	dayIds,
	reason,
	open,
	onClick,
}: {
	dayIds: readonly string[];
	reason: "scope" | "before" | "after";
	open?: boolean;
	onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
	const { ix } = useWorkspace();
	const n = dayIds.length;
	const first = ix.day(dayIds[0])?.date;
	const last = ix.day(dayIds.at(-1))?.date;
	const word = n === 1 ? "day" : "days";
	const label =
		reason === "scope"
			? `${n} ${word} elsewhere`
			: reason === "before"
				? `${n} ${word} before`
				: `${n} ${word} after`;
	return (
		<button
			type="button"
			data-testid={PLAN_TESTID.fold}
			data-reason={reason}
			aria-expanded={open}
			title={
				reason === "scope"
					? undefined
					: "Show these days · Shift-click adds just the next one"
			}
			onClick={onClick}
			className="group flex h-7 w-full items-center gap-3 px-4 text-xs text-muted-foreground hover:text-foreground"
		>
			<span aria-hidden className="h-px flex-1 bg-border" />
			<span className="shrink-0">
				{label}{" "}
				<span className="font-mono tnum">
					{first ? `· ${formatDateRange(first, last)}` : ""}
				</span>{" "}
				{open ? "▴" : "⋯"}
			</span>
			<span aria-hidden className="h-px flex-1 bg-border" />
		</button>
	);
}

/**
 * "← from Osaka · 🚄 Shinkansen 2h15" / "→ to Kyoto · …" (28px, muted italic).
 * Click selects the boundary leg; double-click zooms out to the common parent.
 */
export function GhostRow({ ghost }: { ghost: Ghost }) {
	const { ix, schedule, nav, scope } = useWorkspace();
	const [from, to] = ghost.pairKey.split(">") as [string, string];
	const outside = ghost.outsideRepId ? ix.node(ghost.outsideRepId) : null;
	const outsideDay = ix.day(ix.item(ghost.outsideItemId)?.dayId)?.date;
	const s = schedule.legs[ghost.pairKey];
	const zoomOut = () => {
		if (!scope || !outside) return nav.zoomOut();
		const common = ix.hierarchy.commonAncestor(scope.id, outside.id);
		nav.zoomTo(common?.id ?? null);
	};
	return (
		<div
			data-testid={PLAN_TESTID.ghost}
			data-dir={ghost.dir}
			className="relative flex h-7 items-center"
		>
			<span className="relative w-[var(--plan-rail-col)] shrink-0 self-stretch">
				<Rail mode="quiet" />
			</span>
			<button
				type="button"
				onClick={() =>
					from && to
						? nav.select({
								kind: "leg",
								target: { kind: "pair", fromItemId: from, toItemId: to },
							})
						: undefined
				}
				onDoubleClick={zoomOut}
				title="Double-click to zoom out"
				className="flex min-w-0 flex-1 items-center gap-1.5 pr-3 text-left text-xs text-muted-foreground italic hover:text-foreground"
			>
				<span aria-hidden>{ghost.dir === "in" ? "←" : "→"}</span>
				<span className="truncate">
					{ghost.dir === "in" ? "from" : "to"}{" "}
					{ghost.reason === "days"
						? `${itemName(ix, ix.item(ghost.outsideItemId))}${outsideDay ? ` · ${formatDayDate(outsideDay)}` : ""}`
						: (outside?.name ?? "elsewhere")}
				</span>
				{ghost.leg?.mode ? (
					<>
						<span aria-hidden>·</span>
						<span className="opacity-50">
							<ModeGlyph mode={ghost.leg.mode} colored={false} />
						</span>
						<GhostLeg leg={ghost.leg} scheduled={s?.minutes ?? 0} />
					</>
				) : null}
			</button>
		</div>
	);
}

/**
 * A reserved ride's own time on board, departure to arrival: "SP3 7h55" for
 * 21:35 → 05:30⁺¹, "NH 9 14h". The schedule's minutes add the access time,
 * which contradicted the ticket just above the carry row ("SP3 8h05";
 * QA PLAN-R2-13).
 */
export function rideMinutes(leg: {
	depAt: string | null;
	arrAt: string | null;
}): number | null {
	const dep = leg.depAt ? Date.parse(leg.depAt) : Number.NaN;
	const arr = leg.arrAt ? Date.parse(leg.arrAt) : Number.NaN;
	if (!Number.isFinite(dep) || !Number.isFinite(arr) || arr < dep) return null;
	return Math.round((arr - dep) / 60_000);
}

/** The leg on a ghost row: a reserved ride's name and time on board, else the leg's minutes. */
function GhostLeg({ leg, scheduled }: { leg: GraphLeg; scheduled: number }) {
	const { ix } = useWorkspace();
	const timed = ix.isTimed(leg);
	const d = ix.legDetails(leg);
	const flight = d.kind === "flight" ? flightTimes(d.flight) : null;
	const minutes = flight
		? flight.minutes
		: timed
			? rideMinutes(leg)
			: scheduled;
	const duration =
		minutes !== null && minutes > 0
			? `${flight?.estimate ? "~" : ""}${formatDuration(minutes, { compact: true })}${flight?.estimate ? " est." : ""}`
			: "";
	return (
		<span className="truncate not-italic">
			{timed ? timedLegName(ix, leg) : ""}
			{timed && duration ? " " : ""}
			{/* A clear gap: "NH 9 14h" must never read as "NH914h" (QA PLAN-R2-13). */}
			{duration ? (
				<span className={timed ? "ml-1 font-mono tnum" : "font-mono tnum"}>
					{duration}
				</span>
			) : null}
		</span>
	);
}

/**
 * "Unlinked transit · Fuji Excursion 7 (Shinjuku → Kawaguchiko) · Relink ·
 * Discard" (28px, amber): a significant leg whose pair broke (§7.8).
 */
export function UnlinkedRow({
	legId,
	fromItemId,
	toItemId,
}: {
	legId: string;
	fromItemId: string;
	toItemId: string;
}) {
	const { ix } = useWorkspace();
	// Relink targets come from the server's order, never from neighbours that
	// only exist in the simulation of a suggestion (QA COLLAB-R2-01).
	const real = useContext(PlanUiContext).realIx ?? ix;
	const actions = usePlanActions();
	const guard = useEditGuard();
	const [confirm, setConfirm] = useState(false);
	const leg = ix.leg(legId);
	if (!leg) return null;
	const a = real.item(fromItemId);
	const b = real.item(toItemId);
	const next = a ? real.nextLocated(a.id) : null;
	const prev = b ? real.prevLocated(b.id) : null;
	const candidates = [
		next && a && next.nodeId !== a.nodeId ? { from: a.id, to: next.id } : null,
		prev && b && prev.nodeId !== b.nodeId && prev.id !== a?.id
			? { from: prev.id, to: b.id }
			: null,
	].filter((c): c is { from: string; to: string } => c !== null);
	return (
		<div
			data-testid={PLAN_TESTID.unlinked}
			className="relative flex min-h-7 items-center border-l-2 border-warning-hairline bg-warning-wash"
		>
			<span className="relative w-[calc(var(--plan-rail-col)-2px)] shrink-0 self-stretch">
				<Rail mode={leg.mode ?? "unset"} late />
			</span>
			<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 py-1 pr-3 text-xs">
				<span className="font-semibold text-warning">Unlinked transit</span>
				<span className="truncate text-muted-foreground">
					·{" "}
					{timedLegName(ix, leg) === "the departure" ? (
						<LegSummary leg={leg} compact />
					) : (
						timedLegName(ix, leg)
					)}{" "}
					({itemName(ix, a)} → {itemName(ix, b)})
				</span>
				<span className="ml-auto flex items-center gap-1">
					<Popover>
						<PopoverTrigger asChild>
							<Button
								size="xs"
								variant="ghost"
								disabled={guard.disabled || !candidates.length}
								className="h-5 px-1.5 text-[11px]"
							>
								Relink
							</Button>
						</PopoverTrigger>
						<PopoverContent align="end" className="w-72 p-2">
							<p className="px-2 pb-1 text-xs text-muted-foreground">
								Attach this route to:
							</p>
							{candidates.map((c) => (
								<Button
									key={pairKey(c.from, c.to)}
									variant="ghost"
									size="sm"
									className="w-full justify-start"
									onClick={() =>
										actions.relink.mutate({
											legId,
											fromItemId: c.from,
											toItemId: c.to,
										})
									}
								>
									{itemName(ix, ix.item(c.from))} →{" "}
									{itemName(ix, ix.item(c.to))}
								</Button>
							))}
						</PopoverContent>
					</Popover>
					{confirm ? (
						<>
							<Button
								size="xs"
								variant="destructive"
								className="h-5 px-1.5 text-[11px]"
								onClick={() => actions.discard.mutate({ legId })}
							>
								Discard route
							</Button>
							<Button
								size="xs"
								variant="ghost"
								className="h-5 px-1.5 text-[11px]"
								onClick={() => setConfirm(false)}
							>
								Keep
							</Button>
						</>
					) : (
						<Button
							size="xs"
							variant="ghost"
							disabled={guard.disabled}
							className="h-5 px-1.5 text-[11px]"
							onClick={() => setConfirm(true)}
						>
							Discard
						</Button>
					)}
				</span>
			</span>
		</div>
	);
}

/** The area-lens block header: "Shibuya · 5 stops · 10:00–15:30 ▾" + family dots. */
export function BlockHeader({
	repId,
	itemIds,
	open,
	onToggle,
}: {
	repId: string;
	itemIds: readonly string[];
	open: boolean;
	onToggle: () => void;
}) {
	const { ix, schedule, nav } = useWorkspace();
	const rep = ix.node(repId);
	const stops = itemIds.filter((id) => ix.item(id)?.nodeId).length;
	const span = blockSpan(schedule, itemIds);
	const cats = itemIds
		.map((id) => ix.node(ix.item(id)?.nodeId)?.category)
		.filter((c): c is NonNullable<typeof c> => !!c)
		.slice(0, 8);
	return (
		<div data-testid={PLAN_TESTID.areaBlock} className="flex items-center pr-3">
			<span className="w-[var(--plan-rail-col)] shrink-0" />
			<div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 hover:bg-accent/50">
				<button
					type="button"
					aria-expanded={open}
					aria-label={open ? `Collapse ${rep?.name}` : `Expand ${rep?.name}`}
					onClick={onToggle}
					className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
				>
					{open ? (
						<ChevronDown className="size-4" strokeWidth={1.5} />
					) : (
						<ChevronRight className="size-4" strokeWidth={1.5} />
					)}
				</button>
				{/* QA VIS2-09: on a phone the place name keeps its room. When the
				    row is short of space the dots go first (they drop out whole),
				    then the "· 4 stops · 14:05–23:35" line truncates, and only
				    then the name: `flex-auto` sizes the button by its content, and
				    the heavy shrink factors make the dots and the line give way. */}
				<button
					type="button"
					onClick={() => rep && nav.select({ kind: "node", id: rep.id })}
					onDoubleClick={() => rep && nav.zoomIn(rep.id)}
					className="flex min-w-0 flex-auto items-center gap-2 text-left"
				>
					{rep ? <TypeGlyph type={rep.type} category={rep.category} /> : null}
					<span
						data-block-name=""
						className="min-w-0 truncate text-sm font-medium"
					>
						{rep?.name ?? "Elsewhere"}
					</span>
					<span className="min-w-0 shrink-[100] truncate font-mono text-xs text-muted-foreground tnum">
						· {stops} {stops === 1 ? "stop" : "stops"}
						{span.start && span.end && span.tz
							? ` · ${formatTime(span.start, span.tz)}–${formatTime(span.end, span.tz)}`
							: ""}
					</span>
				</button>
				<span
					aria-hidden
					data-block-dots=""
					className="hidden h-2 min-w-0 shrink-[1000] flex-wrap items-center gap-1 overflow-hidden p-px @sm:flex"
				>
					{cats.map((c, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: dots repeat
						<CategoryDot key={i} category={c} />
					))}
				</span>
			</div>
		</div>
	);
}

/**
 * A visit band (64px; city, region and country lenses): "Tokyo" + "12–18 Apr ·
 * 6 nights · 23 stops · Planned 4 days · scheduled 3", on a card with a 4px
 * muted left rule. It expands to its days.
 */
export function BandCard({
	visit,
	open,
	onToggle,
}: {
	visit: Visit;
	open: boolean;
	onToggle: () => void;
}) {
	const { ix, nav } = useWorkspace();
	const rep = ix.node(visit.repId);
	const s = bandSummary(ix, visit);
	const parts = [
		s.from ? formatDateRange(s.from, s.to) : null,
		s.nights > 0 ? `${s.nights} ${s.nights === 1 ? "night" : "nights"}` : null,
		`${s.stops} ${s.stops === 1 ? "stop" : "stops"}`,
		s.plannedDays !== null
			? `Planned ${s.plannedDays} ${s.plannedDays === 1 ? "day" : "days"} · scheduled ${s.scheduledDays}`
			: null,
	].filter(Boolean);
	return (
		<div data-testid={PLAN_TESTID.band} className="px-3 pt-3 pb-1">
			<div className="flex min-h-16 items-center gap-3 rounded-lg border border-l-4 border-l-muted-foreground/25 bg-card px-3 py-2">
				<button
					type="button"
					aria-expanded={open}
					aria-label={open ? `Collapse ${rep?.name}` : `Expand ${rep?.name}`}
					onClick={onToggle}
					className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					{open ? (
						<ChevronDown className="size-4" strokeWidth={1.5} />
					) : (
						<ChevronRight className="size-4" strokeWidth={1.5} />
					)}
				</button>
				<button
					type="button"
					onClick={() => rep && nav.select({ kind: "node", id: rep.id })}
					onDoubleClick={() => rep && nav.zoomIn(rep.id)}
					className="min-w-0 flex-1 text-left"
				>
					<span className="flex items-center gap-2">
						{rep ? (
							<TypeGlyph
								type={rep.type}
								category={rep.category}
								className="size-4"
							/>
						) : null}
						<span className="truncate text-[17px] leading-[22px] font-semibold">
							{rep?.name ?? "Elsewhere"}
						</span>
						{visit.occurrence > 1 ? (
							<span className="shrink-0 rounded-full bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">
								visit {visit.occurrence}
							</span>
						) : null}
					</span>
					<span className="mt-0.5 block truncate text-[13px] text-muted-foreground">
						{parts.join(" · ")}
					</span>
				</button>
			</div>
		</div>
	);
}

/**
 * Between bands: "✈ KIX → ICN · 2h05 · Sat 18 Apr 14:20", "🚄 Tokyo →
 * Kawaguchiko [Fuji Excursion] · 1h52", "☾ Overnight". A ride shows its line
 * (or route) chips, as in the leg row at the country lens.
 */
export function BandLink({ transition }: { transition: Transition }) {
	const { ix, schedule, nav } = useWorkspace();
	const key = pairKey(transition.fromItemId, transition.toItemId);
	const s = schedule.legs[key];
	const leg = transition.leg;
	const from = ix.node(ix.item(transition.fromItemId)?.nodeId);
	const to = ix.node(ix.item(transition.toItemId)?.nodeId);
	const d = leg ? ix.legDetails(leg) : null;
	const select = () =>
		nav.select({
			kind: "leg",
			target: {
				kind: "pair",
				fromItemId: transition.fromItemId,
				toItemId: transition.toItemId,
			},
		});
	const text =
		transition.via === "overnight"
			? "Overnight"
			: transition.via === "stay"
				? "Overnight at the stay"
				: d?.kind === "flight"
					? `${d.flight.from.iata} → ${d.flight.to.iata}`
					: `${from?.name ?? ""} → ${to?.name ?? ""}`;
	const when =
		s && leg?.depAt && d?.kind === "flight"
			? `${formatDayDate(localDateOf(Date.parse(leg.depAt), d.flight.from.tz))} ${formatTime(new Date(leg.depAt), d.flight.from.tz)}`
			: null;
	// A reserved ride reads its own time on board, like its ticket ("KIX → ICN ·
	// 1h55", not the schedule's 4h55 with the airport time; QA BANDLINK). A
	// flight without times reads its great-circle estimate (FB-18).
	const flight = d?.kind === "flight" ? flightTimes(d.flight) : null;
	const ride = flight
		? flight.minutes
		: leg && ix.isTimed(leg)
			? rideMinutes(leg)
			: null;
	const minutes = ride ?? s?.minutes ?? 0;
	const estimate = flight ? flight.estimate : ride === null && !!s?.estimate;
	return (
		<button
			type="button"
			data-testid={PLAN_TESTID.bandLink}
			onClick={select}
			className="flex h-8 w-full items-center gap-2 pr-3 pl-[calc(var(--plan-rail-x)-6px)] text-left text-xs text-muted-foreground hover:text-foreground"
		>
			<ModeGlyph
				mode={transition.via === "leg" ? (leg?.mode ?? null) : "overnight"}
			/>
			<span className="truncate">{text}</span>
			{transition.via === "leg" && d?.kind !== "flight" ? (
				<LegChips details={d} max={2} />
			) : null}
			{minutes > 0 ? (
				<span className="font-mono tnum">
					· {formatDuration(minutes, { compact: true })}
					{estimate ? " est." : ""}
				</span>
			) : null}
			{when ? (
				<span className="hidden font-mono tnum @sm:inline">· {when}</span>
			) : null}
		</button>
	);
}

/**
 * An E7 origin row, "Itoya → Day 7 · Maya": where a suggested move would take
 * an item from. `DaySection` puts it at the item's old slot (`originAnchors`).
 */
export function OriginRow({ mark: m }: { mark: ProposalMark }) {
	const { ix, nav } = useWorkspace();
	const itemId = m.origin?.entity.startsWith("item:")
		? m.origin.entity.slice(5)
		: null;
	return (
		<div className="flex h-7 items-center pr-3">
			<span className="w-[var(--plan-rail-col)] shrink-0" />
			<button
				type="button"
				data-testid={PLAN_TESTID.originRow}
				data-item-id={itemId ?? undefined}
				onClick={() => nav.select({ kind: "proposal", id: m.proposalId })}
				className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg border border-dashed px-2 text-left text-xs text-muted-foreground hover:text-foreground"
				style={{ borderColor: presenceColor(m.author.color) }}
			>
				<span
					aria-hidden
					className="size-1.5 shrink-0 rounded-full"
					style={{ backgroundColor: presenceColor(m.author.color) }}
				/>
				<span className="truncate">
					{itemName(ix, ix.item(itemId))} → {m.origin?.toLabel} ·{" "}
					{m.author.name}
				</span>
			</button>
		</div>
	);
}

/** Origin rows with no slot of their own (their item wasn't on the day): at the end. */
export function OriginRows({ marks }: { marks: readonly ProposalMark[] }) {
	if (!marks.length) return null;
	return (
		<>
			{marks.map((m) => (
				<OriginRow key={m.proposalId} mark={m} />
			))}
		</>
	);
}

const VERB: Record<string, string> = {
	delete: "deleting this day",
	move: "moving this day",
	update: "changing this day",
	create: "adding a day here",
	other: "a change to this day",
};

/** "Maya suggests deleting this day · Review" (a day.* proposal on this day). */
export function DayProposalBanner({ dayId }: { dayId: string }) {
	const marks = useProposalMarks(`day:${dayId}`);
	return (
		<ProposalBanners
			marks={marks}
			text={(m) => `suggests ${VERB[m.kind] ?? VERB.other}`}
		/>
	);
}

/** "Maya suggests shifting the trip +1 day · Review" (trip.* proposals), at the top of the Plan. */
export function TripProposalBanner() {
	const { proposals } = useWorkspace();
	const marks = useProposalMarks("trip").filter(
		(m) => m.op.startsWith("trip.") || m.op.startsWith("day."),
	);
	return (
		<ProposalBanners
			marks={marks}
			text={(m) =>
				`suggested: ${proposals.list.find((p) => p.id === m.proposalId)?.summary ?? "a change to the trip"}`
			}
		/>
	);
}

function ProposalBanners({
	marks,
	text,
}: {
	marks: ReturnType<typeof useProposalMarks>;
	text: (m: ReturnType<typeof useProposalMarks>[number]) => string;
}) {
	const { nav, access } = useWorkspace();
	const setReviewOpen = useUi((s) => s.setReviewOpen);
	if (!marks.length) return null;
	return (
		<>
			{marks.map((m) => (
				<div key={m.proposalId} className="px-3 py-1">
					<div
						data-testid={PLAN_TESTID.proposalBanner}
						className="flex min-h-8 items-center gap-2 rounded-lg border border-dashed px-2.5 py-1 text-xs"
						style={{ borderColor: presenceColor(m.author.color) }}
					>
						<MemberAvatar user={m.author} size={16} />
						<span className="min-w-0 flex-1 truncate">
							<span className="font-medium">{m.author.name}</span> {text(m)}
						</span>
						<button
							type="button"
							className="shrink-0 font-medium text-primary hover:underline"
							onClick={() =>
								access.canReview
									? setReviewOpen(true)
									: nav.select({ kind: "proposal", id: m.proposalId })
							}
						>
							Review
						</button>
					</div>
				</div>
			))}
		</>
	);
}
