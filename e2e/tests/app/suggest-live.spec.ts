/**
 * WP-Suggest against F-ext1's live proposal platform (EXTENSIONS §3.5–§3.7,
 * QA SUG). Each test clones its own trip (SPEC §18.5); most with Maya as a
 * suggester and her five demo suggestions proposed through the real gate
 * (`cloneFixtureTrip(request, { mayaRole: "suggester", proposals: true })`):
 * add Nishiki Market, move Itoya Ginza to Day 1, delete Shibuya Sky, shift
 * the trip +1 day, move Kama-asa (knives) to Day 4.
 *
 * - SUG-02 / SUG-14: the owner accepts from the card (ghost ✓) and rejects
 *   with a note; Maya, online, is told, and sees both under Mine; Accept all.
 * - SUG-03: the owner moved it first → a `changed` conflict → Accept anyway.
 * - SUG-09 / SUG-16: the owner suggests too (Suggesting mode); the bar lists
 *   both alternatives; accepting one puts Maya's under Conflicts; back in
 *   Editing, changes apply directly.
 * - SUG-07 / SUG-12: a note addition through the gate, withdrawn by Undo.
 * - SUG-13: a view-link guest sees no suggestion UI.
 * - Phone: Maya's pill, first-time hint and "Your suggestions".
 *
 * The components load through the dev harness until the owners mount them
 * (`suggest-helpers.ts`).
 */
import { type APIRequestContext, devices, expect, test } from "@playwright/test";
import { SUGGEST_TESTID as S } from "../../../src/features/suggest/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";
import { collectConsole, expectLive, expectNoHorizontalOverflow } from "./_helpers/page";
import { callServerFn, centerRuleWidth, dayOfItem, settle, withSuggestUi } from "./suggest-helpers";

const ITEMS = "/src/functions/items.functions.ts";

function must(v: string | undefined, what: string): string {
	if (!v) throw new Error(`fixture has no ${what}`);
	return v;
}

/**
 * A clone with Maya as a suggester and her five demo suggestions. The gate's
 * 60-per-author-per-hour limit applies to the seeding too (CONTRACT_REQUESTS
 * T4), so a failure here names what was skipped.
 */
async function seededClone(request: APIRequestContext): Promise<FixtureClone> {
	const c = await cloneFixtureTrip(request, { mayaRole: "suggester", proposals: true });
	expect(c.proposals?.ids, `Maya's demo suggestions; skipped: ${JSON.stringify(c.proposals?.skipped)}`).toHaveLength(5);
	return c;
}

function keys(c: FixtureClone) {
	return {
		itoya: must(c.ids.items.itoya, "items.itoya"),
		sky: must(c.ids.items.sky, "items.sky"),
		knives: must(c.ids.items.knives, "items.knives"),
		sensoji: must(c.ids.items.sensoji, "items.sensoji"),
		d1: must(c.ids.days.d1, "days.d1"),
		d3: must(c.ids.days.d3, "days.d3"),
		shibuyaSky: must(c.ids.nodes.shibuyaSky, "nodes.shibuyaSky"),
	};
}

