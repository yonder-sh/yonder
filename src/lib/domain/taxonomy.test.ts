import * as lucide from "lucide-react";
import { describe, expect, it } from "vitest";
import {
	NODE_TYPE_VALUES,
	PLACE_CATEGORY_VALUES,
	PRIORITY_VALUES,
} from "@/lib/schemas/enums";
import {
	compareByPriority,
	defaultItemDuration,
	NODE_TYPES,
	nodeIcon,
	PIN_FAMILIES,
	PLACE_CATEGORIES,
	PLACE_GROUPS,
	PRIORITIES,
	PRIORITY_ORDER,
	type Priority,
	pinStyle,
	priorityRank,
	SHEET_CATEGORY_MAP,
	SHEET_PRIORITY_MAP,
	SHEET_TIME_MAP,
	scoreTier,
	TIME_NEEDED,
	TYPE_DEFAULT_MIN,
	timeNeededOf,
} from "./taxonomy";

describe("taxonomy keys match the database enums", () => {
	it("covers every node type, category and priority, in enum order", () => {
		expect(Object.keys(NODE_TYPES)).toEqual([...NODE_TYPE_VALUES]);
		expect(Object.keys(PLACE_CATEGORIES)).toEqual([...PLACE_CATEGORY_VALUES]);
		expect(Object.keys(PRIORITIES)).toEqual([...PRIORITY_VALUES]);
		expect(PRIORITY_ORDER).toEqual([...PRIORITY_VALUES]);
		expect(Object.keys(PLACE_CATEGORIES)).toHaveLength(22); // CATEGORIES.md's 21 + `other`
	});

	it("ranks node types coarse to fine", () => {
		expect(Object.values(NODE_TYPES).map((t) => t.rank)).toEqual([
			0, 1, 2, 3, 4,
		]);
	});
});

describe("icons (lucide-react 1.47.0)", () => {
	it("uses only real lucide exports", () => {
		const exported = new Set(Object.values(lucide));
		for (const c of Object.values(PLACE_CATEGORIES))
			expect(exported.has(c.icon)).toBe(true);
		for (const t of Object.values(NODE_TYPES))
			expect(exported.has(t.icon)).toBe(true);
		expect(PLACE_CATEGORIES.airport.icon).toBe(lucide.Plane);
		expect(NODE_TYPES.city.icon).toBe(lucide.BuildingComplex);
		expect(nodeIcon({ type: "place", category: "bar" })).toBe(lucide.Martini);
		expect(nodeIcon({ type: "place", category: null })).toBe(lucide.MapPin);
		expect(nodeIcon({ type: "region" })).toBe(lucide.Map);
	});
});

