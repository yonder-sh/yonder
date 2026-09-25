/**
 * I2 "content" verifier: QA LIST-01…06 on the imported Asia 2027 trip, with
 * two real browsers (Dennis + Audrey).
 */
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";
import { openLink } from "./_helpers/link";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
const state = (h: string) => path.join(AUTH, `${h}.json`);

type G = {
	trip: { id: string };
	nodes: { id: string; name: string }[];
	items: { id: string; nodeId: string | null; dayId: string | null; title: string | null }[];
	days: { id: string; date: string }[];
	legs: { id: string; kind: string; fromItemId: string | null; toItemId: string | null; mode: string | null; details: Record<string, unknown> | null }[];
	members: { id: string; name: string; userId: string | null; status: string }[];
};
export async function graphOf(page: Page): Promise<G> {
	return page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
}
async function ctxFor(browser: Browser, h: string) {
	const ctx = await browser.newContext({ storageState: state(h), viewport: { width: 1440, height: 900 } });
	return { ctx, page: await ctx.newPage() };
}
const row = (scope: Page | ReturnType<Page["getByTestId"]>, text: string | RegExp) =>
	scope.getByTestId(L.row).filter({ hasText: text });

async function inspectorLists(page: Page, sel: string) {
	await page.goto(`/t/asia-2027?sel=${sel}`);
	await expectLive(page);
	await page.getByTestId(TESTID.inspector).getByRole("tab", { name: "Lists" }).click();
	const panel = page.getByTestId(TESTID.listsPanel);
	await expect(panel).toBeVisible();
	return panel;
}

async function addIn(page: Page, panel: ReturnType<Page["getByTestId"]>, text: string) {
	const input = panel.getByTestId(L.add).getByTestId(TESTID.mentionInput);
	await input.click();
	await page.keyboard.type(text);
	await page.keyboard.press("Enter");
	await expect(row(panel, text)).toBeVisible();
}

test("LIST-01 a todo on Bar Benfiddich syncs to Audrey; check/uncheck persists", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	const g = await graphOf(d.page);
	const benf = g.nodes.find((n) => n.name === "Bar Benfiddich");
	if (!benf) throw new Error("no Bar Benfiddich");
	const dp = await inspectorLists(d.page, `n.${benf.id}`);
	const a = await ctxFor(browser, "audrey");
	const ap = await inspectorLists(a.page, `n.${benf.id}`);
	const text = "Reserve on TableCheck (≈15 seats)";
	await addIn(d.page, dp, text);
	const t0 = Date.now();
	await expect(row(ap, text)).toBeVisible({ timeout: 5_000 });
	console.log("LIST-01 sync ms", Date.now() - t0);
	await row(dp, text).getByTestId(L.rowCheck).click();
	await expect(row(dp, text)).toHaveAttribute("data-status", "done");
	const t1 = Date.now();
	// A remote tick folds the row into "1 done" on Audrey's side.
	await expect(row(ap, text)).toHaveCount(0, { timeout: 5_000 });
	console.log("LIST-01 tick sync ms", Date.now() - t1);
	await expect(ap.getByTestId(L.doneFold).first()).toContainText(/\d+ done/);
	await shot(a.page, "12-list01-audrey-done");
	await row(dp, text).getByTestId(L.rowCheck).click();
	await expect(row(dp, text)).toHaveAttribute("data-status", "open");
	await expect(row(ap, text)).toHaveAttribute("data-status", "open", { timeout: 5_000 });
	await d.page.reload();
	await expectLive(d.page);
	await d.page.getByTestId(TESTID.inspector).getByRole("tab", { name: "Lists" }).click();
	await expect(row(d.page.getByTestId(TESTID.listsPanel), text)).toHaveAttribute("data-status", "open");
	await shot(d.page, "12-list01-dennis-reload");
	await d.ctx.close();
	await a.ctx.close();
});

