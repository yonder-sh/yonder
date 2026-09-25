/**
 * QA security verifier (I2 round 2): UI re-checks of reported WP-Home bugs on
 * the sharing/permission surface, with screenshots to look at:
 * guest claim nudge, viewer's item menu, Share dialog (role select, link
 * created time), Trip settings holidays, dashboard hero "1 day", live rename
 * of the browser tab title.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { type Browser, expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { hydrated } from "./_helpers/page";
import { call, EMAIL, MOD, memberPage } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const shot = (p: import("@playwright/test").Page, n: string) => p.screenshot({ path: path.join(DIR, `r2-ui-${n}.png`) });
const out: Record<string, unknown> = {};
test.afterAll(() => writeFileSync(path.join(DIR, "r2-ui.json"), JSON.stringify(out, null, 1)));

async function user(browser: Browser, email: string, first: string, last: string) {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(ctx.request, email, { first, last });
	return { ctx, page: await ctx.newPage() };
}

test("signed-in guest named like a placeholder: no working 'Are you …?' claim", async ({ browser }) => {
	const stamp = Date.now().toString(36);
	const o = await user(browser, `qa-sec-r2-o-${stamp}@example.com`, "Olga", "Owner");
	const c = await cloneFixtureTrip(o.page.request);
	const g = await user(browser, `qa-sec-r2-a-${stamp}@example.com`, "Audrey", "Guestname");
	await g.page.goto(`/join#t=${c.shareTokens.viewer}`);
	await expect(g.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await g.page.waitForTimeout(3000);
	const prompt = g.page.getByTestId("home-claim-prompt");
	out.guestClaimPromptVisible = await prompt.isVisible().catch(() => false);
	out.guestClaimPromptText = out.guestClaimPromptVisible ? await prompt.innerText() : null;
	await shot(g.page, "guest-named-audrey");
	if (out.guestClaimPromptVisible) {
		await g.page.getByTestId("home-claim-button").click();
		await g.page.waitForTimeout(2500);
		out.afterClaimClickToasts = await g.page.locator("[data-sonner-toast]").allInnerTexts();
		await shot(g.page, "guest-named-audrey-after-click");
	}
	const me = await g.page.evaluate(() => (window as unknown as { __yonder?: { graph?: { me?: unknown } } }).__yonder?.graph?.me);
	out.guestMeAfter = me;
	await o.ctx.close();
	await g.ctx.close();
});

test("viewer's item menu: Move to day", async ({ browser }) => {
	const { ctx, page } = await memberPage(browser, EMAIL.kai);
	await page.goto("/t/asia-2027?days=2027-10-05");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(3000);
	const card = page.locator("[data-testid=timeline-item]", { hasText: "Cha no Ikedaya" }).first();
	await card.hover();
	const menuBtn = card.getByTestId("plan-item-menu").first();
	out.viewerMenuButton = await menuBtn.count();
	if (await menuBtn.count()) {
		await menuBtn.click();
		await page.waitForTimeout(700);
		const items = page.getByRole("menuitem");
		const n = await items.count();
		const states: string[] = [];
		for (let i = 0; i < n; i++) {
			const it = items.nth(i);
			states.push(`${(await it.innerText()).split("\n")[0]}:${(await it.getAttribute("aria-disabled")) ?? (await it.getAttribute("data-disabled")) ?? "enabled"}`);
		}
		out.viewerMenuItems = states;
		await shot(page, "viewer-item-menu");
	}
	await ctx.close();
});

test("Share dialog: role select and link created time; settings holidays", async ({ browser }) => {
	const { ctx, page } = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	await page.goto("/t/asia-2027?tab=plan");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await (await hydrated(page.getByTestId("share-button").first())).click();
	const dlg = page.getByTestId("share-dialog");
	await expect(dlg).toBeVisible();
	await page.waitForTimeout(1500);
	const maya = dlg.getByTestId("home-member-row").filter({ hasText: "Maya" }).getByTestId("home-member-role");
	out.mayaRoleSelect = await maya.evaluate((el) => ({ text: (el as HTMLElement).innerText, scrollW: el.scrollWidth, clientW: el.clientWidth })).catch((e) => String(e));
	await shot(page, "share-people");
	const linksTab = dlg.getByRole("tab", { name: /links/i }).first();
	if (await linksTab.isVisible().catch(() => false)) await linksTab.click();
	await page.waitForTimeout(1000);
	out.linkCreated = await dlg.getByTestId("home-share-link-created").allInnerTexts().catch(() => []);
	await shot(page, "share-links");
	await page.keyboard.press("Escape");
	// Trip settings → holidays heading count.
	await page.goto("/t/asia-2027?settings=1");
	await page.waitForTimeout(2000);
	const settingsOpen = await page.getByTestId("home-settings-name").isVisible().catch(() => false);
	if (!settingsOpen) {
		await page.goto("/t/asia-2027?tab=plan");
		await page.getByRole("button", { name: /Asia 2027/ }).first().click().catch(() => undefined);
		await page.getByRole("menuitem", { name: /settings/i }).first().click().catch(() => undefined);
	}
	await page.waitForTimeout(1500);
	const dialog = page.getByRole("dialog").first();
	out.holidayHeadings = await dialog.getByText(/^Public holidays$/).count().catch(() => -1);
	await dialog.evaluate((el) => el.querySelector("[data-radix-scroll-area-viewport], .overflow-y-auto")?.scrollTo(0, 99999)).catch(() => undefined);
	await shot(page, "trip-settings");
	await ctx.close();
});

test("dashboard hero on a one-day trip", async ({ browser }) => {
	const { ctx, page } = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	await page.clock.setFixedTime(new Date("2027-11-10T12:00:00Z"));
	await page.goto("/dashboard");
	await page.waitForTimeout(3500);
	out.hero = await page.getByTestId("home-hero").innerText().catch((e) => String(e));
	await shot(page, "dashboard-hero");
	await ctx.close();
});

test("live rename reaches another member's tab title", async ({ browser }) => {
	const stamp = Date.now().toString(36);
	const o = await user(browser, `qa-sec-r2-ro-${stamp}@example.com`, "Olga", "Owner");
	const c = await cloneFixtureTrip(o.page.request);
	const m = await user(browser, "maya@example.com", "Maya", "Chen");
	await m.page.goto(`/t/${c.slug}?tab=plan`);
	await expect(m.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await m.page.waitForTimeout(3000);
	const before = await m.page.title();
	await o.page.goto("/login");
	const r = await call(o.page, MOD.trips, "updateTrip", { tripId: c.tripId, name: `Renamed ${stamp} 🇯🇵` });
	await m.page.waitForTimeout(5000);
	out.rename = { call: r.ok ? "OK" : r.err, titleBefore: before, titleAfter: await m.page.title(), header: (await m.page.locator("header").first().innerText()).slice(0, 80) };
	await o.ctx.close();
	await m.ctx.close();
});
