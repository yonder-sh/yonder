/**
 * I2 verifier "home" (round 2): re-checks of round-1 findings that need the
 * QA seed (Asia 2027 as dennis@asia2027.test) on the isolated dev server.
 */
import { type APIRequestContext, type Browser, type Page, expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { hydrated } from "./_helpers/page";
import { openLink, setTestLink } from "./_helpers/link";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
});

const SHOTS = process.env.QA_SHOTS ?? "shots";
const shot = (page: Page, name: string, fullPage = false) =>
	page.screenshot({ path: `${SHOTS}/r2-${name}.png`, animations: "disabled", fullPage });

async function graphOf(page: Page): Promise<any> {
	await expect
		.poll(() => page.evaluate(() => !!(window as any).__yonder?.graph), { timeout: 30_000 })
		.toBe(true);
	return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__yonder.graph)));
}

async function callFn(page: Page, mod: string, fn: string, data: unknown) {
	return page.evaluate(
		async ({ mod, fn, data }) => {
			try {
				const m = await import(/* @vite-ignore */ mod);
				const v = await m[fn]({ data });
				return { ok: true, value: JSON.parse(JSON.stringify(v ?? null)) };
			} catch (e) {
				return { ok: false, error: String((e as Error)?.message ?? e) };
			}
		},
		{ mod, fn, data },
	) as Promise<{ ok: boolean; value?: any; error?: string }>;
}

async function login(req: APIRequestContext, email: string, first: string, last: string) {
	for (let i = 0; ; i++) {
		try {
			return await loginViaApi(req, email, { first, last });
		} catch (e) {
			if (i >= 4) throw e;
			await new Promise((r) => setTimeout(r, 500 + Math.random() * 1500));
		}
	}
}

async function userPage(browser: Browser, email: string, first = "QA", last = "Tester") {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await login(ctx.request, email, first, last);
	return { ctx, page: await ctx.newPage() };
}

test("R2 dashboard hero: a one-day trip says '1 day'", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dennis@asia2027.test");
	await page.clock.setFixedTime(new Date("2027-11-10T12:00:00Z"));
	await page.goto("/dashboard");
	await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 });
	const hero = page.getByTestId("home-hero");
	await expect(hero).toBeVisible();
	const t = await hero.innerText();
	console.log("R2 HERO:", t.replace(/\n/g, " | "));
	await shot(page, "hero-1day");
	expect.soft(t).not.toMatch(/\b1 days\b/);
	expect.soft(t).toMatch(/\b1 day\b/);
	await ctx.close();
});

test("R2 share dialog: role select fits 'Can suggest'; link rows show a created date", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dennis@asia2027.test");
	// The QA seed shares no link: turn it on (the test route keeps /t/asia-2027).
	await setTestLink(ctx.request, "asia-2027", "viewer");
	await page.goto("/t/asia-2027?tab=plan");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await (await hydrated(page.getByTestId("share-button").first())).click();
	const dlg = page.getByTestId("share-dialog");
	await expect(dlg).toBeVisible();
	const maya = dlg.getByTestId("home-member-row").filter({ hasText: "Maya" });
	await expect(maya).toBeVisible({ timeout: 15_000 });
	const sel = maya.getByTestId("home-member-role");
	const m = await sel.evaluate((el) => {
		const inner = (el.querySelector("[data-slot=select-value]") ?? el) as HTMLElement;
		return { text: el.textContent, sw: inner.scrollWidth, cw: inner.clientWidth, w: el.getBoundingClientRect().width };
	});
	console.log("R2 MAYA select:", JSON.stringify(m));
	await maya.screenshot({ path: `${SHOTS}/r2-maya-row.png` });
	await shot(page, "share-dialog");
	expect.soft(m.text).toMatch(/Can suggest/);
	expect.soft(m.sw, "select text clipped").toBeLessThanOrEqual(m.cw + 1);
	// Links section
	const links = dlg.getByRole("tab", { name: /Links/ }).or(dlg.getByRole("button", { name: /^Links/ }));
	if (await links.count()) await links.first().click();
	await page.waitForTimeout(800);
	await shot(page, "share-links");
	const created = dlg.getByTestId("home-share-link-created");
	const n = await created.count();
	const texts = n ? await created.allInnerTexts() : [];
	console.log("R2 LINK created:", n, texts);
	expect.soft(n, "link rows show when each link was created").toBeGreaterThan(0);
	await ctx.close();
});

