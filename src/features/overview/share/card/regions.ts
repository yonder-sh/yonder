/**
 * docs/OVERVIEW.md §Sharing, more than 12 rows: neighbouring countries of one
 * region fold into one row ("SOUTHEAST ASIA · Thailand · Laos · Cambodia ·
 * 18 nights"); if the list is still too long it ends with "+N more · M
 * nights". Regions are the UN M49 sub-regions, named the way travellers say
 * them (Türkiye and Iran in the Middle East, the Caucasus on its own, Mexico
 * in Central America).
 */
import { countryLabel, type RouteRow } from "../../lib/trip-route";

const REGIONS: Record<string, string> = {
	"Southeast Asia": "BN KH ID LA MY MM PH SG TH TL VN",
	"East Asia": "CN HK MO JP KP KR MN TW",
	"South Asia": "AF BD BT IN MV NP PK LK",
	"Central Asia": "KZ KG TJ TM UZ",
	"Middle East": "AE BH IQ IR IL JO KW LB OM PS QA SA SY TR YE",
	Caucasus: "AM AZ GE",
	"Northern Europe": "DK EE FI FO IS IE LV LT NO SE GB AX SJ IM GG JE",
	"Western Europe": "AT BE FR DE LI LU MC NL CH",
	"Southern Europe": "AL AD BA HR GI GR VA IT MT ME MK PT SM RS SI ES XK CY",
	"Eastern Europe": "BY BG CZ HU MD PL RO RU SK UA",
	"North Africa": "DZ EG LY MA SD TN EH",
	"West Africa": "BJ BF CV CI GM GH GN GW LR ML MR NE NG SN SL TG SH",
	"East Africa": "BI KM DJ ER ET KE MG MW MU YT MZ RE RW SC SO SS TZ UG ZM ZW",
	"Central Africa": "AO CM CF TD CG CD GQ GA ST",
	"Southern Africa": "BW SZ LS NA ZA",
	"North America": "US CA GL BM PM",
	"Central America": "MX BZ CR SV GT HN NI PA",
	Caribbean:
		"AG AI AW BS BB BQ VG KY CU CW DM DO GD GP HT JM MQ MS PR BL KN LC MF VC SX TT TC VI",
	"South America": "AR BO BR CL CO EC FK GF GY PY PE SR UY VE",
	"Australia & NZ": "AU NZ",
	"Pacific Islands":
		"FJ PG SB VU NC PF WS TO KI FM MH NR PW TV CK NU GU MP AS WF",
};

const REGION_OF: Record<string, string> = {};
for (const [region, codes] of Object.entries(REGIONS))
	for (const c of codes.split(" ")) REGION_OF[c] = region;

export const regionOf = (countryCode: string | null): string | null =>
	(countryCode && REGION_OF[countryCode]) || null;

/** One line of the card's route list. */
export interface CardRow {
	kind: "country" | "region" | "more";
	/** Upper-cased on the card. */
	label: string;
	/** Cities of a country; the countries of a region; empty for "more". */
	parts: string[];
	nights: number;
	/** Accent per country in the row (one for a country row). */
	colors: string[];
	modeIn: RouteRow["modeIn"];
}

export const MAX_ROWS = 12;

const countryRow = (r: RouteRow): CardRow => ({
	kind: "country",
	label: countryLabel(r),
	parts: [...r.cities],
	nights: r.nights,
	colors: [r.color],
	modeIn: r.modeIn,
});

/**
 * The route list's rows: one per country run while they fit in `max`; else
 * runs of neighbouring rows in one region fold (the longest run first, so one
 * fold saves the most), then the tail folds into "+N more · M nights".
 */
export function cardRows(rows: readonly RouteRow[], max = MAX_ROWS): CardRow[] {
	let groups: RouteRow[][] = rows.map((r) => [r]);
	const regionOfGroup = (g: RouteRow[]) => {
		const first = regionOf(g[0]?.countryCode ?? null);
		return first && g.every((r) => regionOf(r.countryCode) === first)
			? first
			: null;
	};
	while (groups.length > max) {
		// Maximal runs of neighbouring groups in one region.
		let best: { from: number; to: number } | null = null;
		let i = 0;
		while (i < groups.length) {
			const region = regionOfGroup(groups[i] ?? []);
			let j = i + 1;
			while (
				region &&
				j < groups.length &&
				regionOfGroup(groups[j] ?? []) === region
			)
				j++;
			if (region && j - i >= 2 && (!best || j - i > best.to - best.from))
				best = { from: i, to: j };
			i = Math.max(j, i + 1);
		}
		if (!best) break;
		// Fold just enough of the run to fit (all of it when that's still not enough).
		const need = groups.length - max;
		const take = Math.min(best.to - best.from, need + 1);
		const merged = groups.slice(best.from, best.from + take).flat();
		groups = [
			...groups.slice(0, best.from),
			merged,
			...groups.slice(best.from + take),
		];
	}
	let out: CardRow[] = groups.map((g) => {
		const first = g[0] as RouteRow;
		if (g.length === 1) return countryRow(first);
		const names: string[] = [];
		const colors: string[] = [];
		for (const r of g) {
			const n = countryLabel(r);
			if (!names.includes(n)) names.push(n);
			if (!colors.includes(r.color)) colors.push(r.color);
		}
		// Going back to a country inside a folded region: it's still one region row.
		if (names.length === 1)
			return {
				...countryRow(first),
				parts: [...new Set(g.flatMap((r) => r.cities))],
				nights: g.reduce((s, r) => s + r.nights, 0),
			};
		return {
			kind: "region",
			label: regionOf(first.countryCode) ?? countryLabel(first),
			parts: names,
			nights: g.reduce((s, r) => s + r.nights, 0),
			colors,
			modeIn: first.modeIn,
		};
	});
	if (out.length > max) {
		const rest = out.slice(max - 1);
		out = [
			...out.slice(0, max - 1),
			{
				kind: "more",
				label: `+${rest.length} more`,
				parts: [],
				nights: rest.reduce((s, r) => s + r.nights, 0),
				colors: [],
				modeIn: rest[0]?.modeIn ?? "unset",
			},
		];
	}
	return out;
}
