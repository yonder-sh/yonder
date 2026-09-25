/**
 * QA I2 "money" verifier, round 3, part b: the Asia 2027 QA seed (db:seed:qa)
 * as Dennis (owner), Kai (viewer), Maya (suggester) and an anonymous edit-link
 * guest; plus the CSV download from the UI and a ₫ settlement. Screenshots
 * only where a person should look. Needs `pnpm db:seed:qa` on this server.
 */
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { MONEY_TESTID as M } from "../../../src/features/money/testids";
import { TESTID } from "../../../src/lib/testids";

const BASE = process.env.APP_URL ?? "http://localhost:5350";
const SHOTS = process.env.QA_SHOTS ?? "/tmp/qa-money-shots";
const MONEY = "/src/features/money/money.functions.ts";
const GRAPH = "/src/functions/graph.functions.ts";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "desktop project only");
});

async function login(request: APIRequestContext, email: string) {
	const H = { Origin: BASE, "Content-Type": "application/json" };
	for (let i = 0; ; i++) {
		const send = await request.post("/api/auth/email-otp/send-verification-otp", { data: { email, type: "sign-in" }, headers: H });
		const sign = send.ok() ? await request.post("/api/auth/sign-in/email-otp", { data: { email, otp: "000000" }, headers: H }) : null;
		if (sign?.ok()) break;
		if (i >= 4) throw new Error(`login ${email}`);
		await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
	}
}
async function userPage(browser: Browser, email: string, viewport = { width: 1440, height: 900 }) {
	const ctx = await browser.newContext({ baseURL: BASE, viewport });
	await login(ctx.request, email);
	return { ctx, page: await ctx.newPage() };
}
async function callFn<T>(page: Page, fn: string, data: unknown, module = MONEY): Promise<T> {
	const r = await page.evaluate(
		async ({ module, fn, data }) => {
			try {
				const m = await import(/* @vite-ignore */ module);
				return { ok: true as const, value: await m[fn]({ data }) };
			} catch (e) {
				return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
			}
		},
		{ module, fn, data },
	);
	if (!r.ok) throw new Error(`${fn}: ${r.error}`);
	return r.value as T;
}
async function waitLive(page: Page) {
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(async () => {
			const s = await page.getByTestId("connection-pill").evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
			return s.length === 0 || s.includes("live") ? "live" : s.join(",");
		}, { timeout: 30_000 })
		.toBe("live");
}
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
type G = { trip: { id: string }; nodes: { id: string; name: string; type: string; slug: string; parentId: string | null }[]; members: { id: string; name: string; role?: string }[] };
const graphOf = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);

