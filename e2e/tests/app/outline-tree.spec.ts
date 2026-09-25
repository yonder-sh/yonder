/**
 * WP-Outline acceptance (SPEC §18.3, QA HIER-01/05/07/09/13): the flattened
 * sortable tree on the workspace's one DndContext.
 * - Harajuku dragged under Kyoto persists (reload) and shows in a second
 *   context; a city under a place is refused by the tree and by the server.
 * - Keyboard reorder: Space, arrows, Space, announced politely.
 * - An idea dropped on a Plan day schedules it; **A** does the same.
 * - Rename, Drop, Delete (with the affected list) and Undo from the menu.
 * - The level filter shows cities only, with the places they hide.
 * Each test clones its own trip (SPEC §18.5).
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { OUTLINE_TESTID } from "../../../src/features/outline/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

type GraphNode = { id: string; parentId: string | null; name: string; status: string };
type Win = {
	__yonder?: {
		graph: {
			nodes: GraphNode[];
			items: { id: string; nodeId: string | null; dayId: string | null }[];
			days: { id: string; date: string }[];
		};
	};
};

const outline = (page: Page) => page.getByTestId(TESTID.outline).first();
const row = (page: Page, name: string) =>
	outline(page).locator(`[role=treeitem][aria-label^="${name},"]`).first();

const nodeOf = (page: Page, id: string) =>
	page.evaluate((nid) => (window as unknown as Win).__yonder?.graph.nodes.find((n) => n.id === nid), id);

/** A mouse drag the dnd-kit MouseSensor accepts (4px activation), in steps. */
async function drag(page: Page, from: Locator, to: Locator, opts: { dx?: number; dy?: number } = {}) {
	const a = await from.boundingBox();
	const b = await to.boundingBox();
	if (!a || !b) throw new Error("no box");
	const sx = a.x + 60;
	const sy = a.y + a.height / 2;
	await page.mouse.move(sx, sy);
	await page.mouse.down();
	await page.mouse.move(sx + 2, sy + 6, { steps: 3 });
	const tx = sx + (opts.dx ?? 0);
	const ty = b.y + b.height / 2 + (opts.dy ?? 0);
	await page.mouse.move(tx, ty, { steps: 12 });
	await page.waitForTimeout(150);
	await page.mouse.move(tx, ty + 1, { steps: 2 });
	await page.mouse.up();
}

test("Harajuku dragged under Kyoto persists and shows in a second context", async ({ page, browser }, info) => {
	test.skip(info.project.name !== "chromium", "mouse drag in the xl sidebar");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const N = c.ids.nodes;
	await page.goto(`/t/${c.slug}/japan/tokyo`);
	await expectLive(page);
	await expect(row(page, "Harajuku")).toBeVisible();

	await drag(page, row(page, "Harajuku"), row(page, "Kyoto"));
	await expect.poll(async () => (await nodeOf(page, N.harajuku as string))?.parentId).toBe(N.kyoto);
	await expect(page.getByTestId("outline-live")).toHaveText("Harajuku moved into Kyoto");
	// It sits inside Kyoto (one level deeper, right under it).
	await expect(row(page, "Harajuku")).toHaveAttribute("aria-level", "3");

	// A second person sees it without reloading.
	const other = await browser.newContext({ storageState: storageStateOf("maya") });
	const p2 = await other.newPage();
	await p2.goto(`/t/${c.slug}/japan/kyoto`);
	await expectLive(p2);
	await expect(row(p2, "Harajuku")).toBeVisible();
	await expect(row(p2, "Harajuku")).toHaveAttribute("aria-level", "3");
	// Maya is looking at Kyoto: a presence dot on that row in the first context.
	await expect(row(page, "Kyoto").locator('[role=img][aria-label^="Here:"]')).toHaveAttribute(
		"aria-label",
		/Maya/,
		{ timeout: 10_000 },
	);
	await other.close();

	// And it survives a reload.
	await page.reload();
	await expectLive(page);
	await expect.poll(async () => (await nodeOf(page, N.harajuku as string))?.parentId).toBe(N.kyoto);
	expect(logs.messages).toEqual([]);
});

