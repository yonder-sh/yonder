/**
 * Logs the fixture users in through the API once and saves a storageState per
 * handle to `e2e/.auth/<handle>.json` (SPEC §18.5). Specs use them with
 * `test.use({ storageState: storageStateOf("dev") })` or `browser.newContext`.
 */
import { mkdirSync } from "node:fs";
import { type FullConfig, request } from "@playwright/test";
import { loginViaApi } from "./auth";
import { AUTH_DIR, assertNotMainStack, storageStateOf } from "./env";

export const USERS = {
	dev: { email: "dev@example.com", first: "Dev", last: "User" },
	maya: { email: "maya@example.com", first: "Maya", last: "Chen" },
} as const;

const SWITCHES_HINT =
	"The app server must run with the e2e switches: stop it and start `ENABLE_TEST_ROUTES=1 VITE_E2E=1 DEV_FIXED_OTP= pnpm dev` (or let Playwright start it).";

/**
 * A reused dev server may lack the test switches: POST /api/test/fixture
 * answers 404 (and, started the same way, `window.__yonder` is undefined).
 * Check once, up front, instead of letting every spec fail on its own.
 */
async function assertTestSwitches(baseURL: string | undefined): Promise<void> {
	const ctx = await request.newContext({ baseURL });
	try {
		// Unauthenticated: an enabled route answers 401, a disabled one 404.
		const res = await ctx.post("/api/test/fixture", { data: {} });
		if (res.status() === 404)
			throw new Error(`POST /api/test/fixture is disabled. ${SWITCHES_HINT}`);
		// The server runs on the main stack (the owner's real trips): never.
		if (res.status() === 403)
			throw new Error(`POST /api/test/fixture refused: ${await res.text()}`);
	} finally {
		await ctx.dispose();
	}
}

export default async function globalSetup(config: FullConfig): Promise<void> {
	const baseURL = config.projects[0]?.use.baseURL;
	assertNotMainStack(baseURL);
	await assertTestSwitches(baseURL);
	mkdirSync(AUTH_DIR, { recursive: true });
	for (const [handle, u] of Object.entries(USERS)) {
		const ctx = await request.newContext({ baseURL });
		await loginViaApi(ctx, u.email, { first: u.first, last: u.last });
		await ctx.storageState({ path: storageStateOf(handle) });
		await ctx.dispose();
	}
}
