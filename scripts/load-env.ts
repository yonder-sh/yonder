import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * Loads a dotenv file into `process.env` WITHOUT overriding variables that are
 * already set, the same precedence as `node --env-file` (and unlike
 * `process.loadEnvFile`, which overrides them). So `APP_PORT=5411 pnpm dev:app`
 * or `DATABASE_URL=… pnpm db:migrate` win over `.env`.
 *
 * Used by the root configs (vite, vitest, drizzle) and scripts; a missing file is
 * not an error (CI and Docker builds pass the environment directly).
 * Returns the keys it set.
 */
export function loadDotEnv(path = ".env"): string[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const set: string[] = [];
	for (const [k, v] of Object.entries(parseEnv(text))) {
		if (process.env[k] === undefined && v !== undefined) {
			process.env[k] = v;
			set.push(k);
		}
	}
	return set;
}
