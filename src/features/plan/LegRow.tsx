/**
 * Leg rows between cards (DESIGN §7.1 "Leg row", SPEC §9): the rail in the
 * time column in the mode's pattern, the mode glyph and a one-line label,
 * travellers on the right. Unset legs show their estimate with "est."; late
 * legs get the amber fill, the label and up to three fixes; reserved transit
 * shows "◆ dep 08:30 → 10:26" and its booking line (masked for link guests).
 * Stay legs, overnight connectors and the "continued" row of an overnight
 * flight share the same frame.
 *
 * Calm by default (owner, 2026-09-25): the mode, the time and the line chips
 * (a reserved ride keeps its booking, like a flight's ticket). The distance,
 * Google Maps and the accept chips float in on hover, focus or while the leg
 * is selected (`LegMore`, plan.css), so the row never changes height.
 */
import { cn } from "cn";
import { BedDouble, Lock, Moon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { ModeGlyph } from "@/components/common/glyphs";
import { LegSummary } from "@/components/common/leg-summary";
import { MemberAvatar } from "@/components/common/member";
import { ProposalGhost } from "@/components/common/proposal-ghost";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useDateDraftImpact } from "@/features/insights/use-date-draft-impact";
import { GhostActions } from "@/features/suggest/GhostActions";
import { JapanTransitLink } from "@/features/transit/JapanTransitLink";
import { useLegActions } from "@/features/transit/use-leg-actions";
import { mustRedact } from "@/lib/auth/roles";
import { pairKey } from "@/lib/engine/graph-index";
import { timedLegName } from "@/lib/engine/schedule";
import { conflictFixes } from "@/lib/engine/suggest";
import { localDateTimeToEpoch } from "@/lib/engine/time";
import type { GraphLeg, ScheduledLeg } from "@/lib/engine/types";
import { formatDistance, formatDuration, formatTime } from "@/lib/format";
import type { LegMode } from "@/lib/schemas/enums";
import type { LegTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { type HoverTarget, useUi } from "@/lib/workspace/ui-store";
import { useProposalMarks } from "@/lib/workspace/use-proposals";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { LegBundleIcons } from "./ItemCard";
import { setPlanHover } from "./plan-hover";
import { PLAN_TESTID } from "./testids";
import { itemName, usePlanActions } from "./use-plan-actions";

/** A leg's mode, "unset" (an estimate: dashed), a stay, the night, or "quiet" (folds, ghosts). */
export type RailMode = LegMode | "unset" | "stay" | "overnight" | "quiet";

/** The rail in the time column, in the mode's pattern (DESIGN §2.3). */
export function Rail({
	mode,
	late,
	color,
}: {
	mode: RailMode;
	late?: boolean;
	color?: string | null;
}) {
	return (
		<span
			aria-hidden="true"
			className="plan-rail"
			data-mode={mode}
			data-late={late || undefined}
			style={color ? ({ "--rail-color": color } as CSSProperties) : undefined}
		/>
	);
}

/**
 * E7 and E2 marks on a leg: a suggested change wraps it in `ProposalGhost`
 * (dashed, the author's avatar); a leg the date what-if touches gets the
 * primary rule (ADDENDUM §10: primary, not amber).
 */
export function LegMarks({
	legId,
	legKey,
	children,
}: {
	legId: string | null;
	legKey: string;
	children: ReactNode;
}) {
	const { access } = useWorkspace();
	const marks = useProposalMarks(legId ? `leg:${legId}` : null);
	const impact = useDateDraftImpact();
	const whatIf =
		!!impact &&
		((legId !== null && impact.legs.has(legId)) || impact.legs.has(legKey));
	const body = whatIf ? (
		<div
			data-what-if=""
			className="rounded-md ring-2 ring-primary/60 ring-inset"
		>
			{children}
		</div>
	) : (
		children
	);
	if (!marks.length) return body;
	return (
		<ProposalGhost
			marks={marks}
			actions={
				access.canReview
					? (lead) => <GhostActions proposalId={lead.proposalId} />
					: undefined
			}
		>
			{body}
		</ProposalGhost>
	);
}

/** The frame every row between cards uses: rail column + content. */
export function RowFrame({
	rail,
	children,
	className,
	height = "h-7",
	onClick,
	testId,
	label,
	railSlot,
	hover,
	anchor,
	selected,
}: {
	rail: ReactNode;
	children: ReactNode;
	className?: string;
	height?: string;
	onClick?: () => void;
	testId?: string;
	label?: string;
	/** Something drawn on the rail (the ◆ of a reserved departure). */
	railSlot?: ReactNode;
	/** What the map highlights while the row is hovered (MAP-07). */
	hover?: HoverTarget | null;
	/** FB-17: the live-cursor anchor id (`leg:<sel>`). */
	anchor?: string;
	/** The inspector is open on this row (a leg row then shows its details). */
	selected?: boolean;
}) {
	const inner = (
		<>
			<span className="relative w-[var(--plan-rail-col)] shrink-0 self-stretch">
				{rail}
				{railSlot}
			</span>
			<span className="relative flex min-w-0 flex-1 items-center gap-2 pr-3">
				{children}
			</span>
		</>
	);
	const hoverProps = hover
		? {
				onMouseEnter: () => setPlanHover(hover, true),
				onMouseLeave: () => setPlanHover(hover, false),
			}
		: {};
	if (!onClick)
		return (
			<div
				data-testid={testId}
				data-cursor-anchor={anchor}
				data-selected={selected || undefined}
				{...hoverProps}
				className={cn("relative flex items-center", height, className)}
			>
				{inner}
			</div>
		);
	return (
		// QA A11Y-01: rows hold their own buttons and links (accept chips, fixes,
		// Google Maps), so the row is no role=button. A plain box selects on
		// click; its keyboard and screen reader entry is the row's own button
		// underneath the content (its click bubbles here too).
		// biome-ignore lint/a11y/noStaticElementInteractions: the row's own button is the keyboard entry
		// biome-ignore lint/a11y/useKeyWithClickEvents: the row's own button is the keyboard entry
		<div
			data-testid={testId}
			data-cursor-anchor={anchor}
			data-selected={selected || undefined}
			onClick={onClick}
			{...hoverProps}
			className={cn(
				"relative flex cursor-pointer items-center hover:bg-accent/40 has-[[data-row-main]:focus-visible]:bg-accent/60",
				height,
				className,
			)}
		>
			<button
				type="button"
				data-row-main=""
				aria-label={label}
				className="absolute inset-0 cursor-pointer outline-none"
			/>
			{inner}
		</div>
	);
}

function railFor(leg: GraphLeg | null, s: ScheduledLeg | undefined): RailMode {
	if (!leg?.mode || s?.unset) return "unset";
	if (s?.estimate && !s.timed) return "unset";
	return leg.mode;
}

/** The line colour of a single-line transit route (the rail takes it). */
function lineColor(
	ix: ReturnType<typeof useWorkspace>["ix"],
	leg: GraphLeg | null,
): string | null {
	if (leg?.mode !== "transit") return null;
	const d = ix.legDetails(leg);
	if (d.kind !== "transit") return null;
	const colored = (d.route?.segments ?? []).filter(
		(x) => x.mode !== "walk" && x.color,
	);
	const first = colored[0]?.color;
	return first && colored.every((x) => x.color === first) ? first : null;
}

function Travellers({ ids }: { ids: readonly string[] }) {
	if (!ids.length) return null;
	return (
		<span className="ml-auto flex shrink-0 -space-x-1">
			{ids.slice(0, 3).map((id) => (
				<MemberAvatar key={id} memberId={id} size={16} />
			))}
		</span>
	);
}

/**
 * A leg row's details, shown on hover, on focus or while the leg is
 * selected (plan.css): a small pill that floats at the row's end, left of the
 * travellers, so revealing it never moves or grows the row. Always in the
 * accessibility tree and the tab order (focusing it shows it).
 */
function LegMore({ children }: { children: ReactNode }) {
	return (
		<span
			data-testid={PLAN_TESTID.legMore}
			className="plan-leg-more absolute top-1/2 right-full z-10 mr-1.5 flex -translate-y-1/2 items-center gap-2 rounded-full border bg-card px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground shadow-xs empty:hidden"
		>
			{children}
		</span>
	);
}

const MODE_WORD: Record<LegMode, string> = {
	walk: "Walk",
	transit: "Transit",
	flight: "Flight…",
	other: "Other",
};

/** "Use transit ~1h43 · Walk · Flight…": the suggestion first (§9.3). */
function AcceptChips({
	target,
	s,
}: {
	target: LegTarget;
	s: ScheduledLeg | undefined;
}) {
	const { accept } = useLegActions();
	const openAddFlight = useUi((u) => u.openAddFlight);
	const guard = useEditGuard();
	const [busy, setBusy] = useState<LegMode | null>(null);
	const sug = s?.suggestion;
	const first: LegMode | null = sug?.mode ?? null;
	const order: LegMode[] = [
		...(first ? [first] : []),
		...(["walk", "transit", "flight"] as LegMode[]).filter((m) => m !== first),
	];
	const run = async (mode: LegMode) => {
		if (mode === "flight") {
			openAddFlight({ target });
			return;
		}
		setBusy(mode);
		try {
			await accept(target, mode);
		} finally {
			setBusy(null);
		}
	};
	return (
		<span className="flex shrink-0 items-center gap-1">
			{order.slice(0, 3).map((mode, i) => (
				<Button
					key={mode}
					type="button"
					size="xs"
					variant={i === 0 && first ? "outline" : "ghost"}
					data-testid={PLAN_TESTID.legAccept}
					// On a phone only the suggestion fits; the rest live in the leg editor.
					data-extra={i > 0 && first ? "" : undefined}
					data-mode={mode}
					disabled={guard.disabled || busy !== null}
					title={guard.reason ?? undefined}
					className="h-5 rounded-full px-2 text-[11px] font-medium data-[extra]:hidden @md:data-[extra]:inline-flex"
					onClick={(e) => {
						e.stopPropagation();
						void run(mode);
					}}
				>
					{busy === mode ? <Spinner className="size-3" /> : null}
					{i === 0 && first && mode !== "flight" && sug?.estimateMin
						? `Use ${mode} ~${formatDuration(sug.estimateMin, { compact: true })}`
						: MODE_WORD[mode]}
				</Button>
			))}
		</span>
	);
}

/** Up to three fixes for a late leg: shorten the previous stop (§9.3). */
function LegFixes({ legKey }: { legKey: string }) {
	const { ix, schedule } = useWorkspace();
	const actions = usePlanActions();
	const guard = useEditGuard();
	const fixes = conflictFixes(ix, schedule, { kind: "leg", key: legKey });
	if (!fixes.length) return null;
	return (
		<span className="flex shrink-0 items-center gap-1">
			{fixes.slice(0, 3).map((f) =>
				f.kind === "shorten" ? (
					<Button
						key={`${f.kind}:${f.itemId}`}
						size="xs"
						variant="ghost"
						data-testid={PLAN_TESTID.legFix}
						disabled={guard.disabled}
						className="h-5 px-1.5 text-[11px] text-warning hover:text-warning"
						onClick={(e) => {
							e.stopPropagation();
							actions.update.mutate({
								itemId: f.itemId,
								patch: { durationMin: f.durationMin },
							});
						}}
					>
						Shorten {itemName(ix, ix.item(f.itemId))} to{" "}
						{formatDuration(f.durationMin, { compact: true })}
					</Button>
				) : null,
			)}
		</span>
	);
}

/** A reserved ride's own time on board: "7h 55m" for SP3 21:35 → 05:30⁺¹ (QA TZ-05). */
export function timedMinutes(
	fixed: {
		departLocal: string;
		arriveLocal: string;
		fromTz: string;
		toTz: string;
	} | null,
): number | null {
	if (!fixed) return null;
	const a = localDateTimeToEpoch(fixed.departLocal, fixed.fromTz);
	const b = localDateTimeToEpoch(fixed.arriveLocal, fixed.toTz);
	if (a === null || b === null || b < a) return null;
	return Math.round((b - a) / 60_000);
}

/** "Berths" on a sleeper ("Soft sleeper 4-berth", couchette), else "Seat"/"Seats" (QA TR-11). */
export function seatWord(cls: string | null | undefined, n: number): string {
	const berth = /sleep|berth|couchette|bunk/i.test(cls ?? "");
	return berth ? (n > 1 ? "Berths" : "Berth") : n > 1 ? "Seats" : "Seat";
}

/** "◆ Fuji Excursion 7 · dep 08:30 → 10:26 · 1h 56m · Car 3 · Seats 5A, 5B · ref E7K2Q9". */
function TimedLine({ leg }: { leg: GraphLeg }) {
	const { ix, graph } = useWorkspace();
	const d = ix.legDetails(leg);
	const guest = mustRedact(graph.me);
	if (d.kind !== "transit" || !d.fixed) return null;
	const dep = d.fixed.departLocal.slice(11, 16);
	const arr = d.fixed.arriveLocal.slice(11, 16);
	const nextDay =
		d.fixed.arriveLocal.slice(0, 10) > d.fixed.departLocal.slice(0, 10);
	const b = d.booking;
	const seats = (b?.seats ?? []).map((s) => s.seat).filter(Boolean);
	const minutes = timedMinutes(d.fixed);
	return (
		// Claims the row next to the glyph; booking details that don't fit wrap
		// under the name and times rather than being cut, so the class and
		// berths always show (QA TR-11), as a flight's ticket shows its seats.
		<span className="flex min-w-0 flex-1 basis-72 flex-wrap items-center gap-x-1.5 text-xs [&>*]:whitespace-nowrap">
			<span className="max-w-full truncate font-medium text-foreground">
				{timedLegName(ix, leg)}
			</span>
			<span className="font-mono text-muted-foreground tnum">
				dep {dep} → {arr}
				{nextDay ? <sup className="text-[9px]">+1</sup> : null}
			</span>
			{minutes !== null ? (
				<span
					data-testid={PLAN_TESTID.timedDuration}
					className="font-mono text-muted-foreground tnum"
				>
					· {formatDuration(minutes)}
				</span>
			) : null}
			{b?.class ? (
				<span className="hidden truncate text-muted-foreground @md:inline">
					· {b.class}
				</span>
			) : null}
			{b?.car ? (
				<span className="hidden text-muted-foreground @md:inline">
					· Car {b.car}
				</span>
			) : null}
			{seats.length ? (
				<span className="hidden text-muted-foreground @md:inline">
					· {seatWord(b?.class, seats.length)}{" "}
					<span className="font-mono">{guest ? "••" : seats.join(", ")}</span>
				</span>
			) : null}
			{b?.ref || guest ? (
				<span className="hidden items-center gap-0.5 font-mono text-muted-foreground @lg:inline-flex">
					· ref{" "}
					{guest || !b?.ref ? (
						<span
							title="Hidden for link guests"
							className="inline-flex items-center gap-0.5"
						>
							•• <Lock className="size-3" strokeWidth={1.5} />
						</span>
					) : (
						b.ref
					)}
				</span>
			) : null}
		</span>
	);
}

/**
 * A pair leg (same day, or a cross-day leg with a mode), or a stay leg. The
 * caller routes flights to `FlightRows`.
 */
export function LegRow({
	legKey,
	target,
	stay,
}: {
	legKey: string;
	target: LegTarget;
	/** Stay legs read "🛏 from Hotel Gracery" / "🛏 to Kawaguchiko Ryokan". */
	stay?: { end: "start" | "end"; nodeId: string | null };
}) {
	const { ix, schedule, nav, sel } = useWorkspace();
	const s = schedule.legs[legKey];
	const leg =
		target.kind === "pair"
			? (ix.legByPair.get(pairKey(target.fromItemId, target.toItemId)) ?? null)
			: (ix.legByStay.get(`${target.dayId}:${target.end}`) ?? null);
	const rail = railFor(leg, s);
	const late = s?.late;
	const timed = !!leg && ix.isTimed(leg);
	const selected =
		sel?.kind === "leg" &&
		JSON.stringify(sel.target) === JSON.stringify(target);
	const stayName = stay ? ix.node(stay.nodeId)?.name : null;
	const unset = !leg?.mode;
	return (
		<LegMarks legId={leg?.id ?? null} legKey={legKey}>
			<RowFrame
				testId={stay ? PLAN_TESTID.stayLeg : TESTID.leg}
				anchor={
					target.kind === "pair"
						? `leg:l.${target.fromItemId}.${target.toItemId}`
						: `leg:s.${target.dayId}.${target.end}`
				}
				label={
					target.kind === "pair"
						? `Travel ${itemName(ix, ix.item(target.fromItemId))} → ${itemName(ix, ix.item(target.toItemId))}`
						: `Travel${stayName ? ` ${stay?.end === "start" ? "from" : "to"} ${stayName}` : ""}`
				}
				height={late ? "min-h-7 py-1" : "min-h-7"}
				selected={selected}
				onClick={() => nav.select({ kind: "leg", target })}
				hover={
					target.kind === "pair"
						? {
								kind: "pair",
								id: pairKey(target.fromItemId, target.toItemId),
							}
						: null
				}
				className={cn(
					"plan-leg",
					late && "bg-warning-wash",
					selected && "bg-primary/5",
				)}
				rail={
					<Rail
						mode={stay && unset ? "stay" : rail}
						late={!!late}
						color={lineColor(ix, leg)}
					/>
				}
				railSlot={
					timed ? (
						<span
							aria-label="reserved"
							role="img"
							className="absolute top-1/2 left-[calc(var(--plan-rail-x)-3px)] -translate-y-1/2 text-[8px] leading-none text-primary"
						>
							◆
						</span>
					) : null
				}
			>
				{/* A hanging indent (QA VIS3-02): the first part (the mode glyph, the
				    stay's bed) starts the line, and whatever wraps (line chips, the
				    late label) lines up after it. */}
				<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 [&>:first-child]:-ml-5">
					{stay ? (
						<span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
							<BedDouble
								className="size-3.5 shrink-0 text-mode-other"
								strokeWidth={1.5}
								aria-hidden
							/>
							<span className="truncate">
								{stay.end === "start" ? "from" : "to"} {stayName ?? "the stay"}
							</span>
							{!unset ? <span aria-hidden>·</span> : null}
						</span>
					) : null}
					{timed && leg ? (
						<>
							<ModeGlyph mode={leg.mode} />
							<TimedLine leg={leg} />
						</>
					) : unset ? (
						<span
							className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
							data-testid={TESTID.legMode}
							data-mode="unset"
						>
							<ModeGlyph mode={s?.suggestion?.mode ?? null} colored={false} />
							{s && s.minutes > 0 ? (
								<span className="truncate">
									<span className="font-mono tnum">
										~{formatDuration(s.minutes, { compact: true })}
									</span>{" "}
									est.
								</span>
							) : (
								<span className="truncate">Not set</span>
							)}
							{s && s.minutes > 0 ? (
								<span data-testid={TESTID.legDuration} className="sr-only">
									{s.minutes}
								</span>
							) : null}
						</span>
					) : (
						<span
							data-testid={TESTID.legMode}
							data-mode={leg?.mode ?? "unset"}
							className="flex min-w-0 items-center gap-1.5"
						>
							{/* Each chip and "1h 14m est." stays whole and wraps as one piece. */}
							<LegSummary
								leg={leg}
								schedule={s ?? null}
								distance={false}
								className="min-w-0 pl-5 [&>*]:whitespace-nowrap [&>:first-child]:-ml-5"
							/>
							<span data-testid={TESTID.legDuration} className="sr-only">
								{s?.minutes ?? leg?.durationMin ?? ""}
							</span>
						</span>
					)}
					{s?.stale ? (
						<StaleLink target={target} mode={leg?.mode ?? null} />
					) : null}
					{late ? (
						<span
							className="w-full text-xs font-semibold text-warning"
							data-testid={TESTID.conflictBadge}
						>
							{late.cause === "departure" || late.cause === "flight"
								? late.label
								: `Late ${late.minutes} min`}
						</span>
					) : null}
				</span>
				<span className="relative ml-auto flex shrink-0 items-center gap-2">
					<LegMore>
						{!unset && leg?.distanceM ? (
							<span className="font-mono tnum">
								{formatDistance(leg.distanceM)}
							</span>
						) : null}
						{unset ? <AcceptChips target={target} s={s} /> : null}
						{/* ADDENDUM §5 / FB-03: every leg with two located ends links to Google Maps. */}
						<JapanTransitLink target={target} iconOnly />
					</LegMore>
					{/* QA LIST-02: the leg's own todos, media, notes and costs. */}
					<LegBundleIcons legId={leg?.id} />
					{late ? <LegFixes legKey={legKey} /> : null}
					<Travellers ids={leg?.assigneeIds ?? []} />
				</span>
			</RowFrame>
		</LegMarks>
	);
}

function StaleLink({
	target,
	mode,
}: {
	target: LegTarget;
	mode: LegMode | null;
}) {
	const { accept } = useLegActions();
	const guard = useEditGuard();
	return (
		<button
			type="button"
			data-testid={PLAN_TESTID.legStale}
			disabled={guard.disabled || !mode}
			onClick={(e) => {
				e.stopPropagation();
				if (mode) void accept(target, mode);
			}}
			className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:no-underline"
		>
			{target.kind === "stay"
				? "First stop changed · Update"
				: "Times changed · Refresh routes"}
		</button>
	);
}

/** "☾ Overnight · Golden Gai → Meiji Jingu": no travel across the night. */
export function OvernightRow({
	fromItemId,
	toItemId,
}: {
	fromItemId: string;
	toItemId: string;
}) {
	const { ix, nav } = useWorkspace();
	return (
		<RowFrame
			testId={PLAN_TESTID.overnight}
			label={`Overnight · ${itemName(ix, ix.item(fromItemId))} → ${itemName(ix, ix.item(toItemId))}`}
			onClick={() =>
				nav.select({
					kind: "leg",
					target: { kind: "pair", fromItemId, toItemId },
				})
			}
			hover={{ kind: "pair", id: pairKey(fromItemId, toItemId) }}
			rail={<Rail mode="overnight" />}
		>
			<span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground italic">
				<Moon className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
				<span className="truncate">
					Overnight · {itemName(ix, ix.item(fromItemId))} →{" "}
					{itemName(ix, ix.item(toItemId))}
				</span>
			</span>
		</RowFrame>
	);
}

/** A reserved line (train) that leaves or arrives on another day. */
export function TimedLegRow({
	legKey,
	fromItemId,
	toItemId,
	continued,
}: {
	legKey: string;
	fromItemId: string;
	toItemId: string;
	/** The arrival day's "continued" row. */
	continued?: boolean;
}) {
	const { ix, schedule, nav, sel } = useWorkspace();
	const leg = ix.legByPair.get(pairKey(fromItemId, toItemId)) ?? null;
	const s = schedule.legs[legKey];
	if (!leg) return null;
	const d = ix.legDetails(leg);
	if (d.kind === "flight") return null;
	const tz = s ? ix.tzOf(ix.item(toItemId)?.nodeId) : null;
	const selected =
		sel?.kind === "leg" &&
		sel.target.kind === "pair" &&
		sel.target.fromItemId === fromItemId &&
		sel.target.toItemId === toItemId;
	return (
		<RowFrame
			testId={continued ? PLAN_TESTID.flightContinued : TESTID.leg}
			label={`${timedLegName(ix, leg)}${continued ? " continued" : ""}`}
			height="min-h-7"
			selected={selected}
			className={cn(
				"plan-leg",
				continued && "plan-hatch",
				s?.late && !continued && "bg-warning-wash",
			)}
			onClick={() =>
				nav.select({
					kind: "leg",
					target: { kind: "pair", fromItemId, toItemId },
				})
			}
			hover={{ kind: "pair", id: pairKey(fromItemId, toItemId) }}
			rail={<Rail mode={leg.mode ?? "unset"} late={!!s?.late && !continued} />}
		>
			<ModeGlyph mode={leg.mode} />
			{continued && s && tz ? (
				<span className="truncate text-xs text-muted-foreground">
					→{" "}
					<span className="font-mono text-foreground tnum">
						{formatTime(s.end, tz)}
					</span>{" "}
					{itemName(ix, ix.item(toItemId))} · {timedLegName(ix, leg)} continued
				</span>
			) : (
				<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
					<TimedLine leg={leg} />
					{s?.late ? (
						<span
							className="w-full text-xs font-semibold text-warning"
							data-testid={TESTID.conflictBadge}
						>
							{s.late.label}
						</span>
					) : null}
				</span>
			)}
			<span className="relative ml-auto flex shrink-0 items-center gap-2">
				{continued ? null : (
					<LegMore>
						{/* FB-03: the overnight train links to Google Maps (transit) like
						    every same-day reserved row. */}
						<JapanTransitLink
							target={{ kind: "pair", fromItemId, toItemId }}
							iconOnly
						/>
					</LegMore>
				)}
				<LegBundleIcons legId={leg.id} />
				<Travellers ids={leg.assigneeIds} />
			</span>
		</RowFrame>
	);
}
