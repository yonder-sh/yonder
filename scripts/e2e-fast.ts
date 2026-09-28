/**
 * `pnpm e2e:fast [--envs N] [--rebuild] [--keep] [--baseline <file>] [playwright args…]`
 *
 * The whole app e2e suite on N isolated app envs at once (e2e/README.md,
 * "Fast full run"):
 *   1. the template database (scripts/e2e-template.ts), rebuilt only when stale;
 *   2. N clones of it (`create database … template trip_e2e_tmpl`), each with
 *      its own ports, bucket, Redis prefix, outbox and log (scripts/lib/e2e-fast.ts);
 *   3. N app envs (vite dev + collab with the worker in-process);
 *   4. Playwright with one worker per env (e2e/playwright.fast.config.ts):
 *      worker slot i talks to env i+1 only and resets it to the template
 *      before each spec file;
 *   5. servers stopped (Ctrl-C included) and a summary printed.
 *
 *   --envs N        how many envs/workers (default: E2E_FAST_ENVS, else 4),
 *                   capped by memory: floor((available GB - 16) / 2); it
 *                   refuses to start below 20 GB available, and stops the
 *                   run if the machine drops below 5 GB available
 *   --rebuild       rebuild the template even when it looks current
 *   --keep          leave the envs running after the run (stop: kill the pids
 *                   in .data/e2e-fast/pids.json, or run again)
 *   --baseline F    also list which failures are not in F (`project | file | title`)
 *   --smoke         only the smoke set (scripts/lib/e2e-select.ts, about 6 min)
 *   --affected [R]  the smoke set plus the specs a change since git ref R
 *                   (default HEAD, uncommitted work included) touches
 *   --frozen        run from a worktree at HEAD (../trip-planner-e2e), so the
 *                   repo can keep changing meanwhile (scripts/lib/e2e-frozen.ts)
 *   --record-map    fill the basemap cache (the main checkout's
 *                   .data/e2e-fast/map-cache) with what the run browses,
 *                   fetched once from OpenFreeMap and Esri
 *                   (`pnpm e2e:tiles:warm`); every other run only reads it
 * E2E_FAST_SLOT=1…3 runs beside another run (its own envs, ports, services
 * stub and files);
 * E2E_FAST_MIN_GB lowers the 20 GB it needs to start.
 * Anything else goes to `playwright test` (spec files, --project, -g, --retries…).
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { ensureTemplate } from "./e2e-template";
import {
	clearRedisPrefix,
	ENVS_FILE,
	ensurePostgres,
	FAST_DIR,
	type FastEnv,
	fastEnv,
	freshBucket,
	killAllSync,
	memAvailableGb,
	printOfflineReport,
	REPO_ROOT,
	type Running,
	type StubStats,
	sourceEnv,
	startEnv,
	startServicesStub,
	stopAll,
	stopPostgres,
	stubStats,
	TEMPLATE_DB,
	VITE_BASE_CACHE,
	waitHealthy,
	withPg,
	withRedis,
	writeJson,
} from "./lib/e2e-fast";
import { runFrozen } from "./lib/e2e-frozen";
import {
	affectedByTestIds,
	parseTestIds,
	SMOKE,
	selectionArgs,
} from "./lib/e2e-select";

/**
 * E2E_FAST_SLOT=k (0…3): a run beside another one (a background suite and a
 * kept env to work against), on envs 10k+1… with its own ports, databases,
 * and pids, envs and report files.
 */
const SLOT = Number(process.env.E2E_FAST_SLOT ?? 0);
if (!Number.isInteger(SLOT) || SLOT < 0 || SLOT > 3)
	throw new Error(
		`E2E_FAST_SLOT must be 0…3, got ${process.env.E2E_FAST_SLOT}`,
	);
const slotFile = (name: string) =>
	path.join(FAST_DIR, SLOT ? `${name}-${SLOT}.json` : `${name}.json`);
