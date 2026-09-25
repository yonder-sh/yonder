/**
 * WP-Suggest (EXTENSIONS §3.7, QA SUG): the suggestion review UI on the
 * fixture trip (`/dev/fixture`: the fixture's 7 proposals — Maya's batch, a
 * guest's flight change, Audrey's stacked alternative — as the owner):
 * control, drawer, Show → bar, stacked alternatives, overview, suggest mode,
 * note blocks, and the phone layout. The live flows (accept, reject, conflicts,
 * the author's view) are in `suggest-live.spec.ts`.
 *
 * The components load through the dev harness until the owners mount them
 * (`suggest-helpers.ts`). `ProposalOverview` (`sel=p.<id>`) is already
 * mounted by the inspector.
 */
import { expect, test } from "@playwright/test";
import { SUGGEST_TESTID as S } from "../../../src/features/suggest/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath } from "./_helpers/env";
import { collectConsole, expectNoHorizontalOverflow } from "./_helpers/page";
import { centerRuleWidth, graphOf, itemIdByName, settle, withSuggestUi } from "./suggest-helpers";

/** Fixture proposal ids: `uuid(0x5000 + n)` in the demo fixture. */
const pid = (n: number) => `00000000-0000-7000-8000-${(0x5000 + n).toString(16).padStart(12, "0")}`;
const ITOYA_MOVE = pid(2);
const TRIP_SHIFT = pid(4);

test.describe("fixture: reviewing suggestions (desktop 1440×900)", () => {
	test.skip(({ isMobile }) => isMobile, "desktop layout");

	test("control → drawer → Show → bar; stacked alternatives; overview; suggest mode", async ({ page }) => {
		const logs = collectConsole(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto("/dev/fixture/japan/tokyo");
		const harness = await withSuggestUi(page, "fixture");

		// The control: editors see "Editing ▾" and the open count.
		const ctl = page.getByTestId(TESTID.suggestModeControl).first();
		await expect(ctl).toBeVisible();
		await expect(ctl).toHaveAttribute("data-mode", "edit");
		await expect(ctl).toContainText("Editing");
		await settle(page);
		await page.screenshot({ path: shotPath("suggest/desktop-1-control.png"), animations: "disabled" });

		// The drawer: grouped by author batch, with Accept / Reject and Show.
		await page.getByRole("button", { name: /^Review \d+ suggestions?$/ }).first().click();
		const drawer = page.getByTestId(TESTID.reviewDrawer);
		await expect(drawer).toBeVisible();
		const groups = drawer.getByTestId(S.group);
		await expect(groups.first()).toContainText("Maya");
		expect(await groups.count()).toBeGreaterThanOrEqual(3);
		const itoyaRow = drawer.locator(`[data-testid="${S.row}"][data-proposal-id="${ITOYA_MOVE}"]`);
		await expect(itoyaRow).toContainText("Move Itoya Ginza to Day 1");
		await expect(itoyaRow.getByTestId(S.accept)).toBeVisible();
		await settle(page);
		await page.screenshot({ path: shotPath("suggest/desktop-2-drawer.png"), animations: "disabled" });

		// Filters: Mine is empty for the owner (one line, no illustration).
		await drawer.locator('[data-filter="mine"]').click();
		await expect(drawer.getByText("You haven't suggested anything yet.")).toBeVisible();
		await drawer.locator('[data-filter="open"]').click();

		// Show: selects the item, closes the drawer, the bar names the suggestion.
		await itoyaRow.getByTestId(S.show).click();
		await expect(drawer).toBeHidden();
		const itoya = await itemIdByName(page, "Itoya Ginza");
		await expect(page).toHaveURL(new RegExp(`sel=i\\.${itoya}`));
		const bar = page.getByTestId(TESTID.proposalBar);
		await expect(bar).toContainText("Suggested by Maya");
		await expect(bar).toContainText("Move to Day 1");
		await expect(bar.getByTestId(S.accept)).toBeVisible();
		await settle(page);
		await page.screenshot({ path: shotPath("suggest/desktop-3-bar.png"), animations: "disabled" });

		// Ghost ✓/✕ on the Plan card (hover), as ProposalGhost will draw them.
		if (harness) {
			const card = page.locator(`[data-testid="${TESTID.timelineItem}"]`, { hasText: "Itoya Ginza" }).first();
			await card.hover();
			await expect(page.getByTestId(S.ghostAccept).first()).toBeVisible();
			await page.screenshot({ path: shotPath("suggest/desktop-4-ghost.png"), animations: "disabled" });
		}

		// Two people moved the knife shop: the bar lists both alternatives.
		const knives = await itemIdByName(page, "Kama-asa (knives)");
		await page.goto(`/dev/fixture/japan/tokyo?sel=i.${knives}`);
		await withSuggestUi(page, "fixture");
		const alts = page.getByTestId(S.barAlternative);
		await expect(alts).toHaveCount(2);
		await expect(alts.nth(0)).toContainText("Maya: Move to Day 4");
		await expect(alts.nth(1)).toContainText("Audrey: Move to Day 1");
		await settle(page);
		await page.screenshot({ path: shotPath("suggest/desktop-5-alternatives.png"), animations: "disabled" });

		// The overview of one suggestion (sel=p.<id>): before → after.
		await page.goto(`/dev/fixture/japan/tokyo?sel=p.${ITOYA_MOVE}`);
		const overview = page.getByTestId(TESTID.proposalOverview);
		await expect(overview).toContainText("Move Itoya Ginza to Day 1");
		const dayRow = overview.locator(`[data-testid="${S.fieldRow}"][data-field="dayId"]`);
		await expect(dayRow).toContainText("Day 2");
		await expect(dayRow).toContainText("Day 1");
		await settle(page);
		await page.screenshot({ path: shotPath("suggest/desktop-6-overview.png"), animations: "disabled" });

		// A trip shift lists what moves.
		await page.goto(`/dev/fixture?sel=p.${TRIP_SHIFT}`);
		await expect(page.getByTestId(TESTID.proposalOverview)).toContainText("Shift the trip +1 day");
		await expect(page.getByTestId(TESTID.dateImpactList)).toBeAttached();

		// Suggest mode: the menu switches, the center panel gets its rule.
		await page.goto("/dev/fixture/japan/tokyo");
		await withSuggestUi(page, "fixture");
		await page.getByRole("button", { name: "Mode: Editing" }).click();
		await page.getByTestId(S.modeSuggesting).click();
		await expect(page.getByTestId(TESTID.suggestModeControl).first()).toHaveAttribute("data-mode", "suggest");
		// WP-Shell's rule (its banner row) or, without it, WP-Suggest's border.
		expect(await centerRuleWidth(page)).toBe("2px");
		await settle(page);
		await page.screenshot({ path: shotPath("suggest/desktop-7-suggesting.png"), animations: "disabled" });
		await page.getByRole("button", { name: "Mode: Suggesting" }).click();
		await page.getByTestId(S.modeEditing).click();
		await expect(page.getByTestId(TESTID.suggestModeControl).first()).toHaveAttribute("data-mode", "edit");

		await expectNoHorizontalOverflow(page);
		expect(logs.messages).toEqual([]);
	});

	test("note additions render as Markdown under the note (harness data)", async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto("/dev/fixture/japan/tokyo");
		await page.waitForFunction(() => !!(window as unknown as { __yonder?: unknown }).__yonder);
		const g = await graphOf(page);
		const sky = g.nodes.find((n) => n.name === "Shibuya Sky");
		await page.goto(`/dev/fixture/japan/tokyo?sel=n.${sky?.id}`);
		const harness = await withSuggestUi(page, "fixture");
		test.skip(!harness, "the fixture has no note.append; the harness adds one");
		await page.getByTestId(TESTID.inspector).getByRole("tab", { name: "Notes" }).click();
		const block = page.getByTestId(S.noteBlock);
		await expect(block).toBeVisible();
		await expect(block.locator("strong")).toHaveText("Sunset slots sell out");
		await expect(block.getByTestId(S.noteInsert)).toBeDisabled(); // no editor in the stub
		await settle(page);
		await page.screenshot({ path: shotPath("suggest/desktop-8-note.png"), animations: "disabled" });
	});
});

