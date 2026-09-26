/**
 * Flights in the timeline (DESIGN §7.1 "Flight block"): the ticket stub
 * between the departure and arrival cards (no airport buffers: time at the
 * airport is the airport stop's own duration), the hatched layover block with
 * the tight-connection chip, and the "continued" stub at the top of the
 * arrival day of an overnight flight. The block drags as one unit; the drop
 * rules live in the Plan's drop handler.
 */
import { cn } from "cn";
import { Lock, Plane } from "lucide-react";
import type { CSSProperties } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { Button } from "@/components/ui/button";
import { mustRedact } from "@/lib/auth/roles";
import {
	flightArrDate,
	flightDepDate,
	flightTimes,
} from "@/lib/engine/flights";
import { pairKey } from "@/lib/engine/graph-index";
import { formatFlightNumber } from "@/lib/engine/schedule";
import { conflictFixes } from "@/lib/engine/suggest";
import { localDateTimeToEpoch, tzLabel } from "@/lib/engine/time";
import type { GraphLeg, ScheduledLeg } from "@/lib/engine/types";
import { formatDuration, formatTime } from "@/lib/format";
import type { FlightDetails } from "@/lib/schemas/legs";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { LegBundleIcons } from "./ItemCard";
import { LegMarks, Rail, RowFrame } from "./LegRow";
import { setPlanHover } from "./plan-hover";
import { PLAN_TESTID } from "./testids";
import { itemName, usePlanActions } from "./use-plan-actions";

const CABIN: Record<NonNullable<FlightDetails["cabin"]>, string> = {
	economy: "Economy",
	premium_economy: "Premium",
	business: "Business",
	first: "First",
};

function flightOf(
	ix: ReturnType<typeof useWorkspace>["ix"],
	leg: GraphLeg | null | undefined,
): FlightDetails | null {
	if (!leg) return null;
	const d = ix.legDetails(leg);
	return d.kind === "flight" ? d.flight : null;
}

/** A flight leg between two items (true when `FlightRows` should draw it). */
export function isFlightLeg(
	ix: ReturnType<typeof useWorkspace>["ix"],
	fromItemId: string,
	toItemId: string,
): boolean {
	return !!flightOf(ix, ix.legByPair.get(pairKey(fromItemId, toItemId)));
}

/**
 * One end of the stub. `known`: the ticket's time; `estimated`: the plan's
 * estimate ("~06:05", FB-18: only a departure time); neither: "TBD". The
 * zone label is always for this flight's own moment (FB-20: EST in December).
 */
function Endpoint({
	at,
	known,
	estimated,
	tz,
	iata,
	nextDay,
	align = "left",
}: {
	at: number;
	known: boolean;
	estimated?: boolean;
	tz: string;
	iata: string;
	nextDay?: boolean;
	align?: "left" | "right";
}) {
	return (
		<span
			className={cn(
				// Wraps the zone label under the time on a phone ("05:25⁺¹ HND" / "JST").
				"flex min-w-0 flex-wrap items-baseline gap-x-1.5",
				align === "right" && "justify-end",
			)}
		>
			<span className="font-mono text-[15px] leading-5 font-semibold tnum">
				{known ? (
					formatTime(at, tz)
				) : estimated ? (
					`~${formatTime(at, tz)}`
				) : (
					<span className="font-sans text-xs font-medium text-muted-foreground">
						TBD
					</span>
				)}
				{nextDay ? (
					<sup className="ml-px font-mono text-[9px] font-normal text-muted-foreground">
						+1
					</sup>
				) : null}
			</span>
			<span className="text-[15px] leading-5 font-semibold tracking-wide">
				{iata}
			</span>
			<span className="text-[11px] text-muted-foreground">
				{tzLabel(tz, at)}
			</span>
		</span>
	);
}

/**
 * The instants a stub shows: the ticket's times, else the plan's (the
 * schedule assumes an untimed flight leaves when the stop before ends), else
 * noon on the flight's dates.
 */
function stubTimes(
	f: FlightDetails,
	s: ScheduledLeg | undefined,
): {
	dep: number;
	arr: number;
	t: ReturnType<typeof flightTimes>;
	nextDay: boolean;
} {
	const t = flightTimes(f);
	const noon = (date: string | null, tz: string) =>
		(date && localDateTimeToEpoch(`${date}T12:00`, tz)) || 0;
	const depDate = flightDepDate(f);
	const arrDate = flightArrDate(f) ?? depDate;
	const dep = t.depMs ?? s?.flight?.depMs ?? noon(depDate, f.from.tz);
	const arr =
		(t.depMs !== null ? t.arrMs : null) ??
		s?.flight?.arrMs ??
		noon(arrDate, f.to.tz);
	return {
		dep,
		arr,
		t,
		nextDay: !!depDate && !!arrDate && arrDate > depDate,
	};
}

