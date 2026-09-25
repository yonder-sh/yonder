/**
 * WP-Money, the expense editor through the UI (EXTENSIONS §8.6): itemize with
 * a 10% service charge (MONEY-14), a points booking with cents per point
 * that stays out of balances (MONEY-08), a refund in the original's
 * proportions (MONEY-15), a private expense Maya never sees (MONEY-12), and
 * "Bought" on a priced shopping item (ADDENDUM §6 shopping link).
 */
import { expect, type Page, test } from "@playwright/test";
import { MONEY_TESTID as M } from "../../../src/features/money/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });
test.beforeEach(({}, info) => {
	test.skip(info.project.name !== "chromium", "desktop editor flows");
});

type Money = {
	expenses: {
		id: string;
		title: string;
		isPrivate: boolean;
		refundOfId: string | null;
		listItemId: string | null;
		splitMode: string;
		shares: { memberId: string; amountMinor: number | null }[];
		lines: { label: string; memberIds: string[] }[];
		points: { program: string; points: number } | null;
	}[];
};

async function callFn<T>(page: Page, fn: string, data: unknown): Promise<T> {
	const r = await page.evaluate(
		async ({ fn, data }) => {
			try {
				const m = await import(/* @vite-ignore */ "/src/features/money/money.functions.ts");
				return { ok: true as const, value: await m[fn]({ data }) };
			} catch (e) {
				return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
			}
		},
		{ fn, data },
	);
	if (!r.ok) throw new Error(`${fn}: ${r.error}`);
	return r.value as T;
}

async function openMoney(page: Page, c: FixtureClone, path = "") {
	await page.goto(`/t/${c.slug}${path}?tab=money`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.moneyTab)).toBeVisible();
}

async function newExpense(page: Page) {
	await page.getByTestId(M.addButton).first().click();
	const dialog = page.getByTestId(TESTID.addExpenseDialog);
	await expect(dialog).toBeVisible();
	return dialog;
}

test("MONEY-14: itemize two dishes with a 10% service charge", async ({ page }) => {
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c, "/japan/tokyo");
	const d = await newExpense(page);
	await d.getByTestId(M.amount).fill("2860");
	await d.getByTestId(M.title).fill("Izakaya");
	await d.getByTestId(M.more).click();
	await d.getByTestId(M.itemize).click();
	const line1 = d.getByTestId(M.line).nth(0);
	await line1.getByTestId(M.lineLabel).fill("Ramen");
	await line1.getByTestId(M.lineAmount).fill("1200");
	// The first line starts with everyone: keep only me.
	await line1.getByTestId(M.linePerson).filter({ hasText: "Audrey" }).click();
	await line1.getByTestId(M.linePerson).filter({ hasText: "Maya" }).click();
	await d.getByTestId(M.addLine).click();
	const line2 = d.getByTestId(M.line).nth(1);
	await line2.getByTestId(M.lineLabel).fill("Beer");
	await line2.getByTestId(M.lineAmount).fill("1400");
	await line2.getByTestId(M.linePerson).filter({ hasText: "Maya" }).click();
	await d.getByTestId(M.addFee).click();
	await expect(d.getByTestId(M.remainder).last()).toContainText("Adds up");
	await page.screenshot({ path: shotPath("money/itemize-1440.png"), animations: "disabled" });
	await d.getByTestId(M.save).click();
	await expect(d).toBeHidden();
	const m = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	const e = m.expenses.find((x) => x.title === "Izakaya");
	expect(e?.lines.map((l) => l.label)).toEqual(["Ramen", "Beer"]);
	expect(e?.lines[0]?.memberIds).toEqual([c.members.owner]);
	await expect(page.getByTestId(M.expenseRow).filter({ hasText: "Izakaya" })).toContainText("split 2");
	expect(logs.messages).toEqual([]);
});

test("MONEY-08: a points booking shows cents per point and never enters balances", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c);
	const d = await newExpense(page);
	await d.getByTestId(M.more).click();
	await d.getByTestId(M.points).click();
	await d.getByLabel("Programme", { exact: true }).fill("Aeroplan");
	await d.getByLabel("Points", { exact: true }).fill("60000");
	await d.getByLabel("Cash price").fill("900");
	await d.getByTestId(M.title).fill("KIX → ICN award");
	await page.screenshot({ path: shotPath("money/points-1440.png"), animations: "disabled" });
	await d.getByTestId(M.save).click();
	await expect(d).toBeHidden();
	await expect(page.getByTestId(M.summary)).toContainText("Aeroplan");
	await expect(page.getByTestId(M.summary)).toContainText("60,000 pts");
	await expect(page.getByTestId(M.summary)).toContainText("1.50¢");
	await expect(page.getByTestId(M.balances)).toContainText("Everyone is square.");
});

test("MONEY-15: Refund… splits back like the original", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c);
	const maya = c.members.maya as string;
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Ghibli Museum",
		category: "activities",
		amountMinor: 3000,
		currency: "JPY",
		split: {
			mode: "exact",
			shares: [
				{ memberId: c.members.owner, amountMinor: 2000 },
				{ memberId: maya, amountMinor: 1000 },
			],
		},
		payments: [
			{
				paidAt: new Date().toISOString(),
				paidTz: "Asia/Tokyo",
				currency: "JPY",
				amountMinor: 3000,
				payers: [{ memberId: c.members.owner, amountMinor: 3000 }],
			},
		],
	});
	await page.reload();
	await expectLive(page);
	await page.getByTestId(M.expenseRow).filter({ hasText: "Ghibli Museum" }).click();
	const d = page.getByTestId(TESTID.addExpenseDialog);
	await d.getByTestId(M.refund).click();
	await expect(d).toContainText("Refund · Ghibli Museum");
	await d.getByTestId(M.amount).fill("600");
	await d.getByTestId(M.save).click();
	await expect(d).toBeHidden();
	const m = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	const r = m.expenses.find((x) => x.refundOfId);
	expect(r?.splitMode).toBe("exact");
	expect(Object.fromEntries(r?.shares.map((s) => [s.memberId, s.amountMinor]) ?? [])).toEqual({
		[c.members.owner]: -400,
		[maya]: -200,
	});
	await expect(page.getByTestId(M.expenseRow).filter({ hasText: "Refund" })).toContainText("-¥600");
});

