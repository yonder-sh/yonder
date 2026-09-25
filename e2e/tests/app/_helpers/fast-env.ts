/**
 * Fast full run (`pnpm e2e:fast`, e2e/README.md): worker slot i talks to env
 * i+1 only. `playwright.fast.config.ts` imports this FIRST, and Playwright
 * loads the config again in every worker before any spec, so the env
 * variables below are in place for everything that reads them at import time
 * (`_helpers/env.ts`' APP_URL and AUTH_DIR, `otp.ts`' E2E_APP_LOG and
 * EMAIL_OUTBOX_DIR, the QA specs' QA_AUTH_DIR, DATABASE_URL, REDIS_PREFIX…)
 * and for the config's own `use.baseURL`. The runner process gets env 1.
 *
 * The envs file (`.data/e2e-fast/envs.json`, written by scripts/e2e-fast.ts)
 * holds only per-env values; secrets still come from .env via the app config.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type FastEnvEntry = { name: string; appUrl: string; env: Record<string, string> };
export type FastEnvsFile = { report: string; envs: FastEnvEntry[] };

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.E2E_FAST_ENVS_FILE ?? path.resolve(here, "../../../../.data/e2e-fast/envs.json");

if (!existsSync(FILE))
	throw new Error(`${FILE} is missing: run the fast suite with \`pnpm e2e:fast\` (it starts the envs), not with this config alone`);

export const FAST: FastEnvsFile = JSON.parse(readFileSync(FILE, "utf8")) as FastEnvsFile;
if (!FAST.envs.length) throw new Error(`${FILE} lists no envs`);

const slot = process.env.TEST_PARALLEL_INDEX === undefined ? 0 : Number(process.env.TEST_PARALLEL_INDEX);
const mine = FAST.envs[slot];
// Two workers on one env would reset each other's data mid-test.
if (!mine) throw new Error(`worker slot ${slot} has no env (${FAST.envs.length} envs): don't pass --workers above that`);
Object.assign(process.env, mine.env);