test("LIST-02/03 todos on the Fuji Excursion leg, NH 9, Sat 2 Oct and the trip", async ({ browser }) => {
	const a = await ctxFor(browser, "audrey");
	await a.page.goto("/t/asia-2027?tab=plan");
	await expectLive(a.page);
	const g = await graphOf(a.page);
	const itemTitle = (id: string | null) => g.items.find((i) => i.id === id)?.title ?? g.nodes.find((n) => n.id === g.items.find((i) => i.id === id)?.nodeId)?.name;
	const legs = g.legs.map((l) => `${l.id} ${l.kind} ${l.mode} ${itemTitle(l.fromItemId)} -> ${itemTitle(l.toItemId)} ${JSON.stringify(l.details)?.slice(0, 120)}`);
	console.log(legs.filter((l) => /Fuji|flight|NH|Drop bags|JFK|HND/i.test(l)).join("\n"));
	const fuji = g.legs.find((l) => /Fuji Excursion/.test(JSON.stringify(l.details ?? {})) || itemTitle(l.toItemId) === "Drop bags at ryokan");
	const nh9 = g.legs.find((l) => l.mode === "flight" && /NH ?9\b/.test(JSON.stringify(l.details ?? {})));
	if (!fuji || !nh9) throw new Error(`legs fuji=${!!fuji} nh9=${!!nh9}`);
	const ap = await inspectorLists(a.page, `l.${fuji.fromItemId}.${fuji.toItemId}`);
	await shot(a.page, "12-list02-leg-panel");
	await addIn(a.page, ap, "Buy Fuji Excursion seats (open 1 month ahead)");
	// The leg's todo badge in the timeline (Plan tab, Thu 7 Oct).
	await a.page.goto(`/t/asia-2027?tab=plan&sel=l.${fuji.fromItemId}.${fuji.toItemId}`);
	await expectLive(a.page);
	await a.page.waitForTimeout(1500);
	const legRow = a.page.getByTestId(TESTID.leg).filter({ has: a.page.locator(`[data-leg-id="${fuji.id}"]`) });
	console.log("leg rows with data-leg-id", await legRow.count());
	await shot(a.page, "12-list02-plan-leg");
	// LIST-03: NH 9, the day, the trip.
	const nhPanel = await inspectorLists(a.page, `l.${nh9.fromItemId}.${nh9.toItemId}`);
	await addIn(a.page, nhPanel, "Select seats 8D/8G");
	const sat = g.days.find((d) => d.date === "2027-10-02");
	if (!sat) throw new Error("no Sat 2 Oct");
	const dayPanel = await inspectorLists(a.page, `d.${sat.id}`);
	await addIn(a.page, dayPanel, "Charge phones");
	await shot(a.page, "12-list03-day-panel");
	await a.page.goto("/t/asia-2027?tab=lists");
	await expectLive(a.page);
	const tab = a.page.getByTestId(TESTID.listsTab);
	await tab.getByTestId(L.add).getByTestId(TESTID.mentionInput).click();
	await a.page.keyboard.type("Transfer Chase → Aeroplan before 30 Sep 2026");
	await a.page.keyboard.press("Enter");
	for (const t of ["Select seats 8D/8G", "Charge phones", "Transfer Chase → Aeroplan before 30 Sep 2026", "Buy Fuji Excursion seats (open 1 month ahead)"]) {
		const r = row(tab, t);
		await expect(r).toBeVisible();
		console.log("ROW", t, "=>", (await r.innerText()).replace(/\n/g, " | "));
	}
	await shot(a.page, "12-list03-root");
	await a.ctx.close();
});

test("LIST-04 Kitchen knives: bought + ¥25,000, Audrey sees it", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027/japan/tokyo/asakusa/kappabashi-street?tab=lists&list=shopping");
	await expectLive(d.page);
	const a = await ctxFor(browser, "audrey");
	await a.page.goto("/t/asia-2027/japan/tokyo/asakusa/kappabashi-street?tab=lists&list=shopping");
	await expectLive(a.page);
	const tab = d.page.getByTestId(TESTID.listsTab);
	const knives = row(tab, "Kitchen knives");
	await expect(knives).toBeVisible();
	await knives.hover();
	await knives.getByTestId(L.rowMenu).click();
	await d.page.getByRole("menuitem", { name: /Quantity & budget/ }).click();
	await shot(d.page, "12-list04-price-editor");
	await d.page.getByLabel("Budget amount").fill("25000");
	await d.page.getByRole("button", { name: "Save" }).click();
	await expect(knives).toContainText("¥25,000");
	await knives.getByTestId(L.rowCheck).click();
	await expect(knives).toHaveAttribute("data-status", "done");
	await shot(d.page, "12-list04-dennis-bought");
	const ak = row(a.page.getByTestId(TESTID.listsTab), "Kitchen knives");
	// Audrey: after the linger it folds away into "N done"; check the server truth and the fold.
	await expect
		.poll(
			() =>
				a.page.evaluate(async () => {
					const m = await import("/src/features/lists/lists.functions.ts");
					const y = (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder;
					const rows = await m.listTripListItems({ data: { tripId: y.graph.trip.id } });
					const k = rows.find((r: { text: string }) => r.text === "Kitchen knives");
					return `${k?.status} ${k?.priceAmount} ${k?.priceCurrency}`;
				}),
			{ timeout: 5_000 },
		)
		.toBe("done 25000 JPY");
	await a.page.waitForTimeout(1500);
	console.log("Audrey knives rows visible:", await ak.count());
	await shot(a.page, "12-list04-audrey");
	const fold = a.page.getByTestId(L.doneFold).first();
	if (await fold.count()) {
		await fold.click();
		await a.page.waitForTimeout(400);
		await shot(a.page, "12-list04-audrey-done-open");
		console.log("Audrey knives text", await ak.innerText().catch(() => "none"));
	}
	await d.ctx.close();
	await a.ctx.close();
});

