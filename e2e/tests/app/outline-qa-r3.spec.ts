/**
 * WP-Outline round-3 fixes (owner feedback FB-05, QA PLAN-R3-01):
 * - "Add inside…" from a row's ⋯ menu opens the inline input and keeps it,
 *   even when the new row lands below the Outline's fold (focusing it scrolls
 *   the Outline while the closing menu is still under the pointer).
 * - The Ideas header's "Open in Places →" (docs/PLACES.md §5; it was "Rate
 *   ideas →" to the old Rate screen) opens the Places tab on its Ideas pill,
 *   with the current filter and in the current scope.
 * Each test clones its own trip and signs in through the API itself (no
 * shared storageState). Screenshots go to `e2e/shots/outline/`.
 */
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { OUTLINE_TESTID } from "../../../src/features/outline/testids";
import { PLACES_TAB_TESTID as PT } from "../../../src/features/places/tab/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";
import { openLink } from "./_helpers/link";

test.describe.configure({ mode: "default" });

const outline = (page: Page) => page.getByTestId(TESTID.outline).first();

test.beforeEach(async ({ page }) => {
	await loginViaApi(page.request, "dev@example.com", { first: "Dev", last: "User" });
});

/**
 * Two rateable ideas under Kyoto (the demo's own ideas are airports, which the
 * Places tab doesn't list), through the real server function; then a reload.
 */
async function addIdeas(page: Page, tripId: string, kyotoId: string) {
	await page.evaluate(
		async ({ tripId, parentId, ids }) => {
			const m = await import("/src/functions/nodes.functions.ts");
			await m.createNode({
				data: { tripId, parentId, id: ids[0], type: "place", category: "food_drink", name: "Nishiki Market" },
			});
			await m.createNode({
				data: { tripId, parentId, id: ids[1], type: "place", category: "temple_shrine", name: "Fushimi Inari" },
			});
		},
		{ tripId, parentId: kyotoId, ids: [randomUUID(), randomUUID()] },
	);
	await page.reload();
	await expectLive(page);
}

/** The Outline's scroller: the nearest scrollable ancestor of its tree. */
async function scroller(page: Page) {
	return outline(page)
		.locator("[role=tree]")
		.first()
		.evaluateHandle((tree) => {
			let el: HTMLElement | null = tree as HTMLElement;
			while (el && !(el.scrollHeight > el.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)))
				el = el.parentElement;
			return el;
		});
}

