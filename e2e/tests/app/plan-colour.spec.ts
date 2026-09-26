/**
 * The calmer, more colourful Plan and the collapsible side panels (owner,
 * 2026-09-25):
 * - screenshots of the Plan on the QA seed (Asia 2027), light and dark at
 *   1440×900 and at 390 px, for the owner: `.data/plan-colour-shots/`; each
 *   card's bar is its map pin's family colour;
 * - a leg row shows its mode and time; hovering (or Tab) shows the
 *   alternatives, and accepting one still works;
 * - the Outline and the map hide, stay hidden after a reload and come back;
 *   showing the map restores its width;
 * - the Places tab with the map hidden is wide.
 *
 *   pnpm e2e:fast tests/app/plan-colour.spec.ts --envs 1
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
import { SHELL_TESTID } from "../../../src/features/shell/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { REPO_ROOT, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";

const SHOTS = path.join(REPO_ROOT, ".data/plan-colour-shots");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => path.join(SHOTS, `${name}.png`);

const QA_TRIP = "asia-2027";
const DENNIS = { email: "dennis@asia2027.test", first: "Dennis", last: "Tester" };

test.beforeEach(({}, info) => {
	test.skip(info.project.name !== "chromium", "desktop project; the phone runs its own viewport here");
});

async function openQaPlan(page: Page, query: string): Promise<boolean> {
	await loginViaApi(page.request, DENNIS.email, { first: DENNIS.first, last: DENNIS.last });
	const res = await page.goto(`/t/${QA_TRIP}?${query}`);
	if (!res || res.status() >= 400) return false;
	await expectLive(page, 30_000);
	await expect(page.getByTestId(TESTID.timelineItem).first()).toBeVisible({ timeout: 30_000 });
	return true;
}

/** A card's own box (the row also holds the time rail), by its title. */
const cardBox = (page: Page, title: string) =>
	page.getByTestId(TESTID.timelineItem).filter({ hasText: title }).first().locator("[data-family]");

/** The bar's colour: the first stop of the card's background gradient. */
const barColor = (page: Page, title: string) =>
	cardBox(page, title).evaluate((el) => /rgb[a]?\([^)]*\)|oklab\([^)]*\)|color\([^)]*\)/.exec(getComputedStyle(el).backgroundImage)?.[0] ?? "");

/** Paint settles: fonts, the map's first frame, the reveal transition. */
const settle = (page: Page) => page.waitForTimeout(800);

