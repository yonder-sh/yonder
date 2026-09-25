/**
 * `pnpm sheet:import` flags (SPEC §17.3, with the ADDENDUM §8 defaults):
 *
 *   --owner <email>         dennis@dennispham.me
 *   --owner-first <first>   Dennis
 *   --owner-last <last>     "" (blank → /welcome asks at first sign-in)
 *   --start 2027-10-02 --day1 2027-10-03 --end 2027-11-07
 *   --replace               delete an existing trip with the slug first
 *   --dry-run               plan and report only; nothing is written
 *   --remove                delete the trip with the slug (and its photos) instead of importing
 *   --no-geocode-fallback   never call Photon for nodes without a hint
 *   --no-media              skip the 94 photos
 *   --no-action-timeline    skip the Action Timeline todos
 *   --no-random-notes       accepted for compatibility (Random Notes are never imported: ADDENDUM §8)
 *   --no-flight-rows        skip the Action Timeline's Flight and Points rows (SPEC §17.3 step 8).
 *                           They are imported by default: ADDENDUM §8 makes every Action
 *                           Timeline row a due-dated todo, and §10 names the ANA award
 *                           windows (`--flight-rows` is accepted and is the default)
 *   --no-autofill           don't queue leg autofill jobs after the commit
 *   --dump-graph [file]     write the trip graph (default seed/import/asia-2027.graph.json)
 *   --slug <slug> --name <name>          asia-2027 / "Asia 2027"
 *   --data-dir <dir> --media-dir <dir>   seed/data, seed/media
 *   --report <file>         seed/import/last-report.md ("-" = none)
 */
export type ImportArgs = {
	owner: string;
	ownerFirst: string;
	ownerLast: string;
	start: string;
	day1: string;
	end: string;
	replace: boolean;
	dryRun: boolean;
	remove: boolean;
	geocodeFallback: boolean;
	media: boolean;
	actionTimeline: boolean;
	flightRows: boolean;
	autofill: boolean;
	dumpGraph: string | null;
	slug: string;
	name: string;
	dataDir: string;
	mediaDir: string;
	overrides: string;
	report: string | null;
};

export const DEFAULT_GRAPH_FILE = "seed/import/asia-2027.graph.json";

export const DEFAULTS: ImportArgs = {
	owner: "dennis@dennispham.me",
	ownerFirst: "Dennis",
	ownerLast: "",
	start: "2027-10-02",
	day1: "2027-10-03",
	end: "2027-11-07",
	replace: false,
	dryRun: false,
	remove: false,
	geocodeFallback: true,
	media: true,
	actionTimeline: true,
	flightRows: true,
	autofill: true,
	dumpGraph: null,
	slug: "asia-2027",
	name: "Asia 2027",
	dataDir: "seed/data",
	mediaDir: "seed/media",
	overrides: "seed/import/overrides.json",
	report: "seed/import/last-report.md",
};

export class ArgsError extends Error {
	override name = "ArgsError";
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG = /^[a-z0-9-]{1,100}$/;

export function parseImportArgs(argv: readonly string[]): ImportArgs {
	const a: ImportArgs = { ...DEFAULTS };
	const args = argv.filter((x) => x !== "--");
	for (let i = 0; i < args.length; i++) {
		const flag = args[i] as string;
		const value = (): string => {
			const v = args[i + 1];
			if (v === undefined || v.startsWith("--"))
				throw new ArgsError(`${flag} needs a value`);
			i++;
			return v;
		};
		switch (flag) {
			case "--owner":
				a.owner = value().trim().toLowerCase();
				break;
			case "--owner-first":
				a.ownerFirst = value();
				break;
			case "--owner-last":
				a.ownerLast = value();
				break;
			case "--start":
				a.start = value();
				break;
			case "--day1":
				a.day1 = value();
				break;
			case "--end":
				a.end = value();
				break;
			case "--replace":
				a.replace = true;
				break;
			case "--dry-run":
				a.dryRun = true;
				break;
			case "--remove":
				a.remove = true;
				break;
			case "--no-geocode-fallback":
				a.geocodeFallback = false;
				break;
			case "--no-media":
				a.media = false;
				break;
			case "--no-action-timeline":
				a.actionTimeline = false;
				break;
			case "--no-random-notes":
				break;
			case "--flight-rows":
				a.flightRows = true;
				break;
			case "--no-flight-rows":
				a.flightRows = false;
				break;
			case "--no-autofill":
				a.autofill = false;
				break;
			case "--dump-graph": {
				const next = args[i + 1];
				if (next && !next.startsWith("--")) {
					a.dumpGraph = next;
					i++;
				} else a.dumpGraph = DEFAULT_GRAPH_FILE;
				break;
			}
			case "--slug":
				a.slug = value();
				break;
			case "--name":
				a.name = value();
				break;
			case "--data-dir":
				a.dataDir = value();
				break;
			case "--media-dir":
				a.mediaDir = value();
				break;
			case "--overrides":
				a.overrides = value();
				break;
			case "--report": {
				const v = value();
				a.report = v === "-" ? null : v;
				break;
			}
			case "--help":
			case "-h":
				throw new ArgsError("help");
			default:
				throw new ArgsError(`unknown flag ${flag}`);
		}
	}
	if (!EMAIL.test(a.owner))
		throw new ArgsError(`--owner "${a.owner}" is not an email address`);
	if (!a.ownerFirst.trim()) throw new ArgsError("--owner-first can't be blank");
	for (const [k, v] of [
		["--start", a.start],
		["--day1", a.day1],
		["--end", a.end],
	] as const)
		if (!ISO.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))
			throw new ArgsError(`${k} "${v}" is not a YYYY-MM-DD date`);
	if (!(a.start <= a.day1 && a.day1 <= a.end))
		throw new ArgsError(
			`dates must satisfy start ≤ day1 ≤ end (got ${a.start}, ${a.day1}, ${a.end})`,
		);
	const days = (Date.parse(a.end) - Date.parse(a.start)) / 86_400_000 + 1;
	if (days > 366)
		throw new ArgsError(`the trip can't be longer than 366 days (got ${days})`);
	if (!SLUG.test(a.slug) || a.slug === "rate")
		throw new ArgsError(
			`--slug "${a.slug}" must be lowercase letters, digits and dashes`,
		);
	if (!a.name.trim() || a.name.length > 200)
		throw new ArgsError("--name must be 1–200 characters");
	return a;
}

/** The flags that differ from the defaults, for the report. */
export function describeArgs(a: ImportArgs): string[] {
	const out: string[] = [];
	for (const [k, v] of Object.entries(a) as [
		keyof ImportArgs,
		ImportArgs[keyof ImportArgs],
	][]) {
		if (v === DEFAULTS[k]) continue;
		const flag = `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
		if (typeof v === "boolean") {
			if (k === "replace" || k === "dryRun" || k === "remove") out.push(flag);
			else out.push(`--no-${flag.slice(2)}`);
		} else out.push(`${flag} ${v ?? "-"}`);
	}
	return out;
}
