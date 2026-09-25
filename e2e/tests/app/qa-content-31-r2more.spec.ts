/**
 * I2 "content" verifier, round 2: scenarios round 1 left out (ROLL-05,
 * ROLL-08, NOTE-04, MED-08, DUE-07) and extra private-item probes.
 */
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { MEDIA_TESTID as MT } from "../../../src/features/media/testids";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";

test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
const state = (h: string) => path.join(AUTH, `${h}.json`);
type G = {
	trip: { id: string };
	nodes: { id: string; name: string }[];
	items: { id: string; nodeId: string | null; dayId: string | null; title: string | null }[];
	members: { id: string; name: string; userId: string | null; role: string }[];
};
const graphOf = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
async function ctxFor(browser: Browser, h: string | null) {
	const ctx = await browser.newContext({ ...(h ? { storageState: state(h) } : {}), viewport: { width: 1440, height: 900 } });
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
type Li = { id: string; text: string; status: string; list: string; nodeId: string | null; isPrivate?: boolean; createdBy?: string };

let g: G;
test.beforeAll(async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	g = await graphOf(d.page);
	await d.ctx.close();
});

test("ROLL-05 Place view groups name their source; the › jumps there", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027/japan/tokyo?tab=lists&list=shopping");
	await expectLive(d.page);
	await expect(d.page.getByTestId(TESTID.listsTab)).toBeVisible();
	await d.page.waitForTimeout(800);
	const heads = await d.page.getByTestId(TESTID.listsTab).getByTestId(L.groupHead).allInnerTexts();
	console.log("TOKYO SHOPPING HEADS", JSON.stringify(heads.map((h) => h.replace(/\s+/g, " "))));
	await shot(d.page, "31-roll05-tokyo-shopping");
	const kap = d.page.getByTestId(TESTID.listsTab).getByTestId(L.groupHead).filter({ hasText: /Asakusa/ }).first();
	await expect(kap).toBeVisible();
	const zoom = kap.getByRole("button").last();
	console.log("KAP HEAD buttons", JSON.stringify(await kap.getByRole("button").evaluateAll((b) => b.map((x) => x.getAttribute("aria-label") ?? x.textContent))));
	await zoom.click();
	await d.page.waitForTimeout(1200);
	console.log("after zoom URL", new URL(d.page.url()).pathname);
	expect(new URL(d.page.url()).pathname).toMatch(/asakusa/);
	// Outside Place view each row names its source; the crumb jumps there.
	await d.page.goto("/t/asia-2027/japan/tokyo?tab=lists&list=todo");
	await expectLive(d.page);
	await d.page.getByTestId(L.view).click();
	await d.page.getByRole("option", { name: /Due/ }).first().click();
	await d.page.waitForTimeout(600);
	const src = d.page.getByTestId(TESTID.listsTab).getByTestId(L.rowSource).filter({ hasText: /Fuji Excursion|Benfiddich/ }).first();
	console.log("row source:", await src.innerText().catch(() => "none"));
	await src.click();
	await d.page.waitForTimeout(1200);
	console.log("after source click URL", new URL(d.page.url()).pathname + new URL(d.page.url()).search);
	await shot(d.page, "31-roll05-source-jump");
	await d.page.goto("/t/asia-2027/japan/tokyo?tab=lists&list=todo");
	await expectLive(d.page);
	await d.page.getByTestId(L.view).click();
	await d.page.getByRole("option", { name: /Place/ }).first().click();
	// The todo rollup at Tokyo: leg rows say which leg.
	await d.page.goto("/t/asia-2027/japan/tokyo?tab=lists&list=todo");
	await expectLive(d.page);
	await d.page.waitForTimeout(800);
	const theads = await d.page.getByTestId(TESTID.listsTab).getByTestId(L.groupHead).allInnerTexts();
	console.log("TOKYO TODO HEADS", JSON.stringify(theads.map((h) => h.replace(/\s+/g, " "))));
	await shot(d.page, "31-roll05-tokyo-todo");
	await d.ctx.close();
});

