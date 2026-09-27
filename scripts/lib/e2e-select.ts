/**
 * Which e2e tests to run short of the full suite (`pnpm e2e:fast --smoke`,
 * `--affected [ref]`):
 *   - SMOKE: about 110 fast, stable tests across the main flows (sign in, the
 *     Overview, a day's plan, Rate → Review → Schedule, money, lists, notes,
 *     media, sharing, live collab, the map), plus the phone basics. About 6
 *     minutes on 2 envs.
 *   - affected: the smoke set, plus every spec that imports from a feature a
 *     change touched (`src/features/<feature>/`, its test ids mostly), plus
 *     changed specs themselves. A change anywhere else in src brings the
 *     smoke set only.
 * Playwright matches `--grep` against "<project> <file> <describe…> <title>".
 */

export type SmokeEntry = {
	/** The spec file under e2e/tests/app. */
	spec: string;
	/** Alternatives of test titles (a regex); none = the whole file. */
	grep?: string;
	/** Run it on the phone project instead of desktop. */
	phone?: boolean;
};

export const SMOKE: SmokeEntry[] = [
	// Sign in, landing, onboarding
	{ spec: "landing.spec.ts" },
	{
		spec: "qa-home-auth.spec.ts",
		grep: "AUTH-01:|AUTH-04/10|AUTH-06:|AUTH-12/13",
	},
	{ spec: "foundation-onboarding.spec.ts" },
	{
		spec: "onboarding.spec.ts",
		grep: "the Overview's checklist|a guest through the link",
	},
	// Dashboard, opening a trip
	{ spec: "home-dashboard.spec.ts" },
	{ spec: "qa-home-dash.spec.ts", grep: "DASH-01/02|TRIP-05" },
	{
		spec: "foundation-workspace.spec.ts",
		grep: "unknown scope path|shows the not-found view|cross-site POST",
	},
	{ spec: "home-settings.spec.ts" },
	// Overview
	{
		spec: "overview.spec.ts",
		grep: "desktop: a trip link lands|\\?asOf shows|a stay on the route strip|view-link guest lands",
	},
	// Plan
	{
		spec: "plan-timeline.spec.ts",
		grep: "card times equal|a pin conflict|booked for this date|dropping a stop between|drag to reorder within a day|unschedule and reschedule|day range, person filter|a viewer link sees the plan",
	},
	{ spec: "transit-flights.spec.ts" },
	{ spec: "transit-japan.spec.ts", grep: "custom Shinkansen" },
	{
		spec: "insights-whatif.spec.ts",
		grep: "\\+1 day lists|new closures show before",
	},
	{ spec: "insights-hours.spec.ts", grep: "a closure shows on the card" },
	// Places: rate, review, schedule
	{
		spec: "places-flow.spec.ts",
		grep: "the step bar|rating from the Rate step|Schedule puts a shortlisted",
	},
	{
		spec: "places-overview.spec.ts",
		grep: "priorities persist|Tokyo's overview lists|days-per-city",
	},
	{
		spec: "places-search.spec.ts",
		grep: "Itoya Ginza through Photon|Schedule inserts the new place|a viewer can't use the provider|shared Google Maps link resolves",
	},
	{
		spec: "places-tab.spec.ts",
		grep: "table: group, sort|the board shares|map: picking a row",
	},
	{ spec: "home-can-rate.spec.ts", grep: 'joins with the "Can rate" link' },
	// Money
	{ spec: "money-tab.spec.ts" },
	{
		spec: "money-editor.spec.ts",
		grep: "MONEY-14|MONEY-15|MONEY-12|free-text people|MONEY-10",
	},
	{ spec: "money-overview.spec.ts", grep: "root, Japan, settle-up" },
	// Lists and notes
	{
		spec: "lists-core.spec.ts",
		grep: "the MAIN list|a private item is only|a suggester: an assignee|a shopping item says|the inspector rolls up|a wide panel shows",
	},
	{
		spec: "lists-notes.spec.ts",
		grep: "two people write one note|a viewer reads live|a visit keeps its own note",
	},
	{ spec: "foundation-realtime.spec.ts" },
	// Media
	{ spec: "media-gallery.spec.ts" },
	{
		spec: "media-people.spec.ts",
		grep: "sees adds and deletes live|a guest editor can upload|TikTok, Reels",
	},
	{ spec: "media-rules.spec.ts", grep: "refuses bad files|drop to attach" },
	{ spec: "media-quota.spec.ts" },
	// Sharing and roles
	{
		spec: "home-sharing.spec.ts",
		grep: "the owner invites|FB-13|removing a member",
	},
	{
		spec: "trip-link.spec.ts",
		grep: "a member opens the trip's address|signed out: the link's role|Copy link copies",
	},
	{ spec: "foundation-share.spec.ts" },
	{ spec: "share-card.spec.ts" },
	{
		spec: "home-share-target.spec.ts",
		grep: "a pasted Maps link becomes an idea",
	},
	// Live collab and suggestions
	{ spec: "qa-collab-realtime.spec.ts", grep: "RT-04/05" },
	{ spec: "qa-collab-r3.spec.ts", grep: "RT-08" },
	{
		spec: "suggest-live.spec.ts",
		grep: "accept from the card|a view-link guest sees no suggestion UI",
	},
	{ spec: "shell-inbox.spec.ts", grep: "a mention lights the bell" },
	{ spec: "cursors-live.spec.ts", grep: "cursor chat and emoji" },
	// Map
	{
		spec: "map-core.spec.ts",
		grep: "pins select and zoom in|a view-only link guest gets the same map",
	},
	// Phone
	{
		spec: "overview.spec.ts",
		grep: "phone: the Overview is the sheet",
		phone: true,
	},
	{
		spec: "plan-timeline.spec.ts",
		grep: "mobile: the plan in the sheet",
		phone: true,
	},
	{ spec: "money-tab.spec.ts", grep: "mobile: fast entry", phone: true },
	{
		spec: "lists-core.spec.ts",
		grep: "mobile: the Lists tab in the sheet",
		phone: true,
	},
	{ spec: "places-flow.spec.ts", grep: "phone: the ★ Rate pill", phone: true },
	{
		spec: "places-search.spec.ts",
		grep: "palette is full-screen on phones",
		phone: true,
	},
	{ spec: "map-core.spec.ts", grep: "on a phone, tapping a pin", phone: true },
	{
		spec: "shell-workspace.spec.ts",
		grep: "mobile: the sheet, the FAB menu",
		phone: true,
	},
	{
		spec: "transit-japan.spec.ts",
		grep: "mobile: the leg editor fits",
		phone: true,
	},
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Playwright args for these entries: their spec files, then one `--grep`. */
export function smokeArgs(entries: SmokeEntry[] = SMOKE): string[] {
	const specs = [...new Set(entries.map((e) => `tests/app/${e.spec}`))];
	const alts = entries.map(
		(e) =>
			`^${e.phone ? "mobile" : "chromium"} ${esc(e.spec)} ${e.grep ? `.*(${e.grep})` : ""}`,
	);
	return [...specs, "--grep", alts.map((a) => `(${a})`).join("|")];
}

/** The smoke set's args, widened to every test in the `touched` specs. */
export function selectionArgs(
	touched: readonly string[] = [],
	entries: SmokeEntry[] = SMOKE,
): string[] {
	const smoke = smokeArgs(entries);
	const files = smoke.slice(0, -2);
	const grep = smoke.at(-1) as string;
	return [
		...new Set([...files, ...touched.map((f) => `tests/app/${f}`)]),
		"--grep",
		[grep, ...touched.map((f) => `(^(chromium|mobile) ${esc(f)} )`)].join("|"),
	];
}

/** `src/features/places/tab/X.tsx` → "places"; null outside src/features. */
export function featureOf(file: string): string | null {
	return file.match(/^src\/features\/([^/]+)\//)?.[1] ?? null;
}

/** The features a spec imports from (`…/src/features/<feature>/…`). */
export function specFeatures(specText: string): Set<string> {
	const out = new Set<string>();
	for (const m of specText.matchAll(
		/from\s+"[^"]*\bsrc\/features\/([^/"]+)\//g,
	))
		out.add(m[1] as string);
	return out;
}

/**
 * The specs a change touches: changed specs, and specs importing from a
 * changed feature. `specs` maps a spec's file name to its text.
 */
export function affectedSpecs(
	changed: readonly string[],
	specs: Readonly<Record<string, string>>,
): string[] {
	const features = new Set(
		changed.map(featureOf).filter((f): f is string => !!f),
	);
	const out = new Set<string>();
	for (const f of changed) {
		const m = f.match(/^e2e\/tests\/app\/([^/]+\.spec\.ts)$/);
		if (m && (m[1] as string) in specs) out.add(m[1] as string);
	}
	for (const [name, text] of Object.entries(specs))
		for (const f of specFeatures(text)) if (features.has(f)) out.add(name);
	return [...out].sort();
}
