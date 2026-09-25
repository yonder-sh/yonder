/**
 * I2 verifier "home" (round 1): PWA-* (qa/SCENARIOS §22) and the share target
 * (EXTENSIONS §10) against the PRODUCTION build behind a small router that
 * sends /collab to the collab server (APP_URL = the router). The offline
 * steps stop the built server (QA_PROD_SH stop/start) because setOffline
 * doesn't reach the service worker's own fetches.
 */
import { execFileSync } from "node:child_process";
import { type APIRequestContext, type Browser, type BrowserContext, type Page, expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { APP_URL } from "./_helpers/env";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
});

test.beforeEach(({}, info) => {
	test.skip(!process.env.QA_PROD_SH, "needs the production build behind the collab router and QA_PROD_SH (start/stop)");
});


test.describe.configure({ mode: "serial" });

const SHOTS = process.env.QA_SHOTS ?? "shots";
const PROD = process.env.QA_PROD_SH ?? "";
const shot = (page: Page, name: string, fullPage = false) =>
	page.screenshot({ path: `${SHOTS}/pwa-${name}.png`, animations: "disabled", fullPage });
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function server(cmd: "start" | "stop") {
	const out = execFileSync(PROD, [cmd], { encoding: "utf8", timeout: 90_000 });
	console.log(`server ${cmd}: ${out.trim()}`);
}

async function login(req: APIRequestContext, email: string, first: string, last: string) {
	for (let i = 0; ; i++) {
		try {
			return await loginViaApi(req, email, { first, last });
		} catch (e) {
			if (i >= 4) throw e;
			await new Promise((r) => setTimeout(r, 800 + Math.random() * 1500));
		}
	}
}

async function userCtx(browser: Browser, email: string, first: string, last: string) {
	const ctx = await browser.newContext({ baseURL: APP_URL, viewport: { width: 1440, height: 900 } });
	await login(ctx.request, email, first, last);
	return ctx;
}

async function swControls(page: Page) {
	await expect
		.poll(
			() =>
				page.evaluate(async () => {
					const reg = await navigator.serviceWorker.getRegistration();
					return !!reg?.active && !!navigator.serviceWorker.controller;
				}),
			{ timeout: 30_000 },
		)
		.toBe(true);
}

async function goOffline(ctx: BrowserContext) {
	server("stop");
	await ctx.setOffline(true);
}
async function goOnline(ctx: BrowserContext) {
	await ctx.setOffline(false);
	server("start");
}