const REPORT_FILE = slotFile("report");
const PIDS_FILE = slotFile("pids");
const SLOT_ENVS_FILE = SLOT ? slotFile("envs") : ENVS_FILE;
/**
 * Memory budget (the machine is shared with the owner's own work). Measured
 * with 6 envs under load: vite dev ~1.6 GB each, collab+worker ~0.35 GB, and
 * per Playwright worker ~0.35 GB plus its Chromium 0.6-1.9 GB (multi-user
 * specs with maps peak high): 3-4 GB per env at peaks.
 */
const DEFAULT_ENVS = 4;
const GB_PER_ENV = 2;
const RESERVE_GB = 16;
const MIN_AVAILABLE_GB = Number(process.env.E2E_FAST_MIN_GB ?? 20);
const ABORT_BELOW_GB = Number(process.env.E2E_FAST_ABORT_BELOW_GB ?? 5);

type Args = {
	envs?: number;
	rebuild: boolean;
	keep: boolean;
	baseline?: string;
	smoke: boolean;
	recordMap: boolean;
	/** A git ref, for `--affected`. */
	affected?: string;
	pw: string[];
};

function parseArgs(argv: string[]): Args {
	const a: Args = {
		rebuild: false,
		keep: false,
		smoke: false,
		recordMap: false,
		pw: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const x = argv[i] as string;
		if (x === "--") continue;
		if (x === "--envs") a.envs = Number(argv[++i]);
		else if (x.startsWith("--envs=")) a.envs = Number(x.slice(7));
		else if (x === "--rebuild") a.rebuild = true;
		else if (x === "--keep") a.keep = true;
		else if (x === "--baseline") a.baseline = argv[++i];
		else if (x.startsWith("--baseline=")) a.baseline = x.slice(11);
		else if (x === "--smoke") a.smoke = true;
		else if (x === "--record-map") a.recordMap = true;
		else if (x === "--affected")
			a.affected =
				argv[i + 1]?.startsWith("-") || !argv[i + 1]
					? "HEAD"
					: (argv[++i] as string);
		else if (x.startsWith("--affected=")) a.affected = x.slice(11);
		else a.pw.push(x);
	}
	return a;
}

function assertMemory(what: string): number {
	const free = memAvailableGb();
	if (free < MIN_AVAILABLE_GB)
		throw new Error(
			`only ${free.toFixed(1)} GB of memory available; ${what} needs at least ${MIN_AVAILABLE_GB} GB (the envs are vite dev servers)`,
		);
	return free;
}

/** min(requested or 4, floor((available GB - 16) / 2)), at least 1. */
function pickEnvCount(requested?: number): number {
	const fromEnv = process.env.E2E_FAST_ENVS
		? Number(process.env.E2E_FAST_ENVS)
		: undefined;
	const want = requested ?? fromEnv ?? DEFAULT_ENVS;
	if (!Number.isInteger(want) || want < 1 || want > 40)
		throw new Error(`--envs must be 1…40, got ${want}`);
	const free = assertMemory("starting the envs");
	const byMem = Math.max(1, Math.floor((free - RESERVE_GB) / GB_PER_ENV));
	const n = Math.min(want, byMem);
	console.log(
		`[e2e:fast] ${free.toFixed(1)} GB available → ${n} env(s)${n < want ? ` (asked for ${want}; memory allows ${byMem})` : ""}`,
	);
	return n;
}

function portInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const s = createConnection({ port, host: "localhost" });
		s.once("connect", () => {
			s.destroy();
			resolve(true);
		});
		s.once("error", () => resolve(false));
	});
}

/** Stops envs a `--keep` run (or a crashed one) left behind. */
function stopLeftovers(): void {
	if (!existsSync(PIDS_FILE)) return;
	try {
		const pids = JSON.parse(readFileSync(PIDS_FILE, "utf8")) as number[];
		for (const pid of pids)
			try {
				process.kill(-pid, "SIGKILL");
			} catch {}
	} catch {}
	rmSync(PIDS_FILE, { force: true });
}