test.describe("live review (desktop 1440×900)", () => {
	test.use({ storageState: storageStateOf("dev"), viewport: { width: 1440, height: 900 } });
	test.skip(({ isMobile }) => isMobile, "desktop layout");

	test("accept from the card, reject with a note; Maya is told and sees both under Mine; Accept all (SUG-02, SUG-14)", async ({
		browser,
		page,
	}) => {
		const logs = collectConsole(page);
		const c = await seededClone(page.request);
		const k = keys(c);
		const url = `/t/${c.slug}/japan/tokyo`;

		// Maya (a suggester) is online first, so her result toasts can arrive.
		const mayaCtx = await browser.newContext({
			storageState: storageStateOf("maya"),
			viewport: { width: 1440, height: 900 },
		});
		const maya = await mayaCtx.newPage();
		await maya.goto(url);
		await expectLive(maya);
		await withSuggestUi(maya, "live");
		const pill = maya.getByTestId(TESTID.suggestModeControl).first();
		await expect(pill).toHaveAttribute("data-mode", "suggest");
		await expect(pill).toContainText("Suggesting");
		await expect(pill).toContainText("5");
		const hint = maya.getByTestId(S.firstHint);
		await expect(hint).toContainText("You're suggesting");
		await expect(hint).toContainText("Dev");
		await settle(maya);
		await maya.screenshot({ path: shotPath("suggest/live-1-maya-hint.png"), animations: "disabled" });
		await hint.getByRole("button", { name: "Got it" }).click();
		await expect(hint).toBeHidden();

		// The owner: "Editing ▾ | 5"; the Itoya card's ghost ✓ accepts directly.
		await page.goto(url);
		await expectLive(page);
		const harness = await withSuggestUi(page, "live");
		const ctl = page.getByTestId(TESTID.suggestModeControl).first();
		await expect(ctl).toContainText("Editing");
		await expect(page.getByRole("button", { name: "Review 5 suggestions" })).toBeVisible();
		if (harness) {
			const card = page.locator(`[data-testid="${TESTID.timelineItem}"]`, { hasText: "Itoya Ginza" }).first();
			await card.hover();
			const tick = page.getByTestId(S.ghostAccept).first();
			await expect(tick).toBeVisible();
			await expect(tick).toHaveAccessibleName("Accept: Move Itoya Ginza to Day 1");
			await tick.click();
		} else {
			await page.getByRole("button", { name: "Review 5 suggestions" }).click();
			await page.getByTestId(TESTID.reviewDrawer).getByTestId(S.row).filter({ hasText: "Move Itoya Ginza to Day 1" }).getByTestId(S.accept).click();
			await page.keyboard.press("Escape");
		}
		await expect(page.getByText("Accepted — Move Itoya Ginza to Day 1")).toBeVisible();
		await expect.poll(() => dayOfItem(page, k.itoya), { timeout: 15_000 }).toBe(k.d1);

		// The drawer: reject Maya's delete with a note.
		await page.getByRole("button", { name: "Review 4 suggestions" }).click();
		const drawer = page.getByTestId(TESTID.reviewDrawer);
		await expect(drawer).toBeVisible();
		await expect(drawer.getByTestId(S.group).first()).toContainText("Maya");
		const skyRow = drawer.getByTestId(S.row).filter({ hasText: "Remove Shibuya Sky from the plan" });
		await skyRow.getByTestId(S.reject).click();
		await page.getByTestId(S.rejectNote).fill("We already have the tickets");
		await settle(page);
		await page.screenshot({ path: shotPath("suggest/live-2-reject-note.png"), animations: "disabled" });
		await page.getByTestId(S.rejectConfirm).click();
		await expect(page.getByText("Rejected — Remove Shibuya Sky from the plan")).toBeVisible();
		await expect(skyRow).toHaveCount(0);
		await expect.poll(() => dayOfItem(page, k.sky)).toBe(k.d1); // still planned

		// Maya hears about both while online.
		await expect(maya.getByText("Dev accepted your suggestion")).toBeVisible({ timeout: 15_000 });
		await expect(maya.getByText("Dev rejected your suggestion: “We already have the tickets”")).toBeVisible({
			timeout: 15_000,
		});
		await settle(maya);
		await maya.screenshot({ path: shotPath("suggest/live-3-maya-toasts.png"), animations: "disabled" });

		// …and finds them under Mine, with the status and the note (SUG-14).
		await pill.click();
		const mine = maya.getByTestId(TESTID.reviewDrawer);
		await expect(mine).toBeVisible();
		await expect(mine.getByRole("heading", { name: "Your suggestions" })).toBeVisible();
		await expect(mine.locator('[data-filter="mine"]')).toHaveAttribute("data-state", "active");
		const accepted = mine.locator(`[data-testid="${S.row}"][data-status="accepted"]`);
		await expect(accepted).toContainText("Move Itoya Ginza to Day 1");
		await expect(accepted.getByTestId(S.status)).toContainText("Accepted by Dev");
		const rejected = mine.locator(`[data-testid="${S.row}"][data-status="rejected"]`);
		await expect(rejected.getByTestId(S.status)).toContainText("Rejected by Dev");
		await expect(rejected.getByTestId(S.status)).toContainText("We already have the tickets");
		// Her open ones can be withdrawn; she can't accept anything.
		await expect(mine.locator(`[data-testid="${S.row}"][data-status="open"]`)).toHaveCount(3);
		await expect(mine.getByTestId(S.withdraw)).toHaveCount(3);
		await expect(mine.getByTestId(S.accept)).toHaveCount(0);
		await settle(maya);
		await maya.screenshot({ path: shotPath("suggest/live-4-maya-mine.png"), animations: "disabled" });
		await mayaCtx.close();

		// Accept all: the rest of Maya's batch in one go.
		await expect(drawer.getByTestId(S.row)).toHaveCount(3);
		await settle(page);
		await page.screenshot({ path: shotPath("suggest/live-5-drawer.png"), animations: "disabled" });
		await drawer.getByTestId(S.groupAcceptAll).click();
		await expect(page.getByText(/^Accepted (3 suggestions|\d · \d needs? a look)$/)).toBeVisible();
		await expect(drawer.getByText("Nothing to review.")).toBeVisible({ timeout: 15_000 });
		await expect.poll(() => dayOfItem(page, k.knives), { timeout: 15_000 }).toBe(c.ids.days.d4);

		await expectNoHorizontalOverflow(page);
		expect(logs.messages).toEqual([]);
	});

	test("a change since the suggestion is a conflict; Accept anyway applies it (SUG-03)", async ({ page }) => {
		const logs = collectConsole(page);
		const c = await seededClone(page.request);
		const k = keys(c);
		await page.goto(`/t/${c.slug}/japan/tokyo`);
		await expectLive(page);
		await withSuggestUi(page, "live");

		// The owner moves Itoya to Day 3 first (edit mode applies directly).
		const moved = await callServerFn<Record<string, unknown>>(page, ITEMS, "moveItem", {
			itemId: k.itoya,
			dayId: k.d3,
		});
		expect(moved).not.toHaveProperty("proposed");
		await expect.poll(() => dayOfItem(page, k.itoya), { timeout: 15_000 }).toBe(k.d3);

		await page.getByRole("button", { name: "Review 5 suggestions" }).click();
		const drawer = page.getByTestId(TESTID.reviewDrawer);
		const row = drawer.getByTestId(S.row).filter({ hasText: "Move Itoya Ginza to Day 1" });
		await row.getByTestId(S.accept).click();
		const conflict = row.getByTestId(S.conflict);
		await expect(conflict).toHaveAttribute("data-reason", "changed");
		await expect(conflict).toContainText("Itoya Ginza was changed since it was suggested.");
		await expect(drawer.locator('[data-filter="conflicts"]')).toContainText("1");
		await settle(page);
		await page.screenshot({ path: shotPath("suggest/live-6-conflict.png"), animations: "disabled" });

		await conflict.getByTestId(S.acceptAnyway).click();
		await expect(page.getByText("Accepted — Move Itoya Ginza to Day 1")).toBeVisible();
		await expect.poll(() => dayOfItem(page, k.itoya), { timeout: 15_000 }).toBe(k.d1);
		await expect(row).toHaveCount(0);
		expect(logs.messages).toEqual([]);
	});

	test("an editor suggests too; the bar lists both alternatives; accepting one puts the other under Conflicts (SUG-09, SUG-16)", async ({
		page,
	}) => {
		const logs = collectConsole(page);
		const c = await seededClone(page.request);
		const k = keys(c);
		await page.goto(`/t/${c.slug}/japan/tokyo`);
		await expectLive(page);
		await withSuggestUi(page, "live");

		// Into Suggesting: the center panel gets its rule.
		await page.getByRole("button", { name: "Mode: Editing" }).click();
		await page.getByTestId(S.modeSuggesting).click();
		const ctl = page.getByTestId(TESTID.suggestModeControl).first();
		await expect(ctl).toHaveAttribute("data-mode", "suggest");
		// WP-Shell's rule (its banner row) or, without it, WP-Suggest's border.
		expect(await centerRuleWidth(page)).toBe("2px");

		// The same move as Maya's, to another day: a proposal, not a change.
		const res = await callServerFn<{ proposed?: { id: string; summary: string } }>(page, ITEMS, "moveItem", {
			itemId: k.knives,
			dayId: k.d1,
		});
		expect(res.proposed?.summary).toContain("Kama-asa (knives)");
		expect(await dayOfItem(page, k.knives)).toBe(c.ids.days.d2);

		await page.goto(`/t/${c.slug}/japan/tokyo?sel=i.${k.knives}`);
		await expectLive(page);
		await withSuggestUi(page, "live");
		await expect(page.getByTestId(TESTID.suggestModeControl).first()).toHaveAttribute("data-mode", "suggest");
		const bar = page.getByTestId(TESTID.proposalBar);
		const alts = bar.getByTestId(S.barAlternative);
		await expect(alts).toHaveCount(2, { timeout: 15_000 });
		await expect(alts.nth(0)).toContainText("Maya Chen: Move to Day 4");
		await expect(alts.nth(1)).toContainText("Dev User: Move to Day 1");
		await settle(page);
		await page.screenshot({ path: shotPath("suggest/live-7-alternatives.png"), animations: "disabled" });

		// Accept the owner's own alternative: Maya's now conflicts.
		await alts.nth(1).getByTestId(S.accept).click();
		await expect(page.getByText("Accepted — Move Kama-asa (knives) to Day 1")).toBeVisible();
		await expect.poll(() => dayOfItem(page, k.knives), { timeout: 15_000 }).toBe(k.d1);
		await ctl.getByRole("button", { name: /^Review \d+ suggestions?$/ }).click();
		const drawer = page.getByTestId(TESTID.reviewDrawer);
		await drawer.locator('[data-filter="conflicts"]').click();
		const row = drawer.getByTestId(S.row).filter({ hasText: "Move Kama-asa (knives) to Day 4" });
		await expect(row.getByTestId(S.conflict)).toContainText("Dev's suggestion for this was accepted.", {
			timeout: 15_000,
		});
		await settle(page);
		await page.screenshot({ path: shotPath("suggest/live-8-conflicts.png"), animations: "disabled" });
		await page.keyboard.press("Escape");

		// Back to Editing: the next change applies directly (SUG-09).
		await page.getByRole("button", { name: "Mode: Suggesting" }).click();
		await page.getByTestId(S.modeEditing).click();
		await expect(ctl).toHaveAttribute("data-mode", "edit");
		const direct = await callServerFn<Record<string, unknown>>(page, ITEMS, "moveItem", {
			itemId: k.sensoji,
			dayId: k.d3,
		});
		expect(direct).not.toHaveProperty("proposed");
		await expect.poll(() => dayOfItem(page, k.sensoji), { timeout: 15_000 }).toBe(k.d3);
		expect(logs.messages).toEqual([]);
	});

	test("a note addition goes through the gate; Undo withdraws it (SUG-07, SUG-12)", async ({ page }) => {
		const logs = collectConsole(page);
		const c = await cloneFixtureTrip(page.request);
		const k = keys(c);
		await page.goto(`/t/${c.slug}/japan/tokyo`);
		await expectLive(page);
		await withSuggestUi(page, "live");
		// No suggestions and editing: the control is hidden (calm by default).
		await expect(page.getByTestId(TESTID.suggestModeControl)).toHaveCount(0);

		// The editor's remembered mode (the trip-menu entry is WP-Shell's, M6).
		await page.evaluate((tripId) => localStorage.setItem(`yonder:suggest:${tripId}`, "1"), c.tripId);
		await page.goto(`/t/${c.slug}/japan/tokyo?sel=n.${k.shibuyaSky}`);
		await expectLive(page);
		await withSuggestUi(page, "live");
		const ctl = page.getByTestId(TESTID.suggestModeControl).first();
		await expect(ctl).toHaveAttribute("data-mode", "suggest");
		await expect(ctl).toContainText("Suggesting");

		await page.getByTestId(TESTID.inspector).getByRole("tab", { name: "Notes" }).click();
		await page.getByTestId(S.noteSuggestButton).click();
		await page.getByTestId(S.noteTextarea).fill("- **Sunset** slots sell out: book 4 weeks ahead");
		await page.getByTestId(S.noteSend).click();
		const toast = page.locator("[data-sonner-toast]", { hasText: "Suggested — added to the notes of Shibuya Sky" });
		await expect(toast).toBeVisible();
		const block = page.getByTestId(S.noteBlock);
		await expect(block).toBeVisible({ timeout: 15_000 });
		await expect(block.locator("strong")).toHaveText("Sunset");
		await expect(block).toContainText("Dev User suggests adding");
		await settle(page);
		await page.screenshot({ path: shotPath("suggest/live-9-note.png"), animations: "disabled" });

		// Undo on the toast withdraws it: the block goes away.
		await toast.getByRole("button", { name: "Undo" }).click();
		await expect(block).toHaveCount(0, { timeout: 15_000 });

		// Back to editing: with nothing suggested the control goes away again.
		await page.getByRole("button", { name: "Mode: Suggesting" }).click();
		await page.getByTestId(S.modeEditing).click();
		await expect(page.getByTestId(TESTID.suggestModeControl)).toHaveCount(0);
		expect(await page.evaluate((id) => localStorage.getItem(`yonder:suggest:${id}`), c.tripId)).toBeNull();
		expect(logs.messages).toEqual([]);
	});

	test("a view-link guest sees no suggestion UI (SUG-13)", async ({ browser, page }) => {
		const c = await seededClone(page.request);
		// A signed-out browser (the describe's owner session must not leak in).
		const ctx = await browser.newContext({
			viewport: { width: 1440, height: 900 },
			storageState: { cookies: [], origins: [] },
		});
		const guest = await ctx.newPage();
		await guest.goto(`/join#t=${c.shareTokens.viewer}`);
		await expect(guest).toHaveURL(new RegExp(`/t/${c.slug}`), { timeout: 20_000 });
		await expectLive(guest);
		await withSuggestUi(guest, "live");
		await guest.waitForTimeout(800);
		await expect(guest.getByTestId(TESTID.suggestModeControl)).toHaveCount(0);
		await expect(guest.getByTestId(TESTID.proposalBar)).toHaveCount(0);
		await expect(guest.getByTestId(S.ghostAccept)).toHaveCount(0);
		await expect(guest.locator("[data-suggest-ghost]")).toHaveCount(0);
		await ctx.close();
	});
});

