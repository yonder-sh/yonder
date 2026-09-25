/**
 * Writes a per-agent `.env` (SPEC §5.7): everything from a source `.env`
 * (secrets included), with this agent's own ports, database, bucket and Redis
 * prefix, so parallel agents never share state.
 *
 *   N pnpm agent:env <n> [--from <main checkout>/.env] [--out .env] [--force]
 *   N pnpm agent:env 0 --main        # the main checkout: add missing keys only
 *
 * Agent n gets: APP_PORT=PORT=5100+10n, HOCUSPOCUS_PORT=5101+10n,
 * APP_URL=BETTER_AUTH_URL=http://localhost:<APP_PORT>, DATABASE_URL=…/trip_a<n>,
 * DATABASE_URL_TEST=…/trip_test_a<n>, S3_BUCKET=trip-media-a<n>,
 * REDIS_PREFIX=yonder-a<n>, VITE_COLLAB_URL= (Vite proxies /collab),
 * DEV_FIXED_OTP=000000, EMAIL_OUTBOX_DIR=.data/outbox, ENABLE_TEST_ROUTES=1,
 * VITE_E2E=1. Port 5102+10n is reserved for its `pnpm start` test and 5103+10n
 * for the WP-Transit Routes stub.
 *
 * `--main` (n = 0) never overwrites a value: it appends the keys the main
 * `.env` is missing, with `.env.example`'s defaults.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs, parseEnv } from "node:util";

export type AgentEnv = Record<string, string>;

/** The per-agent overrides for agent `n` (1…26). */
export function agentOverrides(n: number, base: AgentEnv): AgentEnv {
	if (!Number.isInteger(n) || n < 1 || n > 99)
		throw new Error("n must be 1…99");
	const appPort = 5100 + 10 * n;
	const withDb = (url: string | undefined, db: string) => {
		const u = new URL(url ?? "postgres://trip:trip@localhost:5432/trip");
		u.pathname = `/${db}`;
		return u.toString();
	};
	return {
		APP_PORT: String(appPort),
		PORT: String(appPort),
		HOCUSPOCUS_PORT: String(appPort + 1),
		HOCUSPOCUS_URL: `ws://localhost:${appPort + 1}`,
		APP_URL: `http://localhost:${appPort}`,
		BETTER_AUTH_URL: `http://localhost:${appPort}`,
		VITE_COLLAB_URL: "",
		DATABASE_URL: withDb(base.DATABASE_URL, `trip_a${n}`),
		DATABASE_URL_TEST: withDb(base.DATABASE_URL, `trip_test_a${n}`),
		S3_BUCKET: `trip-media-a${n}`,
		S3_PUBLIC_URL: `${(base.S3_PUBLIC_ENDPOINT ?? "http://localhost:8080").replace(/\/$/, "")}/trip-media-a${n}`,
		REDIS_PREFIX: `yonder-a${n}`,
		DEV_FIXED_OTP: "000000",
		EMAIL_OUTBOX_DIR: ".data/outbox",
		ENABLE_TEST_ROUTES: "1",
		VITE_E2E: "1",
	};
}

/** Serializes env values: quotes anything with spaces, `#`, quotes or backslashes. */
function formatValue(v: string): string {
	if (v === "") return "";
	if (/^[A-Za-z0-9_./:@,+-]*$/.test(v)) return v;
	if (!v.includes("'")) return `'${v}'`;
	return JSON.stringify(v);
}

/**
 * Rewrites `template` (a .env file's text) with `values`: known keys keep their
 * line and comment layout with the new value; keys missing from the template
 * are appended under a heading.
 */
export function renderEnv(
	template: string,
	values: AgentEnv,
	heading: string,
): string {
	const seen = new Set<string>();
	const lines = template.split("\n").map((line) => {
		// KEY=value   # trailing comment (kept)
		const m = /^([A-Z0-9_]+)=('[^']*'|"[^"]*"|\S*)(\s+#.*)?$/.exec(line);
		const k = m?.[1] ?? /^([A-Z0-9_]+)=/.exec(line)?.[1];
		if (!k) return line;
		seen.add(k);
		if (!(k in values)) return line;
		return `${k}=${formatValue(values[k] as string)}${m?.[3] ?? ""}`;
	});
	const extra = Object.keys(values).filter((k) => !seen.has(k));
	if (extra.length) {
		lines.push("", `# ---- ${heading} ----`);
		for (const k of extra)
			lines.push(`${k}=${formatValue(values[k] as string)}`);
	}
	return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function main(): void {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			from: { type: "string", default: ".env" },
			out: { type: "string", default: ".env" },
			main: { type: "boolean", default: false },
			force: { type: "boolean", default: false },
		},
	});
	const n = Number(positionals[0] ?? Number.NaN);
	if (!values.main && Number.isNaN(n)) {
		throw new Error(
			"usage: pnpm agent:env <n> [--from <.env>] [--out <.env>] | pnpm agent:env 0 --main",
		);
	}
	const exampleText = existsSync(".env.example")
		? readFileSync(".env.example", "utf8")
		: "";
	const example = parseEnv(exampleText) as AgentEnv;

	if (values.main) {
		// Main checkout: append only the keys .env is missing (never overwrite secrets).
		const current = existsSync(values.out)
			? readFileSync(values.out, "utf8")
			: "";
		const have = parseEnv(current) as AgentEnv;
		const missing = Object.fromEntries(
			Object.entries(example).filter(([k]) => !(k in have)),
		);
		if (!have.BETTER_AUTH_SECRET && !("BETTER_AUTH_SECRET" in missing))
			console.warn("[agent:env] BETTER_AUTH_SECRET is empty in", values.out);
		const text = renderEnv(current, missing, "added by agent:env --main");
		writeFileSync(values.out, text, { mode: 0o600 });
		chmodSync(values.out, 0o600);
		console.log(
			`[agent:env] ${values.out}: ${Object.keys(missing).length} keys added`,
		);
		return;
	}

	if (existsSync(values.out) && values.out === values.from) {
		throw new Error(
			`refusing to overwrite the source ${values.from}; pass --out for the agent copy`,
		);
	}
	if (existsSync(values.out) && !values.force) {
		throw new Error(`${values.out} exists; pass --force to rewrite it`);
	}
	const sourceText = readFileSync(values.from, "utf8");
	const source = { ...example, ...(parseEnv(sourceText) as AgentEnv) };
	if (!source.BETTER_AUTH_SECRET)
		throw new Error(`BETTER_AUTH_SECRET is empty in ${values.from}`);
	const env = { ...source, ...agentOverrides(n, source) };
	writeFileSync(
		values.out,
		renderEnv(exampleText || sourceText, env, "agent extras"),
		{
			mode: 0o600,
		},
	);
	chmodSync(values.out, 0o600);
	console.log(
		`[agent:env] agent ${n}: app :${env.APP_PORT}, collab :${env.HOCUSPOCUS_PORT}, db ${new URL(env.DATABASE_URL as string).pathname.slice(1)}, bucket ${env.S3_BUCKET}, prefix ${env.REDIS_PREFIX} → ${values.out}`,
	);
}

if (process.argv[1]?.endsWith("agent-env.ts")) {
	try {
		main();
	} catch (e) {
		console.error("[agent:env]", e instanceof Error ? e.message : e);
		process.exitCode = 1;
	}
}
