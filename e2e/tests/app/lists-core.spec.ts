/**
 * WP-Lists: to-dos and shopping in real browsers, each test on its own cloned
 * trip (SPEC §18.5).
 * - the trip root opens on the MAIN list (View = Due); a row is added, ticked
 *   silently, reopened within 4 s, then folds into "N done"; a due date set
 *   from the ⋯ menu shows as a chip (QA DUE-01/02, LIST-01);
 * - a private item is only its author's: Maya never sees it or its count
 *   (ADDENDUM §7.2, QA DUE-10);
 * - a shopping item says where its shop is on the plan and "By day" groups it
 *   (ADDENDUM §10, QA DUE-11);
 * - a relative booking window follows its item to another day (ADDENDUM §10,
 *   QA DUE-09);
 * - the inspector's Lists tab for a place rolls up "Everything inside";
 * - mobile: the Lists tab in the sheet at 390 px, no sideways scroll.
 * Screenshots → e2e/shots/lists/.
 */
import { expect, type Page, test } from "@playwright/test";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive, expectNoHorizontalOverflow } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

const row = (page: Page, text: string | RegExp) =>
	page.getByTestId(L.row).filter({ hasText: text });

async function addRow(page: Page, text: string) {
	const input = page.getByTestId(L.add).getByTestId(TESTID.mentionInput);
	await input.click();
	await page.keyboard.type(text);
	await page.keyboard.press("Enter");
	await expect(row(page, text)).toBeVisible();
}

test("the MAIN list: add, tick silently, reopen within 4 s, fold, set a date", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=lists`);
	await expectLive(page);
	const tab = page.getByTestId(TESTID.listsTab);
	await expect(tab).toBeVisible();
	// The trip root opens on View = Due, overdue first.
	await expect(page.getByTestId(L.view)).toContainText("Due");
	await expect(row(page, "Book Shibuya Sky sunset slot")).toBeVisible();

	await addRow(page, "Buy a Pasmo card");
	const pasmo = row(page, "Buy a Pasmo card");
	await pasmo.getByTestId(L.rowCheck).click();
	await expect(pasmo).toHaveAttribute("data-status", "done");
	// Silent: no toast for a tick, and the row stays in place for 4 s…
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
	await expect(pasmo).toBeVisible();
	// …where a second click reopens it.
	await pasmo.getByTestId(L.rowCheck).click();
	await expect(pasmo).toHaveAttribute("data-status", "open");
	await pasmo.getByTestId(L.rowCheck).click();
	await expect(pasmo).toBeHidden({ timeout: 8_000 });
	await expect(page.getByTestId(L.doneFold).first()).toContainText("done");

	// A date from the ⋯ menu.
	const suica = row(page, "Get a Suica card");
	await suica.hover();
	await suica.getByTestId(L.rowMenu).click();
	await page.getByRole("menuitem", { name: /Set date/ }).click();
	const editor = page.getByTestId(L.dueEditor);
	await expect(editor).toBeVisible();
	await editor.getByRole("button", { name: /October 20(th)?, 2027/ }).click();
	await editor.getByTestId(L.dueSave).click();
	await expect(suica.getByTestId(L.dueChip)).toContainText(/Due \w{3} 20 Oct/);
	await page.screenshot({ path: shotPath("lists/root-due-desktop.png"), animations: "disabled" });

	// The source crumb jumps there: Shibuya Sky becomes the scope (QA ROLL-05).
	await row(page, "Book Shibuya Sky sunset slot").getByTestId(L.rowSource).click();
	await expect(page).toHaveURL(/shibuya-sky/);
	await expect(row(page, "Book Shibuya Sky sunset slot")).toBeVisible();
	await expect(row(page, "Get a Suica card")).toHaveCount(0);
	expect(logs.messages).toEqual([]);
});

test("a private item is only its author's", async ({ page, browser }, info) => {
	test.skip(info.project.name !== "chromium", "two browsers once");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=lists`);
	await expectLive(page);
	await page.getByTestId(L.kindShopping).click();
	await page.getByTestId(L.addPrivate).click();
	await expect(page.getByTestId(L.addPrivate)).toHaveAttribute("aria-pressed", "true");
	await addRow(page, "Birthday fountain pen for Maya");
	const gift = row(page, "Birthday fountain pen for Maya");
	await expect(gift).toHaveAttribute("data-private", "");
	await expect(gift.getByTestId(L.privateMark)).toBeVisible();
	await page.screenshot({ path: shotPath("lists/private-desktop.png"), animations: "disabled" });

	const maya = await browser.newContext({ storageState: storageStateOf("maya"), viewport: { width: 1440, height: 900 } });
	const mp = await maya.newPage();
	await mp.goto(`/t/${c.slug}?tab=lists`);
	await expectLive(mp);
	await mp.getByTestId(L.kindShopping).click();
	await expect(row(mp, "Petty knife")).toBeVisible();
	await expect(mp.getByText("Birthday fountain pen")).toHaveCount(0);
	// Her list has the two seeded rows only.
	await expect(mp.getByTestId(L.kindShopping)).toContainText("2");
	await maya.close();
});