test("ROLL-08 done rows fold into 'N done'; the fold is remembered per user", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027/japan/tokyo/asakusa?tab=lists&list=shopping");
	await expectLive(d.page);
	const all = await call<Li[]>(d.page, LISTS, "listTripListItems", { tripId: g.trip.id });
	const want = ["Scissors", "Chopsticks (2 pairs)", "Chopsticks"];
	const tick = all.filter((r) => want.includes(r.text) && r.status === "open").slice(0, 2);
	for (const r of tick) console.log("tick", r.text, JSON.stringify(await call(d.page, LISTS, "setListItemStatus", { id: r.id, status: "done" })).slice(0, 80));
	await d.page.reload();
	await expectLive(d.page);
	const fold = d.page.getByTestId(TESTID.listsTab).getByTestId(L.doneFold).first();
	await expect(fold).toBeVisible();
	console.log("fold", await fold.innerText(), "expanded", await fold.getAttribute("aria-expanded"));
	await shot(d.page, "31-roll08-folded");
	if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
	await expect(fold).toHaveAttribute("aria-expanded", "true");
	await d.page.waitForTimeout(1500);
	await shot(d.page, "31-roll08-open");
	await d.page.reload();
	await expectLive(d.page);
	const fold2 = d.page.getByTestId(TESTID.listsTab).getByTestId(L.doneFold).first();
	console.log("after reload expanded:", await fold2.getAttribute("aria-expanded"));
	// A fresh browser for the same user (no localStorage): the account remembers.
	const d2 = await ctxFor(browser, "dennis");
	await d2.page.goto("/t/asia-2027/japan/tokyo/asakusa?tab=lists&list=shopping");
	await expectLive(d2.page);
	const fold3 = d2.page.getByTestId(TESTID.listsTab).getByTestId(L.doneFold).first();
	await expect(fold3).toBeVisible();
	await d2.page.waitForTimeout(1000);
	console.log("fresh browser expanded:", await fold3.getAttribute("aria-expanded"));
	// Audrey's own fold is hers.
	const a = await ctxFor(browser, "audrey");
	await a.page.goto("/t/asia-2027/japan/tokyo/asakusa?tab=lists&list=shopping");
	await expectLive(a.page);
	await a.page.waitForTimeout(1000);
	console.log("audrey expanded:", await a.page.getByTestId(TESTID.listsTab).getByTestId(L.doneFold).first().getAttribute("aria-expanded"));
	expect(await fold2.getAttribute("aria-expanded")).toBe("true");
	expect(await fold3.getAttribute("aria-expanded")).toBe("true");
	// Back to folded for later runs.
	await fold3.click();
	await d2.page.waitForTimeout(800);
	for (const c of [d, d2, a]) await c.ctx.close();
});