test("R2 trip settings: one 'Public holidays' heading", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?tab=plan");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await (await hydrated(page.getByTestId("trip-menu").first())).click();
	await page.getByRole("menuitem", { name: /Trip settings/ }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await page.waitForTimeout(1500);
	const hol = dialog.getByText(/^Public holidays$/);
	const count = await hol.count();
	if (count) await hol.first().scrollIntoViewIfNeeded();
	await shot(page, "settings-holidays");
	console.log("R2 holidays heading count:", count);
	expect.soft(count).toBe(1);
	await ctx.close();
});

test("R2 viewer: 'Move to day' reads disabled in the item menu", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "kai@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-05");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const g = await graphOf(page);
	console.log("R2 kai role:", g.me.role);
	const card2 = page.getByTestId("timeline-item").filter({ hasText: "Cha no Ikedaya" }).first();
	await expect(card2).toBeVisible({ timeout: 20_000 });
	await card2.scrollIntoViewIfNeeded();
	await card2.hover();
	await card2.getByTestId("plan-item-menu").click();
	await page.waitForTimeout(400);
	const move = page.getByRole("menuitem", { name: /Move to day/ });
	const st = await move.evaluate((el) => ({
		disabled: el.getAttribute("data-disabled"),
		aria: el.getAttribute("aria-disabled"),
		opacity: getComputedStyle(el).opacity,
	}));
	const del = page.getByRole("menuitem", { name: /Delete/ }).first();
	const delSt = await del.evaluate((el) => ({ disabled: el.getAttribute("data-disabled"), opacity: getComputedStyle(el).opacity }));
	console.log("R2 viewer Move to day:", JSON.stringify(st), "Delete:", JSON.stringify(delSt));
	await shot(page, "viewer-item-menu");
	await move.hover();
	await page.waitForTimeout(400);
	const subOpen = await page.getByRole("menuitem", { name: /^D\d+/ }).count();
	console.log("R2 viewer submenu items visible:", subOpen);
	expect.soft(st.aria === "true" || st.disabled !== null).toBe(true);
	expect.soft(st.opacity).toBe(delSt.opacity);
	await ctx.close();
});

test("R2 SHR-07: sharing Itoya's Maps link finds the Itoya in Asia 2027", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?tab=plan");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const g = await graphOf(page);
	const itoya = g.nodes.filter((n: any) => /itoya/i.test(n.name)).map((n: any) => `${n.name}@${n.lat},${n.lng}`);
	console.log("R2 Itoya nodes:", itoya);
	const r = await callFn(page, "/src/features/places/places.functions.ts", "resolveSharedLink", {
		tripId: g.trip.id,
		url: "https://www.google.com/maps/place/Itoya/@35.6739,139.7676,17z",
	});
	console.log("R2 SHR-07 resolve:", JSON.stringify(r).slice(0, 600));
	expect.soft(r.ok).toBe(true);
	expect.soft(r.value?.existing?.name ?? "", "duplicate detected").toMatch(/Itoya/i);
	await ctx.close();
});