test("a busy gift row keeps its text readable and its @mention on one line", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	await page.setViewportSize({ width: 1440, height: 900 });
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=lists&list=shopping`);
	await expectLive(page);
	// Private, a note, an assignee, a due chip and a price: every mark a row can have.
	await page.evaluate(
		async ({ tripId }) => {
			const s = await import("/src/features/home/sharing.functions.ts");
			const { memberId } = await s.addPlaceholder({ data: { tripId, displayName: "Audrey Tester" } });
			const l = await import("/src/features/lists/lists.functions.ts");
			await l.createListItem({
				data: {
					tripId,
					target: { kind: "trip" },
					list: "shopping",
					text: `PEARL earrings for [@Audrey Tester](mention:${memberId})`,
					note: "The small ones",
					isPrivate: true,
					assigneeIds: [memberId],
					dueDate: "2027-09-30",
					priceAmount: 30000,
					priceCurrency: "JPY",
				},
			});
		},
		{ tripId: c.tripId },
	);
	await page.reload();
	await expectLive(page);
	const gift = row(page, "PEARL earrings");
	await expect(gift.getByTestId(L.privateMark)).toBeVisible();
	await expect(gift.getByTestId(L.dueChip)).toBeVisible();
	const text = gift.getByTestId(L.rowText);
	const chip = text.locator("[data-mention]");
	await expect(chip).toHaveText("@Audrey Tester");
	const line = await text.evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight));
	const chipBox = await chip.boundingBox();
	const textBox = await text.boundingBox();
	// The chip is one pill, never "@Audrey" / "Tester" on two lines…
	expect(chipBox?.height ?? 99).toBeLessThan(line * 1.5);
	// …and the marks wrap below the text instead of squeezing it to ~100 px.
	expect(textBox?.width ?? 0).toBeGreaterThanOrEqual(150);
	await gift.screenshot({ path: shotPath("lists/gift-row-marks-desktop.png"), animations: "disabled" });
});

test("a suggester: an assignee ticks directly, anything else is a suggestion", async ({ page, browser }, info) => {
	test.skip(info.project.name !== "chromium", "two browsers once");
	const c = await cloneFixtureTrip(page.request, { mayaRole: "suggester" });
	await page.goto(`/t/${c.slug}?tab=lists`);
	await expectLive(page);
	// Dennis assigns Maya to the Suica card.
	await page.evaluate(
		async ({ tripId, maya }) => {
			const m = await import("/src/features/lists/lists.functions.ts");
			const rows = await m.listTripListItems({ data: { tripId } });
			const suica = rows.find((r: { text: string }) => r.text === "Get a Suica card");
			if (!suica || !maya) throw new Error("no Suica row");
			await m.setListItemAssignees({ data: { id: suica.id, memberIds: [maya] } });
		},
		{ tripId: c.tripId, maya: c.members.maya },
	);

	const maya = await browser.newContext({ storageState: storageStateOf("maya"), viewport: { width: 1440, height: 900 } });
	const mp = await maya.newPage();
	const logs = collectConsole(mp);
	await mp.goto(`/t/${c.slug}?tab=lists`);
	await expectLive(mp);
	// Her own to-do: ticked at once, silently (QA DUE-07).
	const suica = row(mp, "Get a Suica card");
	await suica.getByTestId(L.rowCheck).click();
	await expect(suica).toHaveAttribute("data-status", "done");
	await expect(mp.locator("[data-sonner-toast]")).toHaveCount(0);
	// Someone else's: a suggestion, the row stays open.
	const sky = row(mp, "Book Shibuya Sky sunset slot");
	await sky.getByTestId(L.rowCheck).click();
	await expect(mp.locator("[data-sonner-toast]").filter({ hasText: "Suggested" })).toBeVisible();
	await expect(sky).toHaveAttribute("data-status", "open");
	// A new to-do from a suggester is a ghost until someone accepts it.
	const input = mp.getByTestId(L.add).getByTestId(TESTID.mentionInput);
	await input.click();
	await mp.keyboard.type("Rent a pocket wifi");
	await mp.keyboard.press("Enter");
	await expect(row(mp, "Rent a pocket wifi")).toHaveAttribute("data-ghost", "");
	await mp.screenshot({ path: shotPath("lists/suggester-desktop.png"), animations: "disabled" });
	// Dennis (a reviewer) sees the ghost live and accepts it.
	const ghost = row(page, "Rent a pocket wifi");
	await expect(ghost).toHaveAttribute("data-ghost", "", { timeout: 5_000 });
	// Maya's tick reached him too: Suica folded into "1 done".
	await expect(page.getByTestId(L.doneFold).first()).toContainText("1 done");
	// Accept it (WP-Suggest's ✓ on the ghost calls the same function).
	const proposalId = await ghost.locator("[data-proposal-id]").getAttribute("data-proposal-id");
	await page.evaluate(async (id) => {
		const m = await import("/src/functions/proposals.functions.ts");
		await m.resolveProposal({ data: { proposalId: id, decision: "accept" } });
	}, proposalId);
	// Maya's tab hears it live; it's a real row now.
	await expect(row(mp, "Rent a pocket wifi")).not.toHaveAttribute("data-ghost", "", { timeout: 5_000 });
	await expect(row(mp, "Rent a pocket wifi")).toBeVisible();
	expect(logs.messages).toEqual([]);
	await maya.close();
});

test("a shopping item says where its shop is on the plan; By day groups it", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=lists`);
	await expectLive(page);
	await page.getByTestId(L.kindShopping).click();
	const knife = row(page, "Petty knife");
	await expect(knife.getByTestId(L.shopPlan)).toContainText(/Day 2 · Kama-asa \(knives\)\s*\d\d:\d\d/);
	await page.getByTestId(L.view).click();
	await page.getByRole("option", { name: "By day" }).click();
	const day2 = page.getByTestId(L.group).filter({ has: page.getByText(/^Day 2 · Mon 4 Oct$/) });
	await expect(day2.getByText("Petty knife")).toBeVisible();
	await page.screenshot({ path: shotPath("lists/shopping-by-day-desktop.png"), animations: "disabled" });

	// Quantity and budget (QA LIST-04), then "Bought" offers the expense.
	await knife.hover();
	await knife.getByTestId(L.rowMenu).click();
	await page.getByRole("menuitem", { name: /Quantity & budget/ }).click();
	await page.getByLabel("How many").fill("2");
	await page.getByLabel("Budget amount").fill("25000");
	await page.getByRole("button", { name: "Save" }).click();
	await expect(knife).toContainText("×2");
	await expect(knife).toContainText("¥25,000");
	await knife.getByTestId(L.rowCheck).click();
	await expect(knife.getByTestId(L.boughtExpense)).toBeVisible();
});