test("Asia 2027: Dennis's Money at root, Japan, Vietnam (Local), an item's inspector; CSV download; ₫ settlement", async ({ browser }) => {
	test.setTimeout(240_000);
	const out: Record<string, unknown> = {};
	const d = await userPage(browser, "dennis@asia2027.test");
	const page = d.page;
	await page.goto("/t/asia-2027?tab=money");
	await waitLive(page);
	await expect(page.getByTestId(TESTID.moneyTab).first()).toBeVisible();
	await page.waitForTimeout(800);
	out.root = flat(await page.getByTestId(TESTID.moneyTab).first().innerText()).slice(0, 900);
	await page.screenshot({ path: `${SHOTS}/r3b-asia-root.png`, fullPage: true });
	const g = await graphOf(page);
	const tripId = g.trip.id;
	const country = (name: string) => g.nodes.find((n) => n.type === "country" && n.name === name);
	out.countries = g.nodes.filter((n) => n.type === "country").map((n) => `${n.name}:${n.slug}`);
	out.members = g.members.map((m) => `${m.name}:${m.role ?? ""}`);
	const money = await callFn<{ homeCurrency: string; expenses: { id: string; title: string; isPrivate: boolean; amountMinor: number | null; currency: string | null }[] }>(page, "listMoney", { tripId });
	out.expenses = money.expenses.map((e) => `${e.title} ${e.amountMinor} ${e.currency}${e.isPrivate ? " (private)" : ""}`);
	// CSV through the ⋯ menu
	await page.getByTestId(M.moreMenu).click();
	await page.waitForTimeout(300);
	const dl = page.waitForEvent("download", { timeout: 10_000 }).catch(() => null);
	await page.getByTestId(M.exportCsv).click().catch(async () => page.getByRole("menuitem", { name: /CSV/ }).click());
	const file = await dl;
	out.csvName = file ? file.suggestedFilename() : "no download";
	if (file) {
		const p = await file.path();
		const { readFileSync } = await import("node:fs");
		const txt = p ? readFileSync(p, "utf8") : "";
		out.csvHead = txt.split("\r\n").slice(0, 6);
		out.csvTotal = txt.split("\r\n").find((l) => l.startsWith("Total"));
		out.csvBom = txt.charCodeAt(0) === 0xfeff;
	}
	// Japan and Vietnam with Local
	const jp = country("Japan");
	const vn = country("Vietnam");
	await callFn(page, "setUserPrefs", { displayCurrency: "local" }, "/src/functions/prefs.functions.ts");
	for (const [k, n] of [["japan", jp], ["vietnam", vn]] as const) {
		if (!n) continue;
		await page.goto(`/t/asia-2027/${n.slug}?tab=money`);
		await waitLive(page);
		await page.waitForTimeout(800);
		out[k] = flat(await page.getByTestId(TESTID.moneyTab).first().innerText()).slice(0, 700);
		await page.screenshot({ path: `${SHOTS}/r3b-asia-${k}-local.png`, fullPage: true });
	}
	// a ₫ settlement Audrey → Dennis, tagged to Vietnam
	const audrey = g.members.find((m) => /Audrey/.test(m.name));
	const dennis = g.members.find((m) => /Dennis/.test(m.name));
	// leftovers of an earlier run
	const before = await callFn<{ settlements: { id: string; currency: string; amountMinor: number }[] }>(page, "listMoney", { tripId });
	for (const x of before.settlements.filter((x) => x.currency === "VND" && x.amountMinor === 500000)) await callFn(page, "deleteSettlement", { id: x.id });
	if (audrey && dennis && vn) {
		const s = await callFn<{ id: string }>(page, "createSettlement", { tripId, fromMemberId: audrey.id, toMemberId: dennis.id, amountMinor: 500000, currency: "VND", settledAt: new Date().toISOString(), settledTz: "Asia/Ho_Chi_Minh", method: "cash", scope: { nodeId: vn.id } });
		await page.goto(`/t/asia-2027/${vn.slug}?tab=money`);
		await waitLive(page);
		await page.waitForTimeout(800);
		out.vietnamAfterSettle = flat(await page.getByTestId(TESTID.moneyTab).first().innerText()).slice(0, 700);
		await page.screenshot({ path: `${SHOTS}/r3b-asia-vietnam-after-settle.png`, fullPage: true });
		await page.goto("/t/asia-2027?tab=money");
		await waitLive(page);
		await page.getByTestId(M.settleUpButton).click();
		await page.waitForTimeout(700);
		out.settleVnd = flat(await page.getByTestId(M.settleUpDialog).innerText());
		await page.screenshot({ path: `${SHOTS}/r3b-asia-settle-vnd.png` });
		await page.keyboard.press("Escape");
		await callFn(page, "deleteSettlement", { id: s.id });
	}
	await callFn(page, "setUserPrefs", { displayCurrency: null }, "/src/functions/prefs.functions.ts");
	// phone width
	const ph = await userPage(browser, "dennis@asia2027.test", { width: 390, height: 844 });
	await ph.page.goto("/t/asia-2027?tab=money");
	await waitLive(ph.page);
	await ph.page.waitForTimeout(1000);
	out.phoneOverflow = await ph.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	await ph.page.screenshot({ path: `${SHOTS}/r3b-asia-phone.png` });
	await ph.ctx.close();
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.csvName).not.toBe("no download");
	expect.soft(out.csvBom, "DEFECT: the CSV starts with a UTF-8 BOM so Excel reads › · × ¥ ₫").toBe(true);
	await d.ctx.close();
});

