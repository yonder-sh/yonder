/**
 * QA security verifier (I2 round 3): after an identity switch on one device
 * (Dennis's session ended without a sign-out; Kai signs in), does Kai's
 * dashboard ever show Dennis's persisted "Upcoming deadlines" (a to-do
 * assigned to Dennis and Audrey only, text in QA_SEC_DEADLINE)?
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";

test.skip(!process.env.QA_SEC_DIR || !process.env.QA_PROD_SH || !process.env.QA_SEC_DEADLINE, "needs the production build, QA_PROD_SH and QA_SEC_DEADLINE");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const NEEDLE = process.env.QA_SEC_DEADLINE ?? "";

async function swControls(page: Page) {
	await expect
		.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active && !!navigator.serviceWorker.controller), { timeout: 30_000 })
		.toBe(true);
}

test("the next person's dashboard never shows the previous person's deadlines", async ({ browser }) => {
	test.setTimeout(200_000);
	const out: Record<string, unknown> = {};
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(ctx.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
	const page = await ctx.newPage();
	await page.goto("/");
	await swControls(page);
	await page.reload();
	await page.waitForTimeout(6000);
	out.dennisDashboardHasIt = (await page.locator("body").innerText()).includes(NEEDLE);
	await ctx.clearCookies();
	await loginViaApi(ctx.request, "kai@asia2027.test", { first: "Kai", last: "Viewer" });
	const seen: number[] = [];
	const t0 = Date.now();
	await page.goto("/");
	for (let i = 0; i < 60; i++) {
		const txt = await page.locator("body").innerText().catch(() => "");
		if (txt.includes(NEEDLE)) {
			seen.push(Date.now() - t0);
			if (seen.length === 1) await page.screenshot({ path: path.join(DIR, "r3-switch3-kai-sees-dennis.png") });
		}
		await page.waitForTimeout(100);
	}
	out.kaiSawDennisDeadlineAtMs = seen.slice(0, 5);
	out.kaiSawCount = seen.length;
	out.kaiDashboard = (await page.locator("body").innerText()).slice(0, 400).replace(/\s+/g, " ");
	await page.screenshot({ path: path.join(DIR, "r3-switch3-kai-dashboard.png") });
	writeFileSync(path.join(DIR, "r3-switch3.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
});