test("rows on dropped places leave a trace and come back on Show (QA ROLL-12)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=lists&list=shopping`);
	await expectLive(page);
	await page.evaluate(
		async ({ tripId, nodeId }) => {
			const l = await import("/src/features/lists/lists.functions.ts");
			await l.createListItem({
				data: { tripId, target: { kind: "node", nodeId }, list: "shopping", text: "Omamori charm" },
			});
			const n = await import("/src/functions/nodes.functions.ts");
			await n.updateNode({ data: { nodeId, patch: { status: "dropped" } } });
		},
		{ tripId: c.tripId, nodeId: c.ids.nodes.kiyomizu },
	);
	await page.reload();
	await expectLive(page);
	await expect(row(page, "Petty knife")).toBeVisible();
	await expect(row(page, "Omamori charm")).toHaveCount(0);
	const trace = page.getByTestId(L.dropped);
	await expect(trace).toContainText("1 on dropped places");
	await trace.click();
	await expect(row(page, "Omamori charm")).toBeVisible();
	await expect(trace).toContainText("Hide dropped places");
});

test("a relative booking window follows its item to another day", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=lists`);
	await expectLive(page);
	await addRow(page, "Kiyomizu evening tickets");
	const r = row(page, "Kiyomizu evening tickets");
	await r.hover();
	await r.getByTestId(L.rowMenu).click();
	await page.getByRole("menuitem", { name: /Set date/ }).click();
	const editor = page.getByTestId(L.dueEditor);
	await editor.getByRole("button", { name: "Opens" }).click();
	await editor.getByRole("button", { name: /Before/ }).click();
	const rel = editor.getByTestId(L.dueRelative);
	await rel.getByLabel("How many").fill("30");
	await rel.getByLabel("Unit").click();
	await page.getByRole("option", { name: "days before" }).click();
	await rel.getByLabel("Item").click();
	await page.getByRole("option", { name: "Kiyomizu-dera" }).click();
	await rel.getByLabel("Time", { exact: true }).fill("10:00");
	await page.screenshot({ path: shotPath("lists/due-editor-desktop.png"), animations: "disabled" });
	await editor.getByTestId(L.dueSave).click();
	// Kiyomizu is on Day 4 (Wed 6 Oct 2027) → 30 days before = Mon 6 Sep.
	await expect(r.getByTestId(L.dueChip)).toContainText("Opens Mon 6 Sep · 10:00 JST");
	await expect(r).toContainText("30 days before Kiyomizu-dera");

	// Move Kiyomizu to Day 5: the window moves one day later.
	await page.evaluate(
		async ({ itemId, dayId }) => {
			const m = await import("/src/functions/items.functions.ts");
			await m.moveItem({ data: { itemId, dayId } });
		},
		{ itemId: c.ids.items.kiyomizu, dayId: c.ids.days.d5 },
	);
	await page.reload();
	await expectLive(page);
	await expect(row(page, "Kiyomizu evening tickets").getByTestId(L.dueChip)).toContainText(
		"Opens Tue 7 Sep · 10:00 JST",
	);
	await page.screenshot({ path: shotPath("lists/relative-window-desktop.png"), animations: "disabled" });
});

test("the inspector rolls up everything inside a place", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?sel=n.${c.ids.nodes.tokyo}`);
	await expectLive(page);
	await page.getByTestId(TESTID.inspector).getByRole("tab", { name: "Lists" }).click();
	const panel = page.getByTestId(TESTID.listsPanel);
	await expect(panel.getByText("Book Shibuya Sky sunset slot")).toBeVisible();
	await panel.getByTestId(L.kindShopping).click();
	await expect(panel.getByText("Petty knife")).toBeVisible();
	// "Only Tokyo" narrows to Tokyo's own rows (none).
	await panel.getByTestId(L.panelScope).getByRole("radio", { name: "Only Tokyo" }).click();
	await expect(panel.getByText("Petty knife")).toHaveCount(0);
	await panel.getByTestId(L.panelScope).getByRole("radio", { name: "Everything inside Tokyo" }).click();
	await page.screenshot({ path: shotPath("lists/inspector-desktop.png"), animations: "disabled" });

	// A group's own add row attaches to that group's place (DESIGN §7.3).
	const asakusa = panel.getByTestId(L.group).filter({ hasText: "Petty knife" });
	await asakusa.hover();
	await asakusa.getByTestId(L.groupAdd).click();
	await expect(asakusa.getByTestId(L.groupAddInput)).toBeFocused();
	await page.keyboard.type("Donabe pot");
	await page.keyboard.press("Enter");
	await expect(asakusa.getByTestId(L.row).filter({ hasText: "Donabe pot" })).toBeVisible();
	await page.screenshot({ path: shotPath("lists/group-add-desktop.png"), animations: "disabled" });
	await expect
		.poll(() =>
			page.evaluate(async (tripId) => {
				const m = await import("/src/features/lists/lists.functions.ts");
				const rows = await m.listTripListItems({ data: { tripId } });
				const r = rows.find((x: { text: string }) => x.text === "Donabe pot");
				return r?.target.kind === "node" ? r.target.nodeId : null;
			}, c.tripId),
		)
		.toBe(c.ids.nodes.asakusa);
});