async function cloneEnv(e: FastEnv): Promise<void> {
	await withPg("postgres", async (c) => {
		await c.query(`drop database if exists ${e.db} with (force)`);
		await c.query(`create database ${e.db} template ${TEMPLATE_DB}`);
	});
	rmSync(e.dir, { recursive: true, force: true });
	await freshBucket(e);
	if (existsSync(path.join(VITE_BASE_CACHE, "deps/_metadata.json")))
		cpSync(VITE_BASE_CACHE, path.join(e.dir, "vite-cache"), {
			recursive: true,
		});
}

// ---------------------------------------------------------------------------
// Summary (Playwright's JSON report)
// ---------------------------------------------------------------------------

type JsonSuite = {
	title: string;
	file?: string;
	suites?: JsonSuite[];
	specs?: JsonSpec[];
};
type JsonSpec = {
	title: string;
	file: string;
	line: number;
	tests: { projectName: string; status: string }[];
};
type JsonReport = {
	stats?: {
		expected: number;
		unexpected: number;
		flaky: number;
		skipped: number;
		duration: number;
	};
	suites?: JsonSuite[];
	errors?: { message?: string }[];
};

function collect(
	suites: JsonSuite[] | undefined,
	prefix: string[],
	out: { key: string; status: string }[],
): void {
	for (const s of suites ?? []) {
		const titles = s.file && s.title === s.file ? prefix : [...prefix, s.title];
		for (const spec of s.specs ?? [])
			for (const t of spec.tests)
				out.push({
					key: `${t.projectName} | tests/app/${spec.file.replace(/^.*?tests\/app\//, "")} | ${[...titles, spec.title].join(" › ")}`,
					status: t.status,
				});
		collect(s.suites, titles, out);
	}
}

function summarize(wallMs: number, baseline?: string): void {
	const fmt = (ms: number) =>
		`${Math.floor(ms / 60000)}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s`;
	console.log(`\n[e2e:fast] wall time ${fmt(wallMs)}`);
	if (!existsSync(REPORT_FILE)) {
		console.log("[e2e:fast] no JSON report (Playwright did not finish)");
		return;
	}
	const r = JSON.parse(readFileSync(REPORT_FILE, "utf8")) as JsonReport;
	const s = r.stats;
	if (s)
		console.log(
			`[e2e:fast] ${s.expected} passed, ${s.unexpected} failed, ${s.flaky} flaky, ${s.skipped} skipped (Playwright ${fmt(s.duration)})`,
		);
	for (const e of r.errors ?? [])
		console.log(`[e2e:fast] error: ${(e.message ?? "").split("\n")[0]}`);
	const all: { key: string; status: string }[] = [];
	collect(r.suites, [], all);
	const failed = all.filter((t) => t.status === "unexpected").map((t) => t.key);
	const flaky = all.filter((t) => t.status === "flaky").map((t) => t.key);
	const known =
		baseline && existsSync(baseline)
			? new Set(
					readFileSync(baseline, "utf8")
						.split("\n")
						.map((l) => l.trim()),
				)
			: null;
	if (failed.length) {
		console.log(`\n[e2e:fast] failed (${failed.length}):`);
		for (const f of failed.sort())
			console.log(`  ${known && !known.has(f) ? "NEW " : ""}${f}`);
	}
	if (flaky.length) {
		console.log(`\n[e2e:fast] flaky (${flaky.length}):`);
		for (const f of flaky.sort()) console.log(`  ${f}`);
	}
	if (known) {
		const fresh = failed.filter((f) => !known.has(f));
		const fixed = [...known].filter(
			(k) =>
				k &&
				all.some(
					(t) =>
						t.key === k && (t.status === "expected" || t.status === "flaky"),
				),
		);
		console.log(
			`\n[e2e:fast] vs baseline: ${fresh.length} new failure(s), ${fixed.length} baseline failure(s) now pass`,
		);
	}
	console.log(
		`[e2e:fast] report: e2e/playwright-report/fast (bash e2e/pw.sh playwright show-report playwright-report/fast)`,
	);
}

