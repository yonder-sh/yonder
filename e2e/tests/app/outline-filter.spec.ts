/**
 * The shared place filter on the Outline and Ideas (ADDENDUM §10): category
 * group, minimum priority (max of all / one member), unrated by me, not
 * scheduled; kept in the URL (`?f=`) so it survives a reload and is a deep
 * link. Also the guest (view link) rules and the layouts: the xl sidebar,
 * the lg popover, and the 390 px drawer with 44 px rows. Screenshots go to
 * `e2e/shots/outline/`.
 */
import { expect, type Page, test } from "@playwright/test";
import { OUTLINE_TESTID } from "../../../src/features/outline/testids";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive, expectNoHorizontalOverflow, openOrganize } from "./_helpers/page";
import { openLink } from "./_helpers/link";

test.use({ storageState: storageStateOf("dev") });

const outline = (page: Page) => page.getByTestId(TESTID.outline).first();
const rowNames = (page: Page) =>
	outline(page)
		.locator("[role=treeitem][data-testid=outline-row]")
		.evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") ?? "").split(",")[0]));

/** Rates a node as the signed-in member through the real server function. */
async function rate(page: Page, nodeId: string, memberId: string, priority: string) {
	const res = await page.evaluate(
		async (d) => {
			const { setNodePriority } = await import("/src/functions/nodes.functions.ts");
			try {
				await setNodePriority({ data: d });
				return "ok";
			} catch (e) {
				return String((e as Error).message);
			}
		},
		{ nodeId, memberId, priority },
	);
	expect(res).toBe("ok");
}

test("the filter narrows the tree and Ideas, lives in the URL, and survives a reload", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "xl sidebar");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const N = c.ids.nodes;
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	await rate(page, N.tpe as string, c.members.owner, "must");
	await rate(page, N.hands as string, c.members.owner, "want");
	// This tab skips its own live events; the ratings arrive with a reload.
	await page.reload();
	await expectLive(page);
	await openOrganize(page);

	// Category: Shopping.
	await outline(page).getByTestId(OUTLINE_TESTID.filterButton).click();
	const panel = page.getByTestId(OUTLINE_TESTID.filterPanel);
	await panel.locator("[data-testid=place-filter-group][data-group=shopping]").click();
	await expect(page).toHaveURL(/[?&]f=g%3Ashopping/);
	await page.screenshot({ path: shotPath("outline/filter-panel-1440.png"), animations: "disabled" });
	await page.keyboard.press("Escape");
	// Esc closed the popover only: still at the trip root, filter kept.
	await expect(page).toHaveURL(new RegExp(`/t/${c.slug}\\?.*f=`));
	await expect(outline(page).getByTestId(OUTLINE_TESTID.filterSummary)).toContainText("Shopping");
	const names = await rowNames(page);
	expect(names).toContain("Hands Shibuya");
	expect(names).toContain("Itoya Ginza");
	expect(names).not.toContain("Kyoto");
	expect(names).not.toContain("Seoul");

	// Not on the plan yet + priority: the airport ideas remain, rated only.
	await outline(page).getByTestId(OUTLINE_TESTID.filterSummary).getByRole("button", { name: "Clear filter" }).click();
	await expect(page).not.toHaveURL(/[?&]f=/);
	await outline(page).getByTestId(OUTLINE_TESTID.filterButton).click();
	await panel.getByTestId(OUTLINE_TESTID.filterMinPriority).click();
	await page.getByRole("option", { name: "Really want or higher" }).click();
	await expect(page).toHaveURL(/f=p%3Areally_want/);
	await expect(page.locator("[data-slot=select-content]")).toHaveCount(0);
	await expect(panel.getByTestId(OUTLINE_TESTID.filterPriorityOf)).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(panel).toBeHidden();
	await expect.poll(() => rowNames(page)).toEqual(["Taiwan", "Taipei", "Taoyuan (TPE)"]);
	const ideas = page.getByTestId(PLAN_TESTID.ideas);
	await expect(ideas.getByTestId(OUTLINE_TESTID.ideaRow)).toHaveCount(1);
	await expect(ideas.getByTestId(OUTLINE_TESTID.ideasCount)).toHaveText("1 of 3");
	await expect(ideas.getByTestId(OUTLINE_TESTID.ideaRow)).toContainText("Must");
	await page.screenshot({ path: shotPath("outline/filtered-1440.png"), animations: "disabled" });

	// A deep link: reload keeps it.
	await page.reload();
	await expectLive(page);
	await openOrganize(page);
	await expect.poll(() => rowNames(page)).toEqual(["Taiwan", "Taipei", "Taoyuan (TPE)"]);

	// Unrated by me: Hands and TPE are rated by me, so they drop out.
	await page.goto(`/t/${c.slug}/japan/tokyo?f=u%3Ame`);
	await expectLive(page);
	await openOrganize(page);
	const tokyoNames = await rowNames(page);
	expect(tokyoNames).not.toContain("Hands Shibuya");
	expect(tokyoNames).toContain("Shibuya Loft");
	expect(logs.messages).toEqual([]);
});

