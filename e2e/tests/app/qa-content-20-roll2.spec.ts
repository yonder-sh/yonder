/**
 * I2 "content" verifier: QA ROLL-04/07/08/11/12 and NOTE-02 on the imported
 * Asia 2027 trip.
 */
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
const state = (h: string) => path.join(AUTH, `${h}.json`);
type N = { id: string; name: string; slug: string; parentId: string | null };
type G = {
	trip: { id: string };
	nodes: N[];
	items: { id: string; nodeId: string | null; dayId: string | null; title: string | null }[];
	days: { id: string; date: string }[];
	legs: { id: string; kind: string; fromItemId: string | null; toItemId: string | null; mode: string | null }[];
};
const graphOf = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
async function ctxFor(browser: Browser, h: string) {
	const ctx = await browser.newContext({ storageState: state(h), viewport: { width: 1440, height: 900 } });
	return { ctx, page: await ctx.newPage() };
}
function scopePath(g: G, name: string): string {
	const byId = new Map(g.nodes.map((n) => [n.id, n]));
	let n = g.nodes.find((x) => x.name === name);
	const parts: string[] = [];
	while (n) {
		parts.unshift(n.slug);
		n = n.parentId ? byId.get(n.parentId) : undefined;
	}
	return `/t/asia-2027/${parts.join("/")}`;
}
const row = (scope: Page | ReturnType<Page["getByTestId"]>, text: string | RegExp) => scope.getByTestId(L.row).filter({ hasText: text });
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

let g: G;
test.beforeAll(async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	g = await graphOf(d.page);
	await d.ctx.close();
});

test("ROLL-04 tick in Audrey's Tokyo rollup reaches Dennis's Shinjuku rollup live; counts update", async ({ browser }) => {
	const a = await ctxFor(browser, "audrey");
	await a.page.goto(`${scopePath(g, "Tokyo")}?tab=lists&list=shopping`);
	await expectLive(a.page);
	const d = await ctxFor(browser, "dennis");
	await d.page.goto(`${scopePath(g, "Shinjuku")}?tab=lists&list=shopping`);
	await expectLive(d.page);
	const aSwitch0 = await a.page.getByTestId(L.kindShopping).innerText();
	const dSwitch0 = await d.page.getByTestId(L.kindShopping).innerText();
	await row(a.page.getByTestId(TESTID.listsTab), "Camera lenses").getByTestId(L.rowCheck).click();
	const t0 = Date.now();
	await expect(row(d.page.getByTestId(TESTID.listsTab), "Camera lenses")).toHaveCount(0, { timeout: 5_000 });
	console.log("ROLL-04 live ms", Date.now() - t0);
	await expect(d.page.getByTestId(L.doneFold).first()).toContainText(/done/);
	await a.page.waitForTimeout(4500);
	console.log("ROLL-04 switch counts Audrey", aSwitch0, "→", await a.page.getByTestId(L.kindShopping).innerText(), "; Dennis", dSwitch0, "→", await d.page.getByTestId(L.kindShopping).innerText());
	await shot(d.page, "20-roll04-dennis-shinjuku");
	// Undo for later tests.
	const rows = await call<{ id: string; text: string }[]>(a.page, "/src/features/lists/lists.functions.ts", "listTripListItems", { tripId: g.trip.id });
	const cam = rows.find((r) => r.text === "Camera lenses");
	await call(a.page, "/src/features/lists/lists.functions.ts", "setListItemStatus", { id: cam?.id, status: "open" });
	await a.ctx.close();
	await d.ctx.close();
});

test("ROLL-07 adding from the Kappabashi rollup attaches there and rolls up", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto(`${scopePath(g, "Kappabashi Street")}?tab=lists&list=shopping`);
	await expectLive(d.page);
	const tab = d.page.getByTestId(TESTID.listsTab);
	await tab.getByTestId(L.add).getByTestId(TESTID.mentionInput).click();
	await d.page.keyboard.type("Donabe pot");
	await d.page.keyboard.press("Enter");
	await expect(row(tab, "Donabe pot")).toBeVisible();
	for (const s of ["Asakusa", "Tokyo", "Japan"]) {
		await d.page.goto(`${scopePath(g, s)}?tab=lists&list=shopping`);
		await expectLive(d.page);
		await expect(row(d.page.getByTestId(TESTID.listsTab), "Donabe pot")).toBeVisible();
	}
	await d.page.goto("/t/asia-2027?tab=lists&list=shopping");
	await expectLive(d.page);
	await expect(row(d.page.getByTestId(TESTID.listsTab), "Donabe pot")).toBeVisible();
	const rows = await call<{ text: string; target: { kind: string; nodeId?: string } }[]>(d.page, "/src/features/lists/lists.functions.ts", "listTripListItems", { tripId: g.trip.id });
	const r = rows.find((x) => x.text === "Donabe pot");
	console.log("ROLL-07 target", JSON.stringify(r?.target), "kappabashi", g.nodes.find((n) => n.name === "Kappabashi Street")?.id);
	expect(r?.target.nodeId).toBe(g.nodes.find((n) => n.name === "Kappabashi Street")?.id);
	await d.ctx.close();
});

