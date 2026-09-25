/**
 * WP-Lists, owner feedback round 1 and QA round 3 (docs/qa/FEEDBACK-1.md,
 * OPEN_BUGS.json), in real browsers on cloned trips:
 * - FB-06: every popover a list row opens (Set date, Assign/For, Move to,
 *   Quantity & budget, Candidate shops, the add row's target) hangs from its
 *   row, in the narrow inspector, the wide center panel and on a phone; never
 *   from the top-left corner of the screen.
 * - SEC-R3-01: a suggester's own private to-do only reaches the trip through
 *   review. A raw `isPrivate: false` patch is refused; her ⋯ menu offers
 *   "Suggest sharing with the trip", a suggested shared copy that replaces
 *   her private one when accepted.
 * Each test signs its people in itself (no shared storage state).
 * Screenshots → e2e/shots/lists/.
 */
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";

async function signedIn(
	browser: Browser,
	email: string,
	name: { first: string; last: string },
	viewport = { width: 1440, height: 900 },
) {
	const ctx = await browser.newContext({ viewport });
	await loginViaApi(ctx.request, email, name);
	const page = await ctx.newPage();
	return { ctx, page };
}

const DEV = { email: "dev@example.com", name: { first: "Dev", last: "User" } };
const MAYA = { email: "maya@example.com", name: { first: "Maya", last: "Chen" } };

const rowOf = (scope: Page | Locator, text: string | RegExp) => scope.getByTestId(L.row).filter({ hasText: text });