test("LIST-05 For picker offers members only, never a guest", async ({ browser }) => {
	// Guest-E joins through the edit link first.
	const gctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const guest = await gctx.newPage();
	await openLink(guest, "asia-2027", "editor");
	await expect(guest).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
	await expectLive(guest);
	const a = await ctxFor(browser, "audrey");
	await a.page.goto("/t/asia-2027/japan/tokyo/asakusa/kappabashi-street?tab=lists&list=shopping");
	await expectLive(a.page);
	const tab = a.page.getByTestId(TESTID.listsTab);
	await tab.getByTestId(L.add).getByTestId(TESTID.mentionInput).click();
	await a.page.keyboard.type("Donabe lid");
	await a.page.keyboard.press("Enter");
	const r = row(tab, "Donabe lid");
	await expect(r).toBeVisible();
	await r.hover();
	await r.getByTestId(L.rowMenu).click();
	await a.page.getByRole("menuitem", { name: /For…/ }).click();
	await a.page.waitForTimeout(500);
	await shot(a.page, "12-list05-for-picker");
	const opts = await a.page.locator("[role=option],[cmdk-item]").allInnerTexts();
	console.log("FOR options", JSON.stringify(opts));
	expect(opts.join("|")).not.toMatch(/Guest/i);
	// Guest's own view of the picker (a link editor may assign members only).
	await guest.goto("/t/asia-2027/japan/tokyo/asakusa/kappabashi-street?tab=lists&list=shopping");
	await expectLive(guest);
	const gr = row(guest.getByTestId(TESTID.listsTab), "Chopsticks");
	await gr.hover();
	await gr.getByTestId(L.rowMenu).click();
	await guest.getByRole("menuitem", { name: /For…/ }).click();
	await guest.waitForTimeout(500);
	const gopts = await guest.locator("[role=option],[cmdk-item]").allInnerTexts();
	console.log("GUEST FOR options", JSON.stringify(gopts));
	await shot(guest, "12-list05-guest-for-picker");
	await guest.keyboard.press("Escape");
	await gctx.close();
	await a.ctx.close();
});

test("LIST-06 rename, reorder, delete sync to Dennis and persist", async ({ browser }) => {
	const url = "/t/asia-2027/japan/tokyo/asakusa/kappabashi-street?tab=lists&list=shopping";
	const d = await ctxFor(browser, "dennis");
	await d.page.goto(url);
	await expectLive(d.page);
	const a = await ctxFor(browser, "audrey");
	await a.page.goto(url);
	await expectLive(a.page);
	const at = a.page.getByTestId(TESTID.listsTab);
	const dt = d.page.getByTestId(TESTID.listsTab);
	// Rename.
	await row(at, "Chopsticks").getByTestId(L.rowText).click();
	await a.page.keyboard.press("End");
	await a.page.keyboard.type(" (2 pairs)");
	await a.page.keyboard.press("Enter");
	await expect(row(at, "Chopsticks (2 pairs)")).toBeVisible();
	await expect(row(dt, "Chopsticks (2 pairs)")).toBeVisible({ timeout: 5_000 });
	// Delete.
	const tongs = row(at, "Self-standing BBQ tongs");
	await tongs.hover();
	await tongs.getByTestId(L.rowMenu).click();
	await a.page.getByRole("menuitem", { name: "Delete" }).click();
	await expect(row(at, "Self-standing BBQ tongs")).toHaveCount(0);
	await expect(row(dt, "Self-standing BBQ tongs")).toHaveCount(0, { timeout: 5_000 });
	// Drag Chopsticks to the top.
	const rows = at.getByTestId(L.row).filter({ hasNot: a.page.locator("[data-status=done]") });
	console.log("before", JSON.stringify(await at.getByTestId(L.rowText).allInnerTexts()));
	const chop = row(at, "Chopsticks (2 pairs)");
	await chop.hover();
	const grip = chop.getByTestId(L.rowGrip);
	const from = await grip.boundingBox();
	const first = await at.getByTestId(L.row).first().boundingBox();
	if (!from || !first) throw new Error("no boxes");
	await a.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await a.page.mouse.down();
	await a.page.mouse.move(from.x + from.width / 2, from.y - 6, { steps: 4 });
	await a.page.mouse.move(from.x + from.width / 2, first.y + 3, { steps: 16 });
	await a.page.waitForTimeout(300);
	await a.page.mouse.up();
	await a.page.waitForTimeout(800);
	const after = await at.getByTestId(L.rowText).allInnerTexts();
	console.log("after (Audrey)", JSON.stringify(after));
	await expect.poll(async () => (await dt.getByTestId(L.rowText).allInnerTexts())[0], { timeout: 5_000 }).toBe("Chopsticks (2 pairs)");
	await d.page.reload();
	await expectLive(d.page);
	const persisted = await d.page.getByTestId(TESTID.listsTab).getByTestId(L.rowText).allInnerTexts();
	console.log("after reload (Dennis)", JSON.stringify(persisted));
	expect(persisted[0]).toBe("Chopsticks (2 pairs)");
	expect(persisted).not.toContain("Self-standing BBQ tongs");
	await shot(d.page, "12-list06-dennis-reload");
	void rows;
	await d.ctx.close();
	await a.ctx.close();
});
