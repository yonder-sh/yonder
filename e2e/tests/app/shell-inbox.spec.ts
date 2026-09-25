/**
 * WP-Shell: the one inbox, the one-line digest and synced view settings
 * (ADDENDUM §7.2, §10; EXTENSIONS §9), each on its own cloned trip:
 * - Maya's mention (the demo's washi-tape shopping item) lights the bell's
 *   one dot; opening the row deep-links to the place's lists and marks it
 *   read everywhere (QA DIG-08);
 * - Maya adds a place; Dennis's next open shows "1 change since you last
 *   looked", the activity view names it, and Got it clears it across reloads
 *   (QA DIG-01/02/03);
 * - a view setting changed in one browser is there in a fresh one (the
 *   account copy, not just localStorage); 12-hour applies to the page's times
 *   at once; "Start at" can go back to Automatic (the key is removed).
 */
import { randomUUID } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { SHELL_TESTID } from "../../../src/features/shell/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

async function as(browser: Browser, handle: "dev" | "maya", url: string): Promise<Page> {
	const ctx = await browser.newContext({
		storageState: storageStateOf(handle),
		viewport: { width: 1440, height: 900 },
	});
	const page = await ctx.newPage();
	await page.goto(url);
	if (url.startsWith("/t/")) await expectLive(page);
	return page;
}

test("one inbox: a mention lights the bell, opens its place and is read everywhere", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop popover (the drawer is covered on mobile)");
	const dev = await as(browser, "dev", "/dashboard");
	const c = await cloneFixtureTrip(dev.request);
	test.skip(!c.members.maya, "maya@example.com is not seeded");
	const maya = await as(browser, "maya", `/t/${c.slug}?tab=plan`);
	const logs = collectConsole(maya);
	const bell = maya.getByTestId(TESTID.inboxBell);
	await expect(bell).toHaveAttribute("data-unread", "1");
	await expect(maya.getByTestId(SHELL_TESTID.inboxDot)).toHaveCount(1);
	await bell.click();
	const panel = maya.getByTestId(SHELL_TESTID.inboxPanel);
	await expect(panel).toBeVisible();
	const row = panel.getByTestId(SHELL_TESTID.inboxRow).first();
	await expect(row).toHaveAttribute("data-kind", "mention");
	await expect(row).toHaveAttribute("data-read", "0");
	await expect(row).toContainText("mentioned you");
	await expect(row).toContainText("Washi tape");
	await maya.waitForTimeout(300);
	await maya.screenshot({ path: shotPath("shell/desktop-inbox.png"), animations: "disabled" });
	await row.click();
	await expect(maya).toHaveURL(new RegExp(`sel=n\\.${c.ids.nodes.hands}`));
	await expect(maya).toHaveURL(/tab=lists/);
	await expect(maya.getByTestId(TESTID.inspector).getByTestId(TESTID.nodeOverview)).toBeVisible();
	await expect(bell).toHaveAttribute("data-unread", "0");
	await expect(maya.getByTestId(SHELL_TESTID.inboxDot)).toHaveCount(0);
	// Read everywhere: a reload (fresh feed from the server) keeps it read.
	await maya.reload();
	await expectLive(maya);
	await expect(maya.getByTestId(TESTID.inboxBell)).toHaveAttribute("data-unread", "0");
	await maya.getByTestId(TESTID.inboxBell).click();
	await expect(maya.getByTestId(SHELL_TESTID.inboxRow).first()).toHaveAttribute("data-read", "1");
	expect(logs.messages).toEqual([]);
	await maya.context().close();
	await dev.context().close();
});

