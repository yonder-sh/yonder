/**
 * The fast e2e harness's template database `trip_e2e_tmpl` (e2e/README.md,
 * "Fast full run") on the e2e Postgres (compose service `postgres-e2e`):
 *   1. migrations + the dev seed (`db:create`), then `db:seed:qa --no-media --no-auth`;
 *   2. its app (vite dev + collab/worker) runs once: the seed's autofill jobs
 *      finish, and the demo and QA users sign in through the API. The session
 *      rows stay in the template, so ONE set of storageStates
 *      (.data/e2e-fast/auth, .data/e2e-fast/qa-auth) works on every clone;
 *   3. a snapshot of every public table in schema `e2e_snap` plus
 *      `e2e_snap.reset()`, which puts a clone's data back to the template's in
 *      one call (the per-spec-file reset in e2e/tests/app/_helpers/fast-test.ts).
 * Rebuilt only when its fingerprint changes: migrations, seed code and data,
 * this harness — or when its sessions get old (Better Auth: 7 days).
 *
 *   N pnpm e2e:template [--force]
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import path from "node:path";
import {
	AUTH_DIR,
	clearRedisPrefix,
	ensurePostgres,
	type FastEnv,
	fastEnv,
	loginState,
	QA_AUTH_DIR,
	REPO_ROOT,
	readJson,
	sleep,
	sourceEnv,
	startEnv,
	stopAll,
	TEMPLATE_DB,
	VITE_BASE_CACHE,
	waitHealthy,
	withPg,
	withRedis,
	writeJson,
} from "./lib/e2e-fast";

/** What the template's content depends on (seed/media is skipped: --no-media). */
const FINGERPRINT_INPUTS = [
	"drizzle",
	"src/db/schema",
	"src/server/fixture.server.ts",
	"scripts/seed-qa.ts",
	"scripts/sheet/lib",
	"scripts/lib/lifecycle.ts",
	"seed/data",
	"seed/import",
	"seed/airports",
	"scripts/e2e-template.ts",
	"scripts/lib/e2e-fast.ts",
	"package.json",
];
/** Sessions last 7 days; rebuild well before the template's expire. */
const MAX_AGE_MS = 4 * 24 * 3600_000;
const STAMP = path.join(REPO_ROOT, ".data/e2e-fast/template.json");

/** Demo users (e2e global setup: `storageStateOf(handle)`). */
const DEMO_USERS = {
	dev: { email: "dev@example.com", first: "Dev", last: "User" },
	maya: { email: "maya@example.com", first: "Maya", last: "Chen" },
} as const;
/** QA users (`$QA_AUTH_DIR/<handle>.json`); `dev`/`demomaya` are the demo pair. */
const QA_USERS = {
	dennis: { email: "dennis@asia2027.test", first: "Dennis", last: "Tester" },
	audrey: { email: "audrey@asia2027.test", first: "Audrey", last: "Tester" },
	kai: { email: "kai@asia2027.test", first: "Kai", last: "Viewer" },
	eve: { email: "eve@asia2027.test", first: "Eve", last: "Outsider" },
	maya: { email: "maya@asia2027.test", first: "Maya", last: "Chen" },
} as const;

function walk(p: string, out: string[]): void {
	const abs = path.join(REPO_ROOT, p);
	if (!existsSync(abs)) return;
	if (statSync(abs).isDirectory()) {
		for (const f of readdirSync(abs).sort()) walk(path.join(p, f), out);
	} else out.push(p);
}

export function templateFingerprint(): string {
	const h = createHash("sha256");
	const files: string[] = [];
	for (const p of FINGERPRINT_INPUTS) walk(p, files);
	for (const f of files) {
		h.update(f);
		h.update(readFileSync(path.join(REPO_ROOT, f)));
	}
	return h.digest("hex").slice(0, 16);
}

type Stamp = { fingerprint: string; builtAt: string };

