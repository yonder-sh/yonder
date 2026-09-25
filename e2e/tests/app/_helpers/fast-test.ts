/**
 * Fast full run only (`pnpm e2e:fast`): `playwright.fast.config.ts` maps
 * every `import … from "@playwright/test"` to this module (tsconfig.fast.json
 * `paths`), so each spec's `test` carries one extra auto fixture and no spec
 * has to change. The normal config never loads it.
 *
 * The fixture gives every spec FILE pristine data: before the first hook or
 * test of a file in this worker it resets the worker's env to the template —
 * `e2e_snap.reset()` (scripts/e2e-template.ts) in its database and its Redis
 * prefix (except the provider caches) — so what one spec leaves behind (shifted trip dates,
 * trip copies on the dashboard, display currency, `listsShowDone`…) never
 * reaches another. `auto: "all-hooks-included"` also runs it for beforeAll
 * hooks, which run before a test's own fixtures. Tests within one file still
 * share data, as before (the fast config runs each file in order in one worker).
 */
import IORedis from "ioredis";
import pg from "pg";
// The real module, by path: "@playwright/test" itself maps to this file.
import { test as base } from "../../../node_modules/@playwright/test/index.mjs";

export * from "../../../node_modules/@playwright/test/index.mjs";

let lastFile: string | undefined;
let client: pg.Client | undefined;
let redis: IORedis | undefined;

async function db(): Promise<pg.Client> {
	if (!client) {
		const c = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: "yonder-e2e-reset" });
		c.on("error", () => {
			if (client === c) client = undefined;
		});
		await c.connect();
		client = c;
	}
	return client;
}

function kv(): IORedis {
	redis ??= new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: 2 });
	return redis;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function keysUnder(prefix: string): Promise<string[]> {
	const out: string[] = [];
	let cursor = "0";
	do {
		const [next, keys] = await kv().scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 5000);
		cursor = next;
		out.push(...keys);
	} while (cursor !== "0");
	return out;
}

/** Resets this worker's env; exported for specs that need it mid-file. */
export async function resetFastEnv(): Promise<void> {
	const prefix = process.env.REDIS_PREFIX ?? "";
	if (!/^yonder-e2e\d+$/.test(prefix)) throw new Error(`fast reset refuses Redis prefix "${prefix}"`);
	const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname.slice(1);
	if (!/^trip_e2e_\d+$/.test(dbName)) throw new Error(`fast reset refuses database "${dbName}"`);
	// The last spec's background jobs (autofill, media) would write into the fresh
	// data: give the running ones a moment to finish.
	const active = (await keysUnder(prefix)).filter((k) => k.endsWith(":active"));
	for (let t0 = Date.now(); active.length && Date.now() - t0 < 5000; await sleep(100)) {
		const n = await Promise.all(active.map((k) => kv().llen(k)));
		if (n.every((x) => x === 0)) break;
	}
	for (let attempt = 1; ; attempt++) {
		try {
			await (await db()).query("select e2e_snap.reset()");
			break;
		} catch (e) {
			// 40P01 deadlock / 55P03 lock timeout with a straggling app query: again.
			const code = (e as { code?: string }).code;
			if (attempt >= 4 || (code !== "40P01" && code !== "55P03" && code !== undefined)) throw e;
			client = undefined;
			await sleep(200 * attempt);
		}
	}
	// Everything but `<prefix>:cache:*`: providers' answers (routes, places,
	// walks, link previews) with their own TTLs, kept like a long-running env would.
	const keys = (await keysUnder(prefix)).filter((k) => !k.startsWith(`${prefix}:cache:`));
	for (let i = 0; i < keys.length; i += 500) await kv().unlink(...keys.slice(i, i + 500));
}

/**
 * Resets the env when `file` is not the file its data belongs to. The owner
 * is kept in the env's database (`e2e_snap.state`), not in this process: a
 * file that goes on in a fresh worker after a failure keeps its data.
 */
async function enterFile(file: string): Promise<void> {
	if (file === lastFile) return;
	const owner = await (await db())
		.query<{ v: string }>("select v from e2e_snap.state where k = 'file'")
		.then((q) => q.rows[0]?.v ?? null)
		.catch(() => null); // a template from before e2e_snap.state: per process only
	if (owner !== file) {
		await resetFastEnv();
		await (await db())
			.query("insert into e2e_snap.state (k, v) values ('file', $1) on conflict (k) do update set v = excluded.v", [file])
			.catch(() => {});
	}
	lastFile = file;
}

export const test = base.extend<{ _fastReset: void }>({
	_fastReset: [
		async ({}, use, testInfo) => {
			if (process.env.E2E_FAST_ENV) await enterFile(testInfo.file);
			await use();
		},
		// "all-hooks-included": also before beforeAll hooks (Playwright-internal
		// value; its own trace fixture uses it).
		{ auto: "all-hooks-included" as unknown as true, box: true, title: "e2e:fast reset to template" },
	],
});

export default test;
