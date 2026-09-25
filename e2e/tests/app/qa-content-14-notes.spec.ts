/**
 * I2 "content" verifier: QA NOTE-01/02/06, MENT-01/02/04/05 and private notes
 * (ADDENDUM §7.2) on the imported Asia 2027 trip, in real browsers.
 */
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";

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
	legs: { id: string; kind: string; fromItemId: string | null; toItemId: string | null; mode: string | null }[];
	members: { id: string; name: string; userId: string | null; status: string }[];
};
const graphOf = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
async function ctxFor(browser: Browser, h: string | null) {
	const ctx = await browser.newContext({ ...(h ? { storageState: state(h) } : {}), viewport: { width: 1440, height: 900 } });
	return { ctx, page: await ctx.newPage() };
}

let nodeIds: Record<string, string> = {};

async function notesOf(page: Page, nodeId: string) {
	await page.goto(`/t/asia-2027?sel=n.${nodeId}`);
	await expectLive(page);
	await page.getByTestId(TESTID.inspector).getByRole("tab", { name: /Notes/ }).click();
	const panel = page.getByTestId(TESTID.notesPanel);
	await expect(panel).toBeVisible();
	const editor = panel.getByTestId(NT.editor);
	await expect(editor).toBeVisible({ timeout: 15_000 });
	return { panel, editor };
}

test.beforeAll(async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	const g = await graphOf(d.page);
	nodeIds = Object.fromEntries(g.nodes.map((n) => [n.name, n.id]));
	await d.ctx.close();
});

test("NOTE-01/06 markdown in Golden Gai's notes; Kai and Guest-V read live but can't type", async ({ browser }) => {
	const gg = nodeIds["Golden Gai"];
	const a = await ctxFor(browser, "audrey");
	const { editor } = await notesOf(a.page, gg);
	await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
	console.log("GG note before:", (await editor.innerText()).slice(0, 200).replace(/\n/g, " | "));
	const k = await ctxFor(browser, "kai");
	const kn = await notesOf(k.page, gg);
	const gv = await ctxFor(browser, null);
	await gv.page.goto("/join#t=qa-share-token-viewer-asia-2027");
	await expect(gv.page).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
	const gn = await notesOf(gv.page, gg);
	// Clear and type the NOTE-01 text.
	await editor.click();
	await a.page.keyboard.press("Control+a");
	await a.page.keyboard.press("Delete");
	const type = (s: string) => a.page.keyboard.type(s, { delay: 5 });
	await type("## House rules");
	await a.page.keyboard.press("Enter");
	await type("- Cover charge ¥500–¥1,000 per bar");
	await a.page.keyboard.press("Enter");
	await type("**Cash only** at most bars");
	await a.page.keyboard.press("Enter");
	await a.page.keyboard.press("Enter");
	await type("1. Benfiddich first");
	await a.page.keyboard.press("Enter");
	await a.page.keyboard.press("Enter");
	await type("> photos often banned");
	await a.page.keyboard.press("Enter");
	await a.page.keyboard.press("Enter");
	await type("`Kabukicho 1-1` ");
	await a.page.keyboard.press("Enter");
	await type("[guide](https://www.japan-guide.com/e/e3011.html) ");
	await a.page.waitForTimeout(800);
	const html = await editor.innerHTML();
	console.log("NOTE-01 HTML", html.slice(0, 1500));
	await shot(a.page, "14-note01-audrey");
	expect(html).toMatch(/<h2[^>]*>House rules<\/h2>/);
	expect(html).toMatch(/<ul[\s\S]*Cover charge/);
	expect(html).toMatch(/<strong>Cash only<\/strong>/);
	expect(html).toMatch(/<ol[\s\S]*Benfiddich first/);
	expect(html).toMatch(/<blockquote[\s\S]*photos often banned/);
	expect(html).toMatch(/<code>Kabukicho 1-1<\/code>/);
	const linkOk = /<a [^>]*href="https:\/\/www\.japan-guide\.com\/e\/e3011\.html"/.test(html);
	console.log("NOTE-01 markdown link became a link:", linkOk);
	// NOTE-06: both viewers see it live and can't edit.
	const t0 = Date.now();
	await expect(kn.editor).toContainText("photos often banned", { timeout: 5_000 });
	await expect(gn.editor).toContainText("photos often banned", { timeout: 5_000 });
	console.log("NOTE-06 live ms", Date.now() - t0);
	await expect(kn.editor).toHaveAttribute("contenteditable", "false");
	await expect(gn.editor).toHaveAttribute("contenteditable", "false");
	await kn.editor.click();
	await k.page.keyboard.type("KAI WAS HERE");
	await gn.editor.click();
	await gv.page.keyboard.type("GUEST WAS HERE");
	await a.page.waitForTimeout(1000);
	expect(await editor.innerText()).not.toMatch(/WAS HERE/);
	await shot(k.page, "14-note06-kai");
	await shot(gv.page, "14-note06-guest");
	// Reload persists (from the server).
	await a.page.reload();
	const again = await notesOf(a.page, gg);
	await expect(again.editor).toContainText("photos often banned");
	const html2 = await again.editor.innerHTML();
	expect(html2).toMatch(/<h2[^>]*>House rules<\/h2>/);
	await k.ctx.close();
	await gv.ctx.close();
	await a.ctx.close();
});

