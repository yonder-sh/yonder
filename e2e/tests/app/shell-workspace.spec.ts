/**
 * WP-Shell acceptance (SPEC §18.3, CONTRACTS §4.1, EXTENSIONS §1.4, ADDENDUM
 * §10), each test on its own cloned trip (§18.5):
 * - the right structure at 1440, 1100, 900 and 390 px (panes, popover,
 *   Sheet, Drawer), by role and test id;
 * - each `sel` kind mounts the right Overview; the Esc chain; the layout
 *   survives a reload;
 * - the trip overview: "Still to plan" (nights, still to book, city moves,
 *   unrated per member) linking to filtered views, and upcoming deadlines;
 * - the global mounts (ShiftTripDialog via "Try other dates…", the ⌘\ Outline
 *   toggle, the `?` sheet, the Money tab) and the mobile FAB menu with Expense;
 * - on phones the always-open sheet is non-modal (the pills stay reachable by
 *   role) and View settings opens from the ⋯ menu;
 * - screenshots at 1440×900 and 390×844 in `e2e/shots/shell/`.
 */
import { expect, type Page, test } from "@playwright/test";
import { SHELL_TESTID } from "../../../src/features/shell/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive, expectNoHorizontalOverflow } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

const settle = (page: Page) => page.waitForTimeout(400);

