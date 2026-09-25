/**
 * QA security verifier (I2 round 2): SEC-07. A guest opens the viewer link and
 * clicks an outbound guide link; the share token must not appear in any
 * request URL, Referer header or body sent anywhere (app, tiles, S3, links),
 * and it must be gone from the address bar and history.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { TOKEN } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";

test("the share token never leaves the page", async ({ browser }) => {
	test.setTimeout(200_000);
	const ctx = await browser.newContext();
	const leaks: string[] = [];
	const page0url = () => process.env.APP_URL ?? "http://localhost:3000";
	const hosts = new Set<string>();
	ctx.on("request", (r) => {
		hosts.add(new URL(r.url()).host);
		const h = r.headers();
		const blob = `${r.url()} ${h.referer ?? ""} ${r.postData() ?? ""}`;
		if (blob.includes(TOKEN.viewer) && !(r.url().includes("/_serverFn/") && new URL(r.url()).host === new URL(page0url()).host && (r.postData() ?? "").includes("token"))) leaks.push(`${r.method()} ${r.url().slice(0, 100)} referer=${(h.referer ?? "").slice(0, 80)}`);
	});
	const page = await ctx.newPage();
	await page.goto(`/join#t=${TOKEN.viewer}`);
	await page.waitForURL(/\/t\/asia-2027/, { timeout: 30_000 });
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.goto("/t/asia-2027/japan/tokyo/shinjuku/golden-gai");
	await page.getByRole("tab", { name: /^Media/ }).first().click();
	await page.waitForTimeout(3000);
	// Click an outbound link (a guide link card); it opens a popup.
	const ext = page.locator("a[href^='http']:not([href*='localhost'])").first();
	let popupUrl = "";
	if (await ext.count()) {
		const [popup] = await Promise.all([ctx.waitForEvent("page", { timeout: 10_000 }).catch(() => null), ext.click({ modifiers: [] }).catch(() => undefined)]);
		if (popup) {
			popupUrl = popup.url();
			await popup.close().catch(() => undefined);
		}
	}
	const history = await page.evaluate(() => ({ href: location.href, len: history.length }));
	const out = { leaks, hosts: [...hosts], popupUrl, history, relOfExternal: await ext.getAttribute("rel").catch(() => null) };
	writeFileSync(path.join(DIR, "r2-tokenleak.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	expect(leaks).toEqual([]);
	await ctx.close();
});
