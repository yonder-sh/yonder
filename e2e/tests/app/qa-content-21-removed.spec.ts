/**
 * I2 "content" verifier: QA TAG-04 and MENT-03 (a removed member's tags and
 * mentions). Destructive for Kai: run last.
 */
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
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
	items: { id: string; nodeId: string | null; dayId: string | null; title: string | null; assigneeIds: string[] }[];
	members: { id: string; name: string; status: string }[];
};
const graphOf = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
async function ctxFor(browser: Browser, h: string) {
	const ctx = await browser.newContext({ storageState: state(h), viewport: { width: 1440, height: 900 } });
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

test("TAG-04 / MENT-03 Kai removed: greyed former-member tag, plain-text mention, gone from pickers", async ({ browser }) => {
	test.setTimeout(180_000);
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	const g = await graphOf(d.page);
	const kai = g.members.find((m) => m.name.startsWith("Kai"));
	const sky = g.items.find((i) => (i.title ?? g.nodes.find((n) => n.id === i.nodeId)?.name) === "Shibuya Sky" && i.dayId);
	const gg = g.nodes.find((n) => n.name === "Golden Gai");
	if (!kai || !sky || !gg) throw new Error("fixture");
	// MENT-03 needs a mention of Kai from while he was a member: Dennis adds one to Golden Gai's note.
	const notes = async () => {
		await d.page.goto(`/t/asia-2027?sel=n.${gg.id}`);
		await expectLive(d.page);
		await d.page.getByTestId(TESTID.inspector).getByRole("tab", { name: /Notes/ }).click();
		const editor = d.page.getByTestId(TESTID.notesPanel).getByTestId(NT.editor);
		await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
		return editor;
	};
	const ed0 = await notes();
	await ed0.click();
	await d.page.keyboard.press("Control+End");
	await d.page.keyboard.type(" Ask @Kai");
	await expect(d.page.getByTestId(NT.mentionPopup).getByTestId(NT.mentionOption).first()).toContainText("Kai Viewer");
	await d.page.keyboard.press("Enter");
	await d.page.waitForTimeout(1_500);
	await expect((await notes()).locator("[data-mention]").filter({ hasText: /Kai/ })).toHaveCount(1);
	const tag = await call(d.page, "/src/functions/items.functions.ts", "setItemAssignees", { itemId: sky.id, memberIds: [...new Set([...sky.assigneeIds, kai.id])] });
	console.log("tag Kai", JSON.stringify(tag).slice(0, 100));
	const rm = await call(d.page, "/src/features/home/sharing.functions.ts", "removeMember", { memberId: kai.id });
	console.log("removeMember", JSON.stringify(rm));
	await d.page.reload();
	await expectLive(d.page);
	// TAG-04: the overview shows him greyed as a former member.
	await d.page.goto(`/t/asia-2027?sel=i.${sky.id}`);
	await expectLive(d.page);
	const who = d.page.getByTestId(PLAN_TESTID.overviewAssignees);
	console.log("TAG-04 overview who:", (await who.innerText()).replace(/\n/g, " "));
	await shot(d.page, "21-tag04-overview");
	const card = d.page.getByTestId(TESTID.timelineItem).filter({ hasText: "Shibuya Sky" }).first();
	await card.scrollIntoViewIfNeeded();
	console.log("TAG-04 card html has former:", (await card.innerHTML()).includes("former"), "text:", (await card.innerText()).replace(/\n/g, " "));
	await shot(d.page, "21-tag04-card");
	// The plan's person filter no longer offers him.
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	await d.page.getByTestId(PLAN_TESTID.whoFilter).getByRole("button", { name: /Someone|Audrey|Maya/ }).last().click();
	await d.page.waitForTimeout(300);
	const opts = await d.page.locator("[role=menuitemradio],[role=menuitem],[role=option]").filter({ hasNotText: /Must|Want|rated|Sure/ }).allInnerTexts();
	console.log("TAG-04 plan filter options", JSON.stringify(opts));
	expect(opts.join("|")).not.toMatch(/Kai/);
	await d.page.keyboard.press("Escape");
	// MENT-03: the Golden Gai note's @Kai renders as plain text; the popup no longer lists him.
	const ed = await notes();
	const kaiChip = ed.locator("[data-mention]").filter({ hasText: /Kai/ });
	await expect(kaiChip).toHaveCount(1);
	console.log("MENT-03 Kai chips:", await kaiChip.count(), "html:", (await kaiChip.evaluate((e) => e.outerHTML)).slice(0, 300));
	await ed.click();
	await d.page.keyboard.press("Control+End");
	await d.page.keyboard.type(" @Ka");
	await d.page.waitForTimeout(400);
	const popup = await d.page.getByTestId(NT.mentionPopup).innerText().catch(() => "hidden");
	console.log("MENT-03 popup for @Ka:", popup.replace(/\n/g, " | "));
	expect(popup).not.toMatch(/Kai Viewer/);
	await d.page.keyboard.press("Escape");
	for (let i = 0; i < 4; i++) await d.page.keyboard.press("Backspace");
	await shot(d.page, "21-ment03-note");
	// Kai himself: no longer reaches the trip.
	const k = await ctxFor(browser, "kai");
	const resp = await k.page.goto("/t/asia-2027?tab=plan");
	await k.page.waitForTimeout(1500);
	console.log("Kai after removal:", resp?.status(), await k.page.locator("body").innerText().then((t) => t.slice(0, 120).replace(/\n/g, " ")));
	await d.ctx.close();
	await k.ctx.close();
});
