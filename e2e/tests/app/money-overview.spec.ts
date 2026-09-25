/**
 * WP-Money on a realistic trip: ¥, ₩ and USD costs, a deposit, a points
 * booking, a private gift, trip-default and nested budgets, a settlement and
 * then Maya's edit — the owner sees "Balance changed since your last
 * settlement" (MONEY-21), the Japan budget shows its allocation, and the
 * whole tab is captured at 1440 × 900 and 390 × 844.
 */
import { expect, type Page, test } from "@playwright/test";
import { MONEY_TESTID as M } from "../../../src/features/money/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";
import { expectLive, expectNoHorizontalOverflow } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

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

const paid = (amountMinor: number, memberId: string, currency = "JPY", tz = "Asia/Tokyo") => ({
	paidAt: new Date().toISOString(),
	paidTz: tz,
	currency,
	amountMinor,
	payers: [{ memberId, amountMinor }],
});

/** A trip with money in it (owner = dev, Maya = editor, Audrey = placeholder). */
async function seed(page: Page, c: FixtureClone): Promise<{ ramen: string }> {
	const O = c.members.owner;
	const Y = c.members.maya as string;
	const A = c.members.audrey;
	const trip = c.tripId;
	const add = (data: Record<string, unknown>) => callFn<{ id: string }>(page, "createExpense", { tripId: trip, ...data });
	await add({
		target: { kind: "day", dayId: c.ids.days.d3 },
		title: "Kawaguchiko Ryokan",
		category: "lodging",
		amountMinor: 60_000,
		currency: "JPY",
		expectedOn: "2027-10-05",
		payments: [paid(10_000, Y)],
	});
	const ramen = await add({
		target: { kind: "item", itemId: c.ids.items.lunch1 },
		title: "Ramen Ichiran",
		category: "food_drink",
		amountMinor: 3_600,
		currency: "JPY",
		payments: [paid(3_600, O)],
	});
	await add({
		target: { kind: "leg", legId: c.ids.legs.fuji },
		title: "Fuji Excursion",
		amountMinor: 8_000,
		currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: O }, { memberId: Y }] },
		payments: [paid(8_000, Y)],
	});
	await add({
		target: { kind: "item", itemId: c.ids.items.kiyomizu },
		title: "Kiyomizu-dera tickets",
		amountMinor: 1_200,
		currency: "JPY",
		payments: [paid(1_200, O)],
	});
	await add({
		target: { kind: "node", nodeId: c.ids.nodes.seoul },
		title: "Gyeongbokgung hanbok rental",
		category: "activities",
		amountMinor: 45_000,
		currency: "KRW",
		payments: [paid(45_000, A, "KRW", "Asia/Seoul")],
	});
	await add({
		target: { kind: "leg", legId: c.ids.legs.flight },
		title: "KIX → ICN award",
		amountMinor: 5_600,
		currency: "USD",
		points: { program: "Aeroplan", points: 60_000, cashValueMinor: 90_000, cashValueCurrency: "USD" },
		split: { mode: "equal", shares: [{ memberId: O }, { memberId: Y }] },
		payments: [paid(5_600, O, "USD", "America/New_York")],
	});
	await add({
		target: { kind: "node", nodeId: c.ids.nodes.itoya },
		title: "Fountain pen (gift)",
		category: "shopping",
		amountMinor: 18_000,
		currency: "JPY",
		isPrivate: true,
		payments: [paid(18_000, O)],
	});
	const budget = (data: Record<string, unknown>) => callFn(page, "setBudgetLine", { tripId: trip, memberId: null, category: null, kind: "total", ...data });
	await budget({ nodeId: null, amountMinor: 300_000 });
	await budget({ nodeId: c.ids.nodes.japan, amountMinor: 150_000 });
	await budget({ nodeId: c.ids.nodes.tokyo, amountMinor: 60_000 });
	await budget({ nodeId: c.ids.nodes.kyoto, amountMinor: 40_000 });
	await budget({ nodeId: c.ids.nodes.japan, category: "food_drink", amountMinor: 4_000, kind: "per_day" });
	// Maya settles part of what she owes me, in yen.
	await callFn(page, "createSettlement", {
		tripId: trip,
		fromMemberId: Y,
		toMemberId: O,
		amountMinor: 1_000,
		currency: "JPY",
		settledAt: new Date().toISOString(),
		settledTz: "Asia/Tokyo",
		method: "cash",
	});
	return { ramen: ramen.id };
}

