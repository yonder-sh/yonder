/**
 * WP-Lists notes and mentions in real browsers (SPEC §18.3 WP-Lists
 * acceptance; QA NOTE-01/06, MENT-01/02; ADDENDUM §7.2/§8):
 * - two people type in one note: text syncs and the other's named caret shows;
 * - Markdown shortcuts format as you type;
 * - @Ma offers Maya (members only, never guests) and inserts a chip;
 * - a viewer (share link) reads live but can't type;
 * - a private note ("Only me") never reaches anyone else.
 * Each test clones its own trip (SPEC §18.5). Screenshots → e2e/shots/lists/.
 */
import { randomBytes } from "node:crypto";
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";

async function open(browser: Browser, handle: "dev" | "maya", url: string) {
	const ctx = await browser.newContext({
		storageState: storageStateOf(handle),
		viewport: { width: 1440, height: 900 },
	});
	const page = await ctx.newPage();
	await page.goto(url);
	await expectLive(page);
	return { ctx, page };
}

/** The Notes tab's own (top) editor. */
const topEditor = (page: Page) =>
	page.getByTestId(TESTID.notesTab).getByTestId(NT.editor).first();

/** ProseMirror picked up the click (its selection left the document start). */
async function caretMoved(ed: Locator) {
	await expect
		.poll(() =>
			ed.evaluate(
				(e) =>
					(e as unknown as { editor?: { state: { selection: { from: number } } } }).editor
						?.state.selection.from ?? 0,
			),
		)
		.toBeGreaterThan(1);
}

async function typeAtEnd(page: Page, text: string) {
	const ed = topEditor(page);
	await expect(ed).toHaveAttribute("data-editable", "true", { timeout: 15_000 });
	// The caret at the very end: click the last block and let ProseMirror read
	// the new selection (it does on "selectionchange", asynchronously).
	await ed.locator(":scope > *").last().click();
	await caretMoved(ed);
	await page.keyboard.press("End");
	await page.keyboard.press("Enter");
	await page.keyboard.type(text);
}

test("two people write one note; mentions; Markdown shortcuts", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "two desktop browsers once");
	const owner = await browser.newContext({ storageState: storageStateOf("dev") });
	const trip = await cloneFixtureTrip(owner.request);
	await owner.close();
	const url = `/t/${trip.slug}?tab=notes`;
	const a = await open(browser, "dev", url);
	const b = await open(browser, "maya", url);
	const logsA = collectConsole(a.page);

	await typeAtEnd(a.page, "## House rules");
	await a.page.keyboard.press("Enter");
	await a.page.keyboard.type("- **Cash only** at most bars");
	await expect(topEditor(a.page).locator("h2", { hasText: "House rules" })).toBeVisible();
	await expect(topEditor(a.page).locator("li strong", { hasText: "Cash only" })).toBeVisible();
	// Maya sees it live.
	await expect(topEditor(b.page)).toContainText("House rules", { timeout: 5_000 });
	await expect(topEditor(b.page).locator("h2", { hasText: "House rules" })).toBeVisible();

	// A mention: members only (the fixture's guests never appear).
	await a.page.keyboard.press("Enter");
	await a.page.keyboard.press("Enter");
	await a.page.keyboard.type("Ask @Ma");
	const popup = a.page.getByTestId(NT.mentionPopup);
	await expect(popup).toBeVisible();
	await expect(popup.getByTestId(NT.mentionOption)).toContainText(["Maya Chen"]);
	await expect(popup).not.toContainText("Guest");
	await a.page.screenshot({ path: shotPath("lists/notes-mention-desktop.png"), animations: "disabled" });
	await a.page.keyboard.press("Enter");
	await a.page.keyboard.type("about the ryokan dinner.");
	const chip = topEditor(a.page).locator(".mention", { hasText: "@Maya Chen" });
	await expect(chip).toBeVisible();
	await expect(topEditor(b.page).locator(".mention", { hasText: "@Maya Chen" })).toBeVisible({
		timeout: 5_000,
	});

	// Maya's caret shows in Dennis's editor with her name.
	await topEditor(b.page).locator(":scope > *").last().click();
	await caretMoved(topEditor(b.page));
	await b.page.keyboard.press("End");
	await b.page.keyboard.type(" Sounds good!");
	await expect(topEditor(a.page)).toContainText("Sounds good!", { timeout: 5_000 });
	await expect(a.page.locator(".collaboration-carets__label", { hasText: "Maya" })).toBeVisible({
		timeout: 5_000,
	});
	await a.page.screenshot({ path: shotPath("lists/notes-live-desktop.png"), animations: "disabled" });
	expect(logsA.messages).toEqual([]);
	await a.ctx.close();
	await b.ctx.close();
});

