import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RouteRow } from "../../lib/trip-route";
import {
	AROUND_THE_WORLD,
	ASIA_2027,
	EXAMPLES,
	exampleGraph,
	FOUR_CORNERS,
	JAPAN_ONLY,
	LONG_WAY,
	SIXTEEN_ROWS,
} from "./__fixtures__/examples";
import { cardDates, cardFingerprint, shareCardData } from "./card-data";
import {
	buildShareCard,
	type CardSize,
	fitTitle,
	type Rect,
	type ShareCardData,
	tierOf,
} from "./card-svg";
import { type CardFont, createMeasurer, readFontMetrics } from "./metrics";
import { cardRows, regionOf } from "./regions";

const FONT_FILES: Record<CardFont, string> = {
	display: "Parkinsans-700.ttf",
	text: "Commissioner-400.ttf",
	textSemi: "Commissioner-600.ttf",
	textBold: "Commissioner-700.ttf",
	mono: "AtkinsonHyperlegibleMono-400.ttf",
};
const m = createMeasurer(
	Object.fromEntries(
		Object.entries(FONT_FILES).map(([k, f]) => [
			k,
			readFontMetrics(readFileSync(path.join(__dirname, "../fonts", f))),
		]),
	) as Record<CardFont, ReturnType<typeof readFontMetrics>>,
);

const data = (t: typeof ASIA_2027): ShareCardData =>
	shareCardData(exampleGraph(t));
const SIZES: CardSize[] = ["story", "square"];

const overlaps = (a: Rect, b: Rect) =>
	a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, b: Rect) =>
	a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

describe("metrics", () => {
	it("reads advance widths from the fonts (mono is monospaced, bold is wider)", () => {
		expect(m.width("mono", 10, "iiii")).toBeCloseTo(
			m.width("mono", 10, "MMMM"),
		);
		expect(m.width("textBold", 10, "Japan")).toBeGreaterThan(
			m.width("text", 10, "Japan"),
		);
		expect(m.width("text", 20, "Tokyo")).toBeCloseTo(
			2 * m.width("text", 10, "Tokyo"),
		);
		expect(m.width("text", 10, "Tokyo", 1)).toBeCloseTo(
			m.width("text", 10, "Tokyo") + 5,
		);
		expect(m.lineHeight("text", 10)).toBeGreaterThan(10);
	});
});

describe("route list tiers", () => {
	it("1–4 rows: two lines each with mode icons; 5–8: one line; 9–12: tighter", () => {
		expect([1, 4, 5, 8, 9, 12].map(tierOf)).toEqual([
			"roomy",
			"roomy",
			"compact",
			"compact",
			"dense",
			"dense",
		]);
		const asia = buildShareCard(data(ASIA_2027), "story", m);
		expect(asia.layout.tier).toBe("roomy");
		expect(asia.layout.rows).toHaveLength(4);
		// Dotted leaders between the name and the nights, cities on their own line.
		expect(asia.svg.match(/stroke-dasharray="1 2"/g)).toHaveLength(4);
		expect(asia.svg).toContain(">Tokyo · Mt. Fuji · Nagoya · Kyoto · Osaka<");
		const long = buildShareCard(data(LONG_WAY), "story", m);
		expect(long.layout.tier).toBe("compact");
		expect(long.layout.rows.map((r) => r.label)).toEqual([
			"Japan",
			"Korea",
			"Vietnam",
			"Cambodia",
			"Thailand",
			"Malaysia",
			"Singapore",
			"Japan",
		]);
		expect(long.svg).not.toContain('stroke-dasharray="1 2"');
		expect(buildShareCard(data(AROUND_THE_WORLD), "story", m).layout.tier).toBe(
			"dense",
		);
	});

	it("never cuts the nights, on any card", () => {
		for (const t of Object.values(EXAMPLES))
			for (const size of SIZES) {
				const card = buildShareCard(data(t), size, m);
				for (const r of card.layout.rows)
					expect(card.svg).toContain(
						`>${r.nights} ${r.nights === 1 ? "night" : "nights"}<`,
					);
			}
	});

	it("says where the trip starts and ends", () => {
		const svg = buildShareCard(data(ASIA_2027), "story", m).svg;
		expect(svg).toContain(">From New York<");
		expect(svg).toContain(">Home via Istanbul<");
	});
});