test("a guest with the view link browses, and every edit affordance is disabled", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "one run");
	const owner = await browser.newContext({ storageState: storageStateOf("dev") });
	const op = await owner.newPage();
	const c = await cloneFixtureTrip(op.request);
	await owner.close();
	// No session: `test.use({ storageState })` would otherwise apply here too.
	const guestCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const guest = await guestCtx.newPage();
	await openLink(guest, c.slug, "viewer");
	await expect(guest.getByTestId(TESTID.workspace)).toBeVisible({ timeout: 20_000 });
	await expectLive(guest);
	await openOrganize(guest);
	await expect(outline(guest).getByRole("button", { name: "Add a place" })).toBeDisabled();
	const tokyo = outline(guest).locator('[role=treeitem][aria-label^="Tokyo,"]');
	await tokyo.click({ button: "right" });
	await expect(guest.getByRole("menuitem", { name: /Open Tokyo/ })).toBeEnabled();
	await expect(guest.getByRole("menuitem", { name: /Rename/ })).toBeDisabled();
	await expect(guest.getByRole("menuitem", { name: /Delete/ })).toBeDisabled();
	await expect(guest.getByRole("menuitem", { name: /My rating/ })).toHaveCount(0);
	await guest.keyboard.press("Escape");
	// The closing menu hands focus back to the row, which would dismiss a popover opened meanwhile.
	await expect(guest.getByRole("menu")).toHaveCount(0);
	// The filter still works for guests (reading, not writing).
	await outline(guest).getByTestId(OUTLINE_TESTID.filterButton).click();
	await expect(guest.getByTestId(OUTLINE_TESTID.filterPanel)).toBeVisible();
	await expect(guest.getByTestId(OUTLINE_TESTID.filterUnratedBy)).toBeVisible();
	await guestCtx.close();
});

test("layouts: Organize places on the desktop, a tablet and the phone (44px rows); the Plan's ideas", async ({
	page,
}, info) => {
	const c = await cloneFixtureTrip(page.request);
	if (info.project.name === "chromium") {
		await page.goto(`/t/${c.slug}/japan/tokyo`);
		await expectLive(page);
		await openOrganize(page);
		await expect(outline(page)).toBeVisible();
		await page.screenshot({ path: shotPath("outline/organize-1440.png"), animations: "disabled" });
		await page.keyboard.press("Escape");
		// The trip root: unrated ideas get a quiet "–", never a dashed pill.
		await page.goto(`/t/${c.slug}?tab=plan`);
		await expectLive(page);
		const ideas = page.getByTestId(PLAN_TESTID.ideas);
		await expect(ideas.getByTestId(OUTLINE_TESTID.ideaRow).first()).toBeVisible();
		await expect(ideas.locator(".border-dashed")).toHaveCount(0);
		await page.screenshot({ path: shotPath("outline/ideas-1440.png"), animations: "disabled" });
		await page.setViewportSize({ width: 1100, height: 800 });
		await openOrganize(page);
		await expect(outline(page)).toBeVisible();
		await page.screenshot({ path: shotPath("outline/organize-1100.png"), animations: "disabled" });
		await expectNoHorizontalOverflow(page);
		return;
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=plan`);
	await expectLive(page);
	await openOrganize(page);
	const tree = outline(page);
	await expect(tree).toBeVisible();
	// Measured once the dialog has zoomed in.
	await expect
		.poll(async () => (await tree.locator('[role=treeitem][aria-label^="Tokyo,"]').boundingBox())?.height ?? 0)
		.toBeGreaterThanOrEqual(44);
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: shotPath("outline/organize-390.png"), animations: "disabled" });
	await page.keyboard.press("Escape");
	// The ideas are the Plan's, under its days.
	await expect(page.getByTestId(PLAN_TESTID.ideas)).toHaveCount(1);
	await page.getByTestId(PLAN_TESTID.ideas).scrollIntoViewIfNeeded();
	await page.screenshot({ path: shotPath("outline/ideas-390.png"), animations: "disabled" });
});