function pngSize(buf: Buffer): [number, number] {
	return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test("PWA-01: manifest, icons, service worker", async ({ browser }) => {
	const ctx = await userCtx(browser, `qa-home-pwa1-${uniq()}@asia2027.test`, "Pia", "One");
	const page = await ctx.newPage();
	const sw = await page.request.get("/sw.js");
	expect(sw.status()).toBe(200);
	expect(sw.headers()["content-type"]).toContain("javascript");
	await page.goto("/");
	const href = await page.locator('link[rel="manifest"]').getAttribute("href");
	const m = await (await page.request.get(href!)).json();
	console.log("PWA-01 manifest:", JSON.stringify({ ...m, icons: m.icons, share_target: m.share_target }).slice(0, 1200));
	expect(m.name).toBe("Yonder");
	expect(m.short_name).toBeTruthy();
	expect(m.start_url).toBeTruthy();
	expect(m.display).toBe("standalone");
	expect(m.theme_color).toBeTruthy();
	expect(m.background_color).toBeTruthy();
	const sizes: string[] = [];
	for (const icon of m.icons as { src: string; sizes?: string; purpose?: string; type?: string }[]) {
		const r = await page.request.get(icon.src);
		expect(r.status(), icon.src).toBe(200);
		if (icon.type === "image/png" || icon.src.endsWith(".png")) {
			const [w, h] = pngSize(await r.body());
			expect(`${w}x${h}`, icon.src).toBe(icon.sizes);
			sizes.push(`${icon.sizes}${icon.purpose ? `(${icon.purpose})` : ""}`);
		}
	}
	console.log("PWA-01 icons:", sizes);
	expect(sizes.join(" ")).toMatch(/192x192/);
	expect(sizes.join(" ")).toMatch(/512x512/);
	expect(sizes.join(" ")).toMatch(/maskable/);
	expect(m.share_target?.action).toBe("/share");
	await swControls(page);
	await page.reload();
	await swControls(page);
	await ctx.close();
});

test("PWA-03/04/06: last trip offline — reload, other days/scopes, read-only, cold start, back online", async ({ browser }) => {
	const ctx = await userCtx(browser, "dennis@asia2027.test", "Dennis", "Tester");
	const page = await ctx.newPage();
	await page.goto("/");
	await swControls(page);
	await page.goto("/t/asia-2027?days=2027-10-05");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("connection-pill").first()).toHaveAttribute("data-status", "live", { timeout: 20_000 });
	const gg = page.getByTestId("timeline-item").filter({ hasText: "Golden Gai" }).first();
	await expect(gg).toBeVisible({ timeout: 15_000 });
	const ggOnline = (await gg.innerText()).replace(/\n/g, " ");
	const ggTimes = (await page.getByTestId("timeline-item").filter({ hasText: "Golden Gai" }).first().locator("xpath=ancestor::*[1]").innerText()).replace(/\n/g, " ");
	console.log("PWA-03 Golden Gai online:", ggOnline, "|", ggTimes.slice(0, 120));
	// visit Mt. Fuji once? No: PWA-03 says the whole trip is cached, not only viewed pages
	await page.waitForTimeout(2500);
	await page.goto("/");
	await expect(page.getByTestId("home-hero")).toContainText(/Available offline/, { timeout: 15_000 });
	await shot(page, "03-dashboard-available-offline");
	await page.goto("/t/asia-2027?days=2027-10-05");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(2000);
	await goOffline(ctx);
	try {
		await page.reload();
		await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("offline-banner")).toBeVisible({ timeout: 15_000 });
		const banner = await page.getByTestId("offline-banner").innerText();
		console.log("PWA-03 banner:", banner);
		expect(banner).toMatch(/Saved copy from \d\d:\d\d · editing paused/);
		const ggOff = page.getByTestId("timeline-item").filter({ hasText: "Golden Gai" }).first();
		await expect(ggOff).toBeVisible({ timeout: 15_000 });
		await shot(page, "03-offline-oct5");
		const ggTimesOff = (await ggOff.locator("xpath=ancestor::*[1]").innerText()).replace(/\n/g, " ");
		console.log("PWA-03 Golden Gai offline:", ggTimesOff.slice(0, 120));
		expect(ggTimesOff).toContain("21:05");
		// PWA-06: read-only
		const addPlace = page.getByRole("button", { name: "Add a place" }).first();
		expect.soft(await addPlace.isDisabled(), "Add a place disabled offline").toBe(true);
		await addPlace.hover({ force: true });
		await page.waitForTimeout(800);
		const tip = await page.getByRole("tooltip").allInnerTexts();
		console.log("PWA-06 tooltip on Add a place:", tip);
		expect.soft(tip.join(" "), "tooltip says Reconnect to edit").toMatch(/Reconnect|Offline/i);
		expect.soft(await page.locator('[contenteditable="true"]').count(), "nothing editable offline").toBe(0);
		// other day (never viewed) and a scope URL
		await page.goto("/t/asia-2027?days=2027-10-31");
		await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(1500);
		await shot(page, "03-offline-oct31");
		const oct31 = await page.getByTestId("center-panel").innerText().catch(() => page.getByTestId("workspace").innerText());
		console.log("PWA-03 Oct 31 offline:", oct31.slice(0, 300).replace(/\n/g, " | "));
		expect(oct31).toMatch(/31 Oct/);
		await page.goto("/t/asia-2027/japan/mt-fuji");
		await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(1500);
		await shot(page, "03-offline-fuji");
		console.log("PWA-03 fuji url:", page.url(), (await page.getByTestId("scope-breadcrumb").first().innerText().catch(() => "")).replace(/\n/g, " > "));
		// notes and lists offline
		await page.goto("/t/asia-2027?tab=notes");
		await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(2000);
		await shot(page, "03-offline-notes");
		const notes = await page.getByTestId("workspace").innerText();
		console.log("PWA-03 notes offline:", notes.includes("Saved copy") || notes.includes("editing paused"), notes.slice(0, 200).replace(/\n/g, " | "));
		expect.soft(await page.locator('[contenteditable="true"]').count(), "notes not editable offline").toBe(0);
		await page.goto("/t/asia-2027?tab=lists");
		await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(1500);
		await shot(page, "03-offline-lists");
		// PWA-04: cold start
		const cold = await ctx.newPage();
		await cold.goto("/?source=pwa");
		await expect(cold).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
		await expect(cold.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await shot(cold, "04-cold-start");
		await cold.close();
		// another trip is not available offline
		const other = await ctx.newPage();
		await other.goto("/t/phu-quoc-detour?tab=plan");
		await other.waitForTimeout(3000);
		const ot = await other.locator("body").innerText();
		console.log("PWA-05 other trip offline:", other.url(), ot.slice(0, 200).replace(/\n/g, " | "));
		await shot(other, "05-other-trip-offline");
		expect(ot).toMatch(/Not available offline/i);
		await other.close();
		await page.goto("/t/asia-2027?days=2027-10-05");
		await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("offline-banner")).toBeVisible();
	} finally {
		await goOnline(ctx);
	}
	// PWA-06: controls return without a reload
	const back = await expect(page.getByTestId("offline-banner"))
		.toBeHidden({ timeout: 30_000 })
		.then(() => true)
		.catch(() => false);
	console.log("PWA-06 banner gone after reconnect without reload:", back);
	await shot(page, "06-back-online");
	expect.soft(back, "banner clears and editing returns without reload").toBe(true);
	if (back) {
		await expect(page.getByTestId("connection-pill").first()).toHaveAttribute("data-status", "live", { timeout: 20_000 });
		await expect(page.getByRole("button", { name: "Add a place" }).first()).toBeEnabled({ timeout: 20_000 });
	}
	await ctx.close();
});

