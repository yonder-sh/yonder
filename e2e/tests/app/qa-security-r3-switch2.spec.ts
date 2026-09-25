/**
 * QA security verifier (I2 round 3): what exactly stays on a shared device
 * after another person signs in (companion to qa-security-r3-switch): the
 * cached /share page and the keyval entry that mention the previous person.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";

test.skip(!process.env.QA_SEC_DIR || !process.env.QA_PROD_SH, "needs the production build and QA_PROD_SH");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";

async function swControls(page: Page) {
	await expect
		.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active && !!navigator.serviceWorker.controller), { timeout: 30_000 })
		.toBe(true);
}

test("residue after an identity switch", async ({ browser }) => {
	test.setTimeout(200_000);
	const out: Record<string, unknown> = {};
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(ctx.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
	const page = await ctx.newPage();
	await page.goto("/dashboard");
	await swControls(page);
	await page.goto("/t/asia-2027?tab=plan");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(8000);
	await ctx.clearCookies();
	await loginViaApi(ctx.request, "eve@asia2027.test", { first: "Eve", last: "Outsider" });
	await page.goto("/dashboard");
	await page.waitForTimeout(6000);
	out.residue = await page.evaluate(async () => {
		const res: Record<string, unknown> = {};
		const c = await caches.open("pages");
		for (const req of await c.keys()) {
			const r = await c.match(req);
			const t = r ? await r.text() : "";
			const i = t.indexOf("Dennis");
			res[`pages:${new URL(req.url).pathname}`] = {
				bytes: t.length,
				around: i >= 0 ? t.slice(Math.max(0, i - 300), i + 200) : null,
				emails: t.match(/[\w.+-]+@[\w-]+\.[\w.]+/g)?.slice(0, 5) ?? [],
				trips: t.match(/asia-2027|Asia 2027|Phu Quoc|Delete me/g)?.slice(0, 5) ?? [],
			};
		}
		const db = await new Promise<IDBDatabase>((ok, ko) => {
			const r = indexedDB.open("keyval-store");
			r.onsuccess = () => ok(r.result);
			r.onerror = () => ko(r.error);
		});
		const keys = await new Promise<IDBValidKey[]>((ok) => {
			const r = db.transaction("keyval").objectStore("keyval").getAllKeys();
			r.onsuccess = () => ok(r.result);
		});
		for (const k of keys) {
			const v = await new Promise<unknown>((ok) => {
				const r = db.transaction("keyval").objectStore("keyval").get(k);
				r.onsuccess = () => ok(r.result);
			});
			const s = JSON.stringify(v) ?? "";
			if (s.includes("asia-2027") || String(k).includes("asia-2027")) res[`idb:${String(k)}`] = s.slice(0, 400);
		}
		return res;
	});
	writeFileSync(path.join(DIR, "r3-switch2.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
});
