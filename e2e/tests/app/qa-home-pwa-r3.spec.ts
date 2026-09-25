/**
 * I2 verifier "home" (round 3): PWA-10's map pane offline on the production
 * build (APP_URL = the collab router, QA_PROD_SH start/stop).
 */
import { execFileSync } from "node:child_process";
import { type Browser, type BrowserContext, type Page, expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { APP_URL } from "./_helpers/env";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
	test.skip(!process.env.QA_PROD_SH, "needs the production build behind the collab router and QA_PROD_SH (start/stop)");
});

const SHOTS = process.env.QA_SHOTS ?? "shots";
const PROD = process.env.QA_PROD_SH ?? "";
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/pwa-r3-${name}.png`, animations: "disabled" });

function server(cmd: "start" | "stop") {
	console.log(`server ${cmd}: ${execFileSync(PROD, [cmd], { encoding: "utf8", timeout: 90_000 }).trim()}`);
}
async function userCtx(browser: Browser, email: string, first: string, last: string) {
	const ctx = await browser.newContext({ baseURL: APP_URL, viewport: { width: 1440, height: 900 } });
	for (let i = 0; ; i++) {
		try {
			await loginViaApi(ctx.request, email, { first, last });
			break;
		} catch (e) {
			if (i >= 4) throw e;
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
	return ctx;
}
async function swControls(page: Page) {
	await expect
		.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active && !!navigator.serviceWorker.controller), { timeout: 30_000 })
		.toBe(true);
}
async function mapState(page: Page) {
	return page.evaluate(() => {
		const m = document.querySelector('[data-testid="trip-map"]') as HTMLElement | null;
		const c = m?.querySelector("canvas") as HTMLCanvasElement | null;
		return {
			hasMap: !!m,
			visibleText: m ? m.innerText.replace(/\n/g, " | ").slice(0, 200) : null,
			canvas: c ? `${c.width}x${c.height}` : null,
			unavailable: /unavailable offline|offline/i.test(m?.innerText ?? ""),
		};
	});
}

test("R3 PWA-10: the map pane on the saved trip, online then offline", async ({ browser }) => {
	const d: BrowserContext = await userCtx(browser, "dennis@asia2027.test", "Dennis", "Tester");
	const p = await d.newPage();
	await p.goto("/dashboard");
	await swControls(p);
	for (const url of ["/t/asia-2027?days=2027-10-05", "/t/asia-2027"]) {
		await p.goto(url);
		await expect(p.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await p.waitForTimeout(8000);
		console.log("R3 map online", url, JSON.stringify(await mapState(p)));
		await shot(p, `map-online-${url.includes("days") ? "day" : "root"}`);
	}
	server("stop");
	await d.setOffline(true);
	try {
		for (const url of ["/t/asia-2027?days=2027-10-05", "/t/asia-2027", "/t/asia-2027?lens=city"]) {
			await p.goto(url);
			await expect(p.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
			await p.waitForTimeout(10_000);
			console.log("R3 map offline", url, JSON.stringify(await mapState(p)));
			await shot(p, `map-offline-${url.includes("days") ? "day" : url.includes("lens") ? "city" : "root"}`);
		}
	} finally {
		await d.setOffline(false);
		server("start");
	}
	await d.close();
});

async function deviceState(page: Page) {
	return page.evaluate(async () => {
		const names = await caches.keys();
		const pages = names.includes("pages") ? (await (await caches.open("pages")).keys()).map((r) => new URL(r.url).pathname) : null;
		let idb: string[] = [];
		try {
			idb = await new Promise((resolve) => {
				const req = indexedDB.open("keyval-store");
				req.onsuccess = () => {
					try {
						const all = req.result.transaction("keyval", "readonly").objectStore("keyval").getAllKeys();
						all.onsuccess = () => resolve((all.result as IDBValidKey[]).map(String));
						all.onerror = () => resolve([]);
					} catch {
						resolve([]);
					}
				};
				req.onerror = () => resolve([]);
			});
		} catch {}
		return {
			pages,
			saved: localStorage.getItem("yonder:saved-trips"),
			grants: localStorage.getItem("yonder:grants"),
			gone: localStorage.getItem("yonder:grants-gone"),
			idbTrip: idb.filter((k) => k.includes('"trip"')).length,
		};
	});
}

for (const live of [true, false]) {
	test(`R3 guest offline copy after the link is turned off (${live ? "tab open" : "tab closed"})`, async ({ browser }) => {
		const o = await userCtx(browser, `qa-home-r3g-${Date.now().toString(36)}@asia2027.test`, "Olga", "Owner");
		const op = await o.newPage();
		const res = await op.request.post("/api/test/fixture", { headers: { Origin: APP_URL } });
		expect(res.ok(), await res.text()).toBe(true);
		const c = (await res.json()) as { slug: string; shareTokens: { editor: string } };
		const g = await browser.newContext({ baseURL: APP_URL, viewport: { width: 1440, height: 900 } });
		let gp = await g.newPage();
		await gp.goto(`/join#t=${c.shareTokens.editor}`);
		await expect(gp.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await swControls(gp);
		await gp.reload();
		await expect(gp.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await gp.waitForTimeout(3000);
		console.log(`R3 guest(${live}) cached:`, JSON.stringify(await deviceState(gp)));
		if (!live) await gp.goto("about:blank");
		// owner turns the edit link off in the share dialog
		await op.goto(`/t/${c.slug}?tab=plan`);
		await expect(op.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await op.getByTestId("share-button").first().click();
		const sw = op.getByTestId("share-dialog").getByRole("switch", { name: /edit link/i });
		await expect(sw).toBeChecked();
		await sw.click();
		await expect(sw).not.toBeChecked({ timeout: 10_000 });
		if (live) {
			await expect(gp.getByTestId("workspace")).toBeHidden({ timeout: 10_000 });
			await gp.waitForTimeout(2500);
			console.log(`R3 guest(${live}) kicked to:`, gp.url(), (await gp.locator("body").innerText()).slice(0, 120).replace(/\n/g, " | "));
		} else {
			await gp.goto(`/t/${c.slug}?tab=plan`);
			await gp.waitForTimeout(4000);
			console.log(`R3 guest(${live}) opens trip online:`, gp.url(), (await gp.locator("body").innerText()).slice(0, 120).replace(/\n/g, " | "));
		}
		const st = await deviceState(gp);
		console.log(`R3 guest(${live}) after:`, JSON.stringify(st));
		await shot(gp, `guest-${live ? "live" : "closed"}-after-off`);
		server("stop");
		await g.setOffline(true);
		try {
			gp = await g.newPage();
			await gp.goto(`/t/${c.slug}?tab=plan`);
			await gp.waitForTimeout(4000);
			const ws = await gp.getByTestId("workspace").count();
			const txt = (await gp.locator("body").innerText()).slice(0, 160).replace(/\n/g, " | ");
			console.log(`R3 guest(${live}) offline:`, "workspace=", ws, txt);
			await shot(gp, `guest-${live ? "live" : "closed"}-offline`);
			expect.soft(ws, "no trip content offline after the link was turned off").toBe(0);
			expect.soft(st.saved ?? "[]").not.toContain(c.slug);
			expect.soft(st.pages ?? []).not.toContain(`/t/${c.slug}`);
		} finally {
			await g.setOffline(false);
			server("start");
		}
		await g.close();
		await o.close();
	});
}