describe("colours", () => {
	it("gives every category a checked family, and pins a fill and ink", () => {
		for (const c of Object.values(PLACE_CATEGORIES))
			expect(PIN_FAMILIES[c.family]).toBeDefined();
		for (const f of Object.values(PIN_FAMILIES)) {
			expect(f.hex).toMatch(/^#[0-9a-f]{6}$/);
			expect(f.oklch).toMatch(/^oklch\(/);
		}
		expect(
			pinStyle({ type: "place", category: "temple_shrine" }),
		).toMatchObject({ fill: "#cf3b1d", ink: "#ffffff", family: "culture" });
		expect(pinStyle({ type: "place", category: "cafe" })).toMatchObject({
			family: "food",
			ink: "#1b1b1b",
		});
		expect(pinStyle({ type: "city" })).toMatchObject({
			fill: "#7c6b5d",
			family: null,
		});
		expect(pinStyle({ type: "area" })).toMatchObject({
			fill: "#ead65f",
			ink: "#1b1b1b",
		});
	});

	it("rolls finer categories up to a sheet group", () => {
		expect(PLACE_CATEGORIES.market.group).toBe("food_drink");
		expect(PLACE_CATEGORIES.viewpoint.group).toBe("sight");
		expect(PLACE_CATEGORIES.other.group).toBeNull();
		for (const c of Object.values(PLACE_CATEGORIES))
			if (c.group) expect(PLACE_GROUPS[c.group]).toBeDefined();
	});
});

describe("sheet mappings", () => {
	it("maps every sheet category; Neighborhood is an area node", () => {
		expect(SHEET_CATEGORY_MAP.Neighborhood).toEqual({ type: "area" });
		expect(SHEET_CATEGORY_MAP["Temple/Shrine"]).toEqual({
			type: "place",
			category: "temple_shrine",
		});
		expect(SHEET_CATEGORY_MAP.Hotel).toEqual({
			type: "place",
			category: "lodging",
		});
		expect(SHEET_PRIORITY_MAP["Sure why not"]).toBe("sure_why_not");
		expect(SHEET_TIME_MAP["Few hours"]).toBe("few_hours");
		expect(TIME_NEEDED.few_hours.minutes).toBe(150);
	});
});

describe("durations (§7.2)", () => {
	it("timeNeededMin, else the category default, else the type default", () => {
		expect(
			defaultItemDuration({
				type: "place",
				category: "museum",
				timeNeededMin: 45,
			}),
		).toBe(45);
		expect(defaultItemDuration({ type: "place", category: "museum" })).toBe(
			120,
		);
		expect(defaultItemDuration({ type: "place", category: "airport" })).toBe(0);
		expect(defaultItemDuration({ type: "place", category: null })).toBe(60);
		expect(defaultItemDuration({ type: "area" })).toBe(180);
		expect(defaultItemDuration({ type: "city" })).toBe(480);
		expect(TYPE_DEFAULT_MIN.country).toBe(480);
	});

	it("maps minutes to the nearest Time Needed bucket", () => {
		expect(timeNeededOf(150)).toBe("few_hours");
		expect(timeNeededOf(200)).toBe("half_day"); // nearer 240 than 150
		expect(timeNeededOf(45)).toBe("quick_stop"); // tie goes to the shorter one
		expect(timeNeededOf(null)).toBeNull();
	});
});

describe("priority ranking (§7.3)", () => {
	it("ranks by max score, then sum; unrated counts as absent and sorts last", () => {
		expect(priorityRank(["must", "meh"])).toEqual([5, 6]);
		expect(priorityRank(["nah"])).toEqual([0, 0]);
		expect(priorityRank([null, undefined])).toEqual([-1, -1]);
		const nodes: { name: string; priorities: Record<string, Priority> }[] = [
			{ name: "B", priorities: { d: "want", a: "want" } },
			{ name: "Unrated", priorities: {} },
			{ name: "A", priorities: { d: "want", a: "want" } },
			{ name: "Top", priorities: { d: "must" } },
			{ name: "Nah", priorities: { a: "nah" } },
			{ name: "Single want", priorities: { d: "want" } },
		];
		expect(
			[...nodes].sort((x, y) => compareByPriority(x, y)).map((n) => n.name),
		).toEqual(["Top", "A", "B", "Single want", "Nah", "Unrated"]);
		// The "who" filter ranks by one member only.
		expect(
			[...nodes]
				.sort((x, y) => compareByPriority(x, y, ["a"]))
				.map((n) => n.name),
		).toEqual(["A", "B", "Nah", "Single want", "Top", "Unrated"]);
	});
});

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
	const lum = (hex: string) => {
		const [r, g, bl] = [1, 3, 5].map((i) => {
			const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
			return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		}) as [number, number, number];
		return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
	};
	const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m) as [number, number];
	return (x + 0.05) / (y + 0.05);
}

describe('palette D "Green → red" (PLACES §1c)', () => {
	it("goes deep green → red, with a dot colour per level in both themes", () => {
		expect(PRIORITIES.must.light).toEqual({
			bg: "#0f5e38",
			fg: "#ffffff",
			dot: "#0f5e38",
		});
		expect(PRIORITIES.nah.dark).toEqual({
			bg: "#4d1c22",
			fg: "#ff9ba3",
			dot: "#e0566a",
		});
		for (const p of PRIORITY_ORDER)
			for (const t of ["light", "dark"] as const)
				expect(PRIORITIES[p][t].dot).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("every pill's label passes WCAG AA (4.5:1) on its fill, light and dark", () => {
		for (const p of PRIORITY_ORDER)
			for (const t of ["light", "dark"] as const) {
				const { fg, bg } = PRIORITIES[p][t];
				expect(contrast(fg, bg), `${p} ${t}`).toBeGreaterThanOrEqual(4.5);
			}
	});

	it("keeps pin sizes (pinScale) as they were", () => {
		expect(PRIORITY_ORDER.map((p) => PRIORITIES[p].pinScale)).toEqual([
			1.25, 1.1, 1, 1, 0.85, 0.85,
		]);
	});
});

describe("scoreTier: group score → colour band (PLACES §1c)", () => {
	it("maps +5 and up Must, +3–4 Really want, +1–2 Want, 0 Sure, −1 Meh, −2 and below Nah", () => {
		const cases: [number, Priority][] = [
			[12, "must"],
			[5, "must"],
			[4, "really_want"],
			[3, "really_want"],
			[2, "want"],
			[1, "want"],
			[0, "sure_why_not"],
			[-1, "meh"],
			[-2, "nah"],
			[-9, "nah"],
		];
		for (const [score, tier] of cases)
			expect(scoreTier(score), `${score}`).toBe(tier);
	});

	it("floors fractions into the band below and reads NaN as 0", () => {
		expect(scoreTier(4.9)).toBe("really_want");
		expect(scoreTier(0.5)).toBe("sure_why_not");
		expect(scoreTier(-0.5)).toBe("meh");
		expect(scoreTier(Number.NaN)).toBe("sure_why_not");
	});
});