async function templateComment(): Promise<string | null> {
	return withPg("postgres", async (c) => {
		const r = await c.query<{ c: string | null }>(
			"select shobj_description(oid, 'pg_database') as c from pg_database where datname = $1",
			[TEMPLATE_DB],
		);
		return r.rows[0]?.c ?? null;
	});
}

/** Why the template needs a rebuild, or null when it is current. */
async function staleReason(fp: string): Promise<string | null> {
	const comment = await templateComment();
	if (!comment) return "no template yet";
	const stamp = readJson<Stamp>(STAMP);
	if (!stamp || comment !== `e2e-fast ${stamp.fingerprint} ${stamp.builtAt}`)
		return "template and storageStates disagree";
	if (stamp.fingerprint !== fp) return "migrations, seed or harness changed";
	if (Date.now() - Date.parse(stamp.builtAt) > MAX_AGE_MS)
		return "its sessions are getting old";
	for (const h of Object.keys(DEMO_USERS))
		if (!existsSync(path.join(AUTH_DIR, `${h}.json`)))
			return `missing auth/${h}.json`;
	for (const h of [...Object.keys(QA_USERS), "dev", "demomaya"])
		if (!existsSync(path.join(QA_AUTH_DIR, `${h}.json`)))
			return `missing qa-auth/${h}.json`;
	return null;
}

function tsx(e: FastEnv, script: string, args: string[] = []): void {
	const r = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
		cwd: REPO_ROOT,
		env: { ...process.env, ...e.env },
		encoding: "utf8",
	});
	if (r.status !== 0)
		throw new Error(
			`${script} failed:\n${(r.stdout ?? "") + (r.stderr ?? "")}`.trim(),
		);
	const out = (r.stdout ?? "").trim();
	if (out) console.log(out.replace(/^/gm, "  "));
}

/** Waits until no BullMQ job is waiting or active under `prefix` (the seed's autofill). */
async function drainJobs(prefix: string, timeoutMs: number): Promise<void> {
	await withRedis(async (r) => {
		const t0 = Date.now();
		for (;;) {
			let pending = 0;
			let cursor = "0";
			do {
				const [next, keys] = await r.scan(
					cursor,
					"MATCH",
					`${prefix}:bull:*`,
					"COUNT",
					2000,
				);
				cursor = next;
				for (const k of keys) {
					if (
						k.endsWith(":wait") ||
						k.endsWith(":active") ||
						k.endsWith(":paused")
					)
						pending += await r.llen(k);
					else if (k.endsWith(":prioritized")) pending += await r.zcard(k);
				}
			} while (cursor !== "0");
			if (pending === 0) return;
			if (Date.now() - t0 > timeoutMs) {
				console.warn(
					`[e2e:template] ${pending} job(s) still pending after ${timeoutMs / 1000} s; continuing`,
				);
				return;
			}
			await sleep(1000);
		}
	});
}

/**
 * Caches of external providers' answers (Open-Meteo normals, FX rates): a
 * reset keeps what an env has fetched, as a long-running env would; wiping
 * them made every spec file refetch (slow, and rate-limited upstream).
 */
const KEEP_TABLES = new Set(["climate_normals", "fx_rates"]);

