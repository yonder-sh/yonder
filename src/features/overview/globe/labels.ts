/**
 * City labels on the Overview globe (docs/OVERVIEW.md §1, as on the share
 * cards): at most two per country, never overlapping each other, a dot or
 * the frame. Biggest stays first; each tries the right of its dot, then the
 * left, above and below. Pure (screen boxes in, placements out).
 */

export interface LabelCandidate {
	id: string;
	/** The dot's centre and radius (px). */
	x: number;
	y: number;
	r: number;
	/** The text box (px). */
	w: number;
	h: number;
	/** Higher first (nights). */
	priority: number;
	/** At most `maxPerGroup` labels per group (the country). */
	group: string;
}

export type LabelSide = "right" | "left" | "above" | "below";

export interface PlacedLabel {
	id: string;
	/** The text box's top-left corner. */
	x: number;
	y: number;
	side: LabelSide;
}

type Box = { x0: number; y0: number; x1: number; y1: number };
const overlaps = (a: Box, b: Box) =>
	a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export function declutterLabels(
	cands: readonly LabelCandidate[],
	opts: {
		width: number;
		height: number;
		maxPerGroup?: number;
		/** Space between a dot and its text (px). */
		gap?: number;
		/** Every dot on screen, labelled or not: labels keep off them. */
		dots?: readonly { x: number; y: number; r: number }[];
	},
): PlacedLabel[] {
	const max = opts.maxPerGroup ?? 2;
	const gap = opts.gap ?? 5;
	const taken: Box[] = (opts.dots ?? cands).map((d) => ({
		x0: d.x - d.r,
		y0: d.y - d.r,
		x1: d.x + d.r,
		y1: d.y + d.r,
	}));
	const perGroup = new Map<string, number>();
	const out: PlacedLabel[] = [];
	const order = [...cands].sort(
		(a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
	);
	for (const c of order) {
		if ((perGroup.get(c.group) ?? 0) >= max) continue;
		const spots: [LabelSide, number, number][] = [
			["right", c.x + c.r + gap, c.y - c.h / 2],
			["left", c.x - c.r - gap - c.w, c.y - c.h / 2],
			["above", c.x - c.w / 2, c.y - c.r - gap - c.h],
			["below", c.x - c.w / 2, c.y + c.r + gap],
		];
		for (const [side, x, y] of spots) {
			const box = { x0: x, y0: y, x1: x + c.w, y1: y + c.h };
			if (box.x0 < 0 || box.y0 < 0) continue;
			if (box.x1 > opts.width || box.y1 > opts.height) continue;
			// Its own dot is one of the obstacles; the spots never touch it.
			if (taken.some((t) => overlaps(t, box))) continue;
			taken.push(box);
			out.push({ id: c.id, x, y, side });
			perGroup.set(c.group, (perGroup.get(c.group) ?? 0) + 1);
			break;
		}
	}
	return out;
}