describe("more than 12 rows", () => {
	const row = (countryCode: string, nights = 3): RouteRow => ({
		countryKey: countryCode,
		countryCode,
		countryName: countryCode,
		color: "#ff7a6b",
		nights,
		cities: [`${countryCode} city`],
		modeIn: "flight",
		stayIndexes: [0],
	});

	it("folds neighbouring countries of one region into one row", () => {
		const card = buildShareCard(data(SIXTEEN_ROWS), "story", m);
		expect(card.layout.rows).toHaveLength(12);
		const folded = card.layout.rows[0];
		expect(folded).toMatchObject({
			kind: "region",
			label: "Western Europe",
			parts: ["France", "Netherlands", "Belgium", "Switzerland", "Austria"],
			nights: 11,
		});
		expect(card.svg).toContain(">WESTERN EUROPE<");
		expect(card.layout.tier).toBe("dense");
	});

	it("folds only as much as it needs to", () => {
		const rows = [
			"FR",
			"NL",
			"BE",
			"CH",
			"AT",
			"GR",
			"AE",
			"NP",
			"TH",
			"LA",
			"KH",
			"VN",
			"JP",
		].map((c) => row(c));
		const out = cardRows(rows);
		expect(out).toHaveLength(12);
		// One fold of two Western European neighbours is enough.
		expect(out[0]).toMatchObject({
			kind: "region",
			parts: ["FR", "NL"],
			nights: 6,
		});
		expect(out.slice(1).every((r) => r.kind === "country")).toBe(true);
	});

	it("ends with +N more when folding isn't enough", () => {
		// No two neighbours share a region.
		const codes = [
			"FR",
			"JP",
			"PE",
			"IN",
			"AU",
			"CL",
			"ZA",
			"EG",
			"BR",
			"TH",
			"MX",
			"IS",
			"KE",
			"CN",
			"AR",
		];
		const out = cardRows(codes.map((c) => row(c, 2)));
		expect(out).toHaveLength(12);
		expect(out.at(-1)).toMatchObject({
			kind: "more",
			label: "+4 more",
			nights: 8,
		});
		expect(out.slice(0, 11).map((r) => r.label)).toEqual(codes.slice(0, 11));
	});

	it("knows the regions", () => {
		expect(regionOf("TH")).toBe("Southeast Asia");
		expect(regionOf("JP")).toBe("East Asia");
		expect(regionOf("PT")).toBe("Southern Europe");
		expect(regionOf(null)).toBeNull();
	});
});

