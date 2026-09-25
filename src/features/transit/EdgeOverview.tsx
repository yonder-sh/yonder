/**
 * An aggregated map edge (SPEC §12.5 `EdgeOverview({ fromRepId, toRepId })`,
 * DESIGN §8.3): "Tokyo → Kyoto · 3 legs" with the legs behind it, each 44px:
 * "Day 4 · Shibuya Sky → Meiji Jingu · 🚋 17m", estimated ones marked "est.".
 * Clicking a leg opens it (`l.`). Every non-flight leg carries "Open in
 * Google Maps" in its own travel mode (ADDENDUM §5; FB-03).
 */
import { EmptyState } from "@/components/common/empty-state";
import { LegSummary } from "@/components/common/leg-summary";
import { formatDayDate } from "@/lib/format";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { GoogleMapsLink } from "./components/bits";
import { legEnds, mapsTravelMode } from "./lib/endpoints";
import { withFlightTime } from "./lib/flight";
import { TRANSIT_TESTID } from "./testids";

export function EdgeOverview({
	fromRepId,
	toRepId,
}: {
	fromRepId: string;
	toRepId: string;
}) {
	const { model, ix, nav, schedule } = useWorkspace();
	const edge = model.edges.find(
		(e) => e.fromRepId === fromRepId && e.toRepId === toRepId,
	);
	if (!edge)
		return (
			<div data-testid={TESTID.edgeOverview}>
				<EmptyState line="No travel between these places at this zoom." />
			</div>
		);
	const name = (id: string) => {
		const it = ix.item(id);
		return it?.title ?? ix.node(it?.nodeId)?.name ?? "?";
	};
	return (
		<div data-testid={TESTID.edgeOverview} className="grid gap-2 text-sm">
			<p className="text-[11px] leading-[14px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
				{edge.count === 1 ? "Leg" : "Legs"}
			</p>
			<ul className="-mx-2 grid">
				{edge.transitions.map((t) => {
					const target = {
						kind: "pair" as const,
						fromItemId: t.fromItemId,
						toItemId: t.toItemId,
					};
					const day = ix.day(ix.item(t.fromItemId)?.dayId);
					const ends = legEnds(ix, target);
					const mapsMode =
						ends.from && ends.to
							? mapsTravelMode(
									t.leg,
									schedule.legs[ends.key]?.suggestion?.mode ?? null,
								)
							: null;
					return (
						<li
							key={`${t.fromItemId}>${t.toItemId}`}
							data-testid={TRANSIT_TESTID.edgeLeg}
							className="group relative flex min-h-11 items-center gap-2 rounded-md px-2 hover:bg-accent"
						>
							<button
								type="button"
								onClick={() => nav.select({ kind: "leg", target })}
								className="absolute inset-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
								aria-label={`${name(t.fromItemId)} → ${name(t.toItemId)}`}
							/>
							<span className="pointer-events-none grid min-w-0 flex-1 gap-0.5 py-1.5">
								<span className="truncate">
									{day ? (
										<span className="text-muted-foreground">
											Day {ix.dayNumber(day.id)} · {formatDayDate(day.date)} ·{" "}
										</span>
									) : null}
									{name(t.fromItemId)} → {name(t.toItemId)}
								</span>
								<LegSummary
									leg={t.leg}
									schedule={withFlightTime(
										t.leg,
										schedule.legs[`${t.fromItemId}>${t.toItemId}`],
									)}
									compact
								/>
							</span>
							{mapsMode ? (
								<GoogleMapsLink
									ends={ends}
									mode={mapsMode}
									compact
									className="relative"
								/>
							) : null}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
