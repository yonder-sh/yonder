/**
 * WP-Outline E7 marks (EXTENSIONS §1.4, §3.7) on a real clone: Maya is a
 * suggester (`mayaRole: "suggester"`) and her demo suggestions go through
 * the real propose path (`proposals: true`).
 * - Her proposed Nishiki Market is a dashed row under Kyoto, in the tree and
 *   in Kyoto's Ideas, in her colour.
 * - Her drag of Itoya Ginza into Kyoto is a suggestion, not a move: the
 *   server graph keeps Itoya under Tokyo, and Dennis (a reviewer) sees, live,
 *   Itoya drawn inside Kyoto plus a dashed origin row at Tokyo
 *   ("Itoya Ginza → Kyoto · Maya") that selects it.
 * - Dennis can't drag Maya's proposed place ("review it first").
 * Screenshots: `e2e/shots/outline/suggest-*.png`.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { OUTLINE_TESTID } from "../../../src/features/outline/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

type Win = {
	__yonder?: { graph: { nodes: { id: string; parentId: string | null; name: string }[] } };
};

const outline = (page: Page) => page.getByTestId(TESTID.outline).first();
const row = (page: Page, name: string) =>
	outline(page).locator(`[role=treeitem][aria-label^="${name},"]`).first();
const serverParentOf = (page: Page, id: string) =>
	page.evaluate((nid) => (window as unknown as Win).__yonder?.graph.nodes.find((n) => n.id === nid)?.parentId, id);

async function drag(page: Page, from: Locator, to: Locator) {
	const a = await from.boundingBox();
	const b = await to.boundingBox();
	if (!a || !b) throw new Error("no box");
	const sx = a.x + 60;
	const sy = a.y + a.height / 2;
	await page.mouse.move(sx, sy);
	await page.mouse.down();
	await page.mouse.move(sx + 2, sy + 6, { steps: 3 });
	const ty = b.y + b.height / 2;
	await page.mouse.move(sx, ty, { steps: 12 });
	await page.waitForTimeout(150);
	await page.mouse.move(sx, ty + 1, { steps: 2 });
	await page.mouse.up();
}

test("E7: proposed places and moves show as ghosts with an origin row, live for the reviewer", async ({
	page,
	browser,
}, info) => {
	test.skip(info.project.name !== "chromium", "mouse drag in the xl sidebar");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request, { mayaRole: "suggester", proposals: true });
	const N = c.ids.nodes;
	expect(c.proposals?.ids.length ?? 0).toBeGreaterThan(0);

	// Dennis (owner = reviewer) in Kyoto: Maya's Nishiki Market is a dashed row.
	await page.goto(`/t/${c.slug}/japan/kyoto`);
	await expectLive(page);
	const nishiki = row(page, "Nishiki Market");
	await expect(nishiki).toBeVisible();
	await expect(nishiki.locator("xpath=..")).toHaveAttribute("data-proposed", "create");
	// The description sits on the treeitem: a tree owns only items (axe).
	await expect(nishiki).toHaveAttribute("aria-description", /Suggested by Maya/);
	await expect(nishiki.locator("xpath=..")).not.toHaveAttribute("aria-description");
	// … and it sorts into Kyoto's Ideas like any other place, marked as suggested.
	const idea = page.getByTestId(TESTID.ideasBin).first().getByTestId(OUTLINE_TESTID.ideaRow).filter({ hasText: "Nishiki Market" });
	await expect(idea).toHaveAttribute("aria-label", /suggested/);
	await expect(idea).toHaveAttribute("aria-description", /Suggested by Maya/);
	await expect(idea.locator("xpath=..")).toHaveAttribute("data-proposed", "create");
	await expect(idea.locator("xpath=..")).not.toHaveAttribute("aria-description");

	// Dennis can't move Maya's proposed place: it isn't real yet.
	await drag(page, nishiki, row(page, "Mt. Fuji"));
	await expect(page.getByText("Suggested by Maya — review it first").first()).toBeVisible();

	// Dennis now looks at Tokyo while Maya works.
	await page.goto(`/t/${c.slug}/japan/tokyo`);
	await expectLive(page);
	await expect(row(page, "Itoya Ginza")).toBeVisible();

	// Maya (suggester) drags Itoya Ginza into Kyoto: a suggestion, not a move.
	const maya = await browser.newContext({ storageState: storageStateOf("maya") });
	const mp = await maya.newPage();
	await mp.goto(`/t/${c.slug}/japan/tokyo`);
	await expectLive(mp);
	await drag(mp, row(mp, "Itoya Ginza"), row(mp, "Kyoto"));
	await expect(mp.locator("[data-sonner-toast]", { hasText: /Suggested/ }).first()).toBeVisible();
	expect(await serverParentOf(mp, N.itoya as string)).toBe(N.tokyo);

	// Dennis, live (no reload): a dashed trace at Tokyo, Itoya's old parent.
	const origin = outline(page).getByTestId(OUTLINE_TESTID.originRow);
	await expect(origin).toHaveCount(1, { timeout: 10_000 });
	await expect(origin).toHaveAttribute("aria-label", "Itoya Ginza suggested to move to Kyoto by Maya");
	await expect(origin).toContainText("Maya");
	// The trace sits among Tokyo's children (one level deeper than Tokyo).
	await expect(origin).toHaveAttribute("aria-level", "3");
	await expect(row(page, "Itoya Ginza")).toHaveCount(0);
	await page.screenshot({ path: shotPath("outline/suggest-origin-1440.png"), animations: "disabled" });

	// A click selects the moved place, drawn (dashed) inside Kyoto.
	await origin.click();
	await expect(page).toHaveURL(new RegExp(`sel=n\\.${N.itoya}`));
	const itoya = row(page, "Itoya Ginza");
	await expect(itoya).toBeVisible();
	await expect(itoya.locator("xpath=..")).toHaveAttribute("data-proposed", "move");
	expect(await serverParentOf(page, N.itoya as string)).toBe(N.tokyo);
	await page.screenshot({ path: shotPath("outline/suggest-move-1440.png"), animations: "disabled" });

	await maya.close();
	expect(logs.messages).toEqual([]);
});