test("MONEY-12: a private expense is mine alone", async ({ page, browser }) => {
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c);
	const d = await newExpense(page);
	await d.getByTestId(M.amount).fill("18000");
	await d.getByTestId(M.title).fill("Fountain pen (gift)");
	await d.getByTestId(M.more).click();
	await d.getByTestId(M.private).click();
	await expect(d).toContainText("Only you see this.");
	await d.getByTestId(M.save).click();
	await expect(d).toBeHidden();
	const row = page.getByTestId(M.expenseRow).filter({ hasText: "Fountain pen" });
	await expect(row).toContainText("Only you");
	const mayaCtx = await browser.newContext({ storageState: storageStateOf("maya") });
	const maya = await mayaCtx.newPage();
	await maya.goto(`/t/${c.slug}?tab=money`);
	await expectLive(maya);
	const m = await callFn<Money>(maya, "listMoney", { tripId: c.tripId });
	expect(m.expenses.some((e) => e.title.includes("Fountain pen"))).toBe(false);
	await expect(maya.getByTestId(M.expenseRow)).toHaveCount(0);
	await mayaCtx.close();
});

test("shopping link: a priced shopping item is a planned cost until Bought", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c, "/japan/tokyo");
	const shop = page.getByTestId(M.shoppingRow).filter({ hasText: "Petty knife" });
	await expect(shop).toContainText("~¥12,000");
	await expect(page.getByTestId(M.summaryPlanned)).not.toHaveText("$0.00");
	await shop.getByRole("button", { name: "Bought" }).click();
	const d = page.getByTestId(TESTID.addExpenseDialog);
	await expect(d.getByTestId(M.amount)).toHaveValue("12000");
	await expect(d.getByTestId(M.title)).toHaveValue("Petty knife");
	await d.getByTestId(M.save).click();
	await expect(d).toBeHidden();
	await expect(page.getByTestId(M.shoppingRow)).toHaveCount(0);
	const m = await callFn<Money>(page, "listMoney", { tripId: c.tripId });
	expect(m.expenses[0]?.listItemId).toBeTruthy();
	await page.screenshot({ path: shotPath("money/tokyo-1440.png"), animations: "disabled", fullPage: true });
});

test("free-text people: typing a new payer's name adds a placeholder who is owed (ADDENDUM §8)", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c);
	const d = await newExpense(page);
	await d.getByTestId(M.amount).fill("9000");
	await d.getByTestId(M.title).fill("Karaoke");
	// The trip is still ahead, so a new cost starts planned: record it paid.
	await d.getByTestId(M.status).getByRole("radio", { name: "Paid" }).click();
	await d.getByTestId(M.payer).click();
	await page.getByPlaceholder("Search or add a name…").fill("Kenji");
	await page.screenshot({ path: shotPath("money/new-person-1440.png"), animations: "disabled" });
	await page.getByTestId("person-select-add").click();
	await expect(d.getByTestId(M.payer)).toContainText("Kenji");
	await d.getByTestId(M.save).click();
	await expect(d).toBeHidden();
	const m = await callFn<{ expenses: { title: string; payments: { payers: { memberId: string }[] }[] }[] }>(
		page,
		"listMoney",
		{ tripId: c.tripId },
	);
	const payer = m.expenses.find((e) => e.title === "Karaoke")?.payments[0]?.payers[0]?.memberId;
	expect(payer).toBeTruthy();
	expect(Object.values(c.members)).not.toContain(payer);
	await expect(page.getByTestId(M.balances)).toContainText("Kenji");
});

test("MONEY-10: a suggester adds an expense directly; a viewer sees Expense disabled", async ({ browser }) => {
	const owner = await browser.newContext({ storageState: storageStateOf("dev") });
	const c = await cloneFixtureTrip(owner.request, { mayaRole: "suggester" });
	await owner.close();
	const ctx = await browser.newContext({ storageState: storageStateOf("maya") });
	const page = await ctx.newPage();
	await openMoney(page, c);
	const d = await newExpense(page);
	await d.getByTestId(M.amount).fill("1500");
	await d.getByTestId(M.title).fill("Onsen towels");
	await d.getByTestId(M.save).click();
	await expect(d).toBeHidden();
	await expect(page.getByTestId(M.expenseRow).filter({ hasText: "Onsen towels" })).toBeVisible();
	await ctx.close();

	const owner2 = await browser.newContext({ storageState: storageStateOf("dev") });
	const v = await cloneFixtureTrip(owner2.request, { mayaRole: "viewer" });
	await owner2.close();
	const vctx = await browser.newContext({ storageState: storageStateOf("maya") });
	const viewer = await vctx.newPage();
	await openMoney(viewer, v);
	await expect(viewer.getByTestId(M.addButton).first()).toBeDisabled();
	await vctx.close();
});
