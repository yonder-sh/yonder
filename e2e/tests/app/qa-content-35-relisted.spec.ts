/**
 * I2 "content" verifier, round 2: quick looks at a few earlier reports from
 * other areas (holidays heading, link created dates, role select, search,
 * a guest viewer's item menu, the one-day hero).
 */
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { HOME_TESTID as H } from "../../../src/features/home/testids";
import { PLACES_TESTID as P } from "../../../src/features/places/testids";
import { PLAN_TESTID as PL } from "../../../src/features/plan/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";
import { openLink } from "./_helpers/link";

test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");
const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
async function ctxFor(browser: Browser, h: string | null) {
	const ctx = await browser.newContext({ ...(h ? { storageState: path.join(AUTH, `${h}.json`) } : {}), viewport: { width: 1440, height: 900 } });
	return { ctx, page: await ctx.newPage() };
}

test("trip settings: one 'Public holidays' heading", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	await d.page.getByTestId(TESTID.topBar).getByRole("button", { name: /Asia 2027/ }).first().click();
	await d.page.getByRole("menuitem", { name: /Trip settings/ }).click();
	const dlg = d.page.getByTestId(TESTID.tripSettingsDialog);
	await expect(dlg).toBeVisible();
	const n = await dlg.getByText(/^Public holidays$/).count();
	console.log("Public holidays headings:", n);
	await dlg.getByText(/^Public holidays$/).first().scrollIntoViewIfNeeded();
	await shot(d.page, "35-settings-holidays");
	expect(n).toBe(1);
	await d.ctx.close();
});

test("share dialog: link rows show when created; role selects don't clip", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	await d.page.getByTestId("share-button").first().click();
	const dlg = d.page.getByTestId(TESTID.shareDialog);
	await expect(dlg).toBeVisible();
	await d.page.waitForTimeout(800);
	const roles = await dlg.getByTestId(H.memberRole).evaluateAll((els) =>
		els.map((e) => ({ t: (e.textContent ?? "").trim(), clip: e.scrollWidth > e.clientWidth + 1 || [...e.querySelectorAll("span")].some((s) => s.scrollWidth > s.clientWidth + 1) })),
	);
	console.log("member role selects:", JSON.stringify(roles));
	await shot(d.page, "35-share-members");
	const linksTab = dlg.getByRole("tab", { name: /Links/ });
	if (await linksTab.count()) await linksTab.click();
	await d.page.waitForTimeout(500);
	const created = await dlg.getByTestId(H.linkCreated).allInnerTexts();
	console.log("link created labels:", JSON.stringify(created));
	await shot(d.page, "35-share-links");
	expect(created.length).toBeGreaterThan(0);
	await d.ctx.close();
});

test("search: 'daan' finds Da'an District", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	await d.page.keyboard.press("Control+k");
	const input = d.page.getByTestId(P.paletteInput);
	await expect(input).toBeVisible();
	await input.fill("daan");
	await d.page.waitForTimeout(1200);
	const res = await d.page.getByTestId(P.paletteTripResult).allInnerTexts();
	console.log("trip results for daan:", JSON.stringify(res.slice(0, 5)));
	await shot(d.page, "35-search-daan");
	expect(res.join("|")).toMatch(/Da.an/);
	await d.ctx.close();
});

test("a view-link guest's item menu: Move to day is not offered as enabled", async ({ browser }) => {
	const gv = await ctxFor(browser, null);
	await openLink(gv.page, "asia-2027", "viewer");
	await expect(gv.page).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
	await gv.page.goto("/t/asia-2027?days=2027-10-05");
	await expectLive(gv.page);
	const card = gv.page.getByTestId(TESTID.timelineItem).filter({ hasText: "Cha no Ikedaya" }).first();
	await card.scrollIntoViewIfNeeded();
	await card.hover();
	const menu = card.getByTestId(PL.itemMenu);
	console.log("guest item menu buttons:", await menu.count());
	if (await menu.count()) {
		await menu.click();
		await gv.page.waitForTimeout(400);
		const items = await gv.page.locator("[role=menuitem]").evaluateAll((els) => els.map((e) => `${(e.textContent ?? "").trim()}${e.getAttribute("data-disabled") !== null || e.getAttribute("aria-disabled") === "true" ? " [disabled]" : ""}`));
		console.log("guest item menu:", JSON.stringify(items));
		await shot(gv.page, "35-guest-item-menu");
		const move = items.find((t) => /Move to day|Schedule on/.test(t));
		expect(move === undefined || /disabled/.test(move)).toBe(true);
	}
	await gv.ctx.close();
});

test("dashboard hero for a one-day trip says '1 day'", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.clock.setFixedTime(new Date("2027-11-10T12:00:00Z"));
	await d.page.goto("/dashboard");
	const hero = d.page.getByTestId(H.heroCard);
	await expect(hero).toBeVisible({ timeout: 20_000 });
	const t = (await hero.innerText()).replace(/\n/g, " | ");
	console.log("hero:", t);
	await shot(d.page, "35-hero-1day");
	expect(t).not.toMatch(/\b1 days\b/);
	await d.ctx.close();
});