/** The ticket stub (72px) for one flight segment. */
export function FlightRows({
	fromItemId,
	toItemId,
}: {
	fromItemId: string;
	toItemId: string;
}) {
	const { ix, schedule, nav, sel, graph } = useWorkspace();
	const key = pairKey(fromItemId, toItemId);
	const leg = ix.legByPair.get(key);
	const f = flightOf(ix, leg);
	const actions = usePlanActions();
	const guard = useEditGuard();
	if (!leg || !f) return null;
	const s = schedule.legs[key];
	const guest = mustRedact(graph.me);
	const { dep, arr, t, nextDay } = stubTimes(f, s);
	const name = formatFlightNumber(f.flightNumber) ?? f.airline?.name ?? null;
	const seats = f.seats.map((x) => x.seat).filter(Boolean);
	const selected =
		sel?.kind === "leg" &&
		sel.target.kind === "pair" &&
		sel.target.fromItemId === fromItemId &&
		sel.target.toItemId === toItemId;
	const fixes = s?.late
		? conflictFixes(ix, schedule, { kind: "leg", key })
		: [];
	const select = () =>
		nav.select({ kind: "leg", target: { kind: "pair", fromItemId, toItemId } });
	const hover = { kind: "pair", id: key } as const;
	return (
		<LegMarks legId={leg.id} legKey={key}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: hover only previews on the map (MAP-07) */}
			<div
				data-testid={TESTID.leg}
				data-flight=""
				// FB-17 / FB-24: cursors, and "Dennis is editing NH 744", land on the flight.
				data-cursor-anchor={`leg:l.${fromItemId}.${toItemId}`}
				onMouseEnter={() => setPlanHover(hover, true)}
				onMouseLeave={() => setPlanHover(hover, false)}
			>
				{s?.late ? (
					<RowFrame
						height="min-h-7 py-1"
						className="bg-warning-wash"
						rail={<Rail mode="flight" late />}
					>
						<span
							className="text-xs font-semibold text-warning"
							data-testid={TESTID.conflictBadge}
						>
							{s.late.label}
						</span>
						{fixes.map((fx) =>
							fx.kind === "shorten" ? (
								<Button
									key={fx.itemId}
									size="xs"
									variant="ghost"
									data-testid={PLAN_TESTID.legFix}
									disabled={guard.disabled}
									className="h-5 px-1.5 text-[11px] text-warning"
									onClick={() =>
										actions.update.mutate({
											itemId: fx.itemId,
											patch: { durationMin: fx.durationMin },
										})
									}
								>
									Shorten {itemName(ix, ix.item(fx.itemId))}
								</Button>
							) : null,
						)}
					</RowFrame>
				) : null}
				<RowFrame
					height="py-1"
					rail={<Rail mode="flight" />}
					railSlot={
						<span className="absolute top-1/2 left-[calc(var(--plan-rail-x)-7px)] flex size-4 -translate-y-1/2 items-center justify-center rounded-full bg-background">
							<Plane
								className="size-3.5 text-mode-flight"
								strokeWidth={1.5}
								aria-hidden
							/>
						</span>
					}
				>
					<button
						type="button"
						data-testid={PLAN_TESTID.flightStub}
						onClick={select}
						data-untimed={t.untimed ? "" : undefined}
						// The flight's own colour, like a place card's family (plan.css).
						data-family="flight"
						aria-label={`${name ? `Flight ${name}` : "Flight"} ${f.from.iata} to ${f.to.iata}${t.untimed ? ", times to be decided" : ""}`}
						style={{ "--stub-split": "62%" } as CSSProperties}
						className={cn(
							"plan-stub plan-tone relative grid min-h-[72px] w-full grid-cols-[62%_38%] rounded-lg border bg-card text-left outline-none hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring",
							selected && "outline-2 outline-primary",
						)}
					>
						<span className="flex min-w-0 flex-col justify-center gap-1 px-3 py-2">
							<Endpoint
								at={dep}
								known={t.depMs !== null}
								tz={f.from.tz}
								iata={f.from.iata}
							/>
							<span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
								<span
									className={cn(
										name ? "font-mono text-foreground" : "text-foreground",
									)}
								>
									{name ?? "Flight"}
								</span>
								<span className="font-mono tnum">
									· {t.estimate ? "~" : ""}
									{formatDuration(t.minutes, { compact: true })}
									{t.estimate ? " est." : ""}
								</span>
								{t.untimed ? (
									<span data-testid={PLAN_TESTID.flightTbd}>· times TBD</span>
								) : null}
								{f.cabin ? <span>· {CABIN[f.cabin]}</span> : null}
								{seats.length ? (
									<span className="font-mono">
										· {guest ? "••" : seats.join(" ")}
									</span>
								) : null}
								{f.bookingRef || guest ? (
									<span className="inline-flex items-center gap-0.5 font-mono">
										· ref{" "}
										{guest || !f.bookingRef ? (
											<span
												title="Hidden for link guests"
												className="inline-flex items-center gap-0.5"
											>
												•• <Lock className="size-3" strokeWidth={1.5} />
											</span>
										) : (
											f.bookingRef
										)}
									</span>
								) : null}
							</span>
						</span>
						<span className="plan-stub-perf" aria-hidden />
						<span className="flex min-w-0 flex-col justify-center gap-1 px-3 py-2">
							<Endpoint
								at={arr}
								known={t.depMs !== null && !t.arrEstimated}
								estimated={t.arrEstimated}
								tz={f.to.tz}
								iata={f.to.iata}
								nextDay={nextDay}
							/>
							<span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
								<span className="min-w-0 flex-1 truncate">
									{[
										f.to.terminal
											? `T${f.to.terminal.replace(/^T/i, "")}`
											: null,
										f.to.gate ? `Gate ${f.to.gate}` : null,
									]
										.filter(Boolean)
										.join(" · ") || f.to.name}
								</span>
								{/* QA LIST-02: the flight's own todos, media, notes and costs. */}
								<LegBundleIcons legId={leg.id} />
							</span>
						</span>
					</button>
				</RowFrame>
			</div>
		</LegMarks>
	);
}

