/**
 * Pin clustering (DESIGN §9.2, QA GRAN-09): at the place and area lens, pins
 * closer than 28px on screen merge into a count chip (`supercluster`). While
 * clustered, edges attach to the cluster's centroid and edges inside one
 * cluster are hidden.
 *
 * Supercluster measures its radius in units of a 512-wide tile, which is
 * exactly a MapLibre screen pixel at an integer zoom.
 */
import type { Feature, LineString, Point } from "geojson";
import Supercluster, {
	type AnyProps,
	type ClusterProperties,
} from "supercluster";
import type { Lens } from "@/lib/engine/types";
import { snapEnds } from "./geo-utils";
import type { EdgeFC, PinView } from "./map-data";

export const CLUSTER_RADIUS_PX = 28;
/** Past this zoom nothing clusters; identical points spiderfy instead. */
export const CLUSTER_MAX_ZOOM = 17;

export const clusterLens = (lens: Lens) => lens === "place" || lens === "area";

type PinProps = { repId: string };

export type ClusterIndex = Supercluster<PinProps, AnyProps>;

export type Cluster = {
	id: number;
	lng: number;
	lat: number;
	count: number;
	repIds: string[];
	/** Zoom at which it splits (> CLUSTER_MAX_ZOOM: the pins share a spot → spiderfy). */
	expansionZoom: number;
};

export function makeClusterIndex(pins: readonly PinView[]): ClusterIndex {
	const index = new Supercluster<PinProps, AnyProps>({
		radius: CLUSTER_RADIUS_PX,
		maxZoom: CLUSTER_MAX_ZOOM,
		minPoints: 2,
	});
	index.load(
		pins.map(
			(p): Feature<Point, PinProps> => ({
				type: "Feature",
				geometry: { type: "Point", coordinates: [p.lng, p.lat] },
				properties: { repId: p.repId },
			}),
		),
	);
	return index;
}

/** Web-mercator pixels at zoom `z` (512-px tiles, like supercluster's radius). */
function toPx(lng: number, lat: number, z: number): [number, number] {
	const scale = 512 * 2 ** z;
	const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
	return [
		(lng / 360 + 0.5) * scale,
		(0.5 - (0.25 * Math.log((1 + s) / (1 - s))) / Math.PI) * scale,
	];
}

type Node = {
	id: number;
	lng: number;
	lat: number;
	count: number;
	repIds: string[];
	expansionZoom: number;
	cluster: boolean;
	x: number;
	y: number;
};

/**
 * Supercluster seeds clusters greedily, so two cluster centroids (or a
 * centroid and a lone pin) can end up closer than the radius: two "2" chips
 * stacked on top of each other near Shinjuku station, hiding four pins
 * (QA GRAN-09). Merge anything closer than the radius at this zoom until
 * nothing is; a merged chip splits one zoom level in.
 */
function mergeClose(nodes: Node[], z: number): Node[] {
	const r2 = CLUSTER_RADIUS_PX * CLUSTER_RADIUS_PX;
	let list = nodes;
	for (let pass = 0; pass < nodes.length; pass++) {
		// A grid of radius-sized cells: only neighbouring cells can be closer.
		const cells = new Map<string, number[]>();
		const cellOf = (n: Node) =>
			[
				Math.floor(n.x / CLUSTER_RADIUS_PX),
				Math.floor(n.y / CLUSTER_RADIUS_PX),
			] as const;
		list.forEach((n, i) => {
			const [cx, cy] = cellOf(n);
			const k = `${cx}:${cy}`;
			const c = cells.get(k);
			if (c) c.push(i);
			else cells.set(k, [i]);
		});
		let pair: [number, number] | null = null;
		let best = r2;
		list.forEach((a, i) => {
			if (!a.cluster) return; // two lone pins this close are already a cluster
			const [cx, cy] = cellOf(a);
			for (let dx = -1; dx <= 1; dx++)
				for (let dy = -1; dy <= 1; dy++)
					for (const j of cells.get(`${cx + dx}:${cy + dy}`) ?? []) {
						if (j === i) continue;
						const b = list[j] as Node;
						const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
						if (d < best) {
							best = d;
							pair = [i, j];
						}
					}
		});
		if (!pair) return list;
		const [i, j] = pair as [number, number];
		const a = list[i] as Node;
		const b = list[j] as Node;
		const count = a.count + b.count;
		const lng = (a.lng * a.count + b.lng * b.count) / count;
		const lat = (a.lat * a.count + b.lat * b.count) / count;
		const [x, y] = toPx(lng, lat, z);
		const merged: Node = {
			// Stable while the parts are: the smaller part id (never another cluster's).
			id: Math.min(a.id, b.id),
			lng,
			lat,
			count,
			repIds: [...a.repIds, ...b.repIds],
			expansionZoom: z + 1,
			cluster: true,
			x,
			y,
		};
		list = [...list.filter((_, k) => k !== i && k !== j), merged];
	}
	return list;
}