test("NOTE-04 pasting Google Docs HTML keeps bold and links, drops styling", async ({ browser }) => {
	const kuro = g.nodes.find((n) => n.name === "Bar Kuro");
	const d = await ctxFor(browser, "dennis");
	await d.page.goto(`/t/asia-2027?sel=n.${kuro?.id}`);
	await expectLive(d.page);
	await d.page.getByTestId(TESTID.inspector).getByRole("tab", { name: /Notes/ }).click();
	const ed = d.page.getByTestId(TESTID.notesPanel).getByTestId(NT.editor);
	await expect(ed).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
	await ed.click();
	await d.page.keyboard.press("End");
	await d.page.keyboard.press("Enter");
	const html =
		'<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-abc"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#ff0000;background-color:#ffff00;font-weight:700;">PASTEBOLD cash only</span><span style="font-size:11pt;font-family:Comic Sans MS;color:#000000;"> see </span><a href="https://www.japan-guide.com/e/e3011.html" style="text-decoration:none;"><span style="font-size:11pt;font-family:Arial;color:#1155cc;text-decoration:underline;">the guide</span></a></p></b>';
	await d.page.evaluate(
		({ html }) => {
			const el = document.activeElement as HTMLElement;
			const dt = new DataTransfer();
			dt.setData("text/html", html);
			dt.setData("text/plain", "PASTEBOLD cash only see the guide");
			el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
		},
		{ html },
	);
	await d.page.waitForTimeout(1500);
	const inner = await ed.innerHTML();
	const frag = inner.slice(Math.max(0, inner.indexOf("PASTEBOLD") - 200), inner.indexOf("PASTEBOLD") + 400);
	console.log("PASTED HTML", frag);
	await shot(d.page, "31-note04-paste");
	expect(frag).toMatch(/<strong>[^<]*PASTEBOLD/);
	expect(frag).toMatch(/<a [^>]*href="https:\/\/www\.japan-guide\.com\/e\/e3011\.html"/);
	expect(frag).not.toMatch(/style=|font-family|Comic Sans|#ff0000/);
	await d.page.waitForTimeout(2500);
	const notes = await call<{ markdown?: string; plainText?: string }[]>(d.page, "/src/features/notes/notes.functions.ts", "listTripNotes", { tripId: g.trip.id });
	const md = JSON.stringify(notes).match(/[^"]{0,40}PASTEBOLD[^"]{0,120}/)?.[0];
	console.log("stored markdown:", md);
	await d.ctx.close();
});

test("MED-08 cancelling an upload halfway leaves no tile and no row", async ({ browser }) => {
	test.setTimeout(120_000);
	const d = await ctxFor(browser, "dennis");
	const gg = g.nodes.find((n) => n.name === "Golden Gai");
	await d.page.route(/localhost:8080\/.*/, async (route) => {
		if (route.request().method() === "PUT") {
			await new Promise((r) => setTimeout(r, 8_000));
			await route.continue().catch(() => {});
		} else await route.continue();
	});
	await d.page.goto(`/t/asia-2027?sel=n.${gg?.id}`);
	await expectLive(d.page);
	await d.page.getByTestId(TESTID.inspector).getByRole("tab", { name: /Media/ }).click();
	const input = d.page.getByTestId(TESTID.inspector).getByTestId(MT.fileInput).first();
	const big = Buffer.alloc(3 * 1024 * 1024, 0);
	// A tiny valid PNG header so type sniffing (if any) passes.
	Buffer.from("89504e470d0a1a0a", "hex").copy(big);
	await input.setInputFiles({ name: "cancel-me.png", mimeType: "image/png", buffer: big });
	const tile = d.page.getByTestId(MT.uploadTile).first();
	await expect(tile).toBeVisible({ timeout: 10_000 });
	await shot(d.page, "31-med08-uploading");
	await tile.hover();
	await tile.getByTestId(MT.uploadCancel).click();
	await d.page.waitForTimeout(1500);
	console.log("upload tiles after cancel:", await d.page.getByTestId(MT.uploadTile).count());
	await shot(d.page, "31-med08-cancelled");
	await d.page.unroute(/localhost:8080\/.*/);
	await d.page.reload();
	await expectLive(d.page);
	const media = await call<{ id: string; title: string | null; status: string }[]>(d.page, "/src/features/media/media.functions.ts", "listTripMedia", { tripId: g.trip.id });
	console.log("media rows named cancel-me:", JSON.stringify(media.filter((m) => /cancel-me/.test(JSON.stringify(m)))));
	expect(await d.page.getByTestId(MT.uploadTile).count()).toBe(0);
	expect(media.filter((m) => /cancel-me/.test(JSON.stringify(m)))).toEqual([]);
	await d.ctx.close();
});

test("DUE-07 a suggester assignee ticks directly; a non-assignee proposes", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=lists&list=todo");
	await expectLive(d.page);
	const maya = g.members.find((m) => m.name.startsWith("Maya"));
	console.log("maya member", JSON.stringify(maya));
	const mine = await call<{ id?: string }>(d.page, LISTS, "createListItem", { tripId: g.trip.id, target: { kind: "trip" }, list: "todo", text: "DUE07 Maya's own task", assigneeIds: [maya?.id] });
	const other = await call<{ id?: string }>(d.page, LISTS, "createListItem", { tripId: g.trip.id, target: { kind: "trip" }, list: "todo", text: "DUE07 someone else's task" });
	console.log("created", JSON.stringify(mine).slice(0, 100), JSON.stringify(other).slice(0, 100));
	const all = await call<Li[]>(d.page, LISTS, "listTripListItems", { tripId: g.trip.id });
	const mineId = all.find((r) => r.text === "DUE07 Maya's own task")?.id;
	const otherId = all.find((r) => r.text === "DUE07 someone else's task")?.id;
	const m = await ctxFor(browser, "maya");
	await m.page.goto("/t/asia-2027?tab=lists&list=todo");
	await expectLive(m.page);
	const r1 = await call(m.page, LISTS, "setListItemStatus", { id: mineId, status: "done" });
	const r2 = await call(m.page, LISTS, "setListItemStatus", { id: otherId, status: "done" });
	console.log("Maya ticks own:", JSON.stringify(r1).slice(0, 160));
	console.log("Maya ticks other:", JSON.stringify(r2).slice(0, 160));
	const after = await call<Li[]>(d.page, LISTS, "listTripListItems", { tripId: g.trip.id });
	const s1 = after.find((r) => r.id === mineId)?.status;
	const s2 = after.find((r) => r.id === otherId)?.status;
	console.log("status own/other:", s1, s2);
	// And through the UI: Maya's checkbox on her own row.
	await m.page.reload();
	await expectLive(m.page);
	await m.page.waitForTimeout(800);
	await shot(m.page, "31-due07-maya");
	expect(s1).toBe("done");
	expect(s2).toBe("open");
	expect(JSON.stringify(r2)).toMatch(/propos/i);
	for (const c of [d, m]) await c.ctx.close();
});