test("PLAN-R3-01: 'Add inside…' on a row near the fold opens the input and keeps it", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "xl sidebar, mouse path");
	// A short window so the tree overflows and the new row lands below the fold.
	await page.setViewportSize({ width: 1440, height: 560 });
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);

	// The lowest visible row that has children: its new last child is off-screen.
	const box = await (await scroller(page)).evaluate((el) => {
		const s = (el as HTMLElement).getBoundingClientRect();
		return { top: s.top, bottom: s.bottom };
	});
	const rows = outline(page).locator("[role=treeitem][data-testid=outline-row][aria-expanded]");
	const n = await rows.count();
	let target: string | null = null;
	for (let i = n - 1; i >= 0; i--) {
		const r = rows.nth(i);
		const b = await r.boundingBox();
		if (b && b.y + b.height <= box.bottom - 4 && b.y >= box.top) {
			target = (await r.getAttribute("aria-label"))?.split(",")[0] ?? null;
			break;
		}
	}
	expect(target, "a row with children above the fold").not.toBeNull();
	const row = outline(page).locator(`[role=treeitem][aria-label^="${target},"]`).first();

	// Record every focus change from the click on, to explain a failure.
	await page.evaluate(() => {
		const w = window as unknown as { __focusTrace: string[] };
		w.__focusTrace = [];
		document.addEventListener(
			"focusin",
			(e) => {
				const t = e.target as HTMLElement;
				w.__focusTrace.push(`${t.tagName}${t.getAttribute("role") ? `[${t.getAttribute("role")}]` : ""} ${t.getAttribute("aria-label") ?? t.textContent?.slice(0, 30) ?? ""}`);
			},
			true,
		);
	});

	await row.hover();
	await row.getByTestId(OUTLINE_TESTID.rowMenu).click();
	const item = page.getByRole("menuitem", { name: /Add inside/ });
	await expect(item).toBeVisible();
	await page.waitForTimeout(300);
	const bb = await item.boundingBox();
	if (!bb) throw new Error("no menu item");
	// The pointer stays on the item while the menu closes (the QA repro).
	await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 4 });
	await page.mouse.down();
	await page.mouse.up();

	const input = page.getByTestId(OUTLINE_TESTID.inlineInput);
	// Still there and focused well after the menu's exit animation.
	await page.waitForTimeout(1200);
	const trace = await page.evaluate(() => (window as unknown as { __focusTrace: string[] }).__focusTrace);
	await expect(input, `focus trace: ${trace.join(" → ")}`).toBeVisible();
	await expect(input).toHaveAttribute("aria-label", `New place inside ${target}`);
	await expect(input).toBeFocused();
	await expect(page.getByRole("menu")).toHaveCount(0);
	// On screen inside the Outline's scroller.
	const ib = await input.boundingBox();
	const sb = await (await scroller(page)).evaluate((el) => {
		const s = (el as HTMLElement).getBoundingClientRect();
		return { top: s.top, bottom: s.bottom };
	});
	expect(ib && ib.y >= sb.top - 1 && ib.y + ib.height <= sb.bottom + 1).toBe(true);
	await page.screenshot({ path: shotPath("outline/r3-add-inside-below-fold.png"), animations: "disabled" });

	// Typing works, Enter creates the place under the target.
	await input.pressSequentially("Hidden gem R3");
	await input.press("Enter");
	await expect(outline(page).locator('[role=treeitem][aria-label^="Hidden gem R3,"]')).toBeVisible();
	expect(logs.messages).toEqual([]);
});

test("PLAN-R3-01: the keyboard path (Enter on the item) keeps the input too", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "xl sidebar");
	await page.setViewportSize({ width: 1440, height: 560 });
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const rows = outline(page).locator("[role=treeitem][data-testid=outline-row][aria-expanded]");
	const last = rows.last();
	await last.scrollIntoViewIfNeeded();
	const name = (await last.getAttribute("aria-label"))?.split(",")[0] ?? "";
	await last.hover();
	await last.getByTestId(OUTLINE_TESTID.rowMenu).click();
	const item = page.getByRole("menuitem", { name: /Add inside/ });
	await expect(item).toBeVisible();
	// Leave the pointer resting on the menu, then choose with the keyboard.
	const bb = await item.boundingBox();
	if (bb) await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
	await item.focus();
	await page.keyboard.press("Enter");
	const input = page.getByTestId(OUTLINE_TESTID.inlineInput);
	await expect(input).toHaveAttribute("aria-label", `New place inside ${name}`);
	await page.waitForTimeout(1000);
	await expect(input).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(input).toHaveCount(0);
});

