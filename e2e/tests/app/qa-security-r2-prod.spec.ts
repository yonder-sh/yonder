/**
 * QA security verifier (I2 round 2), PRODUCTION build (`NODE_ENV=production`,
 * limiters on): a group of guests on one network opening the real share link
 * (the trip's address, `/t/asia-2027`, with its link on) (re-check of the "3
 * new guests per minute per IP" bug), then guessing addresses.
 * Run with APP_URL_OVERRIDE / QA_SEC_PROD_URL = the built server.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";

test.skip(!process.env.QA_SEC_DIR || !process.env.QA_SEC_PROD_URL, "QA security verifier probes: set QA_SEC_DIR and QA_SEC_PROD_URL");
const PROD = process.env.QA_SEC_PROD_URL ?? "http://localhost:5372";
const DIR = process.env.QA_SEC_DIR ?? "/tmp";
test.use({ baseURL: PROD });

test("a group of guests on one IP opens the real link; guessing is limited", async ({ browser }) => {
	test.setTimeout(300_000);
	const out: { step: string; result: string }[] = [];
	const open = async (slug: string, label: string) => {
		const ctx = await browser.newContext({ baseURL: PROD });
		const page = await ctx.newPage();
		await page.goto(`/t/${slug}`);
		await page
			.waitForFunction(() => !!document.querySelector('[data-testid="workspace"], [data-testid="trip-no-access"]'), undefined, { timeout: 30_000 })
			.catch(() => undefined);
		await page.waitForTimeout(800);
		const text = (await page.locator("body").innerText()).slice(0, 120).replace(/\s+/g, " ");
		const result = (await page.getByTestId("workspace").count()) ? "IN" : (await page.getByTestId("trip-no-access").count()) ? "no access" : `?? ${page.url()} ${text}`;
		out.push({ step: label, result });
		if (label.startsWith("guest 11")) await page.screenshot({ path: path.join(DIR, "r2-prod-guest11.png") });
		await ctx.close();
	};
	for (let i = 1; i <= 6; i++) await open("asia-2027", `guest ${i} (real link)`);
	for (let i = 1; i <= 2; i++) await open(`asia-2027-typo${Date.now().toString(36)}${i}`, `typo ${i} (wrong address)`);
	await open("asia-2027", "guest 9 (real link)");
	await open("asia-2027", "guest 10 (real link)");
	await open("asia-2027", "guest 11 (real link)");
	await open("asia-2027", "guest 12 (real link)");
	writeFileSync(path.join(DIR, "r2-prod-group.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
});