test.describe("live, phone 390×844", () => {
	test.skip(({ isMobile }) => !isMobile, "phone layout");

	test("Maya's pill, the one-time hint and her suggestions", async ({ browser, playwright, baseURL }) => {
		const req = await playwright.request.newContext({ baseURL, storageState: storageStateOf("dev") });
		const c = await seededClone(req);
		await req.dispose();
		const ctx = await browser.newContext({
			...devices["Pixel 7"],
			viewport: { width: 390, height: 844 },
			storageState: storageStateOf("maya"),
		});
		const maya = await ctx.newPage();
		const logs = collectConsole(maya);
		await maya.goto(`/t/${c.slug}/japan/tokyo`);
		await expectLive(maya);
		await withSuggestUi(maya, "live");
		const pill = maya.getByTestId(TESTID.suggestModeControl).first();
		await expect(pill).toHaveAttribute("data-mode", "suggest");
		await expect(pill).toContainText("5");
		const hint = maya.getByTestId(S.firstHint);
		await expect(hint).toBeVisible();
		await settle(maya);
		await maya.screenshot({ path: shotPath("suggest/live-mobile-1-hint.png"), animations: "disabled" });
		await expectNoHorizontalOverflow(maya);
		await hint.getByRole("button", { name: "Got it" }).click();

		await pill.click();
		const drawer = maya.getByTestId(TESTID.reviewDrawer);
		await expect(drawer).toBeVisible();
		await expect(drawer.getByTestId(S.row)).toHaveCount(5);
		await expect(drawer.getByTestId(S.accept)).toHaveCount(0);
		await maya.waitForTimeout(600); // vaul's slide-in
		await maya.screenshot({ path: shotPath("suggest/live-mobile-2-mine.png"), animations: "disabled" });
		await expectNoHorizontalOverflow(maya);

		// Withdraw one of hers.
		const row = drawer.getByTestId(S.row).filter({ hasText: "Move Itoya Ginza to Day 1" });
		await row.getByTestId(S.withdraw).click();
		await expect(maya.getByText("Withdrawn — Move Itoya Ginza to Day 1")).toBeVisible();
		await expect(row).toHaveAttribute("data-status", "withdrawn", { timeout: 15_000 });
		expect(logs.messages).toEqual([]);
		await ctx.close();
	});
});