test.describe("on the QA seed: the owner's screenshots and the leg rows", () => {
	test("light, 1440×900: cards in their family colours, leg rows quiet", async ({ page }) => {
		test.skip(!(await openQaPlan(page, "tab=plan&lens=place&days=2027-10-03")), "needs the QA seed (pnpm db:seed:qa)");
		await expect(cardBox(page, "Anamori Inari Shrine")).toHaveAttribute("data-family", "culture");
		await expect(cardBox(page, "Arrival formalities")).toHaveAttribute("data-family", "flight");
		await expect(cardBox(page, "JINS")).toHaveAttribute("data-family", "shopping");
		await expect(cardBox(page, "Lunch")).toHaveAttribute("data-family", "none");
		// The bar is the map pin's colour (--fam-culture #cf3b1d, --fam-shopping #bc4891).
		expect(await barColor(page, "Anamori Inari Shrine")).toBe("rgb(207, 59, 29)");
		expect(await barColor(page, "JINS")).toBe("rgb(188, 72, 145)");
		expect(await barColor(page, "Lunch")).toBe("");
		await settle(page);
		await page.screenshot({ path: shot("desktop-light-day2"), animations: "disabled" });
		// A second day: the Fuji Excursion, a stay, nature.
		await page.goto(`/t/${QA_TRIP}?tab=plan&lens=place&days=2027-10-07`);
		await expect(cardBox(page, "Oishi Park")).toHaveAttribute("data-family", "nature");
		await expect(cardBox(page, "Drop bags at ryokan")).toHaveAttribute("data-family", "lodging");
		await settle(page);
		await page.screenshot({ path: shot("desktop-light-day6"), animations: "disabled" });
		// A hovered leg shows its alternatives.
		const leg = page.getByTestId("plan-tab").getByTestId(TESTID.leg).filter({ hasText: "~15m" }).first();
		await leg.hover();
		await expect(leg.getByTestId(PLAN_TESTID.legMore)).toHaveCSS("opacity", "1");
		await settle(page);
		await page.getByTestId(TESTID.centerPanel).screenshot({ path: shot("desktop-light-leg-hover"), animations: "disabled" });
	});

	test("dark, 1440×900: the tint still shows, the near-black families are raised", async ({ page }) => {
		await page.emulateMedia({ colorScheme: "dark" });
		test.skip(!(await openQaPlan(page, "tab=plan&lens=place&days=2027-10-03")), "needs the QA seed (pnpm db:seed:qa)");
		await expect(page.locator("html")).toHaveClass(/\bdark\b/);
		// The shrine's tint against Breakfast's plain card (a city's muted bar, no tint).
		const bg = (title: string) => cardBox(page, title).evaluate((el) => getComputedStyle(el).backgroundColor);
		await expect(cardBox(page, "Breakfast")).toHaveAttribute("data-family", "area");
		expect(await bg("Anamori Inari Shrine")).not.toBe(await bg("Breakfast"));
		await settle(page);
		await page.screenshot({ path: shot("desktop-dark-day2"), animations: "disabled" });
		await page.goto(`/t/${QA_TRIP}?tab=plan&lens=place&days=2027-10-07`);
		await expect(cardBox(page, "Drop bags at ryokan")).toHaveAttribute("data-family", "lodging");
		// --fam-lodging (#202638) would vanish on a dark card.
		expect(await barColor(page, "Drop bags at ryokan")).not.toBe("rgb(32, 38, 56)");
		await settle(page);
		await page.screenshot({ path: shot("desktop-dark-day6"), animations: "disabled" });
	});

	test("390 px: the Plan in the phone's sheet", async ({ browser }) => {
		const ctx = await browser.newContext({
			viewport: { width: 390, height: 844 },
			isMobile: true,
			hasTouch: true,
			deviceScaleFactor: 2,
		});
		const page = await ctx.newPage();
		try {
			test.skip(!(await openQaPlanPhone(page)), "needs the QA seed (pnpm db:seed:qa)");
			await expect(cardBox(page, "Anamori Inari Shrine")).toHaveAttribute("data-family", "culture");
			await settle(page);
			await page.screenshot({ path: shot("phone-390-light"), animations: "disabled" });
		} finally {
			await ctx.close();
		}
	});

	test("a leg row shows its mode and time; hover or Tab shows the alternatives, and accepting one works", async ({
		page,
	}) => {
		const logs = collectConsole(page);
		// The QA seed's Mt. Fuji day keeps legs with no mode yet (a fresh clone's
		// get filled in by the worker while the test runs). The file's data is reset
		// before the next spec.
		test.skip(!(await openQaPlan(page, "tab=plan&lens=place&days=2027-10-07")), "needs the QA seed (pnpm db:seed:qa)");
		const unset = page
			.getByTestId("plan-tab")
			.getByTestId(TESTID.leg)
			.filter({ has: page.locator(`[data-testid="${TESTID.legMode}"][data-mode="unset"]`) })
			.first();
		const name = (await unset.locator("[data-row-main]").getAttribute("aria-label")) ?? "";
		expect(name).toMatch(/^Travel /);
		const row = page.getByTestId(TESTID.leg).filter({ has: page.getByRole("button", { name, exact: true }) });
		const more = row.getByTestId(PLAN_TESTID.legMore);
		await row.scrollIntoViewIfNeeded();
		// One quiet line: the mode and "~15m est."; the rest waits.
		await expect(row.getByTestId(TESTID.legMode)).toHaveText(/est\./);
		await page.mouse.move(5, 5);
		await expect(more).toHaveCSS("opacity", "0");
		const before = await row.evaluate((el) => el.getBoundingClientRect().height);
		await row.hover();
		await expect(more).toHaveCSS("opacity", "1");
		await expect(more.getByTestId(PLAN_TESTID.legAccept).first()).toBeVisible();
		// Revealing never changes the row's height.
		expect(await row.evaluate((el) => el.getBoundingClientRect().height)).toBe(before);
		await page.mouse.move(5, 5);
		await expect(more).toHaveCSS("opacity", "0");
		// The keyboard reaches them: Tab from the row's own button.
		await row.getByRole("button", { name, exact: true }).focus();
		await page.keyboard.press("Tab");
		await expect(more.getByTestId(PLAN_TESTID.legAccept).first()).toBeFocused();
		await expect(more).toHaveCSS("opacity", "1");
		// Accepting still works: Walk.
		await row.hover();
		await more.locator(`[data-testid="${PLAN_TESTID.legAccept}"][data-mode="walk"]`).click();
		await expect(row.getByTestId(TESTID.legMode)).toHaveAttribute("data-mode", "walk");
		expect(logs.messages).toEqual([]);
	});
});

/** The phone: sign in, open the Plan, drag the sheet to its top snap. */
async function openQaPlanPhone(page: Page): Promise<boolean> {
	await loginViaApi(page.request, DENNIS.email, { first: DENNIS.first, last: DENNIS.last });
	const res = await page.goto(`/t/${QA_TRIP}?tab=plan&lens=place&days=2027-10-03`);
	if (!res || res.status() >= 400) return false;
	await expectLive(page, 30_000);
	const sheet = page.getByTestId(TESTID.mobileSheet);
	await expect(sheet.getByTestId(TESTID.dayChips)).toBeVisible();
	const box = await sheet.boundingBox();
	if (!box) throw new Error("no sheet");
	await page.mouse.move(195, box.y + 8);
	await page.mouse.down();
	await page.mouse.move(195, box.y - 300, { steps: 8 });
	await page.mouse.move(195, 60, { steps: 8 });
	await page.mouse.up();
	await expect(sheet.getByTestId(TESTID.timelineItem).first()).toBeVisible();
	return true;
}

