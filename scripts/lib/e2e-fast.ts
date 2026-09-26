/**
 * Shared pieces of the fast e2e harness (`pnpm e2e:fast`, e2e/README.md):
 * the env layout, the e2e Postgres (compose service `postgres-e2e`), process
 * start/stop for one app env (vite dev + collab with the BullMQ worker
 * in-process) and API logins that produce Playwright storageStates.
 *
 * Every env is isolated like `pnpm agent:env <n>` (scripts/agent-env.ts), in
 * its own range so the two never collide:
 *   env i (1…40)  app :7100+10i, collab :7101+10i, database trip_e2e_<i>
 *                 (on the e2e Postgres, :5433), bucket trip-media-e2e<i>,
 *                 Redis prefix yonder-e2e<i>
 *   template      app :7100, collab :7101, database trip_e2e_tmpl
 * None of them is a main target (src/lib/main-targets.ts).
 */
import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { freemem } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import {
	CreateBucketCommand,
	DeleteObjectsCommand,
	HeadBucketCommand,
	ListObjectsV2Command,
	S3Client,
} from "@aws-sdk/client-s3";
import { Redis } from "ioredis";
import pg from "pg";
import { mainTargets } from "../../src/lib/main-targets";

export type Env = Record<string, string>;

export const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
/** Everything the harness writes (gitignored with the rest of `.data/`). */
export const FAST_DIR = path.join(REPO_ROOT, ".data/e2e-fast");
/** One storageState per demo user (`storageStateOf`), shared by every env. */
export const AUTH_DIR = path.join(FAST_DIR, "auth");
/** The QA users' storageStates (QA_AUTH_DIR), shared by every env. */
export const QA_AUTH_DIR = path.join(FAST_DIR, "qa-auth");
/** The file Playwright's workers read to find their env. */
export const ENVS_FILE = path.join(FAST_DIR, "envs.json");
/**
 * The Vite dep cache the template's server fills; each env starts from a copy
 * at `env-<n>/vite-cache`. Same depth on purpose: Vite's `_metadata.json`
 * keeps each dep's source path relative to the cache.
 */
export const VITE_BASE_CACHE = path.join(FAST_DIR, "env-tmpl/vite-cache");

/** The e2e Postgres server (compose service `postgres-e2e`). */
export const PG_SERVER =
	process.env.E2E_PG_URL ?? "postgres://trip:trip@localhost:5433";
export const TEMPLATE_DB = "trip_e2e_tmpl";
export const PORT_BASE = 7100;
/** The public-services stub (Open-Meteo, Overpass) every env asks (e2e/stubs/services-stub.mjs). */
export const WEATHER_STUB_PORT = PORT_BASE - 1;

/**
 * Starts the weather stub in its own process (the template's `spawnSync`
 * steps block this one) and resolves once it answers; call the result to
 * stop it. A stub left over from an earlier run answers just as well.
 */
export async function startWeatherStub(): Promise<() => void> {
	const child = spawn(
		process.execPath,
		[
			path.join(REPO_ROOT, "e2e/stubs/services-stub.mjs"),
			"--port",
			String(WEATHER_STUB_PORT),
		],
		{ stdio: "ignore" },
	);
	const stop = () => {
		child.kill();
	};
	process.once("exit", stop);
	const url = `http://127.0.0.1:${WEATHER_STUB_PORT}/__stub/calls`;
	for (let i = 0; i < 50; i++) {
		if (
			await fetch(url).then(
				(r) => r.ok,
				() => false,
			)
		)
			return stop;
		await sleep(100);
	}
	stop();
	throw new Error(`the services stub didn't start on :${WEATHER_STUB_PORT}`);
}

export const pgUrl = (db: string) => `${PG_SERVER.replace(/\/+$/, "")}/${db}`;

