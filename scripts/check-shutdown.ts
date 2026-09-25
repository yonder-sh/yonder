/**
 * `pnpm check:shutdown` — the built app server exits promptly on SIGTERM
 * (Docker's `stop` sends SIGTERM and SIGKILLs after 10 s). Starts
 * `.output/server/index.mjs` in production mode on a free port, makes it use
 * Postgres and Redis (health + a page render), sends SIGTERM and fails unless
 * the process exits within LIMIT_MS. Run after `pnpm build`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";

const LIMIT_MS = 5_000;
const ENTRY = ".output/server/index.mjs";

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			s.close(() => resolve(port));
		});
		s.on("error", reject);
	});
}

async function main(): Promise<void> {
	if (!existsSync(ENTRY))
		throw new Error(`${ENTRY} is missing: run pnpm build`);
	const port = await freePort();
	const child = spawn(process.execPath, ["--env-file-if-exists=.env", ENTRY], {
		env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
		stdio: ["ignore", "ignore", "inherit"],
	});
	const base = `http://127.0.0.1:${port}`;
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await fetch(`${base}/api/health`);
			if (r.ok) break;
		} catch {
			// not listening yet
		}
		if (Date.now() - t0 > 20_000) throw new Error("server didn't start");
		await new Promise((r) => setTimeout(r, 200));
	}
	await fetch(`${base}/login`).then((r) => r.text());
	const exited = new Promise<number>((resolve) =>
		child.once("exit", () => resolve(Date.now())),
	);
	const sent = Date.now();
	child.kill("SIGTERM");
	const timer = setTimeout(() => child.kill("SIGKILL"), LIMIT_MS + 2_000);
	const at = await exited;
	clearTimeout(timer);
	const ms = at - sent;
	if (ms > LIMIT_MS)
		throw new Error(`exited ${ms} ms after SIGTERM (limit ${LIMIT_MS})`);
	console.log(`ok: the app exited ${ms} ms after SIGTERM`);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