/** The hatched layover between two connecting segments (the layover item). */
export function LayoverRow({ itemId }: { itemId: string }) {
	const { ix, schedule, nav, sel } = useWorkspace();
	const item = ix.item(itemId);
	const next = ix.nextLocated(itemId);
	const w = next ? schedule.legs[pairKey(itemId, next.id)]?.warn : undefined;
	const warn = w?.kind === "tight_connection" ? w : undefined;
	const node = ix.node(item?.nodeId);
	const s = schedule.items[itemId];
	const iata = node?.details?.iata ?? node?.name ?? "";
	const selected = sel?.kind === "item" && sel.id === itemId;
	return (
		<RowFrame height="h-11" rail={<Rail mode="flight" />}>
			<button
				type="button"
				data-testid={PLAN_TESTID.layover}
				data-item-id={itemId}
				onClick={() => nav.select({ kind: "item", id: itemId })}
				className={cn(
					"plan-hatch flex h-10 min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
					selected && "outline-2 outline-primary",
				)}
			>
				<span className="truncate rounded bg-background/80 px-1.5">
					Layover{" "}
					<span className="font-mono text-foreground tnum">
						{formatDuration(
							s
								? Math.round((s.end.getTime() - s.start.getTime()) / 60_000)
								: item?.durationMin,
							{ compact: false },
						)}
					</span>{" "}
					· {iata}
				</span>
				{warn ? (
					<span
						data-testid={TESTID.conflictBadge}
						className="shrink-0 rounded-full border border-warning-hairline bg-warning-wash px-2 py-0.5 text-[11px] font-medium text-warning"
					>
						Tight connection
					</span>
				) : null}
			</button>
		</RowFrame>
	);
}

/** "→ 04:15 BKK · NH 849 continued" at the top of an overnight flight's arrival day. */
export function FlightContinued({
	fromItemId,
	toItemId,
}: {
	fromItemId: string;
	toItemId: string;
}) {
	const { ix, nav, schedule } = useWorkspace();
	const key = pairKey(fromItemId, toItemId);
	const leg = ix.legByPair.get(key);
	const f = flightOf(ix, leg);
	if (!leg || !f) return null;
	const { arr, t } = stubTimes(f, schedule.legs[key]);
	const arrKnown = t.depMs !== null && !t.arrEstimated;
	const name = formatFlightNumber(f.flightNumber) ?? "Flight";
	return (
		<RowFrame
			height="h-10"
			rail={<Rail mode="flight" />}
			onClick={() =>
				nav.select({
					kind: "leg",
					target: { kind: "pair", fromItemId, toItemId },
				})
			}
			testId={PLAN_TESTID.flightContinued}
			label={`${name} continued`}
			hover={{ kind: "pair", id: pairKey(fromItemId, toItemId) }}
		>
			<span className="plan-hatch flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 text-xs text-muted-foreground">
				<Plane
					className="size-3.5 shrink-0 text-mode-flight"
					strokeWidth={1.5}
					aria-hidden
				/>
				<span className="truncate rounded bg-background/80 px-1.5">
					→{" "}
					<span className="font-mono text-[13px] font-semibold text-foreground tnum">
						{t.untimed
							? "TBD"
							: `${arrKnown ? "" : "~"}${formatTime(arr, f.to.tz)}`}
					</span>{" "}
					<span className="font-semibold text-foreground">{f.to.iata}</span> ·{" "}
					{name} continued
				</span>
			</span>
		</RowFrame>
	);
}
