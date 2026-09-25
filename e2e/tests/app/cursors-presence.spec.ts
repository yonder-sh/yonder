/**
 * FB-17a presence around live cursors, and phones:
 * - "where are they": B elsewhere reads "Maya · in Tokyo" / "Maya · Lists tab"
 *   on A's strip, a dot on the breadcrumb, and a tap goes there;
 * - the view setting "Show others' cursors" hides them (mine stays shared);
 * - inside the notes editor the mouse cursor hides (the TipTap caret takes over);
 * - a phone never hovers: its taps ripple on the desktop, and a long press on
 *   a card opens the reaction palette, whose emoji lands on that card;
 * - polish: 7-figure money totals never truncate on a phone.
 */
import { randomBytes } from "node:crypto";
import {
	type Browser,
	type BrowserContext,
	devices,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import { MONEY_TESTID as M } from "../../../src/features/money/testids";
import { SHELL_TESTID as S } from "../../../src/features/shell/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

test.describe.configure({ mode: "serial" });

async function open(
	browser: Browser,
	who: string,
	url: string,
	opts: Parameters<Browser["newContext"]>[0] = { viewport: { width: 1440, height: 900 } },
): Promise<{ ctx: BrowserContext; page: Page }> {
	const ctx = await browser.newContext({ storageState: storageStateOf(who), ...opts });
	const page = await ctx.newPage();
	await page.goto(url);
	await expectLive(page);
	await page.waitForFunction(() => !!(window as { __yonderCursors?: unknown }).__yonderCursors);
	return { ctx, page };
}

async function hover(page: Page, el: Locator, fx = 0.5, fy = 0.5) {
	await el.scrollIntoViewIfNeeded();
	const b = await el.boundingBox();
	if (!b) throw new Error("no box");
	await page.mouse.move(b.x + b.width * fx - 25, b.y + b.height * fy - 15);
	await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy, { steps: 5 });
}

let trip: FixtureClone;
let devId = "";
let mayaId = "";

test.beforeAll(async ({ browser }) => {
	const owner = await browser.newContext({ storageState: storageStateOf("dev") });
	trip = await cloneFixtureTrip(owner.request);
	devId = ((await (await owner.request.get("/api/auth/get-session")).json()) as { user: { id: string } }).user.id;
	await owner.close();
	const m = await browser.newContext({ storageState: storageStateOf("maya") });
	mayaId = ((await (await m.request.get("/api/auth/get-session")).json()) as { user: { id: string } }).user.id;
	await m.close();
});

test.beforeEach(({}, info) => {
	test.skip(info.project.name !== "chromium", "drives its own desktop + phone windows");
});

test("where are they: a strip, breadcrumb dots, and a tap goes there", async ({ browser }) => {
	const a = await open(browser, "dev", `/t/${trip.slug}/japan`);
	const b = await open(browser, "maya", `/t/${trip.slug}/japan/tokyo`, { viewport: { width: 1280, height: 800 } });
	const chip = a.page.locator(`[data-testid="${S.elsewhereChip}"][data-user-id="${mayaId}"]`);
	await expect(chip).toContainText("Maya");
	await expect(chip).toContainText("in Tokyo");
	// The Outline row of Tokyo carries her dot already; on B's breadcrumb, A's dot sits on Japan.
	await expect(b.page.getByTestId(TESTID.scopeBreadcrumb).getByTestId(S.crumbPresence)).toHaveCount(1);
	await b.page.getByRole("tab", { name: /Lists/ }).click();
	await expect(chip).toContainText("Lists tab · in Tokyo");
	await a.page.screenshot({ path: shotPath("cursors/where-strip.png") });
	await b.page.getByTestId(TESTID.scopeBreadcrumb).screenshot({ path: shotPath("cursors/crumb-dot.png") });
	await chip.click();
	await expect(a.page).toHaveURL(/\/japan\/tokyo\?.*tab=lists/);
	// Same place, same tab: no chip, the cursor says it.
	await expect(chip).toHaveCount(0);
	await a.ctx.close();
	await b.ctx.close();
});

