/**
 * Loaded into every process of an e2e env (`pnpm e2e:fast`: vite, collab with
 * its worker, the template's scripts, anything a spec spawns) with
 * NODE_OPTIONS="--import <this file>": nothing may reach a host outside this
 * machine (scripts/lib/no-egress.mjs). Each refusal is appended as a JSON line
 * to E2E_EGRESS_LOG (the runner counts them per host) and, with its stack, to
 * the env's app log (E2E_APP_LOG, else stderr). E2E_EGRESS_ALLOW: extra
 * comma-separated `host` or `host:port` entries.
 */
import { appendFileSync } from "node:fs";
import path from "node:path";
import { installNoEgress } from "./lib/no-egress.mjs";

const proc = `${path.basename(process.argv[1] ?? process.argv0)}[${process.pid}]`;

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
