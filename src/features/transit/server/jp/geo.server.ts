// Small geodesy helpers. Coordinates in GeoJSON order are [lng, lat].

export type LngLat = [number, number];
export interface LatLng {
	lat: number;
	lng: number;
}

const R_EARTH_M = 6_371_008.8;
const RAD = Math.PI / 180;

export function haversineM(
	lat1: number,
	lng1: number,
	lat2: number,
	lng2: number,
): number {
	const dLat = (lat2 - lat1) * RAD;
	const dLng = (lng2 - lng1) * RAD;
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
	return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function polylineLengthM(coords: readonly LngLat[]): number {
	let m = 0;
	for (let i = 1; i < coords.length; i++) {
		const a = coords[i - 1] as LngLat;
		const b = coords[i] as LngLat;
		m += haversineM(a[1], a[0], b[1], b[0]);
	}
	return m;
}

/** Douglas–Peucker on a local equirectangular projection. `tolM` in metres. */
export function simplify(coords: readonly LngLat[], tolM: number): LngLat[] {
	if (coords.length <= 2) return coords.slice();
	const lat0 = (coords[0] as LngLat)[1] * RAD;
	const kx = Math.cos(lat0) * 111_320;
	const ky = 110_540;
	const xy = coords.map(([lng, lat]) => [lng * kx, lat * ky] as const);
	const keep = new Uint8Array(coords.length);
	keep[0] = 1;
	keep[coords.length - 1] = 1;
	const stack: [number, number][] = [[0, coords.length - 1]];
	const tol2 = tolM * tolM;
	while (stack.length) {
		const [s, e] = stack.pop() as [number, number];
		const [ax, ay] = xy[s] as readonly [number, number];
		const [bx, by] = xy[e] as readonly [number, number];
		const dx = bx - ax;
		const dy = by - ay;
		const len2 = dx * dx + dy * dy;
		let maxD = -1;
		let idx = -1;
		for (let i = s + 1; i < e; i++) {
			const [px, py] = xy[i] as readonly [number, number];
			let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
			t = Math.max(0, Math.min(1, t));
			const qx = ax + t * dx - px;
			const qy = ay + t * dy - py;
			const d2 = qx * qx + qy * qy;
			if (d2 > maxD) {
				maxD = d2;
				idx = i;
			}
		}
		if (maxD > tol2 && idx > 0) {
			keep[idx] = 1;
			stack.push([s, idx], [idx, e]);
		}
	}
	const out: LngLat[] = [];
	for (let i = 0; i < coords.length; i++)
		if (keep[i]) out.push(coords[i] as LngLat);
	return out;
}

/** Uniform lat/lng grid for radius queries (≈ cellM metres per cell at Japanese latitudes). */
export class GridIndex {
	private readonly cellLat: number;
	private readonly cellLng: number;
	private readonly cells = new Map<string, number[]>();
	private readonly pts: { lat: number; lng: number }[] = [];

	constructor(cellM = 500) {
		this.cellLat = cellM / 110_540;
		this.cellLng = cellM / (111_320 * Math.cos(36 * RAD));
	}

	add(id: number, lat: number, lng: number): void {
		this.pts[id] = { lat, lng };
		const k = this.key(
			Math.floor(lat / this.cellLat),
			Math.floor(lng / this.cellLng),
		);
		const c = this.cells.get(k);
		if (c) c.push(id);
		else this.cells.set(k, [id]);
	}

	/** ids within radiusM, sorted by distance. */
	within(
		lat: number,
		lng: number,
		radiusM: number,
	): { id: number; m: number }[] {
		const rLat = Math.ceil(radiusM / 110_540 / this.cellLat);
		const rLng = Math.ceil(
			radiusM / (111_320 * Math.cos(lat * RAD)) / this.cellLng,
		);
		const ci = Math.floor(lat / this.cellLat);
		const cj = Math.floor(lng / this.cellLng);
		const out: { id: number; m: number }[] = [];
		for (let i = ci - rLat; i <= ci + rLat; i++) {
			for (let j = cj - rLng; j <= cj + rLng; j++) {
				const c = this.cells.get(this.key(i, j));
				if (!c) continue;
				for (const id of c) {
					const p = this.pts[id] as { lat: number; lng: number };
					const m = haversineM(lat, lng, p.lat, p.lng);
					if (m <= radiusM) out.push({ id, m });
				}
			}
		}
		return out.sort((a, b) => a.m - b.m);
	}

	private key(i: number, j: number): string {
		return `${i}:${j}`;
	}
}