test.describe("fixture: mobile 390×844", () => {
	test.skip(({ isMobile }) => !isMobile, "phone layout");

	test("the pill opens the drawer; the overview fits", async ({ page }) => {
		const logs = collectConsole(page);
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto("/dev/fixture/japan/tokyo");
		await withSuggestUi(page, "fixture");
		const ctl = page.getByTestId(TESTID.suggestModeControl).first();
		await expect(ctl).toBeVisible();
		await settle(page);
		await page.screenshot({ path: shotPath("suggest/mobile-1-pill.png"), animations: "disabled" });
		await expectNoHorizontalOverflow(page);

		// The editor's compact control opens the mode menu; Review… opens the drawer.
		await ctl.click();
		await page.getByTestId(S.reviewOpen).click();
		const drawer = page.getByTestId(TESTID.reviewDrawer);
		await expect(drawer).toBeVisible();
		await expect(drawer.getByTestId(S.row).first()).toBeVisible();
		await page.waitForTimeout(600); // vaul's slide-in
		await page.screenshot({ path: shotPath("suggest/mobile-2-drawer.png"), animations: "disabled" });
		await expectNoHorizontalOverflow(page);

		// Show closes the drawer and selects the item.
		await drawer
			.locator(`[data-testid="${S.row}"][data-proposal-id="${ITOYA_MOVE}"]`)
			.getByTestId(S.show)
			.click();
		await expect(drawer).toBeHidden();
		await expect(page).toHaveURL(/sel=i\./);

		await page.goto(`/dev/fixture/japan/tokyo?sel=p.${ITOYA_MOVE}`);
		const overview = page.getByTestId(TESTID.proposalOverview);
		await expect(overview).toBeVisible();
		await page.waitForTimeout(600);
		await page.screenshot({ path: shotPath("suggest/mobile-3-overview.png"), animations: "disabled" });
		await expectNoHorizontalOverflow(page);
		expect(logs.messages).toEqual([]);
	});
});
