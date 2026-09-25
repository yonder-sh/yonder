/**
 * ADDENDUM §10 "dashed lines only for proposals and estimates" on the map
 * (QA PLAN-R2-04, MT-R2-01, VIS2-05): known flights, taxi/car/ferry rides,
 * stays and overnight connectors are never dashed; the fit padding keeps pins
 * clear of the inspector (MT-R2-02).
 */
import { describe, expect, it } from "vitest";
import { clearPadding } from "../geo-utils";
import {
	DASHED_LAYERS,
	edgeLayers,
	FLIGHT_GAP,
	FLIGHT_RULE,
} from "../map-layers";
import { LINES } from "../palette";

type Paint = Record<string, unknown>;
const layers = edgeLayers(LINES.light);
const byId = (id: string) => {
	const l = layers.find((x) => x.id === id);
	if (!l) throw new Error(`no layer ${id}`);
	return l as { id: string; paint?: Paint; layout?: Paint; filter?: unknown };
};
const dash = (id: string) =>
	byId(id).paint?.["line-dasharray"] as number[] | undefined;
/** A dot pattern: a zero-length dash with round caps. */
const isDots = (id: string) => {
	const d = dash(id);
	return !!d && (d[0] ?? 1) < 0.1 && byId(id).layout?.["line-cap"] === "round";
};

describe("edge layers: dashes only for estimates and proposals (ADDENDUM §10)", () => {
	it("draws a known flight as a solid double rule", () => {
		const f = byId("yonder-edges-flight");
		expect(dash("yonder-edges-flight")).toBeUndefined();
		expect(f.paint?.["line-gap-width"]).toBe(FLIGHT_GAP);
		expect(JSON.stringify(f.paint?.["line-width"])).toContain(
			String(FLIGHT_RULE),
		);
		// It only takes known flights; an estimated one goes to flight-est.
		expect(JSON.stringify(f.filter)).toContain('"!"');
		expect(dash("yonder-edges-flight-est")).toBeTruthy();
	});

	it("draws known taxi/car/ferry and transit legs solid", () => {
		expect(dash("yonder-edges-other")).toBeUndefined();
		expect(dash("yonder-edges-transit")).toBeUndefined();
	});

	it("draws walks, stays and overnight connectors as dots, not dashes", () => {
		for (const id of [
			"yonder-edges-walk",
			"yonder-edges-stay",
			"yonder-edges-overnight",
		])
			expect(isDots(id), id).toBe(true);
	});

	it("dashes only the estimate, unset and proposal layers", () => {
		const dashed = layers
			.filter((l) => {
				const p = (l as { paint?: Paint }).paint;
				return p?.["line-dasharray"] && !isDots(l.id ?? "");
			})
			.map((l) => l.id)
			.sort();
		expect(dashed).toEqual([...DASHED_LAYERS].sort());
	});

	it("keeps the casing wide enough for the flight's double rule", () => {
		const w = JSON.stringify(byId("yonder-edges-casing").paint?.["line-width"]);
		expect(w).toContain(`"flight",${FLIGHT_RULE * 2 + FLIGHT_GAP}`);
	});
});

describe("edge fade without re-tiling (VIS2-11)", () => {
	// MapLibre re-tiles a whole source in its worker whenever a DATA-DRIVEN
	// paint value changes. The lens gesture fades edges in ~20 steps, so what
	// the fade changes must be plain numbers.
	const full = edgeLayers(LINES.light, 1);
	const faded = edgeLayers(LINES.light, 0.35);
	it("changes only constant opacities between fade steps", () => {
		for (const [i, a] of full.entries()) {
			const b = faded[i] as { paint?: Paint };
			const pa = (a as { paint?: Paint }).paint ?? {};
			const pb = b.paint ?? {};
			for (const k of Object.keys(pa)) {
				if (JSON.stringify(pa[k]) === JSON.stringify(pb[k])) continue;
				expect(typeof pa[k], `${a.id} ${k}`).toBe("number");
				expect(typeof pb[k], `${a.id} ${k}`).toBe("number");
			}
		}
		// And the fade does change something (the lines' opacity).
		expect(
			(faded.find((l) => l.id === "yonder-edges-flight") as { paint: Paint })
				.paint["line-opacity"],
		).toBeCloseTo(0.35, 5);
	});

	it("keeps the per-feature dimming (o, approx) in the colours' alpha", () => {
		const c = JSON.stringify(
			byId("yonder-edges-transit").paint?.["line-color"],
		);
		expect(c).toContain('"to-rgba"');
		expect(c).toContain('["get","o"]');
		expect(c).toContain('["get","approx"]');
	});
});

describe("clearPadding (MT-R2-02: pins stay clear of the inspector)", () => {
	// Desktop 1440×900: a 655px map panel with the 420px inspector open.
	const hard = { top: 24, right: 444, bottom: 24, left: 24 };
	const soft = { top: 36, right: 76, bottom: 36, left: 36 };

	it("never pads less than the inspector covers on a narrow map", () => {
		const p = clearPadding(hard, soft, 655, 820, 0.7);
		// Room shrinks to the pin margin; the covered 444px stays.
		expect(p.right).toBeGreaterThanOrEqual(444 + 20);
		expect(p.left).toBeGreaterThanOrEqual(24 + 20);
		// A pin (≤ 28px) centred at the fit's right edge clears the panel (12px inset + 420).
		expect(655 - p.right + 14).toBeLessThan(655 - 432);
		// Vertical room is plentiful: unchanged.
		expect(p.top).toBe(60);
		expect(p.bottom).toBe(60);
	});

	it("keeps the full padding when it fits", () => {
		expect(clearPadding(hard, soft, 1200, 820, 0.7)).toEqual({
			top: 60,
			right: 520,
			bottom: 60,
			left: 60,
		});
	});

	it("scales the room proportionally before reaching the pin margin", () => {
		const p = clearPadding(hard, soft, 900, 820, 0.7);
		// 0.7 × 900 = 630 ≥ 468 hard + 112 room: no shrink needed.
		expect(p.right).toBe(520);
		const q = clearPadding(hard, soft, 800, 820, 0.7);
		// 560 − 468 = 92 of room for 112 asked: 82% of each side.
		expect(q.left).toBeCloseTo(24 + 36 * (92 / 112), 5);
		expect(q.right).toBeCloseTo(444 + 76 * (92 / 112), 5);
	});

	it("falls back to scaling everything when the map is tiny", () => {
		const p = clearPadding(hard, soft, 520, 820, 0.7);
		// 520 − 468 − 40 < 72: the old proportional shrink.
		expect(p.left + p.right).toBeCloseTo(520 * 0.7, 5);
	});

	it("with no hard part it behaves like a proportional shrink", () => {
		const p = clearPadding(
			{ top: 0, right: 0, bottom: 0, left: 0 },
			{ top: 140, right: 56, bottom: 300, left: 40 },
			390,
			800,
			0.7,
		);
		expect(p.left + p.right).toBeCloseTo(96, 5);
		expect(p.top + p.bottom).toBeCloseTo(440, 5);
	});
});