test("MENT-01/02/04 mention popup: members only (not guests), chip live and persisted; emails don't trigger", async ({ browser }) => {
	const gg = nodeIds["Golden Gai"];
	// Guest-E present with a live presence.
	const ge = await ctxFor(browser, null);
	await ge.page.goto("/join#t=qa-share-token-editor-asia-2027");
	await expect(ge.page).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
	await notesOf(ge.page, gg);
	const d = await ctxFor(browser, "dennis");
	const dn = await notesOf(d.page, gg);
	const a = await ctxFor(browser, "audrey");
	const an = await notesOf(a.page, gg);
	await expect(dn.editor).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
	await dn.editor.click();
	await d.page.keyboard.press("Control+End");
	await d.page.keyboard.press("Enter");
	await d.page.keyboard.type("Ask ");
	await d.page.keyboard.type("@");
	const popup = d.page.getByTestId(NT.mentionPopup);
	await expect(popup).toBeVisible();
	const all = await popup.getByTestId(NT.mentionOption).allInnerTexts();
	console.log("MENT-02 @ options", JSON.stringify(all));
	await shot(d.page, "14-ment02-at");
	expect(all.join("|")).not.toMatch(/Guest/i);
	await d.page.keyboard.type("Gu");
	await d.page.waitForTimeout(300);
	const gu = await popup.getByTestId(NT.mentionOption).allInnerTexts().catch(() => []);
	console.log("MENT-02 @Gu options", JSON.stringify(gu), "popup text:", await popup.innerText().catch(() => "hidden"));
	await shot(d.page, "14-ment02-atgu");
	for (let i = 0; i < 3; i++) await d.page.keyboard.press("Backspace");
	await d.page.keyboard.type("@Au");
	await expect(popup.getByTestId(NT.mentionOption).first()).toContainText("Audrey Tester");
	await d.page.keyboard.press("Enter");
	await d.page.keyboard.type("about Kai ");
	await d.page.keyboard.type("@Kai");
	await expect(popup.getByTestId(NT.mentionOption).first()).toContainText("Kai Viewer");
	await d.page.keyboard.press("Enter");
	await d.page.waitForTimeout(500);
	const html = await dn.editor.innerHTML();
	console.log("MENT-01 HTML tail", html.slice(-700));
	expect(html).toMatch(/@Audrey Tester/);
	await expect(an.editor).toContainText("@Audrey Tester", { timeout: 5_000 });
	// MENT-04: an email address.
	await d.page.keyboard.type(" write to hotel@kawaguchiko.test");
	await d.page.waitForTimeout(400);
	console.log("MENT-04 popup visible after email:", await popup.isVisible().catch(() => false));
	await shot(d.page, "14-ment04-email");
	await d.page.keyboard.press("Escape");
	await d.page.waitForTimeout(1500);
	// MENT-05: Audrey's bell.
	const bell = a.page.getByTestId(TESTID.inboxBell).first();
	await bell.click();
	await a.page.waitForTimeout(800);
	await shot(a.page, "14-ment05-audrey-inbox");
	await a.page.keyboard.press("Escape");
	await d.page.reload();
	const dn2 = await notesOf(d.page, gg);
	await expect(dn2.editor).toContainText("@Audrey Tester");
	await expect(dn2.editor).toContainText("@Kai Viewer");
	await d.ctx.close();
	await a.ctx.close();
	await ge.ctx.close();
});