test("rows drag to reorder within a place (Place view)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?sel=n.${c.ids.nodes.knifeShop}`);
	await expectLive(page);
	await page.getByTestId(TESTID.inspector).getByRole("tab", { name: "Lists" }).click();
	const panel = page.getByTestId(TESTID.listsPanel);
	await panel.getByTestId(L.kindShopping).click();
	const input = panel.getByTestId(L.add).getByTestId(TESTID.mentionInput);
	await input.click();
	await page.keyboard.type("Whetstone #1000");
	await page.keyboard.press("Enter");
	const rows = panel.getByTestId(L.row);
	await expect(rows).toHaveText([/Petty knife/, /Whetstone #1000/]);
	// Start from the saved rows (not the optimistic one still settling).
	await expect
		.poll(() =>
			page.evaluate(async (tripId) => {
				const m = await import("/src/features/lists/lists.functions.ts");
				const rows = await m.listTripListItems({ data: { tripId } });
				return rows.some((r: { text: string }) => r.text === "Whetstone #1000");
			}, c.tripId),
		)
		.toBe(true);
	await page.reload();
	await expectLive(page);
	await page.getByTestId(TESTID.inspector).getByRole("tab", { name: "Lists" }).click();
	await panel.getByTestId(L.kindShopping).click();
	await expect(rows).toHaveText([/Petty knife/, /Whetstone #1000/]);
	const whetstone = rows.filter({ hasText: "Whetstone" });
	await whetstone.hover();
	const grip = whetstone.getByTestId(L.rowGrip);
	const from = await grip.boundingBox();
	const to = await rows.filter({ hasText: "Petty knife" }).boundingBox();
	if (!from || !to) throw new Error("no boxes");
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(from.x + from.width / 2, from.y - 6, { steps: 4 });
	await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 12 });
	// dnd-kit resolves what's under the pointer on the next frames.
	await page.waitForTimeout(250);
	await page.mouse.up();
	await expect(rows).toHaveText([/Whetstone #1000/, /Petty knife/]);
	// Saved on the server (the list read is ordered by position).
	await expect
		.poll(() =>
			page.evaluate(async (tripId) => {
				const m = await import("/src/features/lists/lists.functions.ts");
				const rows = await m.listTripListItems({ data: { tripId } });
				return rows
					.filter((r: { text: string }) => /Whetstone|Petty/.test(r.text))
					.map((r: { text: string }) => r.text)
					.join(" < ");
			}, c.tripId),
		)
		.toBe("Whetstone #1000 < Petty knife");
	await page.reload();
	await expectLive(page);
	await page.getByTestId(TESTID.inspector).getByRole("tab", { name: "Lists" }).click();
	await panel.getByTestId(L.kindShopping).click();
	await expect(panel.getByTestId(L.row)).toHaveText([/Whetstone #1000/, /Petty knife/]);
});

test("a wide panel shows both lists side by side", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	await page.setViewportSize({ width: 1920, height: 1080 });
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=lists`);
	await expectLive(page);
	const tab = page.getByTestId(TESTID.listsTab);
	await expect(tab).toBeVisible();
	// WP-Shell's centre panel is resizable (440–720); widen it the way a drag would.
	await tab.evaluate((el) => {
		let panel: HTMLElement | null = el;
		const w = el.getBoundingClientRect().width;
		while (panel?.parentElement && panel.parentElement.getBoundingClientRect().width <= w + 1)
			panel = panel.parentElement;
		if (panel) {
			panel.style.width = "720px";
			panel.style.maxWidth = "720px";
			panel.style.flex = "0 0 720px";
		}
	});
	await expect(tab.getByTestId("rollup-todo")).toBeVisible();
	await expect(tab.getByTestId("rollup-shopping")).toBeVisible();
	await expect(tab.getByText("Get a Suica card")).toBeVisible();
	await expect(tab.getByText("Petty knife")).toBeVisible();
	await page.screenshot({ path: shotPath("lists/side-by-side-1920.png"), animations: "disabled" });
});

test("mobile: the Lists tab in the sheet", async ({ page }, info) => {
	test.skip(info.project.name !== "mobile", "mobile layout");
	await page.setViewportSize({ width: 390, height: 844 });
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=lists`);
	await expectLive(page);
	const sheet = page.getByTestId(TESTID.mobileSheet);
	// The tab content is inert (and aria-hidden) at the peek: drag the sheet up
	// from its handle until it isn't.
	const content = sheet.getByTestId(TESTID.centerTabs).locator("xpath=..");
	await expect(async () => {
		const box = await sheet.boundingBox();
		if (!box) throw new Error("no sheet");
		await page.mouse.move(box.x + box.width / 2, box.y + 8);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2, 120, { steps: 12 });
		await page.mouse.up();
		await expect(content).not.toHaveAttribute("aria-hidden", "true", { timeout: 2_000 });
	}).toPass({ timeout: 20_000 });
	await expect(sheet.getByTestId(TESTID.listsTab)).toBeVisible();
	await expect(sheet.getByText("Get a Suica card")).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: shotPath("lists/root-mobile.png"), animations: "disabled" });
	await sheet.getByTestId(L.kindShopping).click();
	await expect(sheet.getByText("Petty knife")).toBeVisible();
	await page.screenshot({ path: shotPath("lists/shopping-mobile.png"), animations: "disabled" });
	// The Notes tab in the same sheet.
	await sheet.getByRole("tab", { name: /Notes/ }).click();
	await expect(sheet.getByTestId(TESTID.notesTab)).toContainText("Passports valid until 2028");
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: shotPath("lists/notes-mobile.png"), animations: "disabled" });
});