test("'Show others' cursors' off hides them; the notes editor hides my mouse cursor", async ({ browser }) => {
	const url = `/t/${trip.slug}?tab=plan`;
	const a = await open(browser, "dev", url);
	const b = await open(browser, "maya", url, { viewport: { width: 1280, height: 800 } });
	const sky = trip.ids.items.sky as string;
	await b.page.locator(`[data-cursor-anchor="item:${sky}"]`).scrollIntoViewIfNeeded();
	const cursor = b.page.locator(`[data-testid="remote-cursor"][data-user-id="${devId}"]`);
	await hover(a.page, a.page.locator(`[data-cursor-anchor="item:${sky}"]`));
	await expect(cursor).toHaveAttribute("data-state", "on");

	// B turns others' cursors off in View settings: A's disappears.
	await b.page.getByTestId(TESTID.tripMenu).click();
	await b.page.getByTestId(S.viewSettingsButton).click();
	const sw = b.page.getByTestId(S.showCursorsSwitch);
	await expect(sw).toBeChecked();
	await b.page.getByTestId(S.viewSettingsDialog).screenshot({ path: shotPath("cursors/view-settings.png") });
	await sw.click();
	await b.page.keyboard.press("Escape");
	await hover(a.page, a.page.locator(`[data-cursor-anchor="item:${sky}"]`), 0.7, 0.5);
	await expect(cursor).toHaveAttribute("data-state", "off");
	// …and back on.
	await b.page.getByTestId(TESTID.tripMenu).click();
	await b.page.getByTestId(S.viewSettingsButton).click();
	await b.page.getByTestId(S.showCursorsSwitch).click();
	await b.page.keyboard.press("Escape");
	await hover(a.page, a.page.locator(`[data-cursor-anchor="item:${sky}"]`), 0.4, 0.5);
	await expect(cursor).toHaveAttribute("data-state", "on");

	// Idle: A's cursor fades after a few seconds still.
	await expect(cursor).toHaveAttribute("data-state", "idle", { timeout: 9_000 });

	// Notes: over the editor A's mouse cursor is hidden for B (the caret takes over).
	await a.page.getByRole("tab", { name: /Notes/ }).click();
	await b.page.getByRole("tab", { name: /Notes/ }).click();
	const editorA = a.page.locator("[data-cursor-caret] .ProseMirror").first();
	await expect(editorA).toBeVisible();
	await hover(a.page, a.page.locator('[data-cursor-anchor="tab:notes"]'));
	await expect(cursor).toHaveAttribute("data-state", "on");
	await hover(a.page, editorA, 0.3, 0.3);
	await expect(cursor).toHaveAttribute("data-state", "off");
	await a.ctx.close();
	await b.ctx.close();
});