const SHARING = "/src/features/home/sharing.functions.ts";
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test("R2 placeholder claim: member prompt, guest hint, role never escalates", async ({ browser }) => {
	const { cloneFixtureTrip } = await import("./_helpers/fixture");
	const o = await userPage(browser, `qa-home-r2co-${uniq()}@asia2027.test`, "Olga", "Owner");
	const c = await cloneFixtureTrip(o.page.request);
	await o.page.goto(`/t/${c.slug}?tab=plan`);
	await expect(o.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const og = await graphOf(o.page);
	const ph = og.members.find((m: any) => m.id === c.members.audrey);
	console.log("R2 CLAIM placeholder:", JSON.stringify(ph));
	// 1) a VIEWER member whose first name matches claims Audrey (placeholder role: editor)
	const v = await userPage(browser, `qa-home-r2cv-${uniq()}@asia2027.test`, "Audrey", "Viewer");
	const vEmail = (await (await v.ctx.request.get("/api/auth/get-session")).json()).user.email;
	const inv = await callFn(o.page, SHARING, "inviteMember", { tripId: c.tripId, email: vEmail, role: "viewer" });
	expect(inv.ok, JSON.stringify(inv)).toBe(true);
	await v.page.goto(`/t/${c.slug}?tab=plan`);
	await expect(v.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const prompt = v.page.getByTestId("home-claim-prompt");
	await expect(prompt).toBeVisible({ timeout: 15_000 });
	console.log("R2 CLAIM viewer prompt:", (await prompt.innerText()).replace(/\n/g, " | "));
	await shot(v.page, "claim-viewer-prompt");
	await v.page.getByTestId("home-claim-button").click();
	await expect(prompt).toBeHidden({ timeout: 10_000 });
	await v.page.waitForTimeout(1000);
	await v.page.reload();
	await expect(v.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const vg = await graphOf(v.page);
	console.log("R2 CLAIM viewer after:", JSON.stringify(vg.me));
	expect.soft(vg.me.role, "claiming an editor placeholder must not raise a viewer").toBe("viewer");
	const edit = await callFn(v.page, "/src/functions/items.functions.ts", "createItem", { tripId: c.tripId, dayId: null, title: "viewer after claim" });
	console.log("R2 CLAIM viewer createItem:", JSON.stringify(edit).slice(0, 160));
	expect.soft(edit.ok).toBe(false);
	const og2 = await graphOf(o.page);
	await o.page.reload();
	await expect(o.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const og3 = await graphOf(o.page);
	console.log("R2 CLAIM owner members after:", og3.members.map((m: any) => `${m.name}:${m.role}:${m.status ?? ""}`));
	void og2;
	// 2) a signed-in guest named Audrey on the EDIT link sees only a hint (clone 2: Audrey is still a placeholder)
	const c2 = await cloneFixtureTrip(o.page.request);
	const g = await userPage(browser, `qa-home-r2cg-${uniq()}@asia2027.test`, "Audrey", "Guest");
	await openLink(g.page, c2.slug, "editor");
	await expect(g.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const hint = g.page.getByTestId("home-claim-prompt");
	await expect(hint).toBeVisible({ timeout: 15_000 });
	const hintText = (await hint.innerText()).replace(/\n/g, " | ");
	console.log("R2 CLAIM guest hint:", hintText, "| claim button:", await g.page.getByTestId("home-claim-button").count());
	await shot(g.page, "claim-guest-hint");
	expect.soft(await g.page.getByTestId("home-claim-button").count()).toBe(0);
	const gc = await callFn(g.page, SHARING, "claimPlaceholder", { tripId: c2.tripId, memberId: c2.members.audrey });
	console.log("R2 CLAIM edit-link guest server:", JSON.stringify(gc));
	expect.soft(gc.ok).toBe(false);
	// 3) a SUGGESTER member named Bob can't claim someone else's placeholder
	const b = await userPage(browser, `qa-home-r2cb-${uniq()}@asia2027.test`, "Bob", "Suggester");
	const bEmail = (await (await b.ctx.request.get("/api/auth/get-session")).json()).user.email;
	await o.page.goto(`/t/${c2.slug}?tab=plan`);
	await expect(o.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const inv2 = await callFn(o.page, SHARING, "inviteMember", { tripId: c2.tripId, email: bEmail, role: "suggester" });
	expect(inv2.ok, JSON.stringify(inv2)).toBe(true);
	await b.page.goto(`/t/${c2.slug}?tab=plan`);
	await expect(b.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const bc = await callFn(b.page, SHARING, "claimPlaceholder", { tripId: c2.tripId, memberId: c2.members.audrey });
	console.log("R2 CLAIM suggester Bob claims Audrey:", JSON.stringify(bc));
	expect.soft(bc.ok).toBe(false);
	for (const x of [o, v, g, b]) await x.ctx.close();
});

test("R2 phone: dashboard, share dialog, settings, login (390x844)", async ({ browser }) => {
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
	await login(ctx.request, "dennis@asia2027.test", "QA", "Tester");
	const page = await ctx.newPage();
	const over = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	await page.goto("/dashboard");
	await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	console.log("R2 PHONE dashboard overflow:", await over());
	await shot(page, "phone-dashboard", true);
	await page.goto("/t/asia-2027?tab=plan");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	console.log("R2 PHONE trip overflow:", await over());
	await shot(page, "phone-trip");
	const share = page.getByTestId("share-button");
	console.log("R2 PHONE share buttons visible:", await share.filter({ visible: true }).count(), "trip-menu visible:", await page.getByTestId("trip-menu").filter({ visible: true }).count());
	{
		await page.getByRole("button", { name: "More" }).click();
		await page.getByRole("menuitem", { name: /^Share$/ }).click();
		await expect(page.getByTestId("share-dialog")).toBeVisible();
		await page.waitForTimeout(800);
		console.log("R2 PHONE share overflow:", await over());
		await shot(page, "phone-share");
		await page.keyboard.press("Escape");
		await page.waitForTimeout(500);
		await page.getByRole("button", { name: "More" }).click();
		await page.getByRole("menuitem", { name: /Trip settings/ }).click();
		await page.waitForTimeout(1000);
		console.log("R2 PHONE settings overflow:", await over());
		await shot(page, "phone-settings");
	}
	await ctx.close();
});
