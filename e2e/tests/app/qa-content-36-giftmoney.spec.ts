/**
 * I2 "content" verifier, round 2: a private gift item bought → its expense
 * starts private (ADDENDUM §10 "Gift privacy") and never reaches Audrey's
 * Money; nobody else can hang an expense on the private item.
 */
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { expectLive } from "./_helpers/page";

test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");
const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
async function ctxFor(browser: Browser, h: string) {
	const ctx = await browser.newContext({ storageState: path.join(AUTH, `${h}.json`), viewport: { width: 1440, height: 900 } });
	return { ctx, page: await ctx.newPage() };
}
async function call<T>(page: Page, mod: string, fn: string, data: unknown): Promise<T> {
	return page.evaluate(
		async ({ mod, fn, data }) => {
			const m = await import(mod);
			try {
				return await m[fn]({ data });
			} catch (e) {
				return { __error: (e as Error).message };
			}
		},
		{ mod, fn, data },
	) as Promise<T>;
}
const LISTS = "/src/features/lists/lists.functions.ts";
const MONEY = "/src/features/money/money.functions.ts";

test("gift privacy: the expense of a private item starts private; others can't use the item", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=lists&list=shopping");
	await expectLive(d.page);
	const g = await d.page.evaluate(() => (window as unknown as { __yonder: { graph: { trip: { id: string }; nodes: { id: string; name: string }[] } } }).__yonder.graph);
	const kap = g.nodes.find((n) => n.name === "Kappabashi Street");
	const gift = await call<{ id?: string }>(d.page, LISTS, "createListItem", { tripId: g.trip.id, target: { kind: "node", nodeId: kap?.id }, list: "shopping", text: "GIFTX knife for Audrey", isPrivate: true, priceAmount: 18000, priceCurrency: "JPY" });
	console.log("gift", JSON.stringify(gift).slice(0, 120));
	// Tick it through the UI: the "Add expense" offer shows.
	await d.page.reload();
	await expectLive(d.page);
	const row = d.page.getByTestId(L.row).filter({ hasText: "GIFTX" }).first();
	await row.scrollIntoViewIfNeeded();
	console.log("row data-private:", await row.getAttribute("data-private"));
	await row.getByTestId(L.rowCheck).click();
	await d.page.waitForTimeout(800);
	const offer = d.page.getByTestId(L.boughtExpense).first();
	console.log("Add expense offered:", await offer.isVisible().catch(() => false));
	await shot(d.page, "36-gift-bought");
	const exp = await call<{ id?: string; __error?: string }>(d.page, MONEY, "createExpense", { tripId: g.trip.id, target: { kind: "node", nodeId: kap?.id }, title: "GIFTX expense", amountMinor: 18000, currency: "JPY", listItemId: gift.id });
	console.log("expense from private item:", JSON.stringify(exp));
	const dm = await call<{ expenses?: { id: string; title: string | null; isPrivate: boolean }[] }>(d.page, MONEY, "listMoney", { tripId: g.trip.id });
	const mine = (dm.expenses ?? []).find((e) => e.id === exp.id);
	console.log("Dennis sees it, private =", mine?.isPrivate);
	const a = await ctxFor(browser, "audrey");
	await a.page.goto("/t/asia-2027?tab=money");
	await expectLive(a.page);
	const am = await call(a.page, MONEY, "listMoney", { tripId: g.trip.id });
	const leaked = /GIFTX/.test(JSON.stringify(am));
	console.log("Audrey's money mentions GIFTX:", leaked);
	await a.page.waitForTimeout(1000);
	console.log("Audrey's Money tab mentions GIFTX:", /GIFTX/.test(await a.page.locator("body").innerText()));
	await shot(a.page, "36-audrey-money");
	// Audrey tries to hang her own expense on Dennis's private item.
	const steal = await call(a.page, MONEY, "createExpense", { tripId: g.trip.id, target: { kind: "trip" }, title: "mine", amountMinor: 100, currency: "JPY", listItemId: gift.id });
	console.log("Audrey expense on private item:", JSON.stringify(steal).slice(0, 160));
	expect(mine?.isPrivate).toBe(true);
	expect(leaked).toBe(false);
	expect(JSON.stringify(steal)).toMatch(/__error/);
	await d.ctx.close();
	await a.ctx.close();
});