/** The clusters at a zoom (pins not in any cluster are simply absent). */
export function clustersAt(index: ClusterIndex, zoom: number): Cluster[] {
	const z = Math.max(0, Math.floor(zoom));
	const nodes: Node[] = [];
	for (const f of index.getClusters([-180, -85, 180, 85], z)) {
		const props = f.properties as ClusterProperties & PinProps;
		const [lng = 0, lat = 0] = f.geometry.coordinates;
		const [x, y] = toPx(lng, lat, z);
		if (!props.cluster) {
			// Lone pins take part in the merge (a chip must not cover them) with
			// negative ids, which can't collide with supercluster's.
			nodes.push({
				id: -1 - nodes.length,
				lng,
				lat,
				count: 1,
				repIds: [props.repId],
				expansionZoom: z,
				cluster: false,
				x,
				y,
			});
			continue;
		}
		const id = props.cluster_id;
		const leaves = index.getLeaves(id, Number.POSITIVE_INFINITY);
		nodes.push({
			id,
			lng,
			lat,
			count: props.point_count,
			repIds: leaves.map((l) => (l.properties as PinProps).repId),
			expansionZoom: index.getClusterExpansionZoom(id),
			cluster: true,
			x,
			y,
		});
	}
	const merged = z > CLUSTER_MAX_ZOOM ? nodes : mergeClose(nodes, z);
	const out: Cluster[] = [];
	for (const n of merged) {
		if (!n.cluster) continue;
		out.push({
			id: n.id,
			lng: n.lng,
			lat: n.lat,
			count: n.count,
			repIds: n.repIds,
			expansionZoom: n.expansionZoom,
		});
	}
	return out;
}

/** repId → its cluster, for every clustered pin. */
export function clusterOfRep(
	clusters: readonly Cluster[],
): Map<string, Cluster> {
	const m = new Map<string, Cluster>();
	for (const c of clusters) for (const r of c.repIds) m.set(r, c);
	return m;
}

/**
 * Edges while clustered: an edge inside one cluster disappears; an edge with a
 * clustered end becomes a straight line from centroid (or pin) to centroid
 * (or pin), except a real track (N02 rail, a walk path), which keeps its shape
 * and just reaches over to the cluster. Other edges keep their geometry.
 */
export function attachEdgesToClusters(
	edges: EdgeFC,
	byRep: ReadonlyMap<string, Cluster>,
	pinAt: (repId: string) => [number, number] | null,
): EdgeFC {
	if (byRep.size === 0) return edges;
	const features: EdgeFC["features"] = [];
	for (const f of edges.features) {
		const ca = byRep.get(f.properties.from);
		const cb = byRep.get(f.properties.to);
		if (!ca && !cb) {
			features.push(f);
			continue;
		}
		if (ca && cb && ca.id === cb.id) continue;
		const a = ca
			? ([ca.lng, ca.lat] as [number, number])
			: pinAt(f.properties.from);
		const b = cb
			? ([cb.lng, cb.lat] as [number, number])
			: pinAt(f.properties.to);
		if (!a || !b) continue;
		if (f.properties.track) {
			// A real track (rail, walk path) keeps its shape; only its ends reach
			// over to the cluster chips.
			features.push({
				...f,
				geometry: snapEnds(f.geometry, ca ? a : null, cb ? b : null),
			});
			continue;
		}
		const geometry: LineString = { type: "LineString", coordinates: [a, b] };
		features.push({ ...f, geometry });
	}
	// Several features may now draw the same centroid line; keep one per edge+ends.
	const seen = new Set<string>();
	const deduped = features.filter((f) => {
		if (f.properties.track) return true;
		const key = `${f.properties.edgeKey}|${JSON.stringify(f.geometry.coordinates)}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return { type: "FeatureCollection", features: deduped };
}

/** Pixel offsets of `n` spiderfied pins on a circle (DESIGN §9.2: 40px). */
export function spiderOffsets(n: number, radius = 40): [number, number][] {
	const out: [number, number][] = [];
	const r = n <= 6 ? radius : radius + (n - 6) * 4;
	for (let i = 0; i < n; i++) {
		const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
		out.push([Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r)]);
	}
	return out;
}
