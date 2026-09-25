/**
 * E1: the quiet source line of OpenStreetMap hours, wherever hours show (the
 * hours chip's popover, the week grid, the editor): "From OpenStreetMap ·
 * 3 Sep · © OpenStreetMap contributors", the first part linking to the OSM
 * object the hours were read from, the last to the ODbL copyright page.
 * Inline, so it sits inside the existing source lines.
 */
import type { ReactNode } from "react";
import type { GraphNode } from "@/lib/engine/types";
import { shortIsoDay } from "./hours-format";
import { OSM_ATTRIBUTION, OSM_COPYRIGHT_URL, osmObjectUrl } from "./osm-link";
import { INSIGHTS_TESTID } from "./testids";

const LINK =
	"underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground";

type OsmNode = Pick<GraphNode, "osmRef" | "details">;

/** `children` linking to the OSM object the hours came from (plain text without one). */
export function OsmObjectLink({
	node,
	children,
}: {
	node: OsmNode;
	children: ReactNode;
}) {
	const url = osmObjectUrl(node.details?.openingHoursRef ?? node.osmRef);
	if (!url) return <>{children}</>;
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			data-testid={INSIGHTS_TESTID.hoursOsmLink}
			className={LINK}
		>
			{children}
		</a>
	);
}

/** "© OpenStreetMap contributors" (ODbL), linking to openstreetmap.org/copyright. */
export function OsmAttribution() {
	return (
		<a
			href={OSM_COPYRIGHT_URL}
			target="_blank"
			rel="noopener noreferrer"
			className={LINK}
		>
			{OSM_ATTRIBUTION}
		</a>
	);
}

export function OsmHoursSource({
	node,
	updatedAt,
	quote,
}: {
	node: OsmNode;
	/** The hours' `updatedAt` (the fetch that last changed them). */
	updatedAt?: string;
	/** The raw tag, when the app couldn't read it. */
	quote?: string | null;
}) {
	const day = updatedAt ? shortIsoDay(updatedAt) : "";
	return (
		<span data-testid={INSIGHTS_TESTID.hoursOsmSource}>
			<OsmObjectLink node={node}>From OpenStreetMap</OsmObjectLink>
			{quote ? (
				<>
					: “<span className="italic">{quote}</span>”
				</>
			) : null}
			{day ? ` · ${day}` : ""}
			{" · "}
			<OsmAttribution />
		</span>
	);
}