test("a city can't go inside a place: the tree refuses it, and so does the server", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "mouse drag in the xl sidebar");
	const c = await cloneFixtureTrip(page.request);
	const N = c.ids.nodes;
	await page.goto(`/t/${c.slug}/japan/tokyo`);
	await expectLive(page);
	// Kyoto dragged up to just under Itoya and two levels right = inside Itoya.
	const kyoto = row(page, "Kyoto");
	const a = await kyoto.boundingBox();
	const itoya = await row(page, "Itoya Ginza").boundingBox();
	if (!a || !itoya) throw new Error("no box");
	await page.mouse.move(a.x + 60, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move(a.x + 62, a.y + a.height / 2 - 6, { steps: 3 });
	await page.mouse.move(a.x + 60 + 32, itoya.y + itoya.height + 4, { steps: 12 });
	await page.waitForTimeout(150);
	await page.mouse.move(a.x + 60 + 33, itoya.y + itoya.height + 5, { steps: 2 });
	await page.screenshot({ path: shotPath("outline/drag-invalid.png"), animations: "disabled" });
	await expect(outline(page).getByText("A city can't go inside a place")).toBeVisible();
	await page.mouse.up();
	await expect(page.getByText("A city can't go inside a place").last()).toBeVisible();
	expect((await nodeOf(page, N.kyoto as string))?.parentId).toBe(N.japan);

	// The server enforces it too (and the cycle guard).
	const err = await page.evaluate(
		async ({ kyoto, itoya, tokyo }) => {
			const { moveNode } = await import("/src/functions/nodes.functions.ts");
			const out: string[] = [];
			for (const [nodeId, parentId] of [
				[kyoto, itoya],
				[tokyo, itoya],
			])
				try {
					await moveNode({ data: { nodeId, parentId } });
					out.push("ok");
				} catch (e) {
					out.push(String((e as Error).message));
				}
			return out;
		},
		{ kyoto: N.kyoto, itoya: N.itoya, tokyo: N.tokyo },
	);
	expect(err[0]).toMatch(/VALIDATION|can't go inside/);
	expect(err[1]).toMatch(/VALIDATION|inside itself/);
});

test("keyboard reorder: Space, arrow, Space — announced", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "keyboard");
	const c = await cloneFixtureTrip(page.request);
	const N = c.ids.nodes;
	await page.goto(`/t/${c.slug}/japan/tokyo`);
	await expectLive(page);
	const asakusa = row(page, "Asakusa");
	await asakusa.focus();
	await page.keyboard.press("Space");
	await page.keyboard.press("ArrowUp");
	await page.waitForTimeout(200);
	await page.keyboard.press("Space");
	// Asakusa now comes before Harajuku under Tokyo.
	await expect
		.poll(() =>
			page.evaluate(
				({ tokyo }) => {
					const g = (window as unknown as Win).__yonder?.graph;
					const kids = (g?.nodes ?? []).filter((n) => n.parentId === tokyo) as (GraphNode & { position: string })[];
					return kids.sort((x, y) => (x.position < y.position ? -1 : 1)).map((n) => n.name);
				},
				{ tokyo: N.tokyo },
			),
		)
		.toEqual(["Shibuya", "Asakusa", "Harajuku", "Itoya Ginza"]);
	await expect(page.getByTestId(OUTLINE_TESTID.live).first()).toHaveText(/Asakusa moved/);
});