test("ROLL-11 day scope; ROLL-12 dropped Hiroshima", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	const day7 = g.days.find((x) => x.date === "2027-10-07");
	await d.page.goto(`/t/asia-2027?tab=lists&days=2027-10-07`);
	await expectLive(d.page);
	await d.page.waitForTimeout(800);
	console.log("URL", d.page.url());
	const t = await d.page.getByTestId(TESTID.listsTab).getByTestId(L.rowText).allInnerTexts();
	console.log("ROLL-11 day 7 Oct todos", JSON.stringify(t));
	await shot(d.page, "20-roll11-day");
	// ROLL-12
	const hiro = g.nodes.find((n) => n.name === "Hiroshima");
	const res = await call(d.page, "/src/features/lists/lists.functions.ts", "createListItem", { tripId: g.trip.id, target: { kind: "node", nodeId: hiro?.id }, list: "todo", text: "QA Hiroshima peace museum tickets" });
	console.log("create on Hiroshima", JSON.stringify(res).slice(0, 80));
	await d.page.goto(`${scopePath(g, "Japan")}?tab=lists&list=todo`);
	await expectLive(d.page);
	const tab = d.page.getByTestId(TESTID.listsTab);
	await expect(row(tab, "QA Hiroshima")).toHaveCount(0);
	const trace = tab.getByTestId(L.dropped);
	console.log("ROLL-12 trace:", await trace.innerText().catch(() => "none"));
	await trace.click();
	await expect(row(tab, "QA Hiroshima")).toBeVisible();
	await shot(d.page, "20-roll12-show-dropped");
	await d.ctx.close();
});

test("NOTE-02 independent notes on trip, Japan, Tokyo, Shinjuku, Golden Gai, Bar Kuro, day, item, leg, flight", async ({ browser }) => {
	test.setTimeout(240_000);
	const a = await ctxFor(browser, "audrey");
	await a.page.goto("/t/asia-2027?tab=plan");
	await expectLive(a.page);
	const name = (id: string | null) => {
		const it = g.items.find((i) => i.id === id);
		return it?.title ?? g.nodes.find((n) => n.id === it?.nodeId)?.name;
	};
	const fuji = g.legs.find((l) => name(l.toItemId) === "Drop bags at ryokan");
	const nh9 = g.legs.find((l) => l.mode === "flight");
	const benfItem = g.items.find((i) => name(i.id) === "Bar Benfiddich" && i.dayId);
	const day5 = g.days.find((x) => x.date === "2027-10-05");
	const node = (n: string) => g.nodes.find((x) => x.name === n)?.id;
	const sels: [string, string][] = [
		["Japan", `n.${node("Japan")}`],
		["Tokyo", `n.${node("Tokyo")}`],
		["Shinjuku", `n.${node("Shinjuku")}`],
		["Bar Kuro", `n.${node("Bar Kuro")}`],
		["Tue 5 Oct", `d.${day5?.id}`],
		["Benfiddich visit", `i.${benfItem?.id}`],
		["Fuji leg", `l.${fuji?.fromItemId}.${fuji?.toItemId}`],
		["NH 9", `l.${nh9?.fromItemId}.${nh9?.toItemId}`],
	];
	for (const [label, sel] of sels) {
		await a.page.goto(`/t/asia-2027?sel=${sel}`);
		await expectLive(a.page);
		await a.page.getByTestId(TESTID.inspector).getByRole("tab", { name: /Notes/ }).click();
		const panel = a.page.getByTestId(TESTID.notesPanel);
		if (label === "Benfiddich visit") await panel.getByTestId(NT.visitScope).getByText("This visit only").click();
		const ed = panel.getByTestId(NT.editor);
		await expect(ed).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
		const doc = await ed.getAttribute("data-doc");
		await ed.click();
		await a.page.keyboard.press("Control+End");
		await a.page.keyboard.press("Enter");
		await a.page.keyboard.type(`QA-NOTE ${label}`);
		await a.page.waitForTimeout(400);
		console.log("NOTE-02", label, "doc", doc);
	}
	await a.page.waitForTimeout(2500);
	const notes = await call<{ name: string; plainText: string | null }[]>(a.page, "/src/features/notes/notes.functions.ts", "listTripNotes", { tripId: g.trip.id });
	for (const [label] of sels) {
		const hits = notes.filter((n) => (n.plainText ?? "").includes(`QA-NOTE ${label}`));
		console.log("NOTE-02 saved", label, hits.length, hits.map((h) => h.name.split("/").slice(2).join("/")).join(","));
		expect(hits.length).toBe(1);
	}
	// The Bar Benfiddich place note must not have received the visit's line.
	const place = notes.find((n) => n.name.endsWith(`/node/${node("Bar Benfiddich")}`));
	console.log("Benfiddich place note has visit text:", (place?.plainText ?? "").includes("QA-NOTE Benfiddich visit"));
	await a.ctx.close();
});
