/**
 * The inspector Overview for the trip root (`sel=root`, and nothing
 * selected; SPEC §18.3): a compact summary — the dates, the countries and the
 * shape of the trip — the "Still to plan" panel (ADDENDUM §10) and a way to
 * the Overview page (docs/OVERVIEW.md), which now holds the deadlines, the
 * typical weather, the people and the latest activity.
 */
import { ArrowRight } from "lucide-react";
import { FlagEmoji } from "@/components/common/glyphs";
import { OVERVIEW_TESTID } from "@/features/overview/testids";
import { formatDateRange } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { StillToPlan } from "./StillToPlan";
import { SHELL_TESTID } from "./testids";

export function TripOverview() {
	const { graph, ix, nav } = useWorkspace();
	const countries = ix.children(null).filter((n) => n.type === "country");
	const places = graph.nodes.filter((n) => n.type === "place").length;
	const ideas = graph.nodes.filter(
		(n) => n.type === "place" && !ix.scheduledNodeIds.has(n.id),
	).length;
	return (
		// minmax(0,1fr) columns (COLLAB-R2-05): a long truncating line must not
		// widen the column past the 420px inspector.
		<div
			data-testid={SHELL_TESTID.tripOverview}
			className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 text-sm"
		>
			<dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2">
				<dt className="text-xs leading-5 text-muted-foreground">Dates</dt>
				<dd>
					{graph.trip.startDate
						? formatDateRange(graph.trip.startDate, graph.trip.endDate, {
								year: true,
							})
						: "Not set"}
					{graph.days.length ? (
						<span className="text-muted-foreground">
							{" "}
							· <span className="font-mono tnum">{graph.days.length}</span>{" "}
							{graph.days.length === 1 ? "day" : "days"}
						</span>
					) : null}
				</dd>
				<dt className="text-xs leading-5 text-muted-foreground">Countries</dt>
				<dd className="flex flex-wrap gap-x-3 gap-y-1">
					{countries.length
						? countries.map((c) => (
								<span key={c.id} className="inline-flex items-center gap-1">
									<FlagEmoji code={c.countryCode} />
									{c.name}
								</span>
							))
						: "None yet"}
				</dd>
				<dt className="text-xs leading-5 text-muted-foreground">Places</dt>
				<dd>
					<span className="font-mono tnum">{places}</span>{" "}
					<span className="text-muted-foreground">
						· <span className="font-mono tnum">{ideas}</span> ideas
					</span>
				</dd>
			</dl>
			<StillToPlan />
			<button
				type="button"
				data-testid={OVERVIEW_TESTID.openOverview}
				onClick={() => nav.setTab("overview")}
				className="inline-flex items-center gap-1.5 justify-self-start text-sm font-medium text-primary underline-offset-2 hover:underline"
			>
				Open the Overview
				<ArrowRight className="size-3.5" aria-hidden />
			</button>
		</div>
	);
}