export type FastEnv = {
	/** 0 = the template's env, 1…N = the test envs. */
	index: number;
	name: string;
	db: string;
	dir: string;
	appUrl: string;
	collabPort: number;
	/** Everything the env's processes need (`.env` + `overrides`). */
	env: Env;
	/** Only what differs per env: what its Playwright worker applies (no secrets). */
	overrides: Env;
};

/** `.env.example` defaults under this checkout's `.env` (secrets included), like agent-env. */
export function sourceEnv(): Env {
	const read = (f: string) => {
		try {
			return parseEnv(readFileSync(path.join(REPO_ROOT, f), "utf8")) as Env;
		} catch {
			return {};
		}
	};
	const env = { ...read(".env.example"), ...read(".env") };
	if (!env.BETTER_AUTH_SECRET)
		throw new Error(
			"BETTER_AUTH_SECRET is empty in .env: the envs share it (the storageStates work everywhere)",
		);
	return env;
}

/** The env layout for env `index` (0 = template). */
export function fastEnv(index: number, source: Env): FastEnv {
	if (!Number.isInteger(index) || index < 0 || index > 40)
		throw new Error(`env index ${index} out of range 0…40`);
	const name = index === 0 ? "tmpl" : String(index);
	const port = PORT_BASE + 10 * index;
	const db = index === 0 ? TEMPLATE_DB : `trip_e2e_${index}`;
	const dir = path.join(FAST_DIR, `env-${name}`);
	const appUrl = `http://localhost:${port}`;
	const s3Public = (
		source.S3_PUBLIC_ENDPOINT ?? "http://localhost:8080"
	).replace(/\/$/, "");
	const overrides: Env = {
		NODE_ENV: "development",
		APP_PORT: String(port),
		PORT: String(port),
		HOCUSPOCUS_PORT: String(port + 1),
		HOCUSPOCUS_URL: `ws://localhost:${port + 1}`,
		HOCUSPOCUS_HOST: "",
		APP_URL: appUrl,
		BETTER_AUTH_URL: appUrl,
		TRUSTED_ORIGINS: "",
		VITE_COLLAB_URL: "",
		DATABASE_URL: pgUrl(db),
		DATABASE_URL_TEST: pgUrl(`${db}_unused_test`),
		S3_BUCKET: `trip-media-e2e${name}`,
		S3_PUBLIC_URL: `${s3Public}/trip-media-e2e${name}`,
		REDIS_PREFIX: `yonder-e2e${name}`,
		DEV_FIXED_OTP: "000000",
		EMAIL_OUTBOX_DIR: path.join(dir, "outbox"),
		ENABLE_TEST_ROUTES: "1",
		VITE_E2E: "1",
		AUTH_RATE_LIMIT: "off",
		COLLAB_RUN_WORKER: "1",
		// Never the real services: a run would spend their quotas and depend on their answers.
		OPEN_METEO_ARCHIVE_URL: `http://127.0.0.1:${WEATHER_STUB_PORT}`,
		OVERPASS_URL: `http://127.0.0.1:${WEATHER_STUB_PORT}/api/interpreter`,
		// Read by the e2e helpers (otp.ts, env.ts, the QA specs).
		E2E_APP_LOG: path.join(dir, "app.log"),
		E2E_AUTH_DIR: AUTH_DIR,
		QA_AUTH_DIR: QA_AUTH_DIR,
		E2E_FAST_ENV: name,
	};
	const env = { ...source, ...overrides };
	const onMain = mainTargets(env, { app: true });
	if (onMain.length)
		throw new Error(
			`env ${name} points at the main stack: ${onMain.join("; ")}`,
		);
	return { index, name, db, dir, appUrl, collabPort: port + 1, env, overrides };
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

export async function withPg<T>(
	db: string,
	fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
	const c = new pg.Client({
		connectionString: pgUrl(db),
		application_name: "yonder-e2e-fast",
	});
	await c.connect();
	try {
		return await fn(c);
	} finally {
		await c.end();
	}
}

async function pgReachable(): Promise<boolean> {
	try {
		await withPg("postgres", async (c) => c.query("select 1"));
		return true;
	} catch {
		return false;
	}
}

/**
 * Starts the compose service `postgres-e2e` when nothing answers on the e2e
 * server. Returns true when it started it (the runner stops it again).
 */
export async function ensurePostgres(): Promise<boolean> {
	if (await pgReachable()) return false;
	if (process.env.E2E_PG_URL)
		throw new Error(`E2E_PG_URL=${process.env.E2E_PG_URL} does not answer`);
	console.log(
		"[e2e:fast] starting the e2e Postgres (compose service postgres-e2e, :5433)",
	);
	const r = spawnSync(
		"docker",
		["compose", "--profile", "e2e", "up", "-d", "--wait", "postgres-e2e"],
		{
			cwd: REPO_ROOT,
			stdio: ["ignore", "ignore", "inherit"],
		},
	);
	if (r.status !== 0)
		throw new Error("could not start the postgres-e2e service");
	for (let i = 0; i < 60 && !(await pgReachable()); i++) await sleep(500);
	if (!(await pgReachable()))
		throw new Error("the e2e Postgres does not answer on :5433");
	return true;
}

/** Stops the compose service `postgres-e2e` (its volume, with the template, stays). */
export function stopPostgres(): void {
	if (process.env.E2E_PG_URL) return;
	spawnSync("docker", ["compose", "--profile", "e2e", "stop", "postgres-e2e"], {
		cwd: REPO_ROOT,
		stdio: ["ignore", "ignore", "inherit"],
	});
}

/** MemAvailable in GB (Linux), else free memory. */
export function memAvailableGb(): number {
	try {
		const m = /MemAvailable:\s+(\d+) kB/.exec(
			readFileSync("/proc/meminfo", "utf8"),
		);
		if (m) return Number(m[1]) / 1024 / 1024;
	} catch {}
	return freemem() / 1024 ** 3;
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

export async function withRedis<T>(
	fn: (r: Redis) => Promise<T>,
	url?: string,
): Promise<T> {
	const r = new Redis(
		url ?? sourceEnv().REDIS_URL ?? "redis://localhost:6379",
		{ lazyConnect: true, maxRetriesPerRequest: 2 },
	);
	await r.connect();
	try {
		return await fn(r);
	} finally {
		r.disconnect();
	}
}

/** SCAN + UNLINK every key under `${prefix}:` (never FLUSHALL: the Redis is shared). */
export async function clearRedisPrefix(
	r: Redis,
	prefix: string,
): Promise<number> {
	if (!/^yonder-e2e[a-z0-9]+$/.test(prefix))
		throw new Error(`refusing to clear Redis prefix ${prefix}`);
	let cursor = "0";
	let n = 0;
	do {
		const [next, keys] = await r.scan(
			cursor,
			"MATCH",
			`${prefix}:*`,
			"COUNT",
			2000,
		);
		cursor = next;
		if (keys.length) n += await r.unlink(...keys);
	} while (cursor !== "0");
	return n;
}

// ---------------------------------------------------------------------------
// App processes
// ---------------------------------------------------------------------------

export type Running = {
	env: FastEnv;
	procs: { name: string; pid: number; exited: Promise<number | null> }[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export { sleep };

function start(
	name: string,
	cmd: string,
	args: string[],
	env: Env,
	log: string,
) {
	const fd = openSync(log, "a");
	const child = spawn(cmd, args, {
		cwd: REPO_ROOT,
		env: { ...process.env, ...env },
		stdio: ["ignore", fd, fd],
		detached: true, // own process group: stop() kills the whole tree
	});
	closeSync(fd);
	const exited = new Promise<number | null>((resolve) =>
		child.on("exit", (code) => resolve(code)),
	);
	if (!child.pid) throw new Error(`could not start ${name}`);
	return { name, pid: child.pid, exited };
}

/**
 * Starts env `e` the way `pnpm dev` does (vite dev + collab), without file
 * watching (a run must not reload mid-test) and with the BullMQ worker inside
 * collab (COLLAB_RUN_WORKER=1): two processes per env.
 */
export function startEnv(e: FastEnv, opts: { viteCache: string }): Running {
	mkdirSync(e.dir, { recursive: true });
	mkdirSync(e.env.EMAIL_OUTBOX_DIR as string, { recursive: true });
	const node = process.execPath;
	const app = start(
		"vite",
		node,
		[
			path.join(REPO_ROOT, "node_modules/vite/bin/vite.js"),
			"dev",
			"--config",
			"scripts/e2e-vite.config.ts",
		],
		{ ...e.env, E2E_VITE_CACHE_DIR: opts.viteCache },
		e.env.E2E_APP_LOG as string,
	);
	const collab = start(
		"collab",
		node,
		["--import", "tsx", "collab/server.ts"],
		e.env,
		path.join(e.dir, "collab.log"),
	);
	return { env: e, procs: [app, collab] };
}

async function ok(url: string): Promise<boolean> {
	try {
		const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
		return r.ok;
	} catch {
		return false;
	}
}

/** Waits for the app's `/api/health` (it queries Postgres) and collab's `/healthz`. */
export async function waitHealthy(
	r: Running,
	timeoutMs = 180_000,
): Promise<void> {
	const t0 = Date.now();
	let dead: string | undefined;
	for (const p of r.procs)
		void p.exited.then((code) => (dead ??= `${p.name} exited (${code})`));
	while (Date.now() - t0 < timeoutMs) {
		if (dead) break;
		if (
			(await ok(`${r.env.appUrl}/api/health`)) &&
			(await ok(`http://127.0.0.1:${r.env.collabPort}/healthz`))
		)
			return;
		await sleep(500);
	}
	throw new Error(
		`env ${r.env.name} is not healthy${dead ? `: ${dead}` : ` after ${timeoutMs / 1000} s`} (logs in ${path.relative(REPO_ROOT, r.env.dir)})`,
	);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** SIGTERM to each process group, SIGKILL after `graceMs`. */
export async function stopAll(
	running: Running[],
	graceMs = 8000,
): Promise<void> {
	const pids = running.flatMap((r) => r.procs.map((p) => p.pid));
	for (const pid of pids) {
		try {
			process.kill(-pid, "SIGTERM");
		} catch {}
	}
	const t0 = Date.now();
	while (Date.now() - t0 < graceMs && pids.some(alive)) await sleep(200);
	for (const pid of pids) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}
}

/** Synchronous best effort (process 'exit' handlers can't await). */
export function killAllSync(running: Running[]): void {
	for (const r of running)
		for (const p of r.procs) {
			try {
				process.kill(-p.pid, "SIGKILL");
			} catch {}
		}
}

// ---------------------------------------------------------------------------
// API logins → storageStates
// ---------------------------------------------------------------------------

type Cookie = {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires: number;
	httpOnly: boolean;
	secure: boolean;
	sameSite: "Strict" | "Lax" | "None";
};

function parseSetCookie(header: string, host: string): Cookie {
	const [pair = "", ...attrs] = header.split(";").map((s) => s.trim());
	const eq = pair.indexOf("=");
	const c: Cookie = {
		name: pair.slice(0, eq),
		value: pair.slice(eq + 1),
		domain: host,
		path: "/",
		expires: -1,
		httpOnly: false,
		secure: false,
		sameSite: "Lax",
	};
	for (const a of attrs) {
		const [k = "", v = ""] = a.split("=");
		const key = k.toLowerCase();
		if (key === "path") c.path = v || "/";
		else if (key === "max-age")
			c.expires = Math.floor(Date.now() / 1000) + Number(v);
		else if (key === "expires" && c.expires === -1)
			c.expires = Math.floor(Date.parse(v) / 1000);
		else if (key === "httponly") c.httpOnly = true;
		else if (key === "secure") c.secure = true;
		else if (key === "samesite")
			c.sameSite = (v.charAt(0).toUpperCase() +
				v.slice(1).toLowerCase()) as Cookie["sameSite"];
	}
	return c;
}

/**
 * Signs `email` in through the API (DEV_FIXED_OTP), sets missing names like
 * the e2e helper `loginViaApi`, and returns a Playwright storageState. The
 * session row lands in the env's database; a template built with it hands the
 * same session to every clone, and cookies ignore the port.
 */
export async function loginState(
	appUrl: string,
	email: string,
	name: { first: string; last: string },
): Promise<{ cookies: Cookie[]; origins: [] }> {
	const host = new URL(appUrl).hostname;
	const headers = {
		Origin: appUrl,
		"Content-Type": "application/json",
		"x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX",
	};
	const send = await fetch(
		`${appUrl}/api/auth/email-otp/send-verification-otp`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({ email, type: "sign-in" }),
		},
	);
	if (!send.ok)
		throw new Error(
			`send-verification-otp ${email}: ${send.status} ${await send.text()}`,
		);
	const sign = await fetch(`${appUrl}/api/auth/sign-in/email-otp`, {
		method: "POST",
		headers,
		body: JSON.stringify({ email, otp: "000000" }),
	});
	if (!sign.ok)
		throw new Error(`sign-in ${email}: ${sign.status} ${await sign.text()}`);
	const cookies = sign.headers
		.getSetCookie()
		.map((c) => parseSetCookie(c, host));
	const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
	const session = (await (
		await fetch(`${appUrl}/api/auth/get-session`, {
			headers: { Cookie: cookieHeader },
		})
	).json()) as {
		user?: { firstName?: string; lastName?: string };
	} | null;
	if (!session?.user) throw new Error(`no session for ${email} after sign-in`);
	if (!session.user.firstName?.trim() || !session.user.lastName?.trim()) {
		const upd = await fetch(`${appUrl}/api/auth/update-user`, {
			method: "POST",
			headers: { ...headers, Cookie: cookieHeader },
			body: JSON.stringify({ firstName: name.first, lastName: name.last }),
		});
		if (!upd.ok)
			throw new Error(
				`update-user ${email}: ${upd.status} ${await upd.text()}`,
			);
	}
	return { cookies, origins: [] };
}

// ---------------------------------------------------------------------------
// S3 (the shared s3proxy; one bucket per env)
// ---------------------------------------------------------------------------

/** Creates env `e`'s bucket if missing and empties it. Returns the objects removed. */
export async function freshBucket(e: FastEnv): Promise<number> {
	const client = new S3Client({
		endpoint: e.env.S3_ENDPOINT,
		region: e.env.S3_REGION || "us-east-1",
		forcePathStyle: true,
		credentials: {
			accessKeyId: e.env.S3_ACCESS_KEY_ID ?? "",
			secretAccessKey: e.env.S3_SECRET_ACCESS_KEY ?? "",
		},
	});
	const Bucket = e.env.S3_BUCKET as string;
	if (!/^trip-media-e2e[a-z0-9]+$/.test(Bucket))
		throw new Error(`refusing to empty bucket ${Bucket}`);
	try {
		try {
			await client.send(new HeadBucketCommand({ Bucket }));
		} catch {
			await client.send(new CreateBucketCommand({ Bucket }));
			return 0;
		}
		let removed = 0;
		let token: string | undefined;
		do {
			const page = await client.send(
				new ListObjectsV2Command({ Bucket, ContinuationToken: token }),
			);
			const keys = (page.Contents ?? []).flatMap((o) =>
				o.Key ? [{ Key: o.Key }] : [],
			);
			if (keys.length) {
				await client.send(
					new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys } }),
				);
				removed += keys.length;
			}
			token = page.IsTruncated ? page.NextContinuationToken : undefined;
		} while (token);
		return removed;
	} finally {
		client.destroy();
	}
}

export function writeJson(file: string, value: unknown): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(file: string): T | null {
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}