test("a viewer reads live but can't type; a private note stays private", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "several browsers once");
	const owner = await browser.newContext({ storageState: storageStateOf("dev") });
	const trip = await cloneFixtureTrip(owner.request);
	await owner.close();
	const url = `/t/${trip.slug}?tab=notes`;
	const a = await open(browser, "dev", url);

	// A viewer through the clone's viewer link.
	const viewerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(viewerCtx.request, `viewer-${randomBytes(3).toString("hex")}@example.com`, {
		first: "Vera",
		last: "Viewer",
	});
	const v = await viewerCtx.newPage();
	await v.goto(`/join#t=${trip.shareTokens.viewer}`);
	await expect(v).toHaveURL(new RegExp(`/t/${trip.slug}`), { timeout: 20_000 });
	await v.goto(url);
	await expectLive(v);
	await expect(topEditor(v)).toHaveAttribute("data-editable", "false", { timeout: 15_000 });
	await expect(v.getByTestId(NT.readOnlyNote)).toContainText("View only");
	// Guests never keep private notes.
	await expect(v.getByTestId(NT.privateToggle)).toHaveCount(0);

	await typeAtEnd(a.page, "Meet at the east exit.");
	await expect(topEditor(v)).toContainText("Meet at the east exit.", { timeout: 5_000 });
	await v.screenshot({ path: shotPath("lists/notes-viewer-desktop.png"), animations: "disabled" });

	// Dennis's private layer.
	await a.page.getByTestId(NT.privateToggle).getByRole("button", { name: /Only me/ }).click();
	const priv = topEditor(a.page);
	await expect(priv).toHaveAttribute("data-doc", /\/u\//);
	await expect(priv).toHaveAttribute("data-editable", "true", { timeout: 15_000 });
	await priv.click();
	await a.page.waitForTimeout(150); // an empty note: the caret is already home
	await a.page.keyboard.type("Gift idea for Maya: a matcha whisk.");
	await a.page.waitForTimeout(2_500); // collab stores after its debounce
	await a.page.screenshot({ path: shotPath("lists/notes-private-desktop.png"), animations: "disabled" });

	const b = await open(browser, "maya", url);
	await expect(topEditor(b.page)).toContainText("Meet at the east exit.");
	await b.page.getByTestId(NT.privateToggle).getByRole("button", { name: /Only me/ }).click();
	await expect(topEditor(b.page)).toHaveAttribute("data-editable", "true", { timeout: 15_000 });
	await expect(b.page.getByTestId(TESTID.notesTab)).not.toContainText("matcha");
	await v.reload();
	await expectLive(v);
	await expect(v.getByTestId(TESTID.notesTab)).not.toContainText("matcha");
	await b.page.getByTestId(NT.privateToggle).getByRole("button", { name: /Shared/ }).click();
	await a.ctx.close();
	await b.ctx.close();
	await viewerCtx.close();
});

test("a visit keeps its own note, apart from its place's (QA NOTE-02)", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const owner = await browser.newContext({ storageState: storageStateOf("dev") });
	const trip = await cloneFixtureTrip(owner.request);
	await owner.close();
	const a = await open(browser, "dev", `/t/${trip.slug}?sel=i.${trip.ids.items.kiyomizu}`);
	const logs = collectConsole(a.page);
	const inspector = a.page.getByTestId(TESTID.inspector);
	await inspector.getByRole("tab", { name: "Notes" }).click();
	const panel = a.page.getByTestId(TESTID.notesPanel);
	await panel.getByTestId(NT.visitScope).getByRole("radio", { name: "This visit only" }).click();
	const ed = panel.getByTestId(NT.editor);
	await expect(ed).toHaveAttribute("data-doc", /item/);
	await expect(ed).toHaveAttribute("data-editable", "true", { timeout: 15_000 });
	await ed.click();
	await a.page.waitForTimeout(150); // an empty note: the caret is already home
	await a.page.keyboard.type("Evening illumination tickets at the east gate.");
	await expect(ed).toContainText("east gate");
	await a.page.screenshot({ path: shotPath("lists/notes-visit-desktop.png"), animations: "disabled" });
	// The place's own note doesn't have it.
	await panel.getByTestId(NT.visitScope).getByRole("radio", { name: "Kiyomizu-dera" }).click();
	await expect(panel.getByTestId(NT.editor)).not.toHaveAttribute("data-doc", /item/);
	await expect(panel).not.toContainText("east gate");
	expect(logs.messages).toEqual([]);
	await a.ctx.close();
});

test("a new person picked in a list row exists only once the row is saved (QA PLAN-R2-08)", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const owner = await browser.newContext({ storageState: storageStateOf("dev") });
	const trip = await cloneFixtureTrip(owner.request);
	await owner.close();
	const a = await open(browser, "dev", `/t/${trip.slug}?tab=lists`);
	const logs = collectConsole(a.page);
	const people = () =>
		a.page.evaluate(() =>
			(window as unknown as { __yonder: { graph: { members: { name: string }[] } } }).__yonder.graph.members.map(
				(m) => m.name,
			),
		);
	const tag = randomBytes(2).toString("hex");
	const gone = `Zed${tag}`;
	const kept = `Yan${tag}`;
	const input = a.page.getByTestId("list-add").getByTestId(TESTID.mentionInput);

	// Picked, then the text is cleared: nobody is added.
	await input.click();
	await a.page.keyboard.type(`Ask @${gone}`);
	await a.page.getByTestId(NT.mentionAdd).click();
	await expect(input.locator("[data-mention]")).toHaveText(`@${gone}`);
	await a.page.keyboard.press("ControlOrMeta+a");
	await a.page.keyboard.press("Backspace");
	await a.page.keyboard.press("Escape");
	await a.page.waitForTimeout(500);
	expect(await people()).not.toContain(gone);

	// Picked and saved: the person exists and the row mentions them.
	await input.click();
	await a.page.keyboard.type(`Gift for @${kept}`);
	await a.page.getByTestId(NT.mentionAdd).click();
	expect(await people()).not.toContain(kept);
	await a.page.keyboard.press("Enter");
	const row = a.page.getByTestId("list-row").filter({ hasText: "Gift for" });
	await expect(row.locator("[data-mention]")).toHaveText(`@${kept}`);
	await expect.poll(people).toContain(kept);
	expect(await people()).not.toContain(gone);
	expect(logs.messages).toEqual([]);
	await a.ctx.close();
});