test.describe("on a clone of the demo trip", () => {
	test.use({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });

	test("the Outline and the map hide, stay hidden after a reload, and come back at their size", async ({ page }) => {
		const logs = collectConsole(page);
		const c = await cloneFixtureTrip(page.request);
		await page.goto(`/t/${c.slug}?tab=plan&lens=place`);
		await expectLive(page);
		const center = page.getByTestId(TESTID.centerPanel);
		// Widen the centre by dragging the divider: the size to come back to.
		const handle = page.locator('[data-slot="resizable-handle"]');
		const h = await handle.boundingBox();
		if (!h) throw new Error("no divider");
		await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
		await page.mouse.down();
		await page.mouse.move(h.x + 120, h.y + h.height / 2, { steps: 8 });
		await page.mouse.up();
		const width = Math.round((await center.boundingBox())?.width ?? 0);

		await page.getByRole("button", { name: "Hide the outline" }).click();
		await page.getByRole("button", { name: "Hide the map" }).click();
		await expect(page.getByTestId(SHELL_TESTID.outlineAside)).toHaveCount(0);
		await expect(page.getByTestId(TESTID.tripMap)).toHaveCount(0);
		await page.reload();
		await expectLive(page);
		await expect(page.getByTestId(SHELL_TESTID.outlineRail)).toBeVisible();
		await expect(page.getByTestId(SHELL_TESTID.mapRail)).toBeVisible();
		await expect(page.getByTestId(SHELL_TESTID.outlineAside)).toHaveCount(0);
		await expect(page.getByTestId(TESTID.tripMap)).toHaveCount(0);
		// The centre takes the width between the two rails.
		expect(Math.round((await center.boundingBox())?.width ?? 0)).toBeGreaterThan(1300);
		// The top bar's Outline popover still works.
		await page.getByTestId(TESTID.outlinePopoverButton).click();
		await expect(page.getByTestId(TESTID.outlinePopover)).toBeVisible();
		await page.keyboard.press("Escape");
		await settle(page);
		await page.screenshot({ path: shot("desktop-panels-hidden"), animations: "disabled" });

		await page.getByRole("button", { name: "Show the outline" }).click();
		await expect(page.getByTestId(SHELL_TESTID.outlineAside)).toBeVisible();
		// ⌘⇧\ (Ctrl on Linux) brings the map back at the width it had.
		await page.locator("body").press("ControlOrMeta+Shift+Backslash");
		await expect(page.getByTestId(TESTID.tripMap)).toBeVisible();
		await expect(page.getByTestId(SHELL_TESTID.mapRail)).toHaveCount(0);
		await expect.poll(async () => Math.round((await center.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(width - 2);
		expect(Math.round((await center.boundingBox())?.width ?? 0)).toBeLessThanOrEqual(width + 2);
		expect(logs.messages).toEqual([]);
	});

	test("md: the map hides too, and the centre takes its width", async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 900 });
		const c = await cloneFixtureTrip(page.request);
		await page.goto(`/t/${c.slug}?tab=plan&lens=place`);
		await expectLive(page);
		await page.getByRole("button", { name: "Hide the map" }).click();
		await expect(page.getByTestId(SHELL_TESTID.mapRail)).toBeVisible();
		expect(Math.round((await page.getByTestId(TESTID.centerPanel).boundingBox())?.width ?? 0)).toBeGreaterThan(840);
		await page.getByRole("button", { name: "Show the map" }).click();
		await expect(page.getByTestId(TESTID.tripMap)).toBeVisible();
	});

	test("the Places tab with the map hidden is wide", async ({ page }) => {
		const c = await cloneFixtureTrip(page.request);
		await page.goto(`/t/${c.slug}?tab=places&pv=table`);
		await expectLive(page);
		const places = page.getByTestId("places-tab");
		await expect(places).toBeVisible();
		const narrow = Math.round((await places.boundingBox())?.width ?? 0);
		await page.getByRole("button", { name: "Hide the map" }).click();
		await expect(page.getByTestId(SHELL_TESTID.mapRail)).toBeVisible();
		// The viewport less the Outline (264) and the map's rail (40).
		await expect.poll(async () => Math.round((await places.boundingBox())?.width ?? 0)).toBeGreaterThan(1100);
		expect(narrow).toBeLessThan(800);
		// One switch: no Wide toggle of its own.
		await expect(page.getByTestId("places-wide")).toHaveCount(0);
		await settle(page);
		await page.screenshot({ path: shot("desktop-places-map-hidden"), animations: "disabled" });
	});
});