test("digest: one line for other people's changes; Got it clears it", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const dev = await as(browser, "dev", "/dashboard");
	const c = await cloneFixtureTrip(dev.request);
	test.skip(!c.members.maya, "maya@example.com is not seeded");
	// Dennis opens the trip once: that is "last looked".
	await dev.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(dev);
	await expect(dev.getByTestId(SHELL_TESTID.digestBanner)).toHaveCount(0);
	// Maya adds a place under Kyoto (a real server-function call from her page).
	const maya = await as(browser, "maya", `/t/${c.slug}?tab=plan`);
	const created = await maya.evaluate(
		async ({ tripId, parentId, id }) => {
			const m = await import("/src/functions/nodes.functions.ts");
			return m.createNode({
				data: { tripId, parentId, id, type: "place", category: "food_drink", name: "Nishiki Market" },
			});
		},
		{ tripId: c.tripId, parentId: c.ids.nodes.kyoto, id: randomUUID() },
	);
	expect(created).toBeTruthy();
	// Dennis's own change never counts.
	await dev.reload();
	await expectLive(dev);
	const banner = dev.getByTestId(SHELL_TESTID.digestBanner);
	await expect(banner).toBeVisible();
	await expect(banner).toContainText("1 change since you last looked");
	await dev.waitForTimeout(300);
	await dev.screenshot({ path: shotPath("shell/desktop-digest.png"), animations: "disabled" });
	await banner.getByRole("button", { name: /since you last looked/ }).click();
	const dialog = dev.getByTestId(SHELL_TESTID.activityDialog);
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("Maya");
	await expect(dialog).toContainText("added Nishiki Market");
	await dev.screenshot({ path: shotPath("shell/desktop-activity.png"), animations: "disabled" });
	await dev.keyboard.press("Escape");
	await dev.getByTestId(SHELL_TESTID.digestGotIt).click();
	await expect(banner).toHaveCount(0);
	await dev.reload();
	await expectLive(dev);
	await dev.waitForTimeout(2_000);
	await expect(dev.getByTestId(SHELL_TESTID.digestBanner)).toHaveCount(0);
	await maya.context().close();
	await dev.context().close();
});

test("view settings follow the account to a fresh browser", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const first = await as(browser, "dev", "/dashboard");
	const c = await cloneFixtureTrip(first.request);
	await first.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(first);
	await first.getByTestId(TESTID.tripMenu).click();
	await first.getByTestId(SHELL_TESTID.viewSettingsButton).click();
	const dialog = first.getByTestId(SHELL_TESTID.viewSettingsDialog);
	await expect(dialog).toBeVisible();
	await dialog.getByRole("radio", { name: "12-hour" }).click();
	await dialog.getByRole("radio", { name: "mi" }).click();
	await expect(dialog.getByRole("radio", { name: "12-hour" })).toHaveAttribute("data-state", "on");
	// Page-wide: the plan behind the dialog switches to 12-hour times.
	await expect(first.getByTestId(TESTID.centerPanel)).toContainText(/\b\d{1,2}:\d{2}(am|pm)\b/);
	// Start at: a lens, then back to Automatic.
	await dialog.locator("#pref-lens").click();
	await first.getByRole("option", { name: "City" }).click();
	await expect(dialog.locator("#pref-lens")).toContainText("City");
	await expect
		.poll(() =>
			first.evaluate(async () => {
				const m = await import("/src/functions/prefs.functions.ts");
				return (await m.getUserPrefs()).defaultLens ?? "auto";
			}),
		)
		.toBe("city");
	await dialog.locator("#pref-lens").click();
	await first.getByRole("option", { name: "Automatic" }).click();
	await expect(dialog.locator("#pref-lens")).toContainText("Automatic");
	await first.waitForTimeout(300);
	await first.screenshot({ path: shotPath("shell/desktop-view-settings.png"), animations: "disabled" });
	// The debounced save reaches the account.
	await expect
		.poll(() =>
			first.evaluate(async () => {
				const m = await import("/src/functions/prefs.functions.ts");
				const p = await m.getUserPrefs();
				return `${p.clock}/${p.defaultLens ?? "auto"}`;
			}),
		)
		.toBe("12h/auto");
	// A new browser (empty localStorage) gets it from the account.
	const second = await as(browser, "dev", `/t/${c.slug}?tab=plan`);
	await second.getByTestId(TESTID.tripMenu).click();
	await second.getByTestId(SHELL_TESTID.viewSettingsButton).click();
	const d2 = second.getByTestId(SHELL_TESTID.viewSettingsDialog);
	await expect(d2.getByRole("radio", { name: "12-hour" })).toHaveAttribute("data-state", "on");
	await expect(d2.getByRole("radio", { name: "mi" })).toHaveAttribute("data-state", "on");
	// Put it back for the other specs.
	await d2.getByRole("radio", { name: "24-hour" }).click();
	await d2.getByRole("radio", { name: "km" }).click();
	await expect
		.poll(() =>
			second.evaluate(async () => {
				const m = await import("/src/functions/prefs.functions.ts");
				const p = await m.getUserPrefs();
				return `${p.clock}/${p.units}`;
			}),
		)
		.toBe("24h/km");
	await expect(second.getByTestId(TESTID.centerPanel)).not.toContainText(/\b\d{1,2}:\d{2}(am|pm)\b/);
	await first.context().close();
	await second.context().close();
});
