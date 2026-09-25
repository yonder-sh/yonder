/**
 * WP-Money (EXTENSIONS §8.6, QA MONEY-*): the Money tab at a scope and at the
 * trip root, fast entry of a ¥ expense (currency from the place's country,
 * equal split, remainder to the payer), a deposit then "Mark paid", settle-up,
 * the budget section, the display currency incl. "Local", and a guest who
 * never sees money. Each test clones its own trip (SPEC §18.5).
 */
import { expect, type Page, test } from "@playwright/test";
import { MONEY_TESTID as M } from "../../../src/features/money/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";
import { collectConsole, expectLive, expectNoHorizontalOverflow } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

const MONEY = "/src/features/money/money.functions.ts";

/** Calls a money server function from inside the page (the real HTTP path). */
async function callFn<T>(page: Page, fn: string, data: unknown): Promise<T> {
	const r = await page.evaluate(
		async ({ module, fn, data }) => {
			try {
				const m = await import(/* @vite-ignore */ module);
				return { ok: true as const, value: await m[fn]({ data }) };
			} catch (e) {
				return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
			}
		},
		{ module: MONEY, fn, data },
	);
	if (!r.ok) throw new Error(`${fn}: ${r.error}`);
	return r.value as T;
}

const now = () => new Date().toISOString();

/** This tab skips its own live events: after seeding through a server function, reload. */
async function reloadMoney(page: Page) {
	await page.reload();
	await expectLive(page);
	await expect(page.getByTestId(TESTID.moneyTab)).toBeVisible();
}

async function openMoney(page: Page, c: FixtureClone, path = "") {
	await page.goto(`/t/${c.slug}${path}${path.includes("?") ? "&" : "?"}tab=money`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.moneyTab)).toBeVisible();
}