test("a phone never hovers: taps ripple on the desktop, a long press reacts on a card", async ({ browser }) => {
	const url = `/t/${trip.slug}?tab=plan`;
	const a = await open(browser, "dev", url);
	const phone = await open(browser, "maya", url, { ...devices["Pixel 7"] });
	// The plan in the phone's sheet.
	await phone.page.evaluate(async () => {
		const m = await import(/* @vite-ignore */ "/src/lib/workspace/ui-store.ts");
		m.useUi.getState().setSheetSnap(0.92);
	});
	const meiji = trip.ids.items.meiji as string;
	const cardP = phone.page.locator(`[data-cursor-anchor="item:${meiji}"]`);
	await cardP.scrollIntoViewIfNeeded();
	await expect(cardP).toBeInViewport();
	await a.page.locator(`[data-cursor-anchor="item:${meiji}"]`).scrollIntoViewIfNeeded();
	const box = await cardP.boundingBox();
	if (!box) throw new Error("no card on the phone");

	// A long press (hold still, let go) on the card: the reaction palette.
	const cdp = await phone.ctx.newCDPSession(phone.page);
	const at = { x: Math.round(box.x + box.width * 0.35), y: Math.round(box.y + box.height / 2) };
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
	await phone.page.waitForTimeout(650);
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	const palette = phone.page.getByTestId(S.reactionPalette);
	await expect(palette).toBeVisible();
	await phone.page.waitForTimeout(400); // the lifted card settles back
	await phone.page.screenshot({ path: shotPath("cursors/phone-long-press-palette.png") });
	await palette.getByRole("button", { name: /❤️/ }).tap();
	await expect(palette).toHaveCount(0);
	const heart = a.page.getByTestId("remote-reaction").filter({ hasText: "❤️" });
	await expect(heart).toBeVisible({ timeout: 5_000 });
	const cardA = await a.page.locator(`[data-cursor-anchor="item:${meiji}"]`).boundingBox();
	if (!cardA) throw new Error("no card on A");
	const hp = await heart.evaluate((el) => ({ x: Number.parseFloat((el as HTMLElement).style.left), y: Number.parseFloat((el as HTMLElement).style.top) }));
	expect(hp.y).toBeGreaterThan(cardA.y - 1);
	expect(hp.y).toBeLessThan(cardA.y + cardA.height + 1);
	await a.page.waitForTimeout(250);
	await a.page.screenshot({ path: shotPath("cursors/a-sees-phone-reaction.png") });

	// A tap: a ripple on A's screen, over the same card; touch never draws a hovering arrow.
	const now = await cardP.boundingBox();
	if (!now) throw new Error("no card on the phone");
	await phone.page.touchscreen.tap(now.x + now.width * 0.3, now.y + now.height / 2);
	const ripple = a.page.getByTestId("remote-tap");
	await expect(ripple).toHaveCount(1, { timeout: 5_000 });
	const rp = await ripple.evaluate((el) => ({ x: Number.parseFloat((el as HTMLElement).style.left), y: Number.parseFloat((el as HTMLElement).style.top) }));
	expect(Math.abs(rp.x - (cardA.x + cardA.width * 0.3))).toBeLessThan(3);
	expect(Math.abs(rp.y - (cardA.y + cardA.height / 2))).toBeLessThan(3);
	await a.page.waitForTimeout(200);
	await a.page.screenshot({ path: shotPath("cursors/a-sees-phone-tap.png") });
	await expect(a.page.locator(`[data-testid="remote-cursor"][data-user-id="${mayaId}"][data-state="on"]`)).toHaveCount(0);
	// She selects the card on the phone: A sees her selection ring on it.
	await cardP.locator("[data-card-main]").tap();
	await expect(phone.page).toHaveURL(new RegExp(`sel=i\\.${meiji}`));
	await expect
		.poll(() =>
			a.page
				.locator(`[data-cursor-anchor="item:${meiji}"]`)
				.evaluate((el) => getComputedStyle(el).boxShadow),
		)
		.toContain("0px 0px 0px 3px");
	await a.page.locator(`[data-cursor-anchor="item:${meiji}"]`).screenshot({ path: shotPath("cursors/a-sees-phone-selection.png") });
	await a.ctx.close();
	await phone.ctx.close();
});

test("polish: a 7-figure money total never truncates on a phone", async ({ browser }) => {
	const phone = await open(browser, "dev", `/t/${trip.slug}?tab=money`, { ...devices["Pixel 7"] });
	await phone.page.evaluate(
		async ({ tripId, owner }) => {
			const m = await import(/* @vite-ignore */ "/src/features/money/money.functions.ts");
			await m.createExpense({
				data: {
					tripId,
					target: { kind: "trip" },
					title: "Rail passes for everyone",
					amountMinor: 1_234_567_800,
					currency: "USD",
					split: { mode: "equal", shares: [{ memberId: owner }] },
				},
			});
		},
		{ tripId: trip.tripId, owner: trip.members.owner },
	);
	await phone.page.reload();
	await expectLive(phone.page);
	await phone.page.evaluate(async () => {
		const m = await import(/* @vite-ignore */ "/src/lib/workspace/ui-store.ts");
		m.useUi.getState().setSheetSnap(0.92);
	});
	const planned = phone.page.getByTestId(M.summaryPlanned);
	await expect(planned).toBeVisible();
	await planned.scrollIntoViewIfNeeded();
	// Nothing is cut: every tile's text fits its box (compact where needed).
	for (const id of [M.summaryPlanned, M.summaryActual, M.summaryRemaining]) {
		const fit = await phone.page.getByTestId(id).evaluate((el) => {
			const tile = el.parentElement?.parentElement as HTMLElement;
			return {
				text: el.textContent,
				el: el.getBoundingClientRect().right,
				tile: tile.getBoundingClientRect().right,
				cut: tile.scrollWidth > tile.clientWidth + 1,
			};
		});
		console.log("[money tile]", id, JSON.stringify(fit));
		expect(fit.cut, `${id} is cut`).toBe(false);
		expect(fit.el).toBeLessThanOrEqual(fit.tile + 1);
	}
	await expect(planned).toHaveAttribute("data-compact", "true");
	await expect(planned).toHaveText(/\$12\.3M/);
	await expect(planned).toHaveAttribute("title", /^\$12,345,\d{3}\.\d{2}$/);
	await phone.page.getByTestId(M.summary).screenshot({ path: shotPath("cursors/money-tiles-phone.png") });
	await phone.ctx.close();
	void randomBytes;
});
