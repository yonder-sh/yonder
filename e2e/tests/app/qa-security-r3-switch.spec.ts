/**
 * QA security verifier (I2 round 3), PRODUCTION build + service worker:
 * PWA-08 on a shared device WITHOUT an explicit sign-out. Dennis opens Asia
 * 2027 (saved for offline); his session ends (cookie gone: expiry or "sign
 * out everywhere"); Eve, who has no access, signs in on the same browser and
 * opens the dashboard. Nothing of Dennis's trip may remain readable, online
 * or offline, in the UI, Cache Storage, IndexedDB or localStorage.
 * Needs QA_PROD_SH (start|stop) and APP_URL = the built server (router).
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

async function swControls(page: Page) {
	await expect
		.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active && !!navigator.serviceWorker.controller), { timeout: 30_000 })
		.toBe(true);
}

async function storage(page: Page, needles: string[]) {
	return page.evaluate(async (needles) => {
		const hits: string[] = [];
		for (const name of await caches.keys()) {
			if (name.startsWith("serwist-precache")) continue; // the app's own bundles (the demo fixture strings live there)
			const c = await caches.open(name);
			for (const req of await c.keys()) {
				const res = await c.match(req);
				const t = res ? await res.clone().text().catch(() => "") : "";
				for (const n of needles) if (t.includes(n) || req.url.includes(n)) hits.push(`cache:${name}:${new URL(req.url).pathname.slice(0, 60)}:${n}`);
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
				const [all, keys] = await Promise.all([
					new Promise<unknown[]>((res) => {
						const r = db.transaction(store).objectStore(store).getAll();
						r.onsuccess = () => res(r.result);
						r.onerror = () => res([]);
					}),
					new Promise<unknown[]>((res) => {
						const r = db.transaction(store).objectStore(store).getAllKeys();
						r.onsuccess = () => res(r.result);
						r.onerror = () => res([]);
					}),
				]);
				const t = JSON.stringify(all) + JSON.stringify(keys);
				for (const n of needles) if (t.includes(n)) hits.push(`idb:${d.name}/${store}:${n}`);
			}
			db.close();
		}
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i) as string;
			const v = localStorage.getItem(k) ?? "";
			for (const n of needles) if (k.includes(n) || v.includes(n)) hits.push(`ls:${k}:${n}`);
		}
		return hits;
	}, needles);
}

test("another person signs in on the same device: the previous person's trip is gone", async ({ browser }) => {
	test.setTimeout(300_000);
	const out: Record<string, unknown> = {};
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(ctx.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
	const page = await ctx.newPage();
	await page.goto("/");
	await swControls(page);
	await page.goto("/t/asia-2027?tab=plan");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(8000);
	const needles = ["Golden Gai", "Kawaguchiko", "ZK4P7Q", "asia-2027", "Dennis Tester"];
	out.dennisStorage = (await storage(page, needles)).length;
	// Dennis's session ends without a sign-out on this device.
	await ctx.clearCookies();
	await loginViaApi(ctx.request, "eve@asia2027.test", { first: "Eve", last: "Outsider" });
	await page.goto("/");
	await page.waitForTimeout(6000);
	out.eveDashboard = (await page.locator("body").innerText()).slice(0, 300).replace(/\s+/g, " ");
	await page.screenshot({ path: path.join(DIR, "r3-switch-eve-dashboard.png") });
	out.eveStorageAfterDashboard = await storage(page, needles);
	await page.goto("/t/asia-2027?tab=plan");
	await page.waitForTimeout(5000);
	out.eveOpensTripOnline = { workspace: await page.getByTestId("workspace").count(), text: (await page.locator("body").innerText()).slice(0, 160).replace(/\s+/g, " ") };
	out.eveStorageAfterTrip = await storage(page, needles);
	server("stop");
	await ctx.setOffline(true);
	try {
		const p2 = await ctx.newPage();
		await p2.goto("/t/asia-2027?tab=plan").catch(() => undefined);
		await p2.waitForTimeout(5000);
		out.eveOffline = { workspace: await p2.getByTestId("workspace").count(), text: (await p2.locator("body").innerText()).slice(0, 200).replace(/\s+/g, " ") };
		await p2.screenshot({ path: path.join(DIR, "r3-switch-eve-offline.png") });
		const p3 = await ctx.newPage();
		await p3.goto("/?source=pwa").catch(() => undefined);
		await p3.waitForTimeout(4000);
		out.eveOfflineHome = (await p3.locator("body").innerText()).slice(0, 200).replace(/\s+/g, " ");
		await p3.screenshot({ path: path.join(DIR, "r3-switch-eve-offline-home.png") });
	} finally {
		await ctx.setOffline(false);
		server("start");
	}
	writeFileSync(path.join(DIR, "r3-switch.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
});