test("an idea dropped on a Plan day is scheduled; A does it from the keyboard", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "xl sidebar + plan");
	const c = await cloneFixtureTrip(page.request);
	const N = c.ids.nodes;
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const ideas = page.getByTestId(TESTID.ideasBin).first();
	const tpe = ideas.getByTestId(OUTLINE_TESTID.ideaRow).filter({ hasText: "Taoyuan" });
	await expect(tpe).toBeVisible();
	const target = page.getByTestId(TESTID.timelineItem).filter({ hasText: "Hands Shibuya" }).first();
	await drag(page, tpe, target, { dx: 380 });
	const itemsOn = (nodeId: string) =>
		page.evaluate(
			(nid) => (window as unknown as Win).__yonder?.graph.items.filter((i) => i.nodeId === nid && i.dayId).length ?? 0,
			nodeId,
		);
	await expect.poll(() => itemsOn(N.tpe as string)).toBe(1);

	// A: select a day, focus an idea, press A.
	const days = await page.evaluate(() => (window as unknown as Win).__yonder?.graph.days ?? []);
	const day2 = days[1] as { id: string };
	await page.goto(`/t/${c.slug}?sel=d.${day2.id}`);
	await expectLive(page);
	const ist = page.getByTestId(TESTID.ideasBin).first().getByTestId(OUTLINE_TESTID.ideaRow).filter({ hasText: "Istanbul" });
	await ist.focus();
	await page.keyboard.press("a");
	await expect.poll(() => itemsOn(N.ist as string)).toBe(1);
	await expect(page.getByText(/Added Istanbul Airport \(IST\) to Day 2/)).toBeVisible();

	// A on a tree row works the same way.
	await page.goto(`/t/${c.slug}/japan/tokyo?sel=d.${day2.id}`);
	await expectLive(page);
	await row(page, "Itoya Ginza").focus();
	await page.keyboard.press("a");
	await expect.poll(() => itemsOn(N.itoya as string)).toBe(2);
});

test("menu: rename, drop, delete with the affected list, and Undo", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "context menu");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const N = c.ids.nodes;
	await page.goto(`/t/${c.slug}/japan/tokyo`);
	await expectLive(page);

	// Rename (F2 shows on the menu item; the inline input saves on Enter).
	await row(page, "Harajuku").click({ button: "right" });
	await page.getByRole("menuitem", { name: /Rename/ }).click();
	const input = outline(page).getByTestId(OUTLINE_TESTID.inlineInput);
	await input.fill("Harajuku & Omotesando");
	await input.press("Enter");
	await expect(row(page, "Harajuku & Omotesando")).toBeVisible();
	await expect.poll(async () => (await nodeOf(page, N.harajuku as string))?.name).toBe("Harajuku & Omotesando");
	// Esc in the menu closes it without zooming the workspace out.
	await row(page, "Shibuya").click({ button: "right" });
	await page.keyboard.press("Escape");
	await expect(page).toHaveURL(new RegExp(`/t/${c.slug}/japan/tokyo`));

	// Drop → the Dropped group; Restore from there.
	await row(page, "Asakusa").click({ button: "right" });
	await page.getByRole("menuitem", { name: "Drop" }).click();
	await expect(page.getByTestId(OUTLINE_TESTID.droppedGroup).first()).toContainText("Dropped · 1");
	await expect(row(page, "Asakusa")).toHaveCount(0);

	// Delete Shibuya: it has places and plan items, so the dialog lists them.
	await row(page, "Shibuya").click({ button: "right" });
	await page.getByRole("menuitem", { name: /Delete/ }).click();
	const dialog = page.getByTestId(OUTLINE_TESTID.deleteDialog);
	await expect(dialog).toContainText("3 places inside");
	await expect(dialog).toContainText("items on the plan");
	await page.screenshot({ path: shotPath("outline/delete-dialog.png"), animations: "disabled" });
	await dialog.getByTestId(OUTLINE_TESTID.deleteConfirm).click();
	await expect(row(page, "Shibuya")).toHaveCount(0);
	await expect.poll(async () => await nodeOf(page, N.shibuya as string)).toBeUndefined();
	await page.locator("[data-sonner-toast]", { hasText: "Shibuya deleted" }).getByRole("button", { name: "Undo" }).click();
	await expect(row(page, "Shibuya")).toBeVisible();
	await expect.poll(async () => (await nodeOf(page, N.hands as string))?.parentId).toBe(N.shibuya);
	expect(logs.messages).toEqual([]);
});