test("MONEY-01/02: a ¥ expense in Kyoto — JPY by default, split equally, in the Kyoto and Japan rollups", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c, "/japan/kyoto");
	await expect(page.getByText("No expenses in Kyoto yet.")).toBeVisible();

	await page.getByTestId(M.addButton).first().click();
	const dialog = page.getByTestId(TESTID.addExpenseDialog);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId(M.currency)).toHaveText(/JPY/);
	await dialog.getByTestId(M.amount).fill("1000");
	await dialog.getByTestId(M.title).fill("Kiyomizu-dera tickets");
	await expect(dialog.getByTestId(M.converted)).toContainText("≈ $");
	// The demo trip is in the future, so new costs start as Planned: record it as paid.
	await dialog.getByTestId(M.status).getByRole("radio", { name: "Paid" }).click();
	await dialog.getByTestId(M.splitToggle).click();
	await page.screenshot({ path: shotPath("money/add-expense-1440.png"), animations: "disabled" });
	await dialog.getByTestId(M.save).click();
	await expect(dialog).toBeHidden();

	const row = page.getByTestId(M.expenseRow).filter({ hasText: "Kiyomizu-dera tickets" });
	await expect(row).toBeVisible();
	await expect(row).toContainText("¥1,000");
	await expect(row).toContainText("split 3");
	await expect(page.getByTestId(M.summaryActual)).toContainText("$");

	// The same expense rolls up into Japan, not into Tokyo.
	await page.goto(`/t/${c.slug}/japan?tab=money`);
	await expect(page.getByTestId(M.expenseRow).filter({ hasText: "Kiyomizu-dera tickets" })).toBeVisible();
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=money`);
	await expect(page.getByTestId(M.shoppingRow)).toHaveCount(1); // Tokyo has a priced shopping item
	await expect(page.getByTestId(M.expenseRow)).toHaveCount(0);

	// MONEY-01: the 3-way split's leftover yen went to the payer (me).
	const money = await callFn<{ expenses: { shares: unknown[]; payments: { payers: { memberId: string }[] }[] }[] }>(
		page,
		"listMoney",
		{ tripId: c.tripId },
	);
	expect(money.expenses[0]?.shares).toHaveLength(3);
	expect(money.expenses[0]?.payments[0]?.payers[0]?.memberId).toBe(c.members.owner);
	expect(logs.messages).toEqual([]);
});

test("MONEY-16/03: a deposit, then Mark paid; settle-up records a payment and squares everyone", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c);
	const maya = c.members.maya as string;
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "day", dayId: c.ids.days.d3 },
		title: "Kawaguchiko Ryokan",
		category: "lodging",
		amountMinor: 60_000,
		currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: c.members.owner }, { memberId: maya }] },
		payments: [
			{
				paidAt: now(),
				paidTz: "Asia/Tokyo",
				currency: "JPY",
				amountMinor: 10_000,
				payers: [{ memberId: maya, amountMinor: 10_000 }],
			},
		],
	});
	await reloadMoney(page);
	const row = page.getByTestId(M.expenseRow).filter({ hasText: "Kawaguchiko Ryokan" });
	await expect(row).toBeVisible();
	await expect(row).toContainText("¥10K of ¥60K");
	await row.click();
	const dialog = page.getByTestId(TESTID.addExpenseDialog);
	await expect(dialog.getByTestId(M.paymentRow)).toHaveCount(1);
	await page.screenshot({ path: shotPath("money/edit-expense-1440.png"), animations: "disabled" });
	await dialog.getByTestId(M.markPaid).click();
	await expect(dialog).toBeHidden();
	await expect(row).toHaveAttribute("data-status", "paid");

	// Maya paid ¥10k, I paid ¥50k, split 50/50 → Maya owes me ¥20k (in USD).
	await expect(page.getByTestId(M.balances)).toContainText("Maya owes you");
	await page.screenshot({ path: shotPath("money/trip-root-1440.png"), animations: "disabled", fullPage: true });
	await page.getByTestId(M.settleUpButton).click();
	const settle = page.getByTestId(M.settleUpDialog);
	await expect(settle.getByTestId(M.transferRow)).toHaveCount(1);
	await settle.getByTestId(M.transferRecord).click();
	await settle.getByRole("button", { name: "Record payment" }).click();
	await expect(settle.getByText("Everyone is square.")).toBeVisible();
	await expect(settle.getByTestId(M.settlementRow)).toHaveCount(1);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId(M.balances)).toContainText("Everyone is square.");
});

test("budgets: a trip default, my own override with Reset, and the group view", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c, "/japan");
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "item", itemId: c.ids.items.kiyomizu },
		amountMinor: 30_000,
		currency: "JPY",
		category: "activities",
	});
	await reloadMoney(page);
	const budget = page.getByTestId(M.budget);
	await expect(budget).toContainText("No budget for Japan yet.");
	await budget.getByRole("button", { name: "Set a budget" }).click();
	await page.getByLabel("Amount (USD)").fill("1500");
	await page.getByRole("button", { name: "Save" }).click();
	const all = budget.locator(`[data-testid=${M.budgetRow}][data-category=all]`);
	await expect(all).toHaveAttribute("data-source", "default");
	await expect(all).toContainText("$1.5K");
	// My own value replaces it for me only.
	await all.getByTestId(M.budgetEdit).click();
	await page.getByRole("radio", { name: "Just me" }).click();
	await page.getByLabel("Amount (USD)").fill("1200");
	await page.getByRole("button", { name: "Save" }).click();
	await expect(all).toHaveAttribute("data-source", "custom");
	await expect(all).toContainText("Custom");
	await page.screenshot({ path: shotPath("money/budget-1440.png"), animations: "disabled", fullPage: true });
	await all.getByTestId(M.budgetEdit).click();
	await page.getByRole("button", { name: "Reset to trip default" }).click();
	await expect(all).toHaveAttribute("data-source", "default");
	await budget.getByRole("radio", { name: "Group" }).click();
	await expect(all).toContainText("$4.5K"); // 3 people × $1,500
});

test("MONEY-19: display in Local shows ¥ inside Japan and the home currency at the root", async ({
	page,
	browser,
}, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	// Maya's own display preference, so parallel specs of the dev user never see it.
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c, "/japan/tokyo");
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "item", itemId: c.ids.items.itoya },
		amountMinor: 4_500,
		currency: "JPY",
		payments: [
			{
				paidAt: now(),
				paidTz: "Asia/Tokyo",
				currency: "JPY",
				amountMinor: 4_500,
				payers: [{ memberId: c.members.owner, amountMinor: 4_500 }],
			},
		],
	});
	const mayaCtx = await browser.newContext({ storageState: storageStateOf("maya") });
	const maya = await mayaCtx.newPage();
	await openMoney(maya, c, "/japan/tokyo");
	await expect(maya.getByTestId(M.summaryActual)).toContainText("$");
	await maya.getByTestId(M.displayCurrency).click();
	await maya.getByRole("option", { name: /Local/ }).click();
	await expect(maya.getByTestId(M.summaryActual)).toContainText("¥");
	await expect(maya.getByTestId(M.displayCurrency)).toContainText("Local · JPY");
	await maya.goto(`/t/${c.slug}?tab=money`);
	await expect(maya.getByTestId(M.summaryActual)).toContainText("$");
	// Back to home for the next run.
	await maya.getByTestId(M.displayCurrency).click();
	await maya.getByRole("option", { name: /Home currency/ }).click();
	await expect(maya.getByTestId(M.displayCurrency)).toContainText("USD");
	await mayaCtx.close();
});

test("MONEY-04: a guest sees no Money tab and listMoney refuses them", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const owner = await browser.newContext({ storageState: storageStateOf("dev") });
	const c = await cloneFixtureTrip(owner.request);
	await owner.close();
	const guestCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const guest = await guestCtx.newPage();
	await guest.goto(`/join#t=${c.shareTokens.editor}`);
	await expect(guest.getByTestId(TESTID.workspace)).toBeVisible({ timeout: 30_000 });
	await expect(guest.getByTestId(TESTID.centerTabs).getByRole("tab", { name: /Money/ })).toHaveCount(0);
	await expect(callFn(guest, "listMoney", { tripId: c.tripId })).rejects.toThrow(/permission|403|FORBIDDEN/i);
	await guestCtx.close();
});

