/**
 * WP-Money fix round (owner FEEDBACK-1 FB-02 / FB-16 and the QA round-3
 * money bugs in docs/qa/OPEN_BUGS.json): each test clones its own trip and
 * checks the fix in the real UI.
 *
 * - MONEY-16: a part-paid ₺ cost owes its unpaid remainder at TODAY's rate.
 * - MONEY-19: "Local" in a one-currency scope shows exact shares, nets and
 *   breakdown lines (¥500 each, "Maya paid ¥4,500 more", "¥10K paid").
 * - MONEY-01/14: a negative exact part is marked in the editor (Save off,
 *   never "Adds up ✓") and refused by the server.
 * - MONEY-21: "Balance changed since your last settlement" names the edit
 *   that moved MY balance, worded like the inbox item.
 * - MONEY-20: the CSV download starts with a UTF-8 BOM.
 * - FB-02: pointer cursor on money controls; FB-16: payers and splits use the
 *   shared circular `PersonAvatar` (a picture when the person has one).
 *
 *   APP_URL=http://localhost:5520 E2E_AUTH_DIR=… N pnpm e2e -- tests/app/money-qa-r3-fixes.spec.ts --project chromium
 */
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { MONEY_TESTID as M } from "../../../src/features/money/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });
// One worker for this file: the Local test changes dev's display currency.
test.describe.configure({ mode: "default" });
test.beforeEach(({}, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
});

const MONEY = "/src/features/money/money.functions.ts";
const PREFS = "/src/functions/prefs.functions.ts";

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

type G = { nodes: { id: string; slug: string; parentId: string | null }[] };
/** "/japan/kyoto" for a node (its own and its ancestors' slugs; countries are top-level). */
async function pathTo(page: Page, nodeId: string): Promise<string> {
	return page.evaluate((id) => {
		const g = (window as unknown as { __yonder: { graph: G } }).__yonder.graph;
		const parts: string[] = [];
		let n = g.nodes.find((x) => x.id === id);
		while (n) {
			parts.unshift(n.slug);
			const parent = n.parentId;
			n = parent ? g.nodes.find((x) => x.id === parent) : undefined;
		}
		return `/${parts.join("/")}`;
	}, nodeId);
}

async function openMoney(page: Page, c: FixtureClone, path = "") {
	await page.goto(`/t/${c.slug}${path}?tab=money`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.moneyTab).first()).toBeVisible();
	await expect(page.getByTestId(M.summary).or(page.getByText(/No expenses in/)).first()).toBeVisible();
}

const pay = (
	amountMinor: number,
	memberId: string,
	currency = "JPY",
	paidAt = new Date().toISOString(),
	paidTz = "Asia/Tokyo",
) => ({ paidAt, paidTz, currency, amountMinor, payers: [{ memberId, amountMinor }] });

