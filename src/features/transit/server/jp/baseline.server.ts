// SPEC §9.3 railEstimateMin(d): the app's current distance-only fallback, reproduced for comparison.
export const RAIL_ESTIMATE_ANCHORS: readonly (readonly [number, number])[] = [
	[0, 8],
	[2, 12],
	[10, 25],
	[30, 50],
	[50, 70],
	[100, 115],
	[150, 130],
	[400, 185],
];

export function railEstimateMin(km: number): number {
	const a = RAIL_ESTIMATE_ANCHORS;
	const last = a[a.length - 1] as readonly [number, number];
	if (km >= last[0]) return Math.round(last[1] + (km - last[0]) * 0.25);
	for (let i = 1; i < a.length; i++) {
		const [x1, y1] = a[i] as readonly [number, number];
		if (km <= x1) {
			const [x0, y0] = a[i - 1] as readonly [number, number];
			return Math.round(y0 + ((km - x0) / (x1 - x0)) * (y1 - y0));
		}
	}
	return last[1];
}
