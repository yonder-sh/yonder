/**
 * Loads and validates the Asia 2027 sheet export (`seed/data/*.json`,
 * `seed/media/manifest.json`, `seed/import/overrides.json`) for the importer
 * (SPEC §17.3). Every file is parsed with a zod schema, so a renamed header,
 * a missing column or a truncated file fails with a message that names the
 * file and the problem (QA SEED-13) before anything touches the database.
 *
 * The other export tabs (flights, seat ratings, ANA watch log, Random Notes)
 * are never read: ADDENDUM §8 drops Random Notes, and the flight tabs are not
 * trip data (QA SEED-12).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const Cell = z.string().nullable();
const Num = z.number().nullable();
const Link = z.object({ text: z.string(), url: z.string() });
const Links = z.array(Link).nullable().default([]);

/** One tab file: `{ source, headers, rows }`; rows must carry every required header. */
function tab<T extends z.ZodRawShape>(required: readonly string[], row: T) {
	return z
		.object({
			headers: z.array(z.string()),
			rows: z.array(z.looseObject({ _row: z.number().int(), ...row })),
		})
		.superRefine((v, ctx) => {
			const missing = required.filter((h) => !v.headers.includes(h));
			if (missing.length)
				ctx.addIssue({
					code: "custom",
					message: `missing column${missing.length > 1 ? "s" : ""} ${missing.map((m) => `"${m}"`).join(", ")} (headers: ${v.headers.map((h) => `"${h}"`).join(", ")})`,
				});
		});
}

export const CitiesFile = tab(
	["Country", "City", "Status", "Days", "Notes", "Guide"],
	{
		Country: z.string(),
		City: z.string(),
		Status: z.enum(["Planned", "Dropped"]),
		Days: Num,
		Notes: Cell,
		Notes_links: Links,
		Guide: Cell,
		Guide_url: Cell.optional(),
	},
);
export type CityRow = z.infer<typeof CitiesFile>["rows"][number];

export const PlacesFile = tab(
	[
		"Country",
		"City",
		"Area",
		"Place",
		"Description",
		"Category",
		"Priority (Dennis)",
		"Priority (Audrey)",
		"Time Needed",
		"Notes",
		"Link",
	],
	{
		Country: z.string(),
		City: z.string(),
		Area: Cell,
		Place: z.string(),
		Description: Cell,
		Category: Cell,
		"Priority (Dennis)": Cell,
		"Priority (Audrey)": Cell,
		"Time Needed": Cell,
		Notes: Cell,
		Notes_links: Links.optional(),
		Link: Cell,
		Link_url: Cell.optional(),
	},
);
export type PlaceRow = z.infer<typeof PlacesFile>["rows"][number];

const DayLabel = z.object({
	number: z.number().int().positive().nullable(),
	city: z.string().nullable(),
	title: z.string().nullable(),
	is_backup: z.boolean(),
});

export const ItineraryFile = tab(
	[
		"Day",
		"Area",
		"Place",
		"Category",
		"Hrs",
		"Book ahead",
		"Open Hours",
		"Notes",
	],
	{
		Day: z.string(),
		_day: DayLabel,
		Area: Cell,
		Place: z.string(),
		Category: Cell,
		Hrs: Num,
		"Book ahead": Cell,
		"Open Hours": Cell,
		Notes: Cell,
	},
).and(
	z.object({
		summary: z.object({
			rows: z.array(
				z.looseObject({
					label: z.string().nullable(),
					hrs: z.union([z.number(), z.string()]).nullable().optional(),
					kind: z.string(),
				}),
			),
		}),
	}),
);
export type ItineraryRow = z.infer<typeof ItineraryFile>["rows"][number];

export const ShoppingFile = tab(
	[
		"Item",
		"For",
		"Where",
		"City",
		"Rough budget",
		"Status",
		"Notes",
		"Sources",
	],
	{
		Item: z.string(),
		For: Cell,
		Where: Cell,
		City: Cell,
		"Rough budget": Cell,
		Status: Cell,
		Notes: Cell,
		Sources_links: Links.optional(),
	},
);
export type ShoppingRow = z.infer<typeof ShoppingFile>["rows"][number];

export const ActionTimelineFile = tab(
	[
		"What",
		"Type",
		"For travel date",
		"Booking opens",
		"Time (ET)",
		"Status",
		"Notes",
	],
	{
		What: z.string(),
		Type: Cell,
		"For travel date": Cell,
		"Booking opens": Cell,
		"Time (ET)": Cell,
		Status: Cell,
		Notes: Cell,
	},
);
export type ActionRow = z.infer<typeof ActionTimelineFile>["rows"][number];

const Pin = {
	lat: z.number().min(-90).max(90),
	lng: z.number().min(-180).max(180),
	timezone: z.string().nullable().optional(),
	confidence: z.enum(["high", "medium", "low"]).nullable().optional(),
};

