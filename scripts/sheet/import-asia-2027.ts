/**
 * The Asia 2027 import (SPEC §17.3 as overridden by ADDENDUM §8 and §10):
 * reads `seed/data/*.json` (+ geocode hints, `seed/media` photos with their
 * manifest) and creates the trip `asia-2027-<random tail>` (the address is
 * the share link, `src/lib/trip-slug.ts`; `--replace` keeps the replaced
 * trip's address) for dennis@dennispham.me in ONE
 * transaction, then queues leg autofill and writes `seed/import/last-report.md`.
 *
 *   N pnpm sheet:import                               # defaults: ADDENDUM §8 owner and dates
 *   N pnpm sheet:import --replace --dump-graph        # re-import; write seed/import/asia-2027.graph.json
 *   N pnpm sheet:import --dry-run --no-media          # plan + report only
 *
 * Flags: see `scripts/sheet/lib/args.ts`. Without `--replace` it refuses when
 * the slug exists. Exit code 1 on any failure, with a message naming the
 * problem (a bad input file names the file).
 */
import { closeQueues } from "../../src/server/live/jobs.server";
import { run } from "../lib/lifecycle";
import { ArgsError, DEFAULTS, parseImportArgs } from "./lib/args";
import { removeImport, runImport } from "./lib/run";

const USAGE = `usage: pnpm sheet:import [--owner <email>] [--owner-first <first>] [--owner-last <last>]
  [--start ${DEFAULTS.start}] [--day1 ${DEFAULTS.day1}] [--end ${DEFAULTS.end}]
  [--replace] [--dry-run] [--remove] [--no-geocode-fallback] [--no-media] [--no-action-timeline]
  [--flight-rows] [--no-autofill] [--dump-graph [file]] [--slug asia-2027] [--name "Asia 2027"]
  [--data-dir seed/data] [--media-dir seed/media] [--overrides file] [--report file|-]`;

let args: ReturnType<typeof parseImportArgs>;
try {
	args = parseImportArgs(process.argv.slice(2));
} catch (e) {
	if (e instanceof ArgsError) {
		if (e.message !== "help") console.error(`[sheet:import] ${e.message}`);
		console.error(USAGE);
		process.exit(e.message === "help" ? 0 : 2);
	}
	throw e;
}

run("sheet:import", async () => {
	if (args.remove) {
		const id = await removeImport(args.slug, undefined, args.owner);
		console.log(
			`[sheet:import] ${id ? `removed trip ${args.slug} (${id})` : `no trip ${args.slug}`}`,
		);
		return;
	}
	const r = await runImport(args).finally(() => closeQueues());
	const c = r.plan.report.counts;
	console.log(
		`[sheet:import] ${r.facts.dryRun ? "dry run: " : ""}${c.nodes} nodes (${c.countries} countries, ${c.citiesAndRegions} cities/regions, ${c.areas} areas, ${c.places} places), ` +
			`${c.itemsScheduled}+${c.itemsUnscheduled} items, ${c.legs} legs, ${c.todos} todos, ${c.shopping} shopping, ${c.links} links, ${r.facts.photosUploaded} photos; ` +
			`${r.facts.geocodeFallbacks.length} geocode fallbacks, ${r.plan.report.unmatched.length} unmatched`,
	);
	if (args.report) console.log(`[sheet:import] report: ${args.report}`);
	if (!r.facts.dryRun)
		console.log(`[sheet:import] open /t/${r.slug} as ${args.owner}`);
});