test("FB-05: the Ideas header's 'Open in Places' keeps the current filter and scope", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "xl sidebar");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	await addIdeas(page, c.tripId, c.ids.nodes.kyoto as string);
	// A filter on (Food & drink), whole trip.
	await page.goto(`/t/${c.slug}?f=g%3Afood_drink`);
	await expectLive(page);
	const ideas = page.getByTestId(TESTID.ideasBin).first();
	const link = ideas.getByTestId(OUTLINE_TESTID.rateIdeas);
	await expect(link).toBeVisible();
	await expect(link).toHaveText(/Open in Places/);
	const href = new URL((await link.getAttribute("href")) ?? "", page.url());
	expect(href.pathname).toBe(`/t/${c.slug}`);
	expect(href.searchParams.get("tab")).toBe("places");
	// The Ideas pill says "not scheduled" now; the shared filter goes along as it is.
	expect(href.searchParams.get("pst")).toBe("idea");
	expect(href.searchParams.get("f")).toBe("g:food_drink");
	await ideas.screenshot({ path: shotPath("outline/r3-rate-ideas-header.png"), animations: "disabled" });
	await page.screenshot({ path: shotPath("outline/r3-rate-ideas-workspace.png"), animations: "disabled" });

	await link.click();
	await expect(page.getByTestId(PT.tab)).toBeVisible({ timeout: 30_000 });
	const url = new URL(page.url());
	expect(url.pathname).toBe(`/t/${c.slug}`);
	expect(url.searchParams.get("tab")).toBe("places");
	expect(url.searchParams.get("pst")).toBe("idea");
	expect(url.searchParams.get("f")).toBe("g:food_drink");
	await expect(page.getByTestId(PT.statusPill).and(page.locator("[data-value=idea]"))).toHaveAttribute("aria-pressed", "true");
	// The set is the idea the Ideas list showed (the temple is filtered out).
	const rows = page.getByTestId(PT.row);
	await expect(rows.filter({ hasText: "Nishiki Market" })).toHaveCount(1, { timeout: 30_000 });
	await expect(rows.filter({ hasText: "Fushimi Inari" })).toHaveCount(0);
	await page.waitForTimeout(500);
	await page.screenshot({ path: shotPath("outline/r3-rate-ideas-landed.png"), animations: "disabled" });
	expect(logs.messages).toEqual([]);
});

test("FB-05: inside a scope 'Open in Places' opens that scope's ideas", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "xl sidebar");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	await addIdeas(page, c.tripId, c.ids.nodes.kyoto as string);
	// Zoom into the country that holds the ideas (Japan): double-click opens it.
	const g = await page.evaluate(
		() =>
			(
				window as unknown as {
					__yonder: { graph: { nodes: { id: string; parentId: string | null; type: string; name: string; slug: string }[] } };
				}
			).__yonder.graph.nodes,
	);
	let top = g.find((n) => n.name === "Nishiki Market");
	while (top?.parentId) top = g.find((n) => n.id === top?.parentId);
	if (!top) throw new Error("no country for Nishiki Market");
	await outline(page).locator(`[role=treeitem][data-node-id="${top.id}"]`).dblclick();
	await expect(page).toHaveURL(new RegExp(`/t/${c.slug}/${top.slug}`));
	const link = page.getByTestId(TESTID.ideasBin).first().getByTestId(OUTLINE_TESTID.rateIdeas);
	await expect(link).toBeVisible();
	const href = new URL((await link.getAttribute("href")) ?? "", page.url());
	expect(href.pathname).toBe(`/t/${c.slug}/${top.slug}`);
	expect(href.searchParams.get("tab")).toBe("places");
	expect(href.searchParams.get("pst")).toBe("idea");
	expect(href.searchParams.get("f")).toBeNull();
	// Keyboard: the link is reachable and Enter follows it.
	await link.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(new RegExp(`/t/${c.slug}/${top.slug}\\?.*tab=places`));
	await expect(page.getByTestId(PT.row).filter({ hasText: "Nishiki Market" })).toHaveCount(1, { timeout: 30_000 });
});

test("FB-05: a view-link guest gets no 'Open in Places' link", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "xl sidebar");
	const ownerCtx = await browser.newContext();
	const owner = await ownerCtx.newPage();
	await loginViaApi(owner.request, "dev@example.com", { first: "Dev", last: "User" });
	const c = await cloneFixtureTrip(owner.request);
	await owner.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(owner);
	await addIdeas(owner, c.tripId, c.ids.nodes.kyoto as string);
	// The owner gets the link; the guest below doesn't.
	await expect(owner.getByTestId(TESTID.ideasBin).first().getByTestId(OUTLINE_TESTID.rateIdeas)).toBeVisible();
	await ownerCtx.close();
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await openLink(page, c.slug, "viewer");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const ideas = page.getByTestId(TESTID.ideasBin).first();
	await expect(ideas).toBeVisible();
	// There are ideas (a member would get the link), but a guest can't rate.
	await expect(ideas.getByTestId(OUTLINE_TESTID.ideaRow).first()).toBeVisible();
	await expect(ideas.getByTestId(OUTLINE_TESTID.rateIdeas)).toHaveCount(0);
	await ctx.close();
});
