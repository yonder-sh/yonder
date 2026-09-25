/** `seed/import/last-report.md` (SPEC §17.3 step 12): counts, matching, geocoding, the Action Timeline mapping. */
import type { ImportPlan } from "./plan";

export type RunFacts = {
	owner: { email: string; created: boolean };
	tripId: string;
	slug: string;
	replacedTripId: string | null;
	photosUploaded: number;
	geocodeFallbacks: string[];
	autofillJobs: number | null;
	dryRun: boolean;
	durationMs: number;
	flags: string[];
};

const COUNT_LABELS: Record<string, string> = {
	countries: "Countries",
	citiesAndRegions: "Cities and regions",
	citiesDropped: "… of which dropped",
	areas: "Areas (wards, neighbourhoods)",
	places: "Places",
	nodes: "Nodes in total",
	priorities: "Ratings (Dennis + Audrey)",
	days: "Days",
	itemsScheduled: "Scheduled items",
	itemsUnscheduled: "Unscheduled items (Tokyo backup)",
	legs: "Legs from Travel rows",
	todos: "Todos",
	todosBookAhead: '… "Book ahead"',
	todosActionTimeline: "… from the Action Timeline",
	todosRelative: "… with a relative booking window",
	shopping: "Shopping items",
	shoppingExtraTargets: "Extra candidate shops",
	links: "Link attachments",
	linksOnListItems: "Links on shopping items",
	photos: "Photos (planned)",
	notes: "Notes (Markdown → Yjs)",
};

export function renderReport(plan: ImportPlan, run: RunFacts): string {
	const r = plan.report;
	const lines: string[] = [];
	const p = (s = "") => lines.push(s);
	p(`# Asia 2027 import report`);
	p();
	p(
		`${run.dryRun ? "**Dry run** (nothing written). " : ""}Trip \`${run.slug}\` (${run.tripId}) for ${run.owner.email}${run.owner.created ? " (new user)" : ""}, ${plan.trip.startDate} → ${plan.trip.endDate}, Day 1 = ${plan.days.find((d) => d.title?.startsWith("Tokyo"))?.date ?? "?"}.`,
	);
	if (run.replacedTripId)
		p(`Replaced the previous import (${run.replacedTripId}).`);
	p(
		`Flags: ${run.flags.length ? run.flags.map((f) => `\`${f}\``).join(" ") : "(defaults)"}. Took ${(run.durationMs / 1000).toFixed(1)} s.`,
	);
	p();
	p(`## Counts`);
	p();
	p(`| What | Count |`);
	p(`|---|---:|`);
	for (const [k, v] of Object.entries(r.counts))
		p(`| ${COUNT_LABELS[k] ?? k} | ${v} |`);
	p(`| Photos uploaded | ${run.photosUploaded} |`);
	p(`| Autofill jobs queued | ${run.autofillJobs ?? "—"} |`);
	p();
	p(`## Geocoding`);
	p();
	p(
		`${r.geocode.fromHints} nodes from \`geocode-hints.json\`, ${r.geocode.overrides} from \`overrides.json\`, ${r.geocode.aliases} from itinerary aliases; **${run.geocodeFallbacks.length} Photon fallbacks**.`,
	);
	if (run.geocodeFallbacks.length)
		for (const f of run.geocodeFallbacks) p(`- fallback: ${f}`);
	if (r.geocode.misses.length) {
		p();
		p(`Without a hint:`);
		for (const m of r.geocode.misses) p(`- ${m}`);
	}
	p();
	p(`## Created (not a row of its own in the sheet)`);
	p();
	if (!r.created.length) p(`Nothing.`);
	for (const c of r.created) p(`- ${c}`);
	p();
	p(`## Unmatched`);
	p();
	if (!r.unmatched.length) p(`Nothing: every row found its place.`);
	for (const u of r.unmatched) p(`- ${u}`);
	p();
	p(`## Action Timeline`);
	p();
	if (!r.actionTimeline.length) p(`Skipped (\`--no-action-timeline\`).`);
	else {
		p(`| Row | What | Attached to | Due / opens | Rule |`);
		p(`|---:|---|---|---|---|`);
		for (const a of r.actionTimeline)
			p(
				`| ${a.row} | ${a.what.replace(/\|/g, "\\|")} | ${a.target} | ${a.due} | ${(a.rule ?? "").replace(/\|/g, "\\|")} |`,
			);
	}
	p();
	p(`## Times from the sheet's words`);
	p();
	p(
		`The Itinerary has no time column: every day starts at 09:00 except where a row says when (\`scripts/sheet/lib/times.ts\`).`,
	);
	p();
	for (const t of r.times)
		p(
			`- ${t.applied ? "" : "**Skipped** (the row no longer says it): "}${t.what} ("${t.quote}")`,
		);
	p();
	p(`## Notes`);
	p();
	for (const n of r.notes) p(`- ${n}`);
	p();
	return `${lines.join("\n")}\n`;
}