test("mobile: fast entry in the drawer (amount → save) and the tab at 390 px", async ({ page }, info) => {
	test.skip(info.project.name !== "mobile", "phone layout");
	const c = await cloneFixtureTrip(page.request);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=money`);
	await expectLive(page);
	// Pull the bottom sheet up to its full snap (the same store the drag handle drives).
	await page.evaluate(async () => {
		const m = await import(/* @vite-ignore */ "/src/lib/workspace/ui-store.ts");
		m.useUi.getState().setSheetSnap(0.92);
	});
	const tab = page.getByTestId(TESTID.moneyTab);
	await expect(tab).toBeVisible();
	await tab.getByTestId(M.addButton).first().click();
	const drawer = page.getByTestId(TESTID.addExpenseDialog);
	await expect(drawer).toBeVisible();
	await expect(drawer.getByTestId(M.currency)).toHaveText(/JPY/);
	await drawer.getByTestId(M.amount).fill("2400");
	await drawer.getByTestId(M.status).getByRole("radio", { name: "Paid" }).click();
	await page.waitForTimeout(400); // the drawer's slide-in
	await page.screenshot({ path: shotPath("money/add-expense-390.png"), animations: "disabled" });
	// Enter saves (the dev-only devtools badge covers the corner where Save sits).
	await drawer.getByTestId(M.amount).press("Enter");
	await expect(drawer).toBeHidden();
	await expect(tab.getByTestId(M.expenseRow)).toHaveCount(1);
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: shotPath("money/tab-390.png"), animations: "disabled" });
});