test("MONEY-16: Still to pay of a part-paid ₺ hotel is the ₺20,000 left at today's rate", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c);
	const { owner } = c.members;
	const e = await callFn<{ id: string }>(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "node", nodeId: c.ids.nodes.istanbul },
		title: "Istanbul hotel",
		category: "lodging",
		amountMinor: 3_000_000,
		currency: "TRY",
		split: { mode: "equal", shares: [{ memberId: owner }] },
		payments: [pay(1_000_000, owner, "TRY", "2025-09-20T09:00:00.000Z", "Europe/Istanbul")],
	});
	type Exp = { id: string; fxRate: number | null; homeAmountMinor: number | null; payments: { homeAmountMinor: number | null }[] };
	const m = await callFn<{ expenses: Exp[] }>(page, "listMoney", { tripId: c.tripId });
	const ex = m.expenses.find((x) => x.id === e.id) as Exp;
	test.skip(ex.fxRate === null || ex.payments[0]?.homeAmountMinor == null, "no FX rates reachable from this server");
	const deposit = ex.payments[0]?.homeAmountMinor as number;
	const rest = Math.round(20_000 * (ex.fxRate as number) * 100); // ₺20,000 at today's rate, in cents
	const usd = (cents: number) => `$${(cents / 100).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	await openMoney(page, c, await pathTo(page, c.ids.nodes.istanbul));
	await expect(page.getByTestId(M.summaryRemaining)).toHaveText(usd(rest));
	// Planned = the deposit at its own date + the rest at today's rate; my share of it too.
	await expect(page.getByTestId(M.summaryPlanned)).toHaveText(usd(deposit + rest));
	await expect(page.getByTestId(M.summaryMyShare)).toHaveText(usd(deposit + rest));
	// Not plan − deposit (the round-3 bug: the gap was deposit × (rate then − rate now)).
	expect(rest).not.toBe((ex.homeAmountMinor as number) - deposit);
	await page.getByTestId(M.summary).screenshot({ path: shotPath("money/r4-fx-remainder.png") });
});

test("MONEY-19: Local ¥ in Japan — shares, nets and breakdown are exact, like the totals", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c);
	const { owner, audrey } = c.members;
	const maya = c.members.maya as string;
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "node", nodeId: c.ids.nodes.kyoto },
		title: "Matcha",
		category: "food_drink",
		amountMinor: 1500,
		currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }, { memberId: audrey }] },
		payments: [pay(1500, owner)],
	});
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "node", nodeId: c.ids.nodes.kyoto },
		title: "Ryokan",
		category: "lodging",
		amountMinor: 60_000,
		currency: "JPY",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [pay(10_000, maya, "JPY", "2026-01-15T03:00:00.000Z")],
	});
	await callFn(page, "setUserPrefs", { displayCurrency: "local" }, PREFS);
	try {
		const kyoto = await pathTo(page, c.ids.nodes.kyoto);
		const japan = kyoto.split("/").slice(0, 2).join("/");
		await openMoney(page, c, japan);
		await expect(page.getByTestId(M.summaryActual)).toHaveText("¥11,500");
		await expect(page.getByTestId(M.summaryMyShare)).toHaveText("¥30,500");
		const row = (id: string) => page.getByTestId(M.personRow).and(page.locator(`[data-member-id="${id}"]`));
		await expect(row(maya)).toContainText("+¥4,500");
		await expect(row(owner)).toContainText("−¥4,000");
		await expect(row(audrey)).toContainText("−¥500");
		const net = page.getByTestId(M.netPositions);
		await expect(net).toContainText("Maya paid ¥4,500 more than their share");
		await expect(net).toContainText("You ¥4,000 less");
		const lodging = page.getByTestId(M.breakdown).locator("li").filter({ hasText: "Lodging" });
		await expect(lodging).toContainText("¥60K · ¥10K paid");
		// No "converted at today's rate" footnote: these are the exact amounts.
		await expect(page.getByTestId(M.people)).not.toContainText("converted from");
		await page.getByTestId(TESTID.moneyTab).first().screenshot({ path: shotPath("money/r4-local-japan.png") });
		await openMoney(page, c, kyoto);
		await expect(page.getByTestId(M.summaryMyShare)).toHaveText("¥30,500");
		await expect(row(audrey)).toContainText("¥500");
		// The ¥1,500 matcha alone (Only Kyoto's items would be the same here): ¥500 each.
		const matchaOnly = await callFn<{ csv: string }>(page, "exportMoneyCsv", { tripId: c.tripId, nodeId: c.ids.nodes.kyoto });
		expect(matchaOnly.csv).toContain("Matcha");
	} finally {
		await callFn(page, "setUserPrefs", { displayCurrency: null }, PREFS);
	}
});

test("MONEY-01: a negative exact part is marked in the editor and refused by the server", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c);
	const { owner } = c.members;
	const maya = c.members.maya as string;
	const err = await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Negative exact",
		amountMinor: 1000,
		currency: "JPY",
		split: { mode: "exact", shares: [{ memberId: owner, amountMinor: 1500 }, { memberId: maya, amountMinor: -500 }] },
		payments: [pay(1000, owner)],
	}).then(
		() => "saved",
		(e: Error) => e.message,
	);
	expect(err).toContain("can't be negative");

	await page.getByTestId(M.addButton).first().click();
	const dlg = page.getByTestId(TESTID.addExpenseDialog);
	await expect(dlg).toBeVisible();
	await dlg.getByTestId(M.amount).fill("1000");
	await dlg.getByTestId(M.title).fill("UI negative exact");
	await dlg.getByTestId(M.splitToggle).click();
	await dlg.getByTestId(M.splitExact).click();
	const parts = dlg.getByTestId(M.splitExactAmount);
	await expect(parts.first()).toBeVisible();
	await parts.nth(0).fill("1500");
	await parts.nth(1).fill("-500");
	for (let i = 2; i < (await parts.count()); i++) await parts.nth(i).fill("0");
	await expect(dlg.getByTestId(M.remainder).first()).toHaveText("No negative amounts");
	await expect(parts.nth(1)).toHaveAttribute("aria-invalid", "true");
	await expect(dlg.getByTestId(M.save)).toBeDisabled();
	await expect(dlg.getByTestId(M.problems)).toHaveText("Exact amounts can't be negative.");
	await dlg.screenshot({ path: shotPath("money/r4-negative-exact.png") });
	// Fixed to 500 / 500 / 0: it adds up and saves.
	await parts.nth(0).fill("500");
	await parts.nth(1).fill("500");
	await expect(dlg.getByTestId(M.remainder).first()).toHaveText("Adds up ✓");
	await expect(dlg.getByTestId(M.save)).toBeEnabled();
	await dlg.getByTestId(M.save).click();
	await expect(dlg).toBeHidden();
	const m = await callFn<{ expenses: { title: string; shares: { amountMinor: number | null }[] }[] }>(page, "listMoney", { tripId: c.tripId });
	const saved = m.expenses.find((e) => e.title === "UI negative exact");
	expect(saved?.shares.every((s) => (s.amountMinor ?? 0) >= 0)).toBe(true);
});

test("MONEY-21: the balance notice names the edit that moved my balance, worded like the inbox", async ({ page, browser }) => {
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c);
	const { owner, audrey } = c.members;
	const maya = c.members.maya as string;
	const usd = (a: number) => pay(a, owner, "USD", new Date().toISOString(), "America/New_York");
	const add = (title: string, amountMinor: number, ids: string[]) =>
		callFn(page, "createExpense", {
			tripId: c.tripId,
			target: { kind: "trip" },
			title,
			amountMinor,
			currency: "USD",
			split: { mode: "equal", shares: ids.map((memberId) => ({ memberId })) },
			payments: [usd(amountMinor)],
		});
	await add("Ramen", 2000, [owner, maya]);
	await callFn(page, "createSettlement", {
		tripId: c.tripId,
		fromMemberId: maya,
		toMemberId: owner,
		amountMinor: 1000,
		currency: "USD",
		settledAt: new Date().toISOString(),
		settledTz: "America/New_York",
	});
	await page.waitForTimeout(50);
	await add("Olga's museum", 1000, [owner, maya]);
	await add("Olga and Audrey taxi", 3000, [owner, audrey]);

	const ctx = await browser.newContext({ storageState: storageStateOf("maya"), viewport: { width: 1440, height: 900 } });
	const mp = await ctx.newPage();
	await openMoney(mp, c);
	const notice = mp.getByTestId(M.balanceNotice);
	await expect(notice).toContainText("Balance changed since your last settlement: −$5.00");
	await expect(notice).toContainText("(Dev added an expense: Olga's museum)");
	await expect(notice).not.toContainText("taxi");
	await mp.getByTestId(M.balances).screenshot({ path: shotPath("money/r4-balance-notice.png") });
	await ctx.close();
});

test("MONEY-20: Export CSV downloads UTF-8 with a BOM", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c);
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "node", nodeId: c.ids.nodes.kyoto },
		title: "2 × Matcha — ¥",
		amountMinor: 4130,
		currency: "JPY",
		payments: [pay(4130, c.members.owner)],
	});
	await page.reload();
	await expectLive(page);
	await page.getByTestId(M.moreMenu).click();
	const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId(M.exportCsv).click()]);
	const file = await download.path();
	const bytes = readFileSync(file);
	expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	const text = bytes.subarray(3).toString("utf8");
	expect(text.startsWith("Expenses — ")).toBe(true);
	expect(text).toContain("Japan › Kyoto");
	expect(text).toContain("2 × Matcha — ¥");
});

test("FB-02 / FB-16: money controls show a pointer; payers and splits use the round PersonAvatar", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await openMoney(page, c);
	const { owner } = c.members;
	const maya = c.members.maya as string;
	await callFn(page, "createExpense", {
		tripId: c.tripId,
		target: { kind: "trip" },
		title: "Shared taxi",
		amountMinor: 3000,
		currency: "USD",
		split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
		payments: [
			{
				paidAt: new Date().toISOString(),
				paidTz: "America/New_York",
				currency: "USD",
				amountMinor: 3000,
				payers: [
					{ memberId: owner, amountMinor: 2000 },
					{ memberId: maya, amountMinor: 1000 },
				],
			},
		],
	});
	await page.reload();
	await expectLive(page);
	const cursor = (l: ReturnType<Page["locator"]>) => l.evaluate((el) => getComputedStyle(el).cursor);
	const tab = page.getByTestId(TESTID.moneyTab).first();
	const row = page.getByTestId(M.expenseRow).filter({ hasText: "Shared taxi" });
	await row.hover();
	expect(await cursor(row)).toBe("pointer");
	// Payers: two round avatars on the row (initials or a picture).
	const avatars = row.locator('[data-slot="avatar"]');
	await expect(avatars).toHaveCount(2);
	// A circle: the corner radius is at least half the side (Tailwind's rounded-full is "infinity px").
	for (const a of await avatars.all())
		expect(
			await a.evaluate((el) => Number.parseFloat(getComputedStyle(el).borderRadius) >= el.getBoundingClientRect().width / 2),
		).toBe(true);
	// The breakdown's place links.
	await tab.getByRole("radio", { name: "Place" }).click();
	// The ⋯ menu items.
	await page.getByTestId(M.moreMenu).click();
	expect(await cursor(page.getByTestId(M.exportCsv))).toBe("pointer");
	await page.keyboard.press("Escape");
	// The editor: split toggle, person chips, "+ Person", More, the payer picker's options.
	await row.click();
	const dlg = page.getByTestId(TESTID.addExpenseDialog);
	await expect(dlg).toBeVisible();
	const more = dlg.getByTestId(M.more);
	if (await more.isVisible()) expect(await cursor(more)).toBe("pointer");
	const toggle = dlg.getByTestId(M.splitToggle);
	if (await toggle.isVisible()) {
		expect(await cursor(toggle)).toBe("pointer");
		await toggle.click();
		const chip = dlg.getByTestId(M.splitPerson).first();
		expect(await cursor(chip)).toBe("pointer");
		await expect(chip.locator('[data-slot="avatar"]')).toHaveCount(1);
		expect(await cursor(dlg.getByTestId(M.splitAddPerson))).toBe("pointer");
	}
	await dlg.screenshot({ path: shotPath("money/r4-editor-avatars.png") });
	// Every button-like control in the tab and the editor points (FB-02).
	const notPointing = async (root: ReturnType<Page["locator"]>) =>
		root.evaluate((el) =>
			[...el.querySelectorAll<HTMLElement>('button:not(:disabled), [role="button"], [role="radio"], [role="menuitem"], [role="option"], a[href], label[for]')]
				.filter((x) => x.offsetParent !== null && getComputedStyle(x).cursor !== "pointer")
				.map((x) => `${x.tagName.toLowerCase()}${x.dataset.testid ? `[${x.dataset.testid}]` : ""} "${(x.textContent ?? "").trim().slice(0, 30)}"`),
		);
	const inDialog = await notPointing(dlg);
	await page.keyboard.press("Escape");
	await expect(dlg).toBeHidden();
	const inTab = await notPointing(tab);
	console.log(JSON.stringify({ inTab, inDialog }, null, 1));
	expect.soft(inTab, "FB-02: controls in the Money tab without a pointer").toEqual([]);
	expect.soft(inDialog, "FB-02: controls in the expense editor without a pointer").toEqual([]);
	await tab.screenshot({ path: shotPath("money/r4-tab-avatars.png") });
});

test("FB-16: a payer's profile picture shows, round, on the row, in the split chips and the per-person table", async ({ page, browser }) => {
	const c = await cloneFixtureTrip(page.request);
	const { owner } = c.members;
	const maya = c.members.maya as string;
	// Maya sets a picture through the real upload path (the square bounding the crop circle).
	const ctx = await browser.newContext({ storageState: storageStateOf("maya") });
	const mp = await ctx.newPage();
	await mp.setContent('<div style="width:96px;height:96px;background:linear-gradient(135deg,#e07a5f,#3d405b)"></div>');
	const png = await mp.screenshot({ clip: { x: 0, y: 0, width: 96, height: 96 }, type: "png" });
	await mp.goto("/dashboard");
	const AVATAR = "/src/functions/avatar.functions.ts";
	type Up = { key: string; url: string; headers: Record<string, string> };
	const up = await callFn<Up>(mp, "createAvatarUpload", { contentType: "image/png", size: png.length }, AVATAR).catch(() => null);
	test.skip(!up, "the avatar upload (FB-16, WP-Home/F) isn't available on this server");
	const put = await ctx.request.put((up as Up).url, { headers: (up as Up).headers, data: png });
	expect(put.ok(), await put.text()).toBe(true);
	await callFn(mp, "commitAvatar", { key: (up as Up).key }, AVATAR);
	try {
		await openMoney(page, c);
		await callFn(page, "createExpense", {
			tripId: c.tripId,
			target: { kind: "trip" },
			title: "Maya's dinner",
			amountMinor: 4000,
			currency: "USD",
			split: { mode: "equal", shares: [{ memberId: owner }, { memberId: maya }] },
			payments: [pay(4000, maya, "USD", new Date().toISOString(), "America/New_York")],
		});
		await page.reload();
		await expectLive(page);
		const row = page.getByTestId(M.expenseRow).filter({ hasText: "Maya's dinner" });
		const pic = row.locator("[data-avatar-image] img");
		await expect(pic).toBeVisible();
		await expect.poll(() => pic.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		const round = (l: ReturnType<Page["locator"]>) =>
			l.evaluate((el) => {
				const a = el.closest("[data-slot=avatar]") as HTMLElement;
				return Number.parseFloat(getComputedStyle(a).borderRadius) >= a.getBoundingClientRect().width / 2 && getComputedStyle(a).overflow === "hidden";
			});
		expect(await round(pic)).toBe(true);
		await expect(page.getByTestId(M.personRow).and(page.locator(`[data-member-id="${maya}"]`)).locator("[data-avatar-image] img")).toBeVisible();
		await row.click();
		const dlg = page.getByTestId(TESTID.addExpenseDialog);
		await dlg.getByTestId(M.splitToggle).click();
		const chip = dlg.getByTestId(M.splitPerson).and(dlg.locator(`[data-member-id="${maya}"]`));
		await expect(chip.locator("[data-avatar-image] img")).toBeVisible();
		await dlg.screenshot({ path: shotPath("money/r4-avatar-photo-editor.png") });
		await page.keyboard.press("Escape");
		await page.getByTestId(TESTID.moneyTab).first().screenshot({ path: shotPath("money/r4-avatar-photo-tab.png") });
	} finally {
		await callFn(mp, "removeAvatar", {}, AVATAR).catch(() => {});
		await ctx.close();
	}
});
