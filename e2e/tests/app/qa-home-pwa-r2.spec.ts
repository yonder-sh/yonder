/**
 * I2 verifier "home" (round 2): PWA-08 purge on the PRODUCTION build (same
 * setup as qa-home-pwa.spec.ts: APP_URL = the collab router, QA_PROD_SH
 * start/stop). Logs what the device still holds after a removal and after
 * sign-out, then what an offline visit shows.
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
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/pwa-r2-${name}.png`, animations: "disabled" });
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function server(cmd: "start" | "stop") {
	console.log(`server ${cmd}: ${execFileSync(PROD, [cmd], { encoding: "utf8", timeout: 90_000 }).trim()}`);
}
async function goOffline(ctx: BrowserContext) {
	server("stop");
	await ctx.setOffline(true);
}
async function goOnline(ctx: BrowserContext) {
	await ctx.setOffline(false);
	server("start");
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
async function deviceState(page: Page) {
	return page.evaluate(async () => {
		const names = await caches.keys();
		const pages = names.includes("pages") ? (await (await caches.open("pages")).keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search) : null;
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
		return { caches: names, pages, saved: localStorage.getItem("yonder:saved-trips"), idb: idb.filter((k) => k.startsWith("yonder-q")) };
	});
}

async function tripWithMember(browser: Browser, name: string) {
	const o = await userCtx(browser, `qa-home-r2o-${uniq()}@asia2027.test`, "Olga", "Owner");
	const k = await userCtx(browser, `qa-home-r2k-${uniq()}@asia2027.test`, "Kai", "Member");
	const op = await o.newPage();
	await op.goto("/");
	await op.getByTestId("new-trip-button").first().click();
	await op.getByTestId("new-trip-name").fill(name);
	await op.getByTestId("new-trip-submit").click();
	await expect(op.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await op.keyboard.press("Escape");
	const slug = new URL(op.url()).pathname.split("/")[2]!;
	const kEmail = (await (await k.request.get("/api/auth/get-session")).json()).user.email;
	await op.getByTestId("share-button").first().click();
	const dlg = op.getByTestId("share-dialog");
	await dlg.getByTestId("home-invite-email").fill(kEmail);
	await dlg.getByTestId("home-invite-submit").click();
	const row = dlg.getByTestId("home-member-row").filter({ hasText: "Kai Member" });
	await expect(row).toBeVisible();
	return { o, k, op, row, slug };
}

test("R2 PWA-08: removed member — dashboard online, then trip online, then offline", async ({ browser }) => {
	const { o, k, op, row, slug } = await tripWithMember(browser, "R2 purge trip");
	const kp = await k.newPage();
	await kp.goto("/");
	await swControls(kp);
	await kp.goto(`/t/${slug}?tab=plan`);
	await expect(kp.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await kp.waitForTimeout(2500);
	console.log("R2-08 cached:", JSON.stringify(await deviceState(kp)));
	await kp.goto("about:blank");
	await row.getByTestId("home-member-menu").click();
	await op.getByRole("menuitem", { name: /remove from trip/i }).click();
	await expect(row).toBeHidden({ timeout: 10_000 });
	// (b) PWA-08b: Kai opens the app at '/' online
	await kp.goto("/");
	await expect(kp.getByTestId("dashboard")).toBeVisible({ timeout: 20_000 });
	await kp.waitForTimeout(3000);
	const dash = await deviceState(kp);
	console.log("R2-08b after dashboard online:", JSON.stringify(dash));
	await goOffline(k);
	try {
		const p = await k.newPage();
		await p.goto(`/t/${slug}?tab=plan`);
		await p.waitForTimeout(4000);
		const ws = await p.getByTestId("workspace").count();
		console.log("R2-08b offline trip: workspace=", ws, "|", (await p.locator("body").innerText()).slice(0, 200).replace(/\n/g, " | "));
		await shot(p, "08b-offline-trip");
		expect.soft(ws, "removed member reads the trip offline after a dashboard visit").toBe(0);
		const cold = await k.newPage();
		await cold.goto("/?source=pwa");
		await cold.waitForTimeout(4000);
		console.log("R2-08b cold start:", cold.url(), "|", (await cold.locator("body").innerText()).slice(0, 200).replace(/\n/g, " | "));
		await shot(cold, "08b-cold-start");
		expect.soft(await cold.getByTestId("workspace").count(), "cold start opens the lost trip").toBe(0);
	} finally {
		await goOnline(k);
	}
	// (a) PWA-08: Kai opens the trip URL online
	const kp2 = await k.newPage();
	await kp2.goto(`/t/${slug}?tab=plan`);
	await kp2.waitForTimeout(3500);
	console.log("R2-08 trip online after removal:", (await kp2.locator("body").innerText()).slice(0, 160).replace(/\n/g, " | "));
	const afterOpen = await deviceState(kp2);
	console.log("R2-08 after trip online:", JSON.stringify(afterOpen));
	await shot(kp2, "08-trip-online-after-removal");
	await goOffline(k);
	try {
		const p = await k.newPage();
		await p.goto(`/t/${slug}?tab=plan`);
		await p.waitForTimeout(4000);
		const txt = (await p.locator("body").innerText()).slice(0, 200).replace(/\n/g, " | ");
		console.log("R2-08 offline after trip online:", txt);
		await shot(p, "08-offline-after-trip-online");
		expect.soft(await p.getByTestId("workspace").count()).toBe(0);
		const html = await p.content();
		expect.soft(html, "no trip name in the offline page").not.toContain("R2 purge trip");
	} finally {
		await goOnline(k);
	}
	await o.close();
	await k.close();
});

test("R2 PWA-08: sign-out purge", async ({ browser }) => {
	const d = await userCtx(browser, `qa-home-r2s-${uniq()}@asia2027.test`, "Sam", "Signout");
	const p = await d.newPage();
	await p.goto("/");
	await swControls(p);
	await p.getByTestId("new-trip-button").first().click();
	await p.getByTestId("new-trip-name").fill("R2 signout trip");
	await p.getByTestId("new-trip-submit").click();
	await expect(p.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const slug = new URL(p.url()).pathname.split("/")[2]!;
	await p.waitForTimeout(2500);
	await p.goto("/");
	await expect(p.getByTestId("dashboard")).toBeVisible();
	console.log("R2 signout before:", JSON.stringify(await deviceState(p)));
	await p.getByTestId("account-menu").first().click();
	await p.getByRole("menuitem", { name: /sign out/i }).click();
	await expect(p).toHaveURL(/\/login/);
	await p.waitForTimeout(1500);
	const left = await deviceState(p);
	console.log("R2 signout after:", JSON.stringify(left));
	expect.soft((left.pages ?? []).some((u) => u.startsWith("/t/")), "trip shells left in the pages cache").toBe(false);
	expect.soft(left.saved ?? "").not.toContain(slug);
	expect.soft(left.idb.length, "persisted query cache left").toBe(0);
	await goOffline(d);
	try {
		const q = await d.newPage();
		await q.goto(`/t/${slug}?tab=plan`);
		await q.waitForTimeout(3500);
		console.log("R2 signout offline trip:", (await q.locator("body").innerText()).slice(0, 200).replace(/\n/g, " | "));
		await shot(q, "signout-offline-trip");
		expect.soft(await q.getByTestId("workspace").count()).toBe(0);
		const c = await d.newPage();
		await c.goto("/?source=pwa");
		await c.waitForTimeout(3500);
		console.log("R2 signout offline cold start:", c.url(), (await c.locator("body").innerText()).slice(0, 200).replace(/\n/g, " | "));
		await shot(c, "signout-offline-cold");
	} finally {
		await goOnline(d);
	}
	await d.close();
});
