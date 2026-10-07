/**
 * The trip's countries in the palette: search results inside them rank
 * first, and a save that would add a new country asks first. Pure.
 */
import type { NodeType } from "@/lib/schemas/enums";
import { resultKind } from "./categorize";
import type { PlaceSearchResult } from "./providers";
import { fold } from "./trip-search";

export type TripCountry = {
	name: string;
	localName?: string | null;
	code: string | null;
};

type CountryNode = {
	type: NodeType;
	name: string;
	localName?: string | null;
	countryCode: string | null;
	status?: string;
};

/** The trip's country nodes (dropped ones left out). */
export function tripCountries(nodes: readonly CountryNode[]): TripCountry[] {
	return nodes
		.filter((n) => n.type === "country" && n.status !== "dropped")
		.map((n) => ({
			name: n.name,
			localName: n.localName,
			code: n.countryCode?.toUpperCase() ?? null,
		}));
}

/** By its country code, else by the last part of its address ("…, Japan"). */
export function inTripCountry(
	r: PlaceSearchResult,
	countries: readonly TripCountry[],
): boolean {
	if (r.countryCode)
		return countries.some((c) => c.code === r.countryCode?.toUpperCase());
	const last = fold(r.subtitle.split(",").at(-1));
	if (!last) return false;
	return countries.some(
		(c) =>
			fold(c.name) === last || (!!c.localName && fold(c.localName) === last),
	);
}

/** Results inside the trip's countries first; the order is kept otherwise. */
export function rankInTripCountries(
	results: readonly PlaceSearchResult[],
	countries: readonly TripCountry[],
): PlaceSearchResult[] {
	if (!countries.length) return [...results];
	const inside = results.filter((r) => inTripCountry(r, countries));
	return [...inside, ...results.filter((r) => !inside.includes(r))];
}

/** The country a save would create, when the trip already has one (else null). */
export function newCountryOf(
	filing: { create: readonly { type: string; name: string }[] },
	countries: readonly TripCountry[],
): string | null {
	if (!countries.length) return null;
	return filing.create.find((c) => c.type === "country")?.name ?? null;
}

/** "Kyo" or "Kyoto" with Kyoto the city among the results: no new country for it. */
export function queryNamesCity(
	q: string,
	results: readonly PlaceSearchResult[],
): boolean {
	const typed = fold(q);
	if (!typed) return false;
	return results.some((r) => {
		const level = resultKind(r.types).level;
		return (
			(level === "city" || level === "region") &&
			fold(r.title).startsWith(typed)
		);
	});
}