/** e2e_snap: a copy of every public table plus `e2e_snap.reset()`. */
async function buildSnapshot(): Promise<{ tables: number; rows: number }> {
	return withPg(TEMPLATE_DB, async (c) => {
		await c.query(
			"drop schema if exists e2e_snap cascade; create schema e2e_snap",
		);
		const tables = (
			await c.query<{ name: string }>(
				`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
				 where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition order by 1`,
			)
		).rows
			.map((r) => r.name)
			.filter((t) => !KEEP_TABLES.has(t));
		const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
		const inserts: string[] = [];
		let rows = 0;
		for (const t of tables) {
			await c.query(`create table e2e_snap.${q(t)} as table public.${q(t)}`);
			const n = Number(
				(
					await c.query<{ n: string }>(
						`select count(*) as n from e2e_snap.${q(t)}`,
					)
				).rows[0]?.n ?? 0,
			);
			rows += n;
			if (!n) continue;
			const cols = (
				await c.query<{ name: string }>(
					`select attname as name from pg_attribute where attrelid = $1::regclass and attnum > 0
					 and not attisdropped and attgenerated = '' order by attnum`,
					[`public.${q(t)}`],
				)
			).rows
				.map((r) => q(r.name))
				.join(", ");
			inserts.push(
				`insert into public.${q(t)} (${cols}) overriding system value select ${cols} from e2e_snap.${q(t)};`,
			);
		}
		const seqs = (
			await c.query<{ name: string }>(
				`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
				 where n.nspname = 'public' and c.relkind = 'S' order by 1`,
			)
		).rows.map((r) => r.name);
		const setvals: string[] = [];
		for (const s of seqs) {
			const v = (
				await c.query<{ last_value: string; is_called: boolean }>(
					`select last_value, is_called from public.${q(s)}`,
				)
			).rows[0];
			if (v)
				setvals.push(
					`perform setval('public.${q(s)}', ${v.last_value}, ${v.is_called});`,
				);
		}
		const truncate = tables.length
			? `truncate table ${tables.map((t) => `public.${q(t)}`).join(", ")};`
			: "";
		// Which spec file the env's data belongs to (e2e/tests/app/_helpers/fast-test.ts):
		// kept across worker restarts, so a file that continues in a new worker
		// after a failure keeps its data, like the old shared env did.
		await c.query(
			"create table e2e_snap.state (k text primary key, v text not null)",
		);
		// replica: no FK checks or user triggers while the rows go back in.
		await c.query(`
create function e2e_snap.reset() returns void language plpgsql as $fn$
begin
	perform set_config('session_replication_role', 'replica', true);
	perform set_config('lock_timeout', '20s', true);
	${truncate}
	${inserts.join("\n\t")}
	${setvals.join("\n\t")}
end
$fn$;`);
		return { tables: tables.length, rows };
	});
}

/**
 * Makes sure `trip_e2e_tmpl` and the shared storageStates are current;
 * rebuilds them when not. Returns true when it rebuilt.
 */
