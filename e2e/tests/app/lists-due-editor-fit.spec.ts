/**
 * The to-do date editor always fits the screen (WP-Lists `DueEditor`). With
 * "Before an item…" open it is ~480 px tall; for a row in the middle of a
 * short window there is room for it on neither side, and it used to run off
 * the screen (Save out of reach). Now it takes the side with more room, is
 * capped to that space and scrolls inside, with Save pinned to its bottom.
 * Desktop at 1280 × 600 and a 390 × 520 phone (a landscape-ish or
 * keyboard-shortened screen).
 */
import { expect, type Page, test } from "@playwright/test";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

const row = (page: Page, text: string | RegExp) => page.getByTestId(L.row).filter({ hasText: text });

test("the date editor fits between the row and the screen edges, and scrolls to Save", async ({ page }, info) => {
	const mobile = info.project.name === "mobile";
	const view = mobile ? { width: 390, height: 520 } : { width: 1280, height: 600 };
	await page.setViewportSize(view);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=lists`);
	await expectLive(page);
	if (mobile)
		await page.evaluate(async () => {
			const m = await import(/* @vite-ignore */ "/src/lib/workspace/ui-store.ts");
			m.useUi.getState().setSheetSnap(0.92);
		});
	await expect(page.getByTestId(TESTID.listsTab)).toBeVisible();
	const r = row(page, "Get a Suica card");
	await expect(r).toBeVisible();
	// The row mid-screen: less than the editor's height above AND below it.
	await r.evaluate((el) => el.scrollIntoView({ block: "center" }));
	await page.waitForTimeout(300);
	await r.hover();
	await r.getByTestId(L.rowMenu).click();
	await page.getByRole("menuitem", { name: /Set date/ }).click();
	const editor = page.getByTestId(L.dueEditor);
	await expect(editor).toBeVisible();
	/** The editor's box is on screen; what doesn't fit scrolls inside it. */
	const fits = async (what: string) => {
		const b = await editor.boundingBox();
		if (!b) throw new Error("no editor box");
		expect(b.y, `${what}: top on screen`).toBeGreaterThanOrEqual(0);
		expect(b.y + b.height, `${what}: bottom on screen`).toBeLessThanOrEqual(view.height + 0.5);
		const m = await editor.evaluate((el) => ({
			scrollH: el.scrollHeight,
			clientH: el.clientHeight,
			overflowY: getComputedStyle(el).overflowY,
		}));
		console.log(info.project.name, what, JSON.stringify({ b, ...m }));
		if (m.scrollH > m.clientH + 1) expect(m.overflowY, `${what}: scrolls`).toBe("auto");
		// Polish (FB round 2): on a phone the editor hangs from the ROW, so it
		// never covers the row's own title (above or below it, never on it).
		if (mobile) {
			const t = await r.getByTestId(L.rowText).first().boundingBox();
			if (!t) throw new Error("no row title");
			const overlap = Math.min(b.y + b.height, t.y + t.height) - Math.max(b.y, t.y);
			expect(overlap, `${what}: the editor covers the row's title`).toBeLessThanOrEqual(0.5);
		}
	};
	// The calendar with a time: the tallest plain form.
	await editor.getByRole("button", { name: /Add time/ }).click();
	await page.waitForTimeout(300);
	await fits("calendar + time");
	// Save stays in view while the capped editor scrolls.
	await expect(editor.getByTestId(L.dueSave)).toBeInViewport({ ratio: 1 });
	await page.screenshot({ path: shotPath(`lists/due-editor-fit-${info.project.name}-calendar.png`), animations: "disabled" });
	// A rule relative to an item.
	await editor.getByRole("button", { name: /Before/ }).click();
	await expect(editor.getByTestId(L.dueRelative)).toBeVisible();
	await page.waitForTimeout(400);
	await page.screenshot({ path: shotPath(`lists/due-editor-fit-${info.project.name}.png`), animations: "disabled" });

	await fits("before an item");
	const box = await editor.boundingBox();
	expect(box?.x ?? -1, "left on screen").toBeGreaterThanOrEqual(0);
	expect((box?.x ?? 0) + (box?.width ?? 1e4), "right on screen").toBeLessThanOrEqual(view.width + 0.5);
	// Save is reachable and works.
	const rel = editor.getByTestId(L.dueRelative);
	await rel.getByLabel("How many").fill("30");
	await rel.getByLabel("Unit").click();
	await page.getByRole("option", { name: "days before" }).click();
	await rel.getByLabel("Item").click();
	await page.getByRole("option", { name: "Kiyomizu-dera" }).click();
	const save = editor.getByTestId(L.dueSave);
	await save.scrollIntoViewIfNeeded();
	await expect(save).toBeInViewport();
	await page.screenshot({ path: shotPath(`lists/due-editor-fit-${info.project.name}-save.png`), animations: "disabled" });
	await save.click();
	await expect(editor).toBeHidden();
	await expect(r.getByTestId(L.dueChip)).toContainText(/Due/);
	await expect(r).toContainText("30 days before Kiyomizu-dera");
});