/** A ⋯ menu item by its label ("Set date…" also carries its shortcut, "D"). */
const menuItem = (page: Page, item: string) =>
	page.getByRole("menuitem", { name: new RegExp(`^${item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });

/** Opens `item` from the row's ⋯ menu. */
async function fromMenu(page: Page, row: Locator, item: string) {
	await row.hover();
	await row.getByTestId(L.rowMenu).click();
	await menuItem(page, item).click();
}

/**
 * The open popover sits right against `anchor` (above or below it, within
 * 12 px) and overlaps it horizontally, i.e. it hangs from it. The FB-06 bug
 * put it at the viewport's top-left corner.
 */
async function expectHangsFrom(page: Page, anchor: Locator, what: string) {
	const pop = page.locator('[data-slot="popover-content"][data-state="open"]');
	await expect(pop, `${what}: a popover opens`).toBeVisible();
	// Floating UI positions it on the next frames.
	await page.waitForTimeout(200);
	const p = await pop.boundingBox();
	const a = await anchor.boundingBox();
	if (!p || !a) throw new Error(`${what}: no box`);
	const vGap = Math.max(0, p.y - (a.y + a.height), a.y - (p.y + p.height));
	const hOverlap = Math.min(p.x + p.width, a.x + a.width) - Math.max(p.x, a.x);
	const where = `${what}: popover ${JSON.stringify(p)} vs anchor ${JSON.stringify(a)}`;
	expect(vGap, where).toBeLessThanOrEqual(12);
	expect(hOverlap, where).toBeGreaterThan(40);
	return pop;
}

async function closePopover(page: Page) {
	await page.keyboard.press("Escape");
	await expect(page.locator('[data-slot="popover-content"][data-state="open"]')).toHaveCount(0);
}

async function devWithClone(browser: Browser, viewport?: { width: number; height: number }) {
	const dev = await signedIn(browser, DEV.email, DEV.name, viewport);
	const c = await cloneFixtureTrip(dev.page.request);
	return { ...dev, c };
}

test("FB-06: the inspector's list popovers hang from their row", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "viewports are set per test");
	test.setTimeout(120_000);
	const { ctx, page, c } = await devWithClone(browser);
	const logs = collectConsole(page);
	// A narrow board: the assign and date buttons hide, the ⋯ menu opens them.
	await page.goto(`/t/${c.slug}?sel=n.${c.ids.nodes.tokyo}`);
	await expectLive(page);
	await page.getByTestId(TESTID.inspector).getByRole("tab", { name: "Lists" }).click();
	const panel = page.getByTestId(TESTID.listsPanel);
	const sky = rowOf(panel, "Book Shibuya Sky sunset slot");
	await expect(sky).toBeVisible();
	await fromMenu(page, sky, "Assign…");
	const assign = await expectHangsFrom(page, sky, "inspector › Assign…");
	await page.screenshot({ path: shotPath("lists/fb06-inspector-assign.png"), animations: "disabled" });
	// Picking someone works from there.
	await assign.getByRole("option", { name: /Maya/ }).click();
	await expect(sky.getByTestId(L.rowAssign)).toBeVisible();
	await closePopover(page);
	for (const item of ["Set date…", "Move to…", "Assign…"]) {
		await fromMenu(page, sky, item);
		await expectHangsFrom(page, sky, `inspector › ${item}`);
		await closePopover(page);
	}
	await panel.getByTestId(L.kindShopping).click();
	const knife = rowOf(panel, "Petty knife");
	await expect(knife).toBeVisible();
	for (const item of ["For…", "Quantity & budget…", "Candidate shops…", "Set date…", "Move to…"]) {
		await fromMenu(page, knife, item);
		await expectHangsFrom(page, knife, `inspector › ${item}`);
		await closePopover(page);
	}
	// The add row's "→ Tokyo" target picker.
	const target = panel.getByTestId(L.add).getByTestId(L.addTarget);
	await target.click();
	await expectHangsFrom(page, target, "inspector › add target");
	await closePopover(page);
	expect(logs.messages).toEqual([]);
	await ctx.close();
});

test("FB-06: the center Lists tab's popovers hang from their row", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "viewports are set per test");
	test.setTimeout(120_000);
	const { ctx, page, c } = await devWithClone(browser);
	await page.goto(`/t/${c.slug}?tab=lists`);
	await expectLive(page);
	const suica = rowOf(page.getByTestId(TESTID.listsTab), "Get a Suica card");
	await expect(suica).toBeVisible();
	for (const item of ["Assign…", "Set date…", "Move to…"]) {
		await fromMenu(page, suica, item);
		await expectHangsFrom(page, suica, `center › ${item}`);
		if (item === "Assign…")
			await page.screenshot({ path: shotPath("lists/fb06-center-assign.png"), animations: "disabled" });
		await closePopover(page);
	}
	// The hover "Assign someone" button itself.
	await suica.hover();
	await suica.getByTestId(L.rowAssign).click();
	await expectHangsFrom(page, suica, "center › assign button");
	await closePopover(page);
	await ctx.close();
});

test("FB-06: on a phone, ⋯ › Assign… hangs from the row", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "viewports are set per test");
	test.setTimeout(120_000);
	const { ctx, page, c } = await devWithClone(browser, { width: 390, height: 844 });
	await page.goto(`/t/${c.slug}?tab=lists`);
	await expectLive(page);
	const suica = rowOf(page, "Get a Suica card").first();
	await expect(suica).toBeVisible();
	for (const item of ["Assign…", "Set date…"]) {
		await suica.getByTestId(L.rowMenu).click();
		await menuItem(page, item).click();
		await expectHangsFrom(page, suica, `phone › ${item}`);
		if (item === "Assign…")
			await page.screenshot({ path: shotPath("lists/fb06-phone-assign.png"), animations: "disabled" });
		await closePopover(page);
	}
	await ctx.close();
});

type Call = { ok: true; r: unknown } | { ok: false; err: string };
async function callFn(page: Page, mod: string, fn: string, data: unknown): Promise<Call> {
	return page.evaluate(
		async ({ mod, fn, data }) => {
			try {
				const m = await import(/* @vite-ignore */ mod);
				return { ok: true as const, r: await m[fn]({ data }) };
			} catch (e) {
				return { ok: false as const, err: String((e as Error)?.message ?? e) };
			}
		},
		{ mod, fn, data },
	);
}
const LISTS = "/src/features/lists/lists.functions.ts";
const PROPOSALS = "/src/functions/proposals.functions.ts";

test("SEC-R3-01: a suggester's private to-do reaches the trip only through review", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "two browsers once");
	test.setTimeout(180_000);
	const maya = await signedIn(browser, MAYA.email, MAYA.name);
	const owner = await signedIn(browser, DEV.email, DEV.name);
	const c = await cloneFixtureTrip(owner.page.request, { mayaRole: "suggester" });
	const stamp = Date.now().toString(36);
	await owner.page.goto(`/t/${c.slug}?tab=lists`);
	await expectLive(owner.page);
	await maya.page.goto(`/t/${c.slug}?tab=lists`);
	await expectLive(maya.page);

	// 1. The QA repro through the API: a private to-do (direct, allowed)…
	const text = `Pay the deposit to Maya's friend ${stamp}`;
	const created = await callFn(maya.page, LISTS, "createListItem", {
		tripId: c.tripId,
		target: { kind: "trip" },
		list: "todo",
		text,
		isPrivate: true,
		dueDate: "2026-09-24",
		dueTime: "09:00",
		dueTz: "Asia/Tokyo",
		url: "https://example.com/pay-here",
		assigneeIds: [c.members.owner, c.members.audrey],
	});
	expect(created.ok, JSON.stringify(created)).toBe(true);
	const priv = (created as { r: { id: string; isPrivate: boolean } }).r;
	expect(priv.isPrivate).toBe(true);
	// …then shared, alone or with an edit: refused, never applied.
	for (const patch of [{ isPrivate: false }, { isPrivate: false, text: `${text} (shared)` }]) {
		const flip = await callFn(maya.page, LISTS, "updateListItem", { id: priv.id, patch });
		expect(flip.ok, JSON.stringify(flip)).toBe(false);
		expect((flip as { err: string }).err).toContain("FORBIDDEN");
	}
	const ownerRows = await callFn(owner.page, LISTS, "listTripListItems", { tripId: c.tripId });
	expect(JSON.stringify(ownerRows)).not.toContain(stamp);

	// 2. The UI: her ⋯ menu offers "Suggest sharing with the trip" instead.
	await maya.page.reload();
	await expectLive(maya.page);
	const mine = rowOf(maya.page, text);
	await expect(mine).toHaveAttribute("data-private", "");
	await mine.hover();
	await mine.getByTestId(L.rowMenu).click();
	await expect(menuItem(maya.page, "Share with the trip")).toHaveCount(0);
	await menuItem(maya.page, "Suggest sharing with the trip").click();
	await expect(maya.page.locator("[data-sonner-toast]").filter({ hasText: "Suggested" })).toBeVisible();
	// Her row is now her dashed suggestion (the private original waits behind it).
	await expect(rowOf(maya.page, text)).toHaveCount(1);
	await expect(rowOf(maya.page, text)).toHaveAttribute("data-ghost", "");
	await maya.page.screenshot({ path: shotPath("lists/sec-r3-01-maya-suggested.png"), animations: "disabled" });
	// Asking again while it waits: refused.
	const again = await callFn(maya.page, LISTS, "createListItem", {
		tripId: c.tripId,
		target: { kind: "trip" },
		list: "todo",
		text,
		fromPrivateId: priv.id,
	});
	expect(again.ok).toBe(false);
	expect((again as { err: string }).err).toContain("CONFLICT");

	// 3. Dennis has no live row, only the suggestion with Maya's avatar.
	const ghost = rowOf(owner.page, text);
	await expect(ghost).toHaveAttribute("data-ghost", "", { timeout: 10_000 });
	await expect(ghost.getByTestId(L.dueChip)).toBeVisible();
	await owner.page.screenshot({ path: shotPath("lists/sec-r3-01-owner-ghost.png"), animations: "disabled" });
	expect(JSON.stringify(await callFn(owner.page, LISTS, "listTripListItems", { tripId: c.tripId }))).not.toContain(
		stamp,
	);

	// 4. He accepts: a live shared to-do with its date; Maya's private copy is gone.
	const proposalId = await ghost.locator("[data-proposal-id]").first().getAttribute("data-proposal-id");
	const acc = await callFn(owner.page, PROPOSALS, "resolveProposal", { proposalId, decision: "accept" });
	expect(acc.ok, JSON.stringify(acc)).toBe(true);
	// Maya's tab hears it live (Dennis's own tab skips its own event: reload it).
	const live = rowOf(maya.page, text);
	await expect(live).not.toHaveAttribute("data-ghost", "", { timeout: 10_000 });
	await expect(live).not.toHaveAttribute("data-private", "");
	await expect(live.getByTestId(L.dueChip)).toBeVisible();
	await expect(rowOf(maya.page, stamp)).toHaveCount(1);
	const after = (await callFn(maya.page, LISTS, "listTripListItems", { tripId: c.tripId })) as {
		r: { id: string; text: string; isPrivate: boolean }[];
	};
	expect(after.r.some((r) => r.id === priv.id)).toBe(false);
	expect(after.r.filter((r) => r.text.includes(stamp)).map((r) => r.isPrivate)).toEqual([false]);
	await owner.page.reload();
	await expectLive(owner.page);
	await expect(rowOf(owner.page, text)).toBeVisible();
	await expect(rowOf(owner.page, text)).not.toHaveAttribute("data-ghost", "");
	await owner.page.screenshot({ path: shotPath("lists/sec-r3-01-owner-accepted.png"), animations: "disabled" });
	await maya.ctx.close();
	await owner.ctx.close();
});