test("PWA-05: only the last trip is kept", async ({ browser }) => {
	const ctx = await userCtx(browser, "dennis@asia2027.test", "Dennis", "Tester");
	const page = await ctx.newPage();
	await page.goto("/");
	await swControls(page);
	await page.goto("/t/asia-2027?tab=plan");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	await page.goto("/t/phu-quoc-detour?tab=plan");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(2500);
	const saved = await page.evaluate(() => localStorage.getItem("yonder:saved-trips"));
	console.log("PWA-05 saved-trips:", saved);
	await goOffline(ctx);
	try {
		await page.goto("/t/phu-quoc-detour?tab=plan");
		await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await shot(page, "05-phu-quoc-offline");
		const p2 = await ctx.newPage();
		await p2.goto("/t/asia-2027?tab=plan");
		await p2.waitForTimeout(3000);
		const t = await p2.locator("body").innerText();
		console.log("PWA-05 Asia offline:", t.slice(0, 200).replace(/\n/g, " | "));
		await shot(p2, "05-asia-offline");
		expect(t).toMatch(/Not available offline/i);
		expect(await p2.getByTestId("workspace").count()).toBe(0);
	} finally {
		await goOnline(ctx);
	}
	await ctx.close();
});

test("PWA-07/08: offline copy refreshes; sign-out and removal purge the offline copy", async ({ browser }) => {
	// Owner + member on a trip the owner makes
	const o = await userCtx(browser, `qa-home-pwa8o-${uniq()}@asia2027.test`, "Olga", "Owner");
	const k = await userCtx(browser, `qa-home-pwa8k-${uniq()}@asia2027.test`, "Kai", "Member");
	const op = await o.newPage();
	await op.goto("/");
	const kEmail = (await (await k.request.get("/api/auth/get-session")).json()).user.email;
	const made = await op.evaluate(async () => {
		const m = await import("/src/functions/trips.functions.ts").catch(() => null);
		return !!m;
	}).catch(() => false);
	console.log("PWA-08 can import source in prod build:", made);
	// Use the UI: New trip
	await op.getByTestId("new-trip-button").first().click();
	await op.getByTestId("new-trip-name").fill("Offline purge trip");
	await op.getByTestId("new-trip-submit").click();
	await expect(op.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await op.keyboard.press("Escape");
	const slug = new URL(op.url()).pathname.split("/")[2]!;
	await op.getByTestId("share-button").first().click();
	const dlg = op.getByTestId("share-dialog");
	await dlg.getByTestId("home-invite-role").click();
	await op.getByRole("option", { name: /Can edit/ }).click();
	await dlg.getByTestId("home-invite-email").fill(kEmail);
	await dlg.getByTestId("home-invite-submit").click();
	const row = dlg.getByTestId("home-member-row").filter({ hasText: "Kai Member" });
	await expect(row).toBeVisible();
	// Kai caches it
	const kp = await k.newPage();
	await kp.goto("/");
	await swControls(kp);
	await kp.goto(`/t/${slug}?tab=plan`);
	await expect(kp.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await kp.waitForTimeout(2500);
	const before = await kp.evaluate(async (s) => ({
		saved: localStorage.getItem("yonder:saved-trips"),
		page: !!(await (await caches.open("pages")).match(`/t/${s}`, { ignoreSearch: true })),
	}), slug);
	console.log("PWA-08 kai before removal:", before);
	await kp.goto("about:blank");
	// owner removes Kai
	await row.getByTestId("home-member-menu").click();
	await op.getByRole("menuitem", { name: /remove from trip/i }).click();
	await expect(row).toBeHidden({ timeout: 10_000 });
	// Kai opens the app online
	await kp.goto("/");
	await expect(kp.getByTestId("dashboard")).toBeVisible({ timeout: 20_000 });
	await kp.waitForTimeout(3000);
	const afterDash = await kp.evaluate(async (s) => ({
		saved: localStorage.getItem("yonder:saved-trips"),
		page: !!(await (await caches.open("pages")).match(`/t/${s}`, { ignoreSearch: true })),
	}), slug);
	console.log("PWA-08 kai after removal, dashboard only:", afterDash);
	await kp.goto(`/t/${slug}?tab=plan`);
	await kp.waitForTimeout(3000);
	const afterOpen = await kp.evaluate(async (s) => {
		const idb: string[] = await new Promise((resolve) => {
			const req = indexedDB.open("keyval-store");
			req.onsuccess = () => {
				try {
					const tx = req.result.transaction("keyval", "readonly");
					const all = tx.objectStore("keyval").getAllKeys();
					all.onsuccess = () => resolve((all.result as IDBValidKey[]).map(String));
					all.onerror = () => resolve([]);
				} catch {
					resolve([]);
				}
			};
			req.onerror = () => resolve([]);
		});
		return {
			saved: localStorage.getItem("yonder:saved-trips"),
			page: !!(await (await caches.open("pages")).match(`/t/${s}`, { ignoreSearch: true })),
			idb: idb.filter((x) => x.startsWith("yonder-q")).slice(0, 10),
		};
	}, slug);
	console.log("PWA-08 kai after opening the trip:", JSON.stringify(afterOpen));
	expect.soft(afterOpen.saved ?? "", "saved-trips cleared of the lost trip").not.toContain(slug);
	expect.soft(afterOpen.page, "pages cache entry removed").toBe(false);
	// offline afterwards shows no trip content
	await goOffline(k);
	try {
		const p3 = await k.newPage();
		await p3.goto(`/t/${slug}?tab=plan`);
		await p3.waitForTimeout(3000);
		const t = await p3.locator("body").innerText();
		console.log("PWA-08 kai offline after removal:", t.slice(0, 160).replace(/\n/g, " | "));
		expect(await p3.getByTestId("workspace").count()).toBe(0);
		await shot(p3, "08-kai-offline-after-removal");
	} finally {
		await goOnline(k);
	}
	// sign-out purges everything (owner)
	await op.goto("/");
	await swControls(op);
	await op.goto(`/t/${slug}?tab=plan`);
	await expect(op.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await op.waitForTimeout(2000);
	await op.goto("/");
	await op.getByTestId("account-menu").first().click();
	await op.getByRole("menuitem", { name: /sign out/i }).click();
	await expect(op).toHaveURL(/\/login/);
	await op.waitForTimeout(1000);
	const left = await op.evaluate(async () => ({
		// The pages cache may be re-created by the /login navigation; what matters is no trip shell in it.
		pages: (await caches.has("pages")) && (await (await caches.open("pages")).keys()).some((r) => new URL(r.url).pathname.startsWith("/t/")),
		thumbs: await caches.has("media-thumbs"),
		saved: localStorage.getItem("yonder:saved-trips"),
		grants: localStorage.getItem("yonder:grants"),
		idbs: (await indexedDB.databases()).map((d) => d.name),
	}));
	console.log("PWA-08 after sign-out:", JSON.stringify(left));
	expect(left.pages).toBe(false);
	expect(left.saved ?? "").not.toContain(slug);
	await goOffline(o);
	try {
		const p4 = await o.newPage();
		await p4.goto(`/t/${slug}?tab=plan`);
		await p4.waitForTimeout(3000);
		expect(await p4.getByTestId("workspace").count()).toBe(0);
		await shot(p4, "08-owner-offline-after-signout");
	} finally {
		await goOnline(o);
	}
	await o.close();
	await k.close();
});

const postShare = (p: Page, fields: Record<string, string>) =>
	p.evaluate((f) => {
		const form = document.createElement("form");
		form.method = "POST";
		form.action = "/share";
		form.enctype = "multipart/form-data";
		for (const [k, v] of Object.entries(f)) {
			const i = document.createElement("input");
			i.type = "hidden";
			i.name = k;
			i.value = v;
			form.appendChild(i);
		}
		document.body.appendChild(form);
		form.submit();
	}, fields);

test("Share target: Maps duplicate check, TikTok save, offline keep, sign-out clear, signed-out login round trip", async ({ browser }) => {
	const ctx = await userCtx(browser, "dennis@asia2027.test", "Dennis", "Tester");
	const page = await ctx.newPage();
	await page.goto("/");
	await swControls(page);
	// SHR-07: Itoya is in Asia 2027 (seed coords 35.6739,139.7676)
	await postShare(page, { title: "Itoya", url: "https://www.google.com/maps/place/Itoya/@35.6739,139.7676,17z" });
	await expect(page).toHaveURL(/\/share\?id=/, { timeout: 15_000 });
	const inbox = page.getByTestId("share-inbox");
	await expect(inbox).toBeVisible({ timeout: 15_000 });
	await page.waitForTimeout(4000);
	await shot(page, "share-01-itoya");
	console.log("SHR-07 inbox:", (await inbox.innerText()).replace(/\n/g, " | ").slice(0, 500));
	// SHR-02: TikTok → new idea named without hashtags
	await page.goto("/");
	await postShare(page, { title: "Best ramen in Shinjuku!! #ramen #tokyo @foodie 🍜", text: "Check it https://www.tiktok.com/@foodie/video/7309876543210987654", url: "" });
	await expect(page).toHaveURL(/\/share\?id=/, { timeout: 15_000 });
	await expect(inbox).toBeVisible({ timeout: 15_000 });
	await page.waitForTimeout(2500);
	const name = await page.getByTestId("home-share-name").inputValue().catch(() => "");
	console.log("SHR-02 name:", JSON.stringify(name), "| inbox:", (await inbox.innerText()).replace(/\n/g, " | ").slice(0, 300));
	expect.soft(name).not.toMatch(/#|@|🍜|http/);
	await shot(page, "share-02-tiktok");
	await page.getByTestId("home-share-save").click();
	await expect(inbox).toContainText(/Saved/, { timeout: 15_000 });
	await shot(page, "share-02-tiktok-saved");
	// offline: from a page loaded online
	await page.goto("/");
	await expect(page.getByTestId("dashboard")).toBeVisible();
	await goOffline(ctx);
	try {
		await postShare(page, { title: "Offline share", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
		await page.waitForTimeout(4000);
		const t = await page.locator("body").innerText().catch(() => "");
		console.log("SHR offline: url=", page.url(), "text=", t.slice(0, 300).replace(/\n/g, " | "));
		await shot(page, "share-03-offline");
		expect.soft(t, "offline share says it's kept on this device").toMatch(/kept on this device/i);
	} finally {
		await goOnline(ctx);
	}
	await page.goto("/");
	await expect(page.getByTestId("dashboard")).toBeVisible();
	await page.waitForTimeout(2500);
	const waiting = await page.getByTestId("home-shared-waiting").innerText().catch(() => "");
	console.log("SHR dashboard waiting:", waiting);
	await shot(page, "share-04-dashboard-waiting");
	// SHR-06: sign-out clears it
	await page.getByTestId("account-menu").first().click();
	await page.getByRole("menuitem", { name: /sign out/i }).click();
	await expect(page).toHaveURL(/\/login/);
	await page.waitForTimeout(1500);
	const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
	console.log("SHR-06 databases after sign-out:", dbs);
	expect.soft(dbs, "yonder-share deleted at sign-out").not.toContain("yonder-share");
	// SHR-04: signed out → login → back to /share?id with the entry intact
	await postShare(page, { title: "Signed out share", url: "https://www.youtube.com/watch?v=abcdefghijk" });
	await page.waitForTimeout(3000);
	console.log("SHR-04 signed-out landed:", page.url());
	await shot(page, "share-05-signed-out");
	expect.soft(page.url(), "signed-out share keeps the entry (no ?lost=1)").not.toContain("lost");
	if (/\/login/.test(page.url())) {
		await page.getByTestId("login-email").fill("dennis@asia2027.test");
		await page.getByTestId("login-submit").click();
		await page.getByTestId("otp-input").click();
		await page.keyboard.type(process.env.DEV_FIXED_OTP || "000000");
		await page.waitForTimeout(4000);
		console.log("SHR-04 after login:", page.url(), (await page.locator("body").innerText()).slice(0, 200).replace(/\n/g, " | "));
		await shot(page, "share-06-after-login");
		expect.soft(page.url()).toMatch(/\/share\?id=/);
	}
	await ctx.close();
});

test("Share target (fresh SW): signed-out share goes through login and back", async ({ browser }) => {
	// a fresh context: the SW is installed while signed out, no sign-out in between
	const ctx = await browser.newContext({ baseURL: APP_URL, viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await page.goto("/login");
	await swControls(page);
	await postShare(page, { title: "Signed out share", url: "https://www.youtube.com/watch?v=abcdefghijk" });
	await page.waitForTimeout(3000);
	console.log("SHR-04b signed-out landed:", page.url());
	expect(page.url()).toMatch(/\/login\?next=.*share%3Fid/);
	await page.getByTestId("login-email").fill(`qa-home-shr-${uniq()}@asia2027.test`);
	await page.getByTestId("login-submit").click();
	await page.getByTestId("otp-input").click();
	await page.keyboard.type(process.env.DEV_FIXED_OTP || "000000");
	await expect(page).toHaveURL(/\/welcome/, { timeout: 15_000 });
	await page.getByTestId("welcome-first-name").fill("Shr");
	await page.getByTestId("welcome-last-name").fill("Four");
	await page.getByTestId("welcome-submit").click();
	await expect(page).toHaveURL(/\/share\?id=/, { timeout: 15_000 });
	await page.waitForTimeout(2000);
	await shot(page, "share-07-fresh-after-login");
	console.log("SHR-04b inbox:", (await page.locator("body").innerText()).slice(0, 300).replace(/\n/g, " | "));
	await ctx.close();
});

test("PWA-07/10: offline copy picks up a newer change; map and media offline", async ({ browser }) => {
	const a = await userCtx(browser, "audrey@asia2027.test", "Audrey", "Tester");
	const d = await userCtx(browser, "dennis@asia2027.test", "Dennis", "Tester");
	const dp = await d.newPage();
	await dp.goto("/");
	await swControls(dp);
	await dp.goto("/t/asia-2027?days=2027-10-05");
	await expect(dp.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await dp.waitForTimeout(2500);
	const ggCard = () => dp.getByTestId("timeline-item").filter({ hasText: "Golden Gai" }).first();
	const before = (await ggCard().innerText()).replace(/\n/g, " ");
	console.log("PWA-07 before:", before);
	// Media tab at Mt. Fuji once (thumbs seen), never Hoi An
	await dp.goto("/t/asia-2027/japan/mt-fuji?tab=media");
	await expect(dp.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await dp.waitForTimeout(3000);
	await shot(dp, "10-fuji-media-online");
	await dp.goto("/t/asia-2027?days=2027-10-05");
	await expect(dp.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await dp.close();
	// Audrey changes Golden Gai's duration to 3h through the UI
	const ap = await a.newPage();
	await ap.goto("/t/asia-2027?days=2027-10-05");
	await expect(ap.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const agg = ap.getByTestId("timeline-item").filter({ hasText: "Golden Gai" }).first();
	await agg.getByText("2h30").click();
	await ap.waitForTimeout(500);
	await shot(ap, "07-audrey-duration-editor");
	await ap.keyboard.press("Control+a");
	await ap.keyboard.type("3h");
	await ap.keyboard.press("Enter");
	await ap.waitForTimeout(1500);
	const aAfter = (await agg.innerText()).replace(/\n/g, " ");
	console.log("PWA-07 audrey after edit:", aAfter);
	// Dennis opens online later, then offline
	const dp2 = await d.newPage();
	await dp2.goto("/t/asia-2027?days=2027-10-05");
	await expect(dp2.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await dp2.waitForTimeout(3000);
	await goOffline(d);
	try {
		await dp2.reload();
		await expect(dp2.getByTestId("offline-banner")).toBeVisible({ timeout: 20_000 });
		const card = dp2.getByTestId("timeline-item").filter({ hasText: "Golden Gai" }).first();
		const off = (await card.innerText()).replace(/\n/g, " ");
		console.log("PWA-07 offline:", off, "| banner:", await dp2.getByTestId("offline-banner").innerText());
		if (aAfter.includes("3h")) expect(off).toContain("3h");
		await shot(dp2, "07-offline-after-change", false);
		// PWA-10: map pane offline
		const map = dp2.getByTestId("trip-map");
		const mapText = await map.innerText().catch(() => "(no trip-map)");
		console.log("PWA-10 map offline text:", mapText.slice(0, 200).replace(/\n/g, " | "));
		await dp2.goto("/t/asia-2027/japan/mt-fuji?tab=media");
		await expect(dp2.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await dp2.waitForTimeout(2500);
		await shot(dp2, "10-fuji-media-offline");
		const broken = await dp2.evaluate(() =>
			[...document.querySelectorAll("img")].filter((i) => i.complete && i.naturalWidth === 0 && i.getBoundingClientRect().width > 0).length,
		);
		console.log("PWA-10 broken images at Fuji media offline:", broken);
		await dp2.goto("/t/asia-2027/vietnam/hoi-an?tab=media");
		await expect(dp2.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await dp2.waitForTimeout(2500);
		await shot(dp2, "10-hoian-media-offline");
		const broken2 = await dp2.evaluate(() =>
			[...document.querySelectorAll("img")].filter((i) => i.complete && i.naturalWidth === 0 && i.getBoundingClientRect().width > 0).length,
		);
		console.log("PWA-10 broken images at Hoi An media offline:", broken2);
	} finally {
		await goOnline(d);
	}
	// revert Audrey's change
	await agg.getByText(/3h/).first().click().catch(() => {});
	await ap.keyboard.press("Control+a");
	await ap.keyboard.type("2h30");
	await ap.keyboard.press("Enter");
	await ap.waitForTimeout(1000);
	await a.close();
	await d.close();
});

test("PWA-08b: removed member opens the app (dashboard only) online, then goes offline", async ({ browser }) => {
	const o = await userCtx(browser, `qa-home-p8bo-${uniq()}@asia2027.test`, "Olga", "Owner");
	const k = await userCtx(browser, `qa-home-p8bk-${uniq()}@asia2027.test`, "Kai", "Member");
	const op = await o.newPage();
	await op.goto("/");
	await op.getByTestId("new-trip-button").first().click();
	await op.getByTestId("new-trip-name").fill("Removal purge trip");
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
	const kp = await k.newPage();
	await kp.goto("/");
	await swControls(kp);
	await kp.goto(`/t/${slug}?tab=plan`);
	await expect(kp.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await kp.waitForTimeout(2500);
	await kp.goto("about:blank");
	await row.getByTestId("home-member-menu").click();
	await op.getByRole("menuitem", { name: /remove from trip/i }).click();
	await expect(row).toBeHidden({ timeout: 10_000 });
	// Kai opens the app: the dashboard, online
	await kp.goto("/");
	await expect(kp.getByTestId("dashboard")).toBeVisible({ timeout: 20_000 });
	await kp.waitForTimeout(3000);
	await goOffline(k);
	try {
		const p3 = await k.newPage();
		await p3.goto(`/t/${slug}?tab=plan`);
		await p3.waitForTimeout(4000);
		const t = await p3.locator("body").innerText();
		const ws = await p3.getByTestId("workspace").count();
		console.log("PWA-08b removed member offline after dashboard visit: workspace=", ws, t.slice(0, 160).replace(/\n/g, " | "));
		await shot(p3, "08b-removed-offline");
		expect.soft(ws, "removed member can still read the trip offline").toBe(0);
		const cold = await k.newPage();
		await cold.goto("/?source=pwa");
		await cold.waitForTimeout(4000);
		console.log("PWA-08b cold start:", cold.url());
		await shot(cold, "08b-removed-cold-start");
	} finally {
		await goOnline(k);
	}
	await o.close();
	await k.close();
});
