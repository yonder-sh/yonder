/**
 * QA security verifier (I2 round 2), PRODUCTION build (`NODE_ENV=production`,
 * limiters on): a group of guests on one network opening the real share link
 * (re-check of the "3 new guests per minute per IP" bug), then guessing.
 * Run with APP_URL_OVERRIDE / QA_SEC_PROD_URL = the built server.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { TOKEN } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR || !process.env.QA_SEC_PROD_URL, "QA security verifier probes: set QA_SEC_DIR and QA_SEC_PROD_URL");
const PROD = process.env.QA_SEC_PROD_URL ?? "http://localhost:5372";
const DIR = process.env.QA_SEC_DIR ?? "/tmp";
test.use({ baseURL: PROD });

test("a group of guests on one IP opens the real link; guessing is limited", async ({ browser }) => {
	test.setTimeout(300_000);
	const out: { step: string; result: string }[] = [];
	const open = async (token: string, label: string) => {
		const ctx = await browser.newContext({ baseURL: PROD });
		const page = await ctx.newPage();
		await page.goto(`/join#t=${token}`);
		await page
			.waitForFunction(() => /\/t\//.test(location.pathname) || /no longer works|too many|try again|wait/i.test(document.body.innerText), undefined, { timeout: 30_000 })
			.catch(() => undefined);
		await page.waitForTimeout(800);
		const text = (await page.locator("body").innerText()).slice(0, 120).replace(/\s+/g, " ");
		const result = /\/t\//.test(new URL(page.url()).pathname) ? "IN" : /too many|try again|wait/i.test(text) ? `LIMITED: ${text}` : /no longer works/i.test(text) ? "dead link" : `?? ${page.url()} ${text}`;
		out.push({ step: label, result });
		if (label.startsWith("guest 11")) await page.screenshot({ path: path.join(DIR, "r2-prod-guest11.png") });
		await ctx.close();
	};
	for (let i = 1; i <= 6; i++) await open(TOKEN.viewer, `guest ${i} (real link)`);
	for (let i = 1; i <= 2; i++) await open(`badtoken${Date.now().toString(36)}${i}xxxxxxxxxxxxxxxxxxxxxx`, `typo ${i} (invalid token)`);
	await open(TOKEN.viewer, "guest 9 (real link)");
	await open(TOKEN.viewer, "guest 10 (real link)");
	await open(TOKEN.viewer, "guest 11 (real link)");
	await open(TOKEN.viewer, "guest 12 (real link)");
	writeFileSync(path.join(DIR, "r2-prod-group.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
});
