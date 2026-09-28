/**
 * Loaded into every process of an e2e env (`pnpm e2e:fast`: vite, collab with
 * its worker, the template's scripts, anything a spec spawns) with
 * NODE_OPTIONS="--import <this file>": nothing may reach a host outside this
 * machine (scripts/lib/no-egress.mjs). Each refusal is appended as a JSON line
 * to E2E_EGRESS_LOG (the runner counts them per host) and, with its stack, to
 * the env's app log (E2E_APP_LOG, else stderr). E2E_EGRESS_ALLOW: extra
 * comma-separated `host` or `host:port` entries.
 *
 * Worker threads have their own `net` and `dns` and don't run `--import`
 * preloads, and Nitro's dev server runs the app's server code in one: every
 * Worker a guarded process starts loads this file first.
 */
import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import { installNoEgress } from "./lib/no-egress.mjs";

const proc = `${isMainThread ? path.basename(process.argv[1] ?? process.argv0) : "worker-thread"}[${process.pid}]`;

installNoEgress({
	allow: (process.env.E2E_EGRESS_ALLOW ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
	onRefuse(r) {
		const at = r.port === undefined ? r.host : `${r.host}:${r.port}`;
		const t = new Date().toISOString();
		try {
			if (process.env.E2E_EGRESS_LOG)
				appendFileSync(
					process.env.E2E_EGRESS_LOG,
					`${JSON.stringify({ t, proc, kind: r.kind, host: r.host, port: r.port })}\n`,
				);
		} catch {}
		const text = `${t} [no-egress] ${proc} refused ${r.kind} to ${at}\n${r.stack}\n`;
		try {
			if (process.env.E2E_APP_LOG)
				appendFileSync(process.env.E2E_APP_LOG, text);
			else process.stderr.write(text);
		} catch {}
	},
});

const GUARDED = Symbol.for("yonder.no-egress.worker");
const threads = createRequire(import.meta.url)("node:worker_threads");
if (!threads.Worker[GUARDED]) {
	// Synchronous, and valid whether the worker's code is CommonJS or a module.
	const self = JSON.stringify(fileURLToPath(import.meta.url));
	const load = `process.getBuiltinModule("node:module").createRequire(${self})(${self});\n`;
	/** A Worker that loads this file, then its own code or entry (as an ES module import). */
	class GuardedWorker extends threads.Worker {
		static [GUARDED] = true;
		constructor(entry, options = {}) {
			if (options.eval) {
				super(load + String(entry), options);
				return;
			}
			const s = String(entry);
			const url =
				entry instanceof URL || /^(file|data):/.test(s)
					? s
					: pathToFileURL(path.resolve(s)).href;
			super(`${load}import(${JSON.stringify(url)});`, {
				...options,
				eval: true,
			});
		}
	}
	threads.Worker = GuardedWorker;
	syncBuiltinESMExports();
}