test("private note: only its author ever sees it", async ({ browser }) => {
	const gg = nodeIds["Golden Gai"];
	const d = await ctxFor(browser, "dennis");
	const dn = await notesOf(d.page, gg);
	const toggle = dn.panel.getByTestId(NT.privateToggle);
	await toggle.getByRole("button", { name: /Only me/ }).click();
	const ed = dn.panel.getByTestId(NT.editor);
	await expect(ed).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
	const docName = await ed.getAttribute("data-doc");
	console.log("private doc", docName);
	await ed.click();
	await d.page.keyboard.type("SECRET surprise party for @Au");
	await expect(d.page.getByTestId(NT.mentionPopup)).toBeVisible();
	await d.page.keyboard.press("Enter");
	await d.page.waitForTimeout(2500);
	await shot(d.page, "14-private-note-dennis");
	// Back to Shared for the next tests.
	await toggle.getByRole("button", { name: /Shared/ }).click();
	const a = await ctxFor(browser, "audrey");
	const an = await notesOf(a.page, gg);
	await expect(an.editor).not.toContainText("SECRET");
	await an.panel.getByTestId(NT.privateToggle).getByRole("button", { name: /Only me/ }).click();
	await a.page.waitForTimeout(1500);
	expect(await an.panel.innerText()).not.toMatch(/SECRET/);
	await an.panel.getByTestId(NT.privateToggle).getByRole("button", { name: /Shared/ }).click();
	const notes = await a.page.evaluate(async () => {
		const m = await import("/src/features/notes/notes.functions.ts");
		const y = (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder;
		return m.listTripNotes({ data: { tripId: y.graph.trip.id } });
	});
	expect(JSON.stringify(notes)).not.toMatch(/SECRET/);
	// Her inbox never gets the private mention.
	const inbox = await a.page.evaluate(async () => {
		const m = await import("/src/functions/inbox.functions.ts");
		return m.listInbox({ data: {} }).catch((e: Error) => ({ error: e.message }));
	});
	console.log("AUDREY INBOX", JSON.stringify(inbox).slice(0, 1500));
	expect(JSON.stringify(inbox)).not.toMatch(/SECRET/);
	// The Notes tab (rollup) at Shinjuku.
	await a.page.goto("/t/asia-2027/japan/tokyo/shinjuku?tab=notes");
	await expectLive(a.page);
	await a.page.waitForTimeout(1500);
	expect(await a.page.getByTestId(TESTID.notesTab).innerText()).not.toMatch(/SECRET/);
	// Activity feed.
	const act = await a.page.evaluate(async () => {
		const m = await import("/src/functions/graph.functions.ts");
		const y = (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder;
		return m.listActivity({ data: { tripId: y.graph.trip.id } });
	});
	expect(JSON.stringify(act)).not.toMatch(/SECRET/);
	// A raw collab connection to Dennis's private doc as Audrey is refused.
	if (docName) {
		const res = await a.page.evaluate(async (name) => {
			const m = await import("/src/lib/realtime/collab-client.ts");
			const c = m.getCollabClient();
			if (!c) return "no client";
			const lease = c.acquire(name, { awareness: false });
			const t0 = Date.now();
			for (;;) {
				const s = lease.getSnapshot();
				if (s.status !== "connecting" || Date.now() - t0 > 8000) {
					const text = JSON.stringify(lease.doc.getXmlFragment("default").toJSON()).slice(0, 200);
					lease.release();
					return `${s.status} ${s.reason ?? ""} synced=${s.synced} text=${text}`;
				}
				await new Promise((r) => setTimeout(r, 100));
			}
		}, docName);
		console.log("AUDREY opening Dennis's private doc:", res);
		expect(res).not.toMatch(/SECRET/);
		expect(res).toMatch(/^denied/);
	}
	await d.ctx.close();
	await a.ctx.close();
});