// ---------------------------------------------------------------------------

/** Playwright args for `--smoke` / `--affected` (printed so the run says what it covers). */
function selection(args: Args): string[] {
	if (!args.smoke && !args.affected) return [];
	if (!args.affected) {
		console.log(`[e2e:fast] --smoke: ${SMOKE.length} entries`);
		return selectionArgs();
	}
	const git = (...a: string[]) =>
		execFileSync("git", a, { cwd: REPO_ROOT, encoding: "utf8" })
			.split("\n")
			.filter(Boolean);
	const changed = [
		...git("diff", "--name-only", args.affected),
		...git("ls-files", "--others", "--exclude-standard"),
	];
	const dir = path.join(REPO_ROOT, "e2e/tests/app");
	const specs = Object.fromEntries(
		readdirSync(dir)
			.filter((f) => f.endsWith(".spec.ts"))
			.map((f) => [f, readFileSync(path.join(dir, f), "utf8")]),
	);
	const read = (f: string) => {
		try {
			return readFileSync(path.join(REPO_ROOT, f), "utf8");
		} catch {
			return "";
		}
	};
	const ids = new Map<string, string>();
	for (const f of execFileSync("git", ["ls-files", "src/**/testids.ts"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean))
		for (const [k, v] of parseTestIds(read(f))) ids.set(k, v);
	const touched = affectedByTestIds(
		Object.fromEntries(changed.map((f) => [f, read(f)])),
		specs,
		ids,
	);
	console.log(
		`[e2e:fast] --affected ${args.affected}: ${changed.length} changed files → smoke + ${touched.length} specs${touched.length ? ` (${touched.join(", ")})` : ""}`,
	);
	return selectionArgs(touched);
}

async function main(): Promise<number> {
	if (process.argv.includes("--frozen"))
		return runFrozen(process.argv.slice(2));
	const args = parseArgs(process.argv.slice(2));
	args.pw = [...selection(args), ...args.pw];
	const t0 = Date.now();
	stopLeftovers();
	assertMemory("e2e:fast");
	const startedPg = await ensurePostgres();
	const stopStub = await startServicesStub({ recordMap: args.recordMap });
	try {
		return await run(args, t0, await stubStats());
	} finally {
		stopStub();
		if (!args.keep && startedPg) stopPostgres();
	}
}

async function run(
	args: Args,
	t0: number,
	stubBefore: StubStats | null,
): Promise<number> {
	const builtTemplate = await ensureTemplate({ force: args.rebuild });

	const source = sourceEnv();
	const n = pickEnvCount(args.envs);
	if (n > 10) throw new Error("at most 10 envs per slot");
	const envs = Array.from({ length: n }, (_, i) =>
		fastEnv(SLOT * 10 + i + 1, source),
	);
	const ports = envs.flatMap((e) => [Number(e.env.APP_PORT), e.collabPort]);
	const busyNow = async () =>
		(
			await Promise.all(
				ports.map(async (p) => ((await portInUse(p)) ? p : null)),
			)
		).filter((p) => p !== null);
	// Envs stopped a moment ago (stopLeftovers) take a few seconds to let go.
	let busy = await busyNow();
	for (let i = 0; busy.length && i < 20; i++) {
		await new Promise((r) => setTimeout(r, 500));
		busy = await busyNow();
	}
	if (busy.length)
		throw new Error(
			`ports already in use: ${busy.join(", ")} (another e2e:fast run? see ${PIDS_FILE})`,
		);

	const t1 = Date.now();
	for (const e of envs) await cloneEnv(e);
	await withRedis(async (r) => {
		for (const e of envs)
			await clearRedisPrefix(r, e.env.REDIS_PREFIX as string);
	}, source.REDIS_URL);
	console.log(
		`[e2e:fast] ${n} databases cloned from ${TEMPLATE_DB} in ${((Date.now() - t1) / 1000).toFixed(1)} s`,
	);

	const running: Running[] = [];
	let stopping = false;
	const cleanup = async () => {
		if (args.keep) return;
		await stopAll(running);
		rmSync(PIDS_FILE, { force: true });
	};
	process.on("exit", () => {
		if (!args.keep) killAllSync(running);
	});
	let pw: ReturnType<typeof spawn> | undefined;
	// The machine is shared: stop everything before it runs out of memory.
	const watchdog = setInterval(() => {
		const free = memAvailableGb();
		if (free >= ABORT_BELOW_GB || stopping) return;
		stopping = true;
		console.log(
			`\n[e2e:fast] only ${free.toFixed(1)} GB of memory left: stopping the run`,
		);
		pw?.kill("SIGINT");
		setTimeout(() => killAllSync(running), 15_000).unref();
	}, 2000);
	watchdog.unref();
	const onSignal = (sig: NodeJS.Signals) => {
		if (stopping) {
			killAllSync(running);
			process.exit(130);
		}
		stopping = true;
		console.log(
			`\n[e2e:fast] ${sig}: stopping Playwright and the envs (again to force)`,
		);
		pw?.kill("SIGINT");
		if (!pw) void cleanup().then(() => process.exit(130));
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	const t2 = Date.now();
	for (const e of envs)
		running.push(startEnv(e, { viteCache: path.join(e.dir, "vite-cache") }));
	writeJson(
		PIDS_FILE,
		running.flatMap((r) => r.procs.map((p) => p.pid)),
	);
	await Promise.all(running.map((r) => waitHealthy(r)));
	console.log(
		`[e2e:fast] ${n} envs healthy in ${((Date.now() - t2) / 1000).toFixed(1)} s (ports ${envs[0]?.env.APP_PORT}…${envs.at(-1)?.env.APP_PORT})`,
	);
	if (stopping) {
		await cleanup();
		return 130;
	}

	// What Playwright's workers read (e2e/tests/app/_helpers/fast-env.ts). No
	// secrets: the config loads the rest from .env.
	writeJson(SLOT_ENVS_FILE, {
		report: REPORT_FILE,
		envs: envs.map((e) => ({
			name: e.name,
			appUrl: e.appUrl,
			env: e.overrides,
		})),
	});

	rmSync(REPORT_FILE, { force: true });
	const t3 = Date.now();
	const code = await new Promise<number>((resolve) => {
		pw = spawn(
			"bash",
			[
				"e2e/pw.sh",
				"playwright",
				"test",
				"-c",
				"playwright.fast.config.ts",
				...args.pw,
			],
			{
				cwd: REPO_ROOT,
				stdio: "inherit",
				env: { ...process.env, E2E_FAST_ENVS_FILE: SLOT_ENVS_FILE },
			},
		);
		pw.on("exit", (c, sig) => resolve(c ?? (sig ? 130 : 1)));
	});
	console.log(
		`[e2e:fast] playwright exited ${code} after ${((Date.now() - t3) / 1000).toFixed(0)} s`,
	);
	clearInterval(watchdog);
	await cleanup();
	if (args.keep)
		console.log(
			`[e2e:fast] --keep: envs still running (pids in ${path.relative(REPO_ROOT, PIDS_FILE)})`,
		);
	summarize(Date.now() - t0, args.baseline);
	const refused = printOfflineReport(
		stubBefore,
		await stubStats(),
		// The template's own log counts when this run built it.
		[
			...(builtTemplate ? [path.join(FAST_DIR, "env-tmpl")] : []),
			...envs.map((e) => e.dir),
		],
	);
	if (refused && code === 0) {
		console.log(
			`[e2e:fast] ${refused} request(s) tried to leave this machine: the run fails`,
		);
		return 1;
	}
	return code;
}

main().then(
	(code) => process.exit(code),
	(e) => {
		console.error("[e2e:fast]", e instanceof Error ? e.message : e);
		process.exit(1);
	},
);