export const GeocodeHintsFile = z.object({
	countries: z.array(
		z.looseObject({ key: z.string(), iso2: z.string().length(2), ...Pin }),
	),
	cities: z.array(z.looseObject({ key: z.string(), ...Pin })),
	areas: z.array(z.looseObject({ key: z.string(), ...Pin })),
	places: z.array(z.looseObject({ key: z.string(), ...Pin })),
	transit_points: z.array(z.looseObject({ name: z.string(), ...Pin })),
	itinerary_aliases: z.array(
		z.looseObject({
			itinerary_place: z.string(),
			maps_to: z.string().optional(),
			route: z.array(z.string()).optional(),
		}),
	),
	itinerary_area_aliases: z.array(
		z.looseObject({ itinerary: z.string(), maps_to: z.string() }),
	),
});
export type GeocodeHints = z.infer<typeof GeocodeHintsFile>;
export type Hint = {
	lat: number;
	lng: number;
	timezone?: string | null;
	confidence?: "high" | "medium" | "low" | null;
};

export const MediaManifestFile = z.array(
	z.looseObject({
		file: z.string().regex(/^[\w.-]+$/, "a bare file name"),
		placeName: z.string().nullable(),
		city: z.string(),
		country: z.string(),
		level: z.enum(["city", "place"]),
		source: z.string(),
		sourceUrl: z.string().nullable().optional(),
		pageUrl: z.string().nullable().optional(),
		author: z.string().nullable().optional(),
		license: z.string().nullable().optional(),
		licenseUrl: z.string().nullable().optional(),
		caption: z.string().nullable().optional(),
		primary: z.boolean().optional(),
		contentType: z.string(),
		width: z.number().int().positive(),
		height: z.number().int().positive(),
		bytes: z.number().int().positive(),
	}),
);
export type MediaEntry = z.infer<typeof MediaManifestFile>[number];

/** `seed/import/overrides.json`: `{ "Country|City|Area|Place": { lat, lng } | { skip: true } }`. */
export const OverridesFile = z.record(
	z.string(),
	z.union([
		z
			.object({
				lat: z.number().min(-90).max(90),
				lng: z.number().min(-180).max(180),
			})
			.strict(),
		z.object({ skip: z.literal(true) }).strict(),
	]),
);
export type Overrides = z.infer<typeof OverridesFile>;

export type SheetData = {
	cities: z.infer<typeof CitiesFile>;
	places: z.infer<typeof PlacesFile>;
	itinerary: z.infer<typeof ItineraryFile>;
	shopping: z.infer<typeof ShoppingFile>;
	actions: z.infer<typeof ActionTimelineFile>;
	hints: GeocodeHints;
	/** Empty with `--no-media`. */
	media: MediaEntry[];
	overrides: Overrides;
};

/** A bad input file: the message names the file and the problem (QA SEED-13). */
export class SheetDataError extends Error {
	override name = "SheetDataError";
}

function readJson(file: string): unknown {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (e) {
		throw new SheetDataError(
			`${file}: can't read it (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`,
		);
	}
	try {
		return JSON.parse(text);
	} catch (e) {
		throw new SheetDataError(
			`${file}: not valid JSON (${(e as Error).message}); is the file truncated?`,
		);
	}
}

function parseWith<S extends z.ZodType>(schema: S, file: string): z.output<S> {
	const r = schema.safeParse(readJson(file));
	if (r.success) return r.data;
	const issues = r.error.issues
		.slice(0, 5)
		.map((i) => {
			const at = i.path.length ? `${i.path.join(".")}: ` : "";
			return `${at}${i.message}`;
		})
		.join("; ");
	const more =
		r.error.issues.length > 5 ? ` (+${r.error.issues.length - 5} more)` : "";
	throw new SheetDataError(`${file}: ${issues}${more}`);
}

export type LoadOptions = {
	/** `seed/data` (the tab exports and geocode hints). */
	dataDir: string;
	/** `seed/media` (manifest.json and the photos); null skips photos. */
	mediaDir: string | null;
	/** `seed/import/overrides.json`; a missing file means no overrides. */
	overridesFile: string | null;
};

export function loadSheetData(o: LoadOptions): SheetData {
	const at = (f: string) => path.join(o.dataDir, f);
	const overrides =
		o.overridesFile && fileExists(o.overridesFile)
			? parseWith(OverridesFile, o.overridesFile)
			: {};
	return {
		cities: parseWith(CitiesFile, at("cities.json")),
		places: parseWith(PlacesFile, at("places.json")),
		itinerary: parseWith(ItineraryFile, at("itinerary.json")),
		shopping: parseWith(ShoppingFile, at("shopping-list.json")),
		actions: parseWith(ActionTimelineFile, at("action-timeline.json")),
		hints: parseWith(GeocodeHintsFile, at("geocode-hints.json")),
		media: o.mediaDir
			? parseWith(MediaManifestFile, path.join(o.mediaDir, "manifest.json"))
			: [],
		overrides,
	};
}

function fileExists(file: string): boolean {
	try {
		readFileSync(file);
		return true;
	} catch {
		return false;
	}
}