test("a trip with money: root, Japan, settle-up and the balance-changed notice (1440)", async ({ page, browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop screenshots");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=money`);
	await expectLive(page);
	const { ramen } = await seed(page, c);
	// MONEY-21: Maya edits Ramen after the settlement.
	const mayaCtx = await browser.newContext({ storageState: storageStateOf("maya") });
	const maya = await mayaCtx.newPage();
	await maya.goto(`/t/${c.slug}?tab=money`);
	await expectLive(maya);
	await callFn(maya, "updateExpense", {
		id: ramen,
		patch: { amountMinor: 4_200, payments: [paid(4_200, c.members.owner)] },
	});
	await mayaCtx.close();

	await page.reload();
	await expectLive(page);
	await expect(page.getByTestId(M.expenseRow)).toHaveCount(7);
	const notice = page.getByTestId(M.balanceNotice);
	await expect(notice).toContainText("Balance changed since your last settlement");
	await expect(notice).toContainText("Maya edited Ramen Ichiran");
	await expect(page.getByTestId(M.summary)).toContainText("Aeroplan");
	await page.screenshot({ path: shotPath("money/root-1440.png"), animations: "disabled" });
	await page.screenshot({ path: shotPath("money/root-1440-full.png"), animations: "disabled", fullPage: true });

	await page.goto(`/t/${c.slug}/japan?tab=money`);
	await expectLive(page);
	const all = page.locator(`[data-testid=${M.budgetRow}][data-category=all]`);
	await expect(all).toContainText("Tokyo");
	await expect(all).toContainText("unallocated");
	await expect(page.getByTestId(M.netPositions)).toContainText("Within Japan");
	await page.screenshot({ path: shotPath("money/japan-1440-full.png"), animations: "disabled", fullPage: true });

	await page.getByTestId(M.netPositions).getByRole("button", { name: /Settle up/ }).click();
	await expect(page.getByTestId(M.settleUpDialog).getByTestId(M.transferRow).first()).toBeVisible();
	await page.screenshot({ path: shotPath("money/settle-1440.png"), animations: "disabled" });
});

test("a trip with money on a phone (390)", async ({ page }, info) => {
	test.skip(info.project.name !== "mobile", "phone screenshots");
	const c = await cloneFixtureTrip(page.request);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/t/${c.slug}?tab=money`);
	await expectLive(page);
	await seed(page, c);
	await page.reload();
	await expectLive(page);
	await page.evaluate(async () => {
		const m = await import(/* @vite-ignore */ "/src/lib/workspace/ui-store.ts");
		m.useUi.getState().setSheetSnap(0.92);
	});
	const tab = page.getByTestId(TESTID.moneyTab);
	await expect(tab.getByTestId(M.expenseRow)).toHaveCount(7);
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: shotPath("money/root-390.png"), animations: "disabled" });
	await tab.getByTestId(M.budget).scrollIntoViewIfNeeded();
	await page.screenshot({ path: shotPath("money/root-390-budget.png"), animations: "disabled" });
	await tab.getByTestId(M.expenseRow).filter({ hasText: "Kawaguchiko Ryokan" }).click();
	const d = page.getByTestId(TESTID.addExpenseDialog);
	await expect(d.getByTestId(M.paymentRow)).toHaveCount(1);
	await page.waitForTimeout(400);
	await page.screenshot({ path: shotPath("money/edit-390.png"), animations: "disabled" });
});