test("private items: only the creator may flip isPrivate; others can't hide a shared row", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=lists&list=todo");
	await expectLive(d.page);
	await call(d.page, LISTS, "createListItem", { tripId: g.trip.id, target: { kind: "trip" }, list: "todo", text: "PRIVFLIP shared task by Dennis" });
	const all = await call<Li[]>(d.page, LISTS, "listTripListItems", { tripId: g.trip.id });
	const id = all.find((r) => r.text === "PRIVFLIP shared task by Dennis")?.id;
	const a = await ctxFor(browser, "audrey");
	await a.page.goto("/t/asia-2027?tab=lists&list=todo");
	await expectLive(a.page);
	const r = await call(a.page, LISTS, "updateListItem", { id, patch: { isPrivate: true } });
	console.log("Audrey makes Dennis's row private:", JSON.stringify(r).slice(0, 200));
	const dAfter = await call<Li[]>(d.page, LISTS, "listTripListItems", { tripId: g.trip.id });
	const aAfter = await call<Li[]>(a.page, LISTS, "listTripListItems", { tripId: g.trip.id });
	const k = await ctxFor(browser, "maya");
	await k.page.goto("/t/asia-2027?tab=plan");
	await expectLive(k.page);
	const kAfter = await call<Li[]>(k.page, LISTS, "listTripListItems", { tripId: g.trip.id });
	const row = dAfter.find((x) => x.id === id);
	console.log("Dennis sees:", JSON.stringify(row).slice(0, 200));
	console.log("Audrey sees it:", aAfter.some((x) => x.id === id), "Maya sees it:", kAfter.some((x) => x.id === id));
	await a.page.reload();
	await expectLive(a.page);
	await a.page.waitForTimeout(800);
	await shot(a.page, "31-privflip-audrey");
	for (const c of [d, a, k]) await c.ctx.close();
});