test("Add inside… from ⋯ or right-click: what you type lands in the new field (HIER-01)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "hover menu and context menu");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan`);
	await expectLive(page);
	const input = outline(page).getByTestId(OUTLINE_TESTID.inlineInput);

	// ⋯ → Add inside…: the caret stays in "Inside Kyoto…" once the menu has
	// closed (Radix used to hand it back to "More for Kyoto").
	const kyoto = row(page, "Kyoto");
	await kyoto.hover();
	await kyoto.getByTestId(OUTLINE_TESTID.rowMenu).click();
	await page.getByRole("menuitem", { name: /Add inside/ }).click();
	await expect(input).toHaveAttribute("placeholder", "Inside Kyoto…");
	await page.waitForTimeout(400); // past the menu's exit animation
	await expect(input).toBeFocused();
	await page.keyboard.type("Gion");
	await expect(input).toHaveValue("Gion");
	await page.keyboard.press("Enter");
	await expect(row(page, "Gion")).toBeVisible();

	// Right-click → Add inside…: the letters don't run the row typeahead.
	await row(page, "Tokyo").click({ button: "right" });
	await page.getByRole("menuitem", { name: /Add inside/ }).click();
	await page.waitForTimeout(400);
	await expect(input).toBeFocused();
	await page.keyboard.type("Zz");
	await expect(input).toHaveValue("Zz");
	await page.keyboard.press("Escape");
	await expect(input).toHaveCount(0);
	expect(logs.messages).toEqual([]);
});

test("the level filter shows cities only, with the places they hide (HIER-07)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "xl sidebar");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo`);
	await expectLive(page);
	await outline(page).getByTestId(OUTLINE_TESTID.headerMenu).click();
	await page.getByRole("menuitemradio", { name: "Cities" }).click();
	await expect(row(page, "Shibuya")).toHaveCount(0);
	await expect(row(page, "Tokyo")).toContainText("7");
	await outline(page).getByRole("button", { name: "Show everything" }).click();
	await expect(row(page, "Shibuya")).toBeVisible();
});

test("released over empty sidebar space, a dragged row goes nowhere (no stray plan item)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "mouse drag in the xl sidebar");
	const c = await cloneFixtureTrip(page.request);
	const N = c.ids.nodes;
	await page.goto(`/t/${c.slug}/japan/tokyo`);
	await expectLive(page);
	const count = () =>
		page.evaluate(
			(nid) => (window as unknown as Win).__yonder?.graph.items.filter((i) => i.nodeId === nid).length ?? -1,
			N.itoya as string,
		);
	const before = await count();
	// The empty space under the last row (above the Ideas bin).
	const last = await row(page, "Newark").boundingBox();
	const ideas = await page.getByTestId(TESTID.ideasBin).first().boundingBox();
	if (!last || !ideas) throw new Error("no box");
	const src = await row(page, "Itoya Ginza").boundingBox();
	if (!src) throw new Error("no box");
	const sx = src.x + 60;
	await page.mouse.move(sx, src.y + src.height / 2);
	await page.mouse.down();
	await page.mouse.move(sx + 2, src.y + src.height / 2 + 6, { steps: 3 });
	const ty = (last.y + last.height + ideas.y) / 2;
	await page.mouse.move(sx, ty, { steps: 12 });
	await page.waitForTimeout(150);
	await page.mouse.up();
	await page.waitForTimeout(500);
	expect(await count()).toBe(before);
	expect((await nodeOf(page, N.itoya as string))?.parentId).toBe(N.tokyo);
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("the tree's expand state follows the account to another device (ADDENDUM §7.2)", async ({ page, browser }, info) => {
	test.skip(info.project.name !== "chromium", "one run");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const kyoto = row(page, "Kyoto");
	await expect(kyoto).toHaveAttribute("aria-expanded", "false");
	await kyoto.focus();
	await page.keyboard.press("ArrowRight");
	await expect(kyoto).toHaveAttribute("aria-expanded", "true");
	// Synced per trip after a short debounce.
	await expect
		.poll(
			() =>
				page.evaluate(async (tripId) => {
					const { getUserPrefs } = await import("/src/functions/prefs.functions.ts");
					const p = (await getUserPrefs()) as { treeExpanded?: Record<string, string[]> };
					return p.treeExpanded?.[tripId]?.length ?? 0;
				}, c.tripId),
			{ timeout: 10_000 },
		)
		.toBeGreaterThan(0);

	// A second device: a fresh browser context, so no localStorage.
	const other = await browser.newContext({ storageState: storageStateOf("dev") });
	const p2 = await other.newPage();
	await p2.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(p2);
	await expect(row(p2, "Kyoto")).toHaveAttribute("aria-expanded", "true");
	await expect(row(p2, "Kiyomizu-dera")).toBeVisible();
	await other.close();
});
