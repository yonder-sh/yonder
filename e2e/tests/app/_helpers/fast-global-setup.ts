/**
 * Global setup of the fast full run (`pnpm e2e:fast`). The runner already
 * started the envs and the template holds the users' sessions, so this
 *   1. checks what every spec relies on: each env answers with the test
 *      routes on, and the shared storageStates exist (the normal global setup
 *      signs users in against ONE server: sessions only that env would have);
 *   2. warms every env up: a fresh `vite dev` compiles each route and client
 *      module on first use, which made the first specs on each env time out.
 *      One browser walks the main pages of every env in parallel first.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { type Browser, chromium, devices, request } from "@playwright/test";
import { assertNotMainStack } from "./env";
import { FAST, type FastEnvEntry } from "./fast-env";

/** The routes most specs open (desktop), then the phone layout. */
const WARM_DESKTOP = [
	"/dashboard",
	"/t/asia-2027",
	"/t/asia-2027?tab=plan",
	"/t/asia-2027?tab=lists",
	"/t/asia-2027?tab=money",
	"/t/asia-2027?tab=media",
	"/t/asia-2027?tab=notes",
	"/t/asia-2027?tab=places",
	"/t/asia-2027/japan/tokyo?tab=plan",
	"/t/asia-2027/rate",
	"/share",
];
const WARM_PHONE = ["/t/asia-2027?tab=plan", "/dashboard"];
// A signed-out visitor at a trip whose link is off: the "no access" page.
const WARM_GUEST = ["/login", "/t/asia-2027"];

async function checkEnv(e: FastEnvEntry): Promise<void> {
	assertNotMainStack(e.appUrl);
	const ctx = await request.newContext({ baseURL: e.appUrl });
	try {
		const res = await ctx.post("/api/test/fixture", { data: {} });
		if (res.status() === 404) throw new Error(`env ${e.name}: POST /api/test/fixture is off (ENABLE_TEST_ROUTES)`);
		if (res.status() === 403) throw new Error(`env ${e.name}: /api/test/fixture refused: ${await res.text()}`);
	} finally {
		await ctx.dispose();
	}
}

async function visit(browser: Browser, e: FastEnvEntry, urls: string[], opts: Parameters<Browser["newContext"]>[0]) {
	const ctx = await browser.newContext({ ...opts, baseURL: e.appUrl });
	const page = await ctx.newPage();
	try {
		for (const url of urls) {
			await page.goto(url, { waitUntil: "load", timeout: 180_000 }).catch(() => {});
			await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
		}
	} finally {
		await ctx.close();
	}
}

export default async function fastGlobalSetup(): Promise<void> {
	await Promise.all(FAST.envs.map(checkEnv));
	const env = FAST.envs[0]?.env ?? {};
	const qa = (h: string) => path.join(env.QA_AUTH_DIR ?? "", `${h}.json`);
	const need = [
		...["dev", "maya"].map((h) => path.join(env.E2E_AUTH_DIR ?? "", `${h}.json`)),
		...["dennis", "audrey", "kai", "eve", "maya", "dev", "demomaya"].map(qa),
	];
	const missing = need.filter((f) => !existsSync(f));
	if (missing.length) throw new Error(`missing storageStates (rebuild: pnpm e2e:fast --rebuild): ${missing.join(", ")}`);

	const t0 = Date.now();
	const browser = await chromium.launch();
	try {
		await Promise.all(
			FAST.envs.map(async (e) => {
				await visit(browser, e, WARM_DESKTOP, { storageState: qa("dennis"), viewport: { width: 1440, height: 900 } });
				await visit(browser, e, WARM_PHONE, { ...devices["Pixel 7"], storageState: qa("dennis") });
				await visit(browser, e, WARM_GUEST, {});
			}),
		);
	} finally {
		await browser.close();
	}
	console.log(`[e2e:fast] ${FAST.envs.length} env(s) warmed up in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
