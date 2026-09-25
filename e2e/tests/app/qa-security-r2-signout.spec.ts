/**
 * QA security verifier (I2 round 2), PRODUCTION build + service worker +
 * live channel (router): PWA-08 at sign-out on a shared device. Dennis opens
 * Asia 2027 (saved for offline), signs out; nothing of the trip may remain in
 * Cache Storage / IndexedDB, and going offline shows no trip.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";

test.skip(!process.env.QA_SEC_DIR || !process.env.QA_PROD_SH, "needs the production build and QA_PROD_SH");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const PROD = process.env.QA_PROD_SH ?? "";
const server = (cmd: "start" | "stop") => execFileSync(PROD, [cmd], { encoding: "utf8", timeout: 90_000 }).trim();

async function hits(page: Page, needles: string[]) {
	return page.evaluate(async (needles) => {
		const out: string[] = [];
		for (const name of await caches.keys()) {
			if (name.includes("precache")) continue; // the app bundle (demo data ships in it)
			const c = await caches.open(name);
			for (const req of await c.keys()) {
				const res = await c.match(req);
				const t = res ? await res.clone().text().catch(() => "") : "";
				for (const n of needles) if (t.includes(n) || req.url.includes(n)) out.push(`cache:${name}:${req.url.slice(0, 70)}:${n}`);
			}
		}
		for (const d of await indexedDB.databases()) {
			if (!d.name) continue;
			const db = await new Promise<IDBDatabase>((res, rej) => {
				const r = indexedDB.open(d.name as string);
				r.onsuccess = () => res(r.result);
				r.onerror = () => rej(r.error);
			});
			for (const store of Array.from(db.objectStoreNames)) {
				const all = await new Promise<unknown[]>((res) => {
					const r = db.transaction(store).objectStore(store).getAll();
					r.onsuccess = () => res(r.result);
					r.onerror = () => res([]);
				});
				const t = JSON.stringify(all);
				for (const n of needles) if (t.includes(n)) out.push(`idb:${d.name}/${store}:${n}`);
			}
			db.close();
		}
		return out;
	}, needles);
}

test("sign-out on a shared device leaves no trip data", async ({ browser }) => {
	test.setTimeout(300_000);
	const out: Record<string, unknown> = {};
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(ctx.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
	const page = await ctx.newPage();
	await page.goto("/dashboard");
	await expect.poll(() => page.evaluate(async () => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
	await page.goto("/t/asia-2027/japan/tokyo/shinjuku/golden-gai");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(8000);
	const needles = ["Golden Gai", "Kawaguchiko", "ZK4P7Q", "dennis@asia2027.test"];
	out.before = (await hits(page, needles)).length;
	await page.goto("/dashboard");
	await page.getByTestId("account-menu").first().click();
	await page.getByRole("menuitem", { name: /sign out/i }).click();
	await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
	await page.waitForTimeout(3000);
	out.afterSignOut = await hits(page, needles);
	server("stop");
	await ctx.setOffline(true);
	try {
		const p2 = await ctx.newPage();
		await p2.goto("/t/asia-2027/japan/tokyo/shinjuku/golden-gai").catch(() => undefined);
		await p2.waitForTimeout(4000);
		out.offline = { workspace: await p2.getByTestId("workspace").count(), text: (await p2.locator("body").innerText()).slice(0, 160).replace(/\s+/g, " ") };
		await p2.screenshot({ path: path.join(DIR, "r2-signout-offline.png") });
	} finally {
		await ctx.setOffline(false);
		server("start");
	}
	writeFileSync(path.join(DIR, "r2-signout.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
});