test("desktop: the trip overview shows what's still to plan", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/t/${c.slug}?sel=root`);
	await expectLive(page);
	const overview = page.getByTestId(SHELL_TESTID.tripOverview);
	await expect(overview).toBeVisible();
	const panel = page.getByTestId(SHELL_TESTID.stillToPlan);
	await expect(panel).toBeVisible();
	const row = (id: string) => panel.locator(`[data-row="${id}"]`);
	// The demo: no stay on Days 1, 2 and 4; Mt. Fuji → Kyoto and Kyoto → Osaka have no mode.
	await expect(row("nights")).toContainText("3 nights without a stay");
	await expect(row("moves")).toContainText("2 city moves without transport");
	await expect(row("book")).toContainText("1 still to book");
	await expect(row("unrated")).toContainText("unrated places");
	await settle(page);
	await page.screenshot({ path: shotPath("shell/desktop-root-overview.png"), animations: "disabled" });

	// Days per city: planned vs scheduled (WP-Places' editable table in the merged build).
	await row("days").getByRole("button").first().click();
	await expect(row("days").getByRole("table")).toContainText("Tokyo");
	await row("nights").getByRole("button").first().click();
	await expect(row("nights")).toContainText("Day 1");
	await settle(page);
	await page.getByTestId(TESTID.inspector).screenshot({
		path: shotPath("shell/desktop-still-to-plan-open.png"),
		animations: "disabled",
	});
	await page.emulateMedia({ colorScheme: "dark" });
	await settle(page);
	await page.screenshot({ path: shotPath("shell/desktop-root-overview-dark.png"), animations: "disabled" });
	await page.emulateMedia({ colorScheme: "light" });

	// Expand the moves and jump to one: the leg editor opens on that pair.
	await row("moves").getByRole("button").first().click();
	await row("moves").getByText("Mt. Fuji → Kyoto").click();
	await expect(page).toHaveURL(new RegExp(`sel=l\\.${c.ids.items.ryokanBreakfast}\\.${c.ids.items.kiyomizu}`));
	await expect(page.getByTestId(TESTID.legOverview)).toBeVisible();

	// "Still to book" expands to its to-dos; one opens the to-do list filtered
	// to it, the inspector on that selection's Lists tab (PLAN-I2-14, PLAN-R2-05).
	await page.goto(`/t/${c.slug}?sel=root`);
	await expect(page.getByTestId(SHELL_TESTID.stillToPlan)).toBeVisible();
	await row("book").getByRole("button", { name: /still to book/ }).click();
	await row("book").getByTestId(SHELL_TESTID.stillToPlanItem).first().click();
	await expect(page).toHaveURL(/tab=lists/);
	await expect(page).toHaveURL(/list=todo/);
	await expect(page).toHaveURL(/sel=/);
	await expect(
		page.getByTestId(SHELL_TESTID.inspectorTabs).getByRole("tab", { name: /Lists/ }),
	).toHaveAttribute("aria-selected", "true");

	// Unrated by me → the shared filter in the URL.
	await page.goto(`/t/${c.slug}?sel=root`);
	await row("unrated").getByRole("button").first().click();
	await row("unrated").getByText("You", { exact: true }).click();
	await expect(page).toHaveURL(/f=u(%3A|:)me/);

	// Deadlines: the dated demo to-do, on the Overview page now (docs/OVERVIEW.md §7).
	await page.goto(`/t/${c.slug}`);
	await expect(page.getByTestId("overview").getByTestId(SHELL_TESTID.deadlines)).toContainText(
		"Book Shibuya Sky sunset slot",
	);
	expect(logs.messages).toEqual([]);
});

test("structure at 1440, 1100, 900 and 390 px", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "viewport sizes set here");
	const c = await cloneFixtureTrip(page.request);
	const cases = [
		{ width: 1440, bp: "xl" },
		{ width: 1100, bp: "lg" },
		{ width: 900, bp: "md" },
		{ width: 390, bp: "sm" },
	] as const;
	for (const { width, bp } of cases) {
		await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
		await page.goto(`/t/${c.slug}/japan/tokyo?sel=n.${c.ids.nodes.shibuya}`);
		await expect(page.getByTestId(TESTID.workspace)).toHaveAttribute("data-breakpoint", bp);
		await expectLive(page);
		const inspector = page.getByTestId(TESTID.inspector);
		await expect(inspector).toBeVisible();
		await expect(inspector.getByTestId(TESTID.nodeOverview)).toBeVisible();
		if (bp === "xl") {
			await expect(page.getByRole("complementary", { name: "Outline" })).toBeVisible();
			await expect(page.getByTestId(TESTID.outlinePopoverButton)).toHaveCount(0);
		}
		if (bp === "lg" || bp === "md")
			await expect(page.getByTestId(TESTID.outlinePopoverButton)).toBeVisible();
		if (bp === "md") await expect(page.getByRole("dialog").getByTestId(TESTID.nodeOverview)).toBeVisible();
		if (bp === "sm") {
			await expect(page.getByTestId(TESTID.mobilePills)).toBeVisible();
			await expect(page.getByTestId(TESTID.mobileSheet)).toBeVisible();
		} else {
			await expect(page.getByTestId(TESTID.topBar)).toBeVisible();
			await expect(page.getByTestId(TESTID.centerPanel)).toBeVisible();
		}
		await expectNoHorizontalOverflow(page);
		await settle(page);
		await page.screenshot({ path: shotPath(`shell/structure-${width}.png`), animations: "disabled" });
	}
});

test("each selection mounts its overview; Esc clears sel, then days, then zooms out", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	const cases: [string, string][] = [
		["root", SHELL_TESTID.tripOverview],
		[`n.${c.ids.nodes.tokyo}`, TESTID.nodeOverview],
		[`i.${I.sky}`, TESTID.itemOverview],
		[`l.${I.hands}.${I.loft}`, TESTID.legOverview],
		[`d.${c.ids.days.d2}`, TESTID.dayOverview],
	];
	for (const [sel, id] of cases) {
		await page.goto(`/t/${c.slug}?sel=${sel}`);
		await expect(page.getByTestId(TESTID.inspector).getByTestId(id)).toBeVisible();
	}
	await page.goto(`/t/${c.slug}/japan/tokyo?days=2027-10-04&sel=i.${I.sensoji}`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.inspector)).toBeVisible();
	await expect(page.getByTestId(TESTID.dayRangeChip)).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page).not.toHaveURL(/sel=/);
	await expect(page.getByTestId(TESTID.inspector)).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(page).not.toHaveURL(/days=/);
	await expect(page.getByTestId(TESTID.dayRangeChip)).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(page).toHaveURL(new RegExp(`/t/${c.slug}/japan(\\?|$)`));
});

test("the layout survives a reload; ⌘\\ hides the Outline; ? lists shortcuts", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const c = await cloneFixtureTrip(page.request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const center = page.getByTestId(TESTID.centerPanel);
	const before = (await center.boundingBox())?.width ?? 0;
	const handle = page.locator('[data-slot="resizable-handle"]').first();
	const hb = await handle.boundingBox();
	if (!hb) throw new Error("no resize handle");
	await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
	await page.mouse.down();
	await page.mouse.move(hb.x + 120, hb.y + hb.height / 2, { steps: 8 });
	await page.mouse.up();
	const resized = (await center.boundingBox())?.width ?? 0;
	expect(resized).toBeGreaterThan(before + 60);
	await page.reload();
	await expectLive(page);
	await expect.poll(async () => Math.round((await center.boundingBox())?.width ?? 0)).toBe(Math.round(resized));

	// ⌘\ collapses the Outline; the popover button takes over; again restores it.
	await page.keyboard.press("ControlOrMeta+Backslash");
	await expect(page.getByTestId(SHELL_TESTID.outlineAside)).toHaveCount(0);
	await expect(page.getByTestId(TESTID.outlinePopoverButton)).toBeVisible();
	await page.keyboard.press("ControlOrMeta+Backslash");
	await expect(page.getByTestId(SHELL_TESTID.outlineAside)).toBeVisible();

	await page.keyboard.press("Shift+Slash");
	await expect(page.getByTestId(SHELL_TESTID.shortcutsDialog)).toBeVisible();
	await expect(page.getByTestId(SHELL_TESTID.shortcutsDialog)).toContainText("Next stop in the plan");
	await page.keyboard.press("Escape");
	await expect(page.getByTestId(SHELL_TESTID.shortcutsDialog)).toHaveCount(0);

	// J selects the first stop in the plan, then the next one.
	await expect(page).not.toHaveURL(/sel=/);
	await page.keyboard.press("j");
	await expect(page).toHaveURL(new RegExp(`sel=i\\.${c.ids.items.hands}`));
	await expect(page.getByTestId(TESTID.inspector).getByRole("heading", { name: "Hands Shibuya" })).toBeVisible();
	await page.keyboard.press("j");
	await expect(page).toHaveURL(new RegExp(`sel=i\\.${c.ids.items.loft}`));
});

test("global mounts: Try other dates, the Money tab, the inspector's Money tab", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	await page.getByTestId(TESTID.tripMenu).click();
	await page.getByTestId(SHELL_TESTID.tryOtherDates).click();
	await expect(page.getByTestId(TESTID.shiftTripDialog)).toBeVisible();
	await page.keyboard.press("Escape");
	await page.getByTestId(TESTID.centerTabs).getByRole("tab", { name: "Money" }).click();
	await expect(page).toHaveURL(/tab=money/);
	await expect(page.getByTestId(TESTID.moneyTab)).toBeVisible();
	await page.goto(`/t/${c.slug}?sel=n.${c.ids.nodes.tokyo}`);
	await page.getByTestId(SHELL_TESTID.inspectorTabs).getByRole("tab", { name: "Money" }).click();
	await expect(page.getByTestId(TESTID.moneyPanel)).toBeVisible();
});

test("mobile: the sheet, the FAB menu with Expense, and the inbox drawer", async ({ page }, info) => {
	test.skip(info.project.name !== "mobile", "mobile layout");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.mobilePills)).toBeVisible();
	// The always-open sheet is non-modal: the pills and the + stay in the accessibility tree.
	await expect(page.getByRole("button", { name: /^Inbox/ })).toBeVisible();
	await expect(page.getByRole("button", { name: "Add" })).toBeVisible();
	await settle(page);
	await page.screenshot({ path: shotPath("shell/mobile-peek.png"), animations: "disabled" });
	await page.getByTestId(TESTID.fab).click();
	const menu = page.getByTestId(SHELL_TESTID.fabMenu);
	await expect(menu).toBeVisible();
	await expect(menu.getByTestId(SHELL_TESTID.fabPlace)).toBeVisible();
	await expect(menu.getByTestId(SHELL_TESTID.fabExpense)).toBeVisible();
	await page.screenshot({ path: shotPath("shell/mobile-fab-menu.png"), animations: "disabled" });
	await menu.getByTestId(SHELL_TESTID.fabExpense).click();
	await expect(page.getByTestId(TESTID.addExpenseDialog)).toBeVisible();
	await page.keyboard.press("Escape");
	// The inbox is a drawer on phones.
	await page.getByTestId(TESTID.mobilePills).getByTestId(TESTID.inboxBell).click();
	await expect(page.getByTestId(SHELL_TESTID.inboxPanel)).toBeVisible();
	await settle(page);
	await page.screenshot({ path: shotPath("shell/mobile-inbox.png"), animations: "disabled" });
	await page.keyboard.press("Escape");
	// View settings from the ⋯ menu: one column, nothing clipped.
	await page.getByTestId(TESTID.mobilePills).getByRole("button", { name: "More" }).click();
	await page.getByTestId(SHELL_TESTID.viewSettingsButton).click();
	const settings = page.getByTestId(SHELL_TESTID.viewSettingsDialog);
	await expect(settings).toBeVisible();
	await expect(settings.getByRole("radio", { name: "24-hour" })).toBeInViewport();
	await settle(page);
	await page.screenshot({ path: shotPath("shell/mobile-view-settings.png"), animations: "disabled" });
	await expectNoHorizontalOverflow(page);
	await page.keyboard.press("Escape");
	// The trip overview in the nested drawer.
	await page.goto(`/t/${c.slug}?sel=root`);
	await expect(page.getByTestId(SHELL_TESTID.stillToPlan)).toBeVisible();
	await settle(page);
	await page.screenshot({ path: shotPath("shell/mobile-root-overview.png"), animations: "disabled" });
	await expectNoHorizontalOverflow(page);
	expect(logs.messages).toEqual([]);
});

test("follow mirrors a peer's view; the offline pill says read-only", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "two desktop browsers");
	const devCtx = await browser.newContext({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });
	const dev = await devCtx.newPage();
	const c = await cloneFixtureTrip(dev.request);
	test.skip(!c.members.maya, "maya@example.com is not seeded");
	const logs = collectConsole(dev, [/net::ERR_INTERNET_DISCONNECTED/, /Failed to fetch/]);
	await dev.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(dev);
	const mayaCtx = await browser.newContext({ storageState: storageStateOf("maya"), viewport: { width: 1440, height: 900 } });
	const maya = await mayaCtx.newPage();
	await maya.goto(`/t/${c.slug}/japan`);
	await expectLive(maya);
	const avatar = dev.getByTestId(TESTID.topBar).getByTestId(TESTID.presenceAvatar).first();
	await expect(avatar).toBeVisible({ timeout: 15_000 });
	await avatar.hover();
	await dev.getByTestId(SHELL_TESTID.followButton).click();
	const bar = dev.getByTestId(SHELL_TESTID.followBar);
	await expect(bar).toContainText("Following Maya");
	// Dennis lands where Maya is, and follows her next move.
	await expect(dev).toHaveURL(new RegExp(`/t/${c.slug}/japan`));
	await maya.goto(`/t/${c.slug}/japan/kyoto?lens=place`);
	await expectLive(maya);
	await expect(dev).toHaveURL(new RegExp(`/t/${c.slug}/japan/kyoto\\?lens=place`), { timeout: 15_000 });
	await settle(dev);
	await dev.screenshot({ path: shotPath("shell/desktop-following.png"), animations: "disabled" });
	await bar.getByRole("button", { name: "Stop" }).click();
	await expect(bar).toHaveCount(0);
	await maya.goto(`/t/${c.slug}/japan/tokyo`);
	await dev.waitForTimeout(1_500);
	await expect(dev).toHaveURL(new RegExp(`/t/${c.slug}/japan/kyoto`));

	// Offline: the pill says so and edits pause (DESIGN §4.1, §6).
	await devCtx.setOffline(true);
	const pill = dev.getByTestId(TESTID.topBar).getByTestId(TESTID.connectionPill);
	await expect(pill).toHaveAttribute("data-status", "offline", { timeout: 20_000 });
	await expect(pill).toContainText("Offline · read-only");
	await devCtx.setOffline(false);
	await expect(pill).toHaveAttribute("data-status", "live", { timeout: 30_000 });
	expect(logs.messages.filter((m) => !/ERR_INTERNET_DISCONNECTED|WebSocket|Failed to fetch/.test(m))).toEqual([]);
	await mayaCtx.close();
	await devCtx.close();
});