test("Asia 2027: Kai (viewer) reads money without write controls; Maya (suggester) adds directly; the edit-link guest sees none", async ({ browser }) => {
	const out: Record<string, unknown> = {};
	const k = await userPage(browser, "kai@asia2027.test");
	await k.page.goto("/t/asia-2027?tab=money");
	await waitLive(k.page);
	await k.page.waitForTimeout(800);
	const tabVisible = await k.page.getByTestId(TESTID.moneyTab).first().isVisible().catch(() => false);
	out.kaiTab = tabVisible;
	out.kaiAdd = await k.page.locator(`[data-testid="${M.addButton}"]:not([disabled])`).count();
	out.kaiSettle = await k.page.getByTestId(M.settleUpButton).count();
	out.kaiText = tabVisible ? flat(await k.page.getByTestId(TESTID.moneyTab).first().innerText()).slice(0, 500) : "";
	await k.page.screenshot({ path: `${SHOTS}/r3b-asia-kai.png`, fullPage: true });
	if (out.kaiSettle) {
		await k.page.getByTestId(M.settleUpButton).first().click();
		await k.page.waitForTimeout(600);
		out.kaiRecordButtons = await k.page.locator(`[data-testid="${M.transferRecord}"]:not([disabled])`).count();
		await k.page.screenshot({ path: `${SHOTS}/r3b-asia-kai-settle.png` });
		await k.page.keyboard.press("Escape");
	}
	const g = await graphOf(k.page);
	out.kaiCreate = await callFn(k.page, "createExpense", { tripId: g.trip.id, target: { kind: "trip" }, title: "Kai tries", amountMinor: 100, currency: "USD" }).then(() => null, (e) => String(e).slice(0, 120));
	await k.ctx.close();
	const m = await userPage(browser, "maya@asia2027.test");
	await m.page.goto("/t/asia-2027?tab=money");
	await waitLive(m.page);
	const mg = await graphOf(m.page);
	const created = await callFn<{ id: string }>(m.page, "createExpense", { tripId: mg.trip.id, target: { kind: "trip" }, title: "Maya coffee", amountMinor: 450, currency: "USD" }).catch((e) => ({ id: "", err: String(e) }));
	out.mayaCreate = created;
	const mm = await callFn<{ expenses: { id: string; title: string; isPrivate: boolean }[] }>(m.page, "listMoney", { tripId: mg.trip.id });
	out.mayaSeesPrivate = mm.expenses.filter((e) => e.isPrivate).map((e) => e.title);
	if (created.id) await callFn(m.page, "deleteExpense", { id: created.id });
	await m.ctx.close();
	// anonymous edit-link guest
	const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
	const gp = await ctx.newPage();
	await gp.goto("/join#t=qa-share-token-editor-asia-2027");
	await gp.waitForURL(/\/t\//, { timeout: 30_000 });
	await waitLive(gp);
	await gp.goto("/t/asia-2027?tab=money");
	await waitLive(gp);
	await gp.waitForTimeout(800);
	out.guestTabs = await gp.getByRole("tab").allInnerTexts();
	out.guestMoneyTab = await gp.getByTestId(TESTID.moneyTab).count();
	out.guestWallet = await gp.locator("svg.lucide-wallet").count();
	out.guestList = await callFn(gp, "listMoney", { tripId: mg.trip.id }).then(() => "ALLOWED", (e) => String(e).slice(0, 80));
	out.guestCounts = JSON.stringify(await callFn(gp, "getTripCounts", { tripId: mg.trip.id }, GRAPH).catch((e) => String(e))).slice(0, 300);
	await gp.screenshot({ path: `${SHOTS}/r3b-asia-guest.png` });
	await ctx.close();
	console.log(JSON.stringify(out, null, 1));
	expect.soft(out.kaiAdd).toBe(0);
	expect.soft(out.kaiRecordButtons ?? 0).toBe(0);
	expect.soft(out.kaiCreate).toContain("FORBIDDEN");
	expect.soft((out.mayaCreate as { id?: string }).id).toBeTruthy();
	expect.soft(out.mayaSeesPrivate).toEqual([]);
	expect.soft(out.guestMoneyTab).toBe(0);
	expect.soft(out.guestList).toContain("FORBIDDEN");
	expect.soft(out.guestCounts).not.toMatch(/money|expense/i);
});