describe("map", () => {
	it("draws a globe when the stays are close together, a flat map when they're spread out", () => {
		const asia = buildShareCard(data(ASIA_2027), "story", m);
		expect(asia.layout.map).toMatchObject({ kind: "globe", zoom: 1 });
		expect(asia.svg).toContain('fill="url(#sphere)"');
		for (const t of [FOUR_CORNERS, AROUND_THE_WORLD]) {
			const card = buildShareCard(data(t), "story", m);
			expect(card.layout.map.kind).toBe("flat");
			expect(card.svg).not.toContain('fill="url(#sphere)"');
			expect(card.svg).toContain('fill="#0c1117"');
		}
		// One country: the globe zooms in on it.
		expect(
			buildShareCard(data(JAPAN_ONLY), "story", m).layout.map.zoom,
		).toBeGreaterThan(3);
	});

	it("labels one or two cities per country, never overlapping each other, a dot or the edge", () => {
		for (const [name, t] of Object.entries(EXAMPLES))
			for (const size of SIZES) {
				const { layout } = buildShareCard(data(t), size, m);
				expect(layout.labels.length, `${name} ${size}`).toBeGreaterThan(0);
				const perCountry = new Map<string, number>();
				layout.labels.forEach((l, i) => {
					perCountry.set(l.countryKey, (perCountry.get(l.countryKey) ?? 0) + 1);
					expect(
						inside(l.rect, layout.labelBounds),
						`${name} ${size} ${l.name}`,
					).toBe(true);
					expect(
						inside(l.rect, { x: 0, y: 0, w: layout.width, h: layout.height }),
					).toBe(true);
					for (const other of layout.labels.slice(i + 1))
						expect(
							overlaps(l.rect, other.rect),
							`${name} ${size} ${l.name}/${other.name}`,
						).toBe(false);
					for (const d of layout.dots)
						expect(
							overlaps(l.rect, d),
							`${name} ${size} ${l.name} over a dot`,
						).toBe(false);
				});
				for (const n of perCountry.values()) expect(n).toBeLessThanOrEqual(2);
			}
	});

	it("labels every country's biggest stay first (Asia 2027 as in the mockup)", () => {
		const { layout } = buildShareCard(data(ASIA_2027), "story", m);
		expect(layout.labels.map((l) => l.name).sort()).toEqual(
			["Ho Chi Minh City", "Hoi An", "Seoul", "Taipei", "Tokyo"].sort(),
		);
	});
});

describe("title", () => {
	it("is as big as the mockup for a short name and shrinks to stay on one line", () => {
		expect(fitTitle(m, "Asia 2027", 470, 72, 30).size).toBe(72);
		const long = fitTitle(m, "Asia, the long way", 470, 72, 30);
		expect(long.size).toBeLessThan(72);
		expect(long.text).toBe("Asia, the long way");
		expect(
			m.width("display", long.size, long.text, -0.02 * long.size),
		).toBeLessThanOrEqual(470);
	});

	it("cuts a very long name at the smallest size", () => {
		const t = fitTitle(m, JAPAN_ONLY.title, 470, 72, 30);
		expect(t.size).toBe(30);
		expect(t.text.endsWith("…")).toBe(true);
		expect(m.width("display", 30, t.text, -0.6)).toBeLessThanOrEqual(470);
		const card = buildShareCard(data(JAPAN_ONLY), "story", m);
		expect(card.layout.title).toEqual(t);
	});
});

describe("card data", () => {
	it("formats the dates like the mockups", () => {
		expect(cardDates("2027-10-02", "2027-11-07")).toBe("Oct 2 – Nov 7 · 2027");
		expect(cardDates("2027-12-20", "2028-01-05")).toBe(
			"Dec 20 · 2027 – Jan 5 · 2028",
		);
		expect(cardDates("2027-10-02", "2027-10-02")).toBe("Oct 2 · 2027");
		expect(data(ASIA_2027)).toMatchObject({
			title: "Asia 2027",
			dates: "Oct 2 – Nov 7 · 2027",
		});
	});

	it("fingerprints exactly what the picture shows", () => {
		const a = data(ASIA_2027);
		expect(cardFingerprint(a)).toBe(cardFingerprint(data(ASIA_2027)));
		expect(cardFingerprint({ ...a, title: "Asia 2028" })).not.toBe(
			cardFingerprint(a),
		);
		expect(cardFingerprint(data(LONG_WAY))).not.toBe(cardFingerprint(a));
	});

	it("draws an empty trip without falling over", () => {
		const g = exampleGraph(ASIA_2027);
		g.days = g.days.map((d) => ({ ...d, nightNodeId: null }));
		for (const size of SIZES) {
			const card = buildShareCard(shareCardData(g), size, m);
			expect(card.layout.rows).toHaveLength(0);
			expect(card.svg).toContain("No stays planned yet");
		}
	});
});