export async function ensureTemplate(
	opts: { force?: boolean } = {},
): Promise<boolean> {
	await ensurePostgres();
	const fp = templateFingerprint();
	const reason = opts.force ? "--force" : await staleReason(fp);
	if (!reason) {
		console.log(`[e2e:template] ${TEMPLATE_DB} is current (${fp})`);
		return false;
	}
	const t0 = Date.now();
	console.log(`[e2e:template] building ${TEMPLATE_DB} (${reason})`);
	const e = fastEnv(0, sourceEnv());
	rmSync(e.dir, { recursive: true, force: true });
	rmSync(STAMP, { force: true });
	await withPg("postgres", (c) =>
		c.query(`drop database if exists ${TEMPLATE_DB} with (force)`),
	);
	await withRedis(
		(r) => clearRedisPrefix(r, e.env.REDIS_PREFIX as string),
		e.env.REDIS_URL,
	);
	tsx(e, "scripts/db-create.ts");
	tsx(e, "scripts/seed-qa.ts", ["--no-media", "--no-auth"]);
	tsx(e, "scripts/e2e-template.ts", ["--warm-caches"]);

	// Run its app once: autofill jobs, API logins (and a warm Vite dep cache).
	const running = [startEnv(e, { viteCache: VITE_BASE_CACHE })];
	try {
		await waitHealthy(running[0] as (typeof running)[0]);
		rmSync(AUTH_DIR, { recursive: true, force: true });
		rmSync(QA_AUTH_DIR, { recursive: true, force: true });
		for (const [h, u] of Object.entries(DEMO_USERS)) {
			const state = await loginState(e.appUrl, u.email, {
				first: u.first,
				last: u.last,
			});
			writeJson(path.join(AUTH_DIR, `${h}.json`), state);
		}
		for (const [h, u] of Object.entries(QA_USERS)) {
			const state = await loginState(e.appUrl, u.email, {
				first: u.first,
				last: u.last,
			});
			writeJson(path.join(QA_AUTH_DIR, `${h}.json`), state);
		}
		cpSync(path.join(AUTH_DIR, "dev.json"), path.join(QA_AUTH_DIR, "dev.json"));
		cpSync(
			path.join(AUTH_DIR, "maya.json"),
			path.join(QA_AUTH_DIR, "demomaya.json"),
		);
		await drainJobs(e.env.REDIS_PREFIX as string, 120_000);
		// Vite pre-bundles the client deps at start-up; the envs copy the result.
		const meta = path.join(VITE_BASE_CACHE, "deps/_metadata.json");
		for (let i = 0; i < 120 && !existsSync(meta); i++) await sleep(500);
	} finally {
		await stopAll(running);
	}
	await withRedis(
		(r) => clearRedisPrefix(r, e.env.REDIS_PREFIX as string),
		e.env.REDIS_URL,
	);
	await withPg("postgres", (c) =>
		c.query(
			"select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
			[TEMPLATE_DB],
		),
	);
	const snap = await buildSnapshot();
	const stamp: Stamp = { fingerprint: fp, builtAt: new Date().toISOString() };
	await withPg("postgres", (c) =>
		c.query(
			`comment on database ${TEMPLATE_DB} is 'e2e-fast ${stamp.fingerprint} ${stamp.builtAt}'`,
		),
	);
	writeJson(STAMP, stamp);
	console.log(
		`[e2e:template] ${TEMPLATE_DB} ready in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${snap.tables} tables, ${snap.rows} rows snapshotted, storageStates in ${path.relative(REPO_ROOT, AUTH_DIR)} and ${path.relative(REPO_ROOT, QA_AUTH_DIR)}`,
	);
	return true;
}

/**
 * `--warm-caches` (run by `ensureTemplate` with the template's env): today's
 * FX rates and the climate normals of every seeded city and area, fetched
 * once into the template (KEEP_TABLES), so the envs start with them instead
 * of each asking the providers again. Best effort: a provider that is down
 * leaves the envs to fetch on demand, as before.
 */
async function warmCaches(): Promise<void> {
	const { getDb, closeDb } = await import("../src/db/db.server");
	const { nodes } = await import("../src/db/schema");
	const { closeRedis } = await import("../src/server/live/redis.server");
	const { ratesOn, todayUtc } = await import(
		"../src/features/money/server/fx.server"
	);
	const { climateCell, climateForCell } = await import(
		"../src/features/insights/server/climate.server"
	);
	const { inArray } = await import("drizzle-orm");
	try {
		const fx = await ratesOn(todayUtc()).catch(() => null);
		const rows = await getDb()
			.select({ lat: nodes.lat, lng: nodes.lng })
			.from(nodes)
			.where(inArray(nodes.type, ["city", "area"]));
		const cells = [
			...new Set(
				rows.flatMap((r) =>
					r.lat === null || r.lng === null ? [] : [climateCell(r.lat, r.lng)],
				),
			),
		];
		let ok = 0;
		for (let i = 0; i < cells.length; i += 4)
			await Promise.all(
				cells.slice(i, i + 4).map((c) =>
					climateForCell(c).then(
						() => ok++,
						() => {},
					),
				),
			);
		console.log(
			`[e2e:template] caches: FX ${fx ? `rates of ${fx.date}` : "unavailable"}, climate ${ok}/${cells.length} cells`,
		);
	} finally {
		await closeDb();
		await closeRedis();
	}
}

if (process.argv[1]?.endsWith("e2e-template.ts")) {
	const main = process.argv.includes("--warm-caches")
		? warmCaches()
		: ensureTemplate({ force: process.argv.includes("--force") }).then(
				() => {},
			);
	main.catch((e) => {
		console.error("[e2e:template]", e instanceof Error ? e.message : e);
		process.exitCode = 1;
	});
}
