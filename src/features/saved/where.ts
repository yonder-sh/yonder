/** Saved by place (pure; unit-tested): the Where chips, the grid's groups, the trip label. */
import { COUNTRY_VIEWS } from "@/data/countries";
import { normName } from "@/features/home/share-classify";
import type { MyTrip } from "@/features/home/types";
import type { SavedLink, SavedTrip, SavedWhere } from "./types";

let NAMES: Intl.DisplayNames | null | undefined;

/** "Japan" for `JP` (the code itself when the browser can't say). */
export function countryName(cc: string): string {
	if (NAMES === undefined)
		try {
			NAMES = new Intl.DisplayNames(["en"], { type: "region" });
		} catch {
			NAMES = null;
		}
	try {
		return NAMES?.of(cc) ?? cc;
	} catch {
		return cc;
	}
}

let LIST: { code: string; name: string }[] | null = null;

/** Every country, by name (the search's own list: no network). */
export function countries(): { code: string; name: string }[] {
	LIST ??= Object.keys(COUNTRY_VIEWS)
		.map((code) => ({ code, name: countryName(code) }))
		.sort((a, b) => a.name.localeCompare(b.name));
	return LIST;
}

/** Countries whose name (or code) starts a word with what was typed. */
export function matchCountries(q: string, max = 4) {
	const n = normName(q);
	if (!n) return [];
	return countries()
		.filter(
			(c) =>
				c.code.toLowerCase() === n || ` ${normName(c.name)}`.includes(` ${n}`),
		)
		.slice(0, max);
}

/** A place to file under: a country, maybe a city in it. */
export type WhereChoice = {
	countryCode: string;
	city: { name: string; lat: number | null; lng: number | null } | null;
};

export const choiceKey = (c: {
	countryCode: string;
	city?: { name: string } | null;
}) => `${c.countryCode}|${c.city ? normName(c.city.name) : ""}`;

/** "Kyoto, Japan" or "Japan". */
export function whereLabel(w: {
	countryCode: string;
	city?: string | { name: string } | null;
}): string {
	const city = typeof w.city === "string" ? w.city : w.city?.name;
	return city
		? `${city}, ${countryName(w.countryCode)}`
		: countryName(w.countryCode);
}

/** A saved item's place as a choice. */
export function choiceOf(w: SavedWhere): WhereChoice {
	return {
		countryCode: w.countryCode,
		city: w.city ? { name: w.city, lat: w.lat, lng: w.lng } : null,
	};
}

/**
 * The Where chips, at once (no network): the cities and countries I filed
 * things under, most recent first (a city, then its country); topped up
 * from my trips' cities and countries while there are few.
 */
export function whereChips(
	links: readonly Pick<SavedLink, "where">[],
	trips: readonly Pick<MyTrip, "cities" | "countryCodes">[] = [],
	max = 8,
): WhereChoice[] {
	const out: WhereChoice[] = [];
	const seen = new Set<string>();
	const push = (c: WhereChoice) => {
		const k = choiceKey(c);
		if (seen.has(k) || out.length >= max) return;
		seen.add(k);
		out.push(c);
	};
	const filed = links
		.flatMap((l) => (l.where ? [l.where] : []))
		.sort((a, b) => b.at - a.at);
	for (const w of filed) {
		if (w.city) push(choiceOf(w));
		push({ countryCode: w.countryCode, city: null });
	}
	for (const t of trips) {
		for (const c of t.cities ?? [])
			push({
				countryCode: c.countryCode,
				city: { name: c.name, lat: c.lat, lng: c.lng },
			});
		for (const cc of t.countryCodes)
			if (/^[A-Z]{2}$/.test(cc)) push({ countryCode: cc, city: null });
	}
	return out;
}

/** What a Maps link's real place says (shown preselected), else null. */
export function suggestedWhere(
	l: Pick<SavedLink, "place" | "where">,
): WhereChoice | null {
	const p = l.place;
	if (l.where || !p?.exact || !p.countryCode) return null;
	return {
		countryCode: p.countryCode,
		city: p.city ? { name: p.city, lat: null, lng: null } : null,
	};
}

export type CityGroup = {
	key: string;
	/** "Kyoto", or "Japan (no city)". */
	label: string;
	items: SavedLink[];
};

export type CountryGroup = {
	/** The country code, or "" for Unsorted. */
	key: string;
	label: string;
	count: number;
	cities: CityGroup[];
};

const latest = (items: readonly SavedLink[]) =>
	Math.max(...items.map((l) => Math.max(l.createdAt, l.where?.at ?? 0)));

/**
 * The grid: by country, then city (most recent first; the country's items
 * without a city last), then Unsorted. Items keep their order (newest first).
 */
export function groupSaved(links: readonly SavedLink[]): CountryGroup[] {
	const byCountry = new Map<string, SavedLink[]>();
	for (const l of links) {
		const k = l.where?.countryCode ?? "";
		byCountry.set(k, [...(byCountry.get(k) ?? []), l]);
	}
	const groups: CountryGroup[] = [];
	for (const [cc, items] of byCountry) {
		if (!cc) continue;
		const byCity = new Map<string, SavedLink[]>();
		for (const l of items) {
			const k = l.where?.cityKey ?? "";
			byCity.set(k, [...(byCity.get(k) ?? []), l]);
		}
		const name = countryName(cc);
		const cities = [...byCity]
			.map(([k, list]) => ({
				key: `${cc}|${k}`,
				label: k ? (list[0]?.where?.city ?? k) : `${name} (no city)`,
				items: list,
				at: latest(list),
				none: !k,
			}))
			.sort((a, b) => Number(a.none) - Number(b.none) || b.at - a.at)
			.map(({ key, label, items }) => ({ key, label, items }));
		groups.push({ key: cc, label: name, count: items.length, cities });
	}
	groups.sort(
		(a, b) =>
			latest(b.cities.flatMap((c) => c.items)) -
			latest(a.cities.flatMap((c) => c.items)),
	);
	const unsorted = byCountry.get("");
	if (unsorted?.length)
		groups.push({
			key: "",
			label: "Unsorted",
			count: unsorted.length,
			cities: [{ key: "|", label: "Unsorted", items: unsorted }],
		});
	return groups;
}

/** The feed's order: the grid's. */
export function gridOrder(groups: readonly CountryGroup[]): string[] {
	return groups.flatMap((g) =>
		g.cities.flatMap((c) => c.items.map((l) => l.id)),
	);
}

/** "In Japan 2027", "In 2 trips", else null. */
export function inTripsLabel(trips: readonly SavedTrip[]): string | null {
	if (!trips.length) return null;
	return trips.length === 1
		? `In ${trips[0]?.name}`
		: `In ${trips.length} trips`;
}

/**
 * A new trip's name from what's in it: "Kyoto", "Kyoto & Osaka", "Japan",
 * "Japan & South Korea", else "New trip".
 */
export function tripNameFor(
	links: readonly Pick<SavedLink, "where">[],
): string {
	const cities: string[] = [];
	const countries: string[] = [];
	for (const l of links) {
		const w = l.where;
		if (!w) continue;
		if (!countries.includes(w.countryCode)) countries.push(w.countryCode);
		if (
			w.city &&
			!cities.some((c) => c.toLowerCase() === w.city?.toLowerCase())
		)
			cities.push(w.city);
	}
	const two = (xs: string[]) => (xs.length === 1 ? xs[0] : xs.join(" & "));
	if (cities.length && cities.length <= 2 && countries.length === 1)
		return two(cities) as string;
	if (countries.length && countries.length <= 2)
		return two(countries.map(countryName)) as string;
	return "New trip";
}
