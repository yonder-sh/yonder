/**
 * QA security verifier (I2 round 2), PRODUCTION build + service worker:
 * PWA-08 for a LINK GUEST. The guest opens the trip's address while its
 * view link is on (the trip is saved for offline), the owner turns the link
 * off, the guest opens the app online once ("no longer active"), then goes
 * offline. Nothing of the trip may be readable offline, in the UI or in
 * Cache Storage/IDB. (Turning the link on gives the seeded `asia-2027` its
 * address tail: the spec reads the address from the Share dialog.)
 * Needs QA_PROD_SH (start|stop) and APP_URL = the built server.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
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

async function storageHits(page: Page, needles: string[]) {
	return page.evaluate(async (needles) => {
		const hits: string[] = [];
		for (const name of await caches.keys()) {
			const c = await caches.open(name);
			for (const req of await c.keys()) {
				const res = await c.match(req);
				const t = res ? await res.clone().text().catch(() => "") : "";
				for (const n of needles) if (t.includes(n) || req.url.includes(n)) hits.push(`cache:${name}:${req.url.slice(0, 80)}:${n}`);
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
				for (const n of needles) if (t.includes(n)) hits.push(`idb:${d.name}/${store}:${n}`);
			}
			db.close();
		}
		return hits;
	}, needles);
}

test("PWA-08 for a link guest whose link is turned off", async ({ browser }) => {
	test.setTimeout(300_000);
	const out: Record<string, unknown> = {};
	const octx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(octx.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
	const op = await octx.newPage();
	await op.goto("/t/asia-2027?tab=plan");
	await expect(op.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await op.getByTestId("share-button").first().click();
	const dlg = op.getByTestId("share-dialog");
	const row = dlg.locator('[data-testid=share-link-row][data-role=viewer]');
	if ((await row.getByTestId("share-link-switch").getAttribute("aria-checked")) !== "true") await row.getByTestId("share-link-switch").click();
	await expect(row.getByTestId("share-link-switch")).toHaveAttribute("aria-checked", "true");
	// The trip's address is the link.
	const address = new URL(await row.getByTestId("share-link-url").inputValue()).pathname;
	const slug = address.replace(/^\/t\//, "");
	const g: BrowserContext = await browser.newContext();
	const gp = await g.newPage();
	await gp.goto("/login");
	await swControls(gp);
	await gp.goto(address);
	await expect(gp.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await gp.waitForTimeout(8000);
	const needles = ["Golden Gai", "Shibuya Sky", "Kawaguchiko"];
	out.beforeRevokeStorage = (await storageHits(gp, needles)).length;
	await row.getByTestId("share-link-switch").click();
	await op.waitForTimeout(1500);
	out.off = await row.getByTestId("share-link-switch").getAttribute("aria-checked");
	const c = { slug };
	// Control: a fresh browser with the same link.
	const fresh = await browser.newContext();
	const fp = await fresh.newPage();
	await fp.goto(address);
	await fp.waitForTimeout(4000);
	out.freshAfterRevoke = (await fp.locator("body").innerText()).slice(0, 80).replace(/\s+/g, " ");
	await fresh.close();
	// The guest opens the app online once.
	const fnLog: string[] = [];
	gp.on("response", async (r) => {
		if (r.url().includes("/_serverFn/")) fnLog.push(`${r.status()} ${(await r.text().catch(() => "")).slice(0, 90)}`);
	});
	await gp.goto(`/t/${c.slug}?tab=plan`);
	await gp.waitForTimeout(8000);
	out.fnLog = fnLog.slice(0, 12);
	await gp.screenshot({ path: path.join(DIR, "r2-pwaguest-online-after-revoke.png") });
	out.onlineAfterRevoke = { url: gp.url(), text: (await gp.locator("body").innerText()).slice(0, 120).replace(/\s+/g, " ") };
	out.afterRevokeStorage = await storageHits(gp, needles);
	server("stop");
	await g.setOffline(true);
	try {
		const p3 = await g.newPage();
		await p3.goto(`/t/${c.slug}?tab=plan`).catch(() => undefined);
		await p3.waitForTimeout(5000);
		out.offline = { workspace: await p3.getByTestId("workspace").count(), text: (await p3.locator("body").innerText()).slice(0, 200).replace(/\s+/g, " ") };
		await p3.screenshot({ path: path.join(DIR, "r2-pwaguest-offline.png") });
	} finally {
		await g.setOffline(false);
		server("start");
	}
	writeFileSync(path.join(DIR, "r2-pwaguest.json"), JSON.stringify(out, null, 1));
	// Restore the QA viewer link (fresh page: the old one went offline with the server).
	await op.reload();
	await expect(op.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await op.getByTestId("share-button").first().click();
	const sw = op.getByTestId("share-dialog").locator('[data-testid=share-link-row][data-role=viewer]').getByTestId("share-link-switch");
	if ((await sw.getAttribute("aria-checked")) !== "true") await sw.click();
	await op.waitForTimeout(1500);
	out.restored = await sw.getAttribute("aria-checked");
	console.log(JSON.stringify(out, null, 1));
	await octx.close();
	await g.close();
});
