/**
 * I2 verifier "collab" (round 1): realtime notes, carets and presence on the
 * QA seed's Asia 2027 (qa/SCENARIOS RT-01, RT-03, RT-04, RT-06, RT-08, RT-10,
 * RT-11), with Dennis, Audrey, Kai (viewer) and Guest-E (editor link).
 *
 * Needs the QA seed and `$QA_AUTH_DIR/<handle>.json` storageStates.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { PLAN_TESTID as P } from "../../../src/features/plan/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath } from "./_helpers/env";
import { openLink } from "./_helpers/link";
import { collectConsole, expectLive } from "./_helpers/page";

const AUTH = process.env.QA_AUTH_DIR ?? path.resolve("e2e/.auth");
const auth = (h: string) => path.join(AUTH, `${h}.json`);
const shot = (n: string) =>
	process.env.QA_SHOTS_DIR ? path.join(process.env.QA_SHOTS_DIR, `${n}.png`) : shotPath(`qa-collab/${n}.png`);
const GG = "/t/asia-2027/japan/tokyo/shinjuku/golden-gai";

async function open(browser: Browser, handle: string | null, url: string) {
	const ctx = await browser.newContext({
		...(handle ? { storageState: auth(handle) } : {}),
		viewport: { width: 1440, height: 900 },
	});
	const page = await ctx.newPage();
	// Guest-E: the trip's address while its link gives "Can edit".
	if (!handle) await openLink(page, "asia-2027", "editor");
	await page.goto(url);
	await expectLive(page);
	return { ctx, page };
}

const topEditor = (p: Page) => p.getByTestId(TESTID.notesTab).getByTestId(NT.editor).first();
type Ed = { editor?: { state: { doc: { textBetween: (a: number, b: number, sep: string) => string; content: { size: number } } }; commands: { focus: (p: "start" | "end") => boolean } } };
/** The document's text (not innerText: that includes other people's caret labels). */
const text = (p: Page) =>
	topEditor(p).evaluate((e) => {
		const d = (e as unknown as Ed).editor?.state.doc;
		return d ? d.textBetween(0, d.content.size, "\n") : "";
	});

async function caretAtEnd(p: Page) {
	const ed = topEditor(p);
	await expect(ed).toHaveAttribute("data-editable", "true", { timeout: 15_000 });
	await ed.click();
	await ed.evaluate((e) => (e as unknown as Ed).editor?.commands.focus("end"));
}
async function caretAtStart(p: Page) {
	const ed = topEditor(p);
	await expect(ed).toHaveAttribute("data-editable", "true", { timeout: 15_000 });
	await ed.click();
	await ed.evaluate((e) => (e as unknown as Ed).editor?.commands.focus("start"));
}

test.skip(({ isMobile }) => isMobile, "desktop, several browsers");

test("RT-01/03/08/10: three editors type at once and converge; carets are labelled; presence shows everyone; the viewer is read-only", async ({
	browser,
}) => {
	test.setTimeout(180_000);
	const tag = randomBytes(2).toString("hex");
	const d = await open(browser, "dennis", `${GG}?tab=notes`);
	const a = await open(browser, "audrey", `${GG}?tab=notes`);
	const g = await open(browser, null, `${GG}?tab=notes`);
	const k = await open(browser, "kai", `${GG}?tab=notes`);
	const logs = collectConsole(d.page);

	// RT-08: Dennis's header shows who else is here, the link guest as "Guest".
	const avatars = d.page.getByTestId(TESTID.presenceAvatar);
	await expect.poll(() => avatars.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
	const labels = await avatars.evaluateAll((els) =>
		els.map((e) => `${e.getAttribute("aria-label") ?? ""} ${e.getAttribute("title") ?? ""} ${e.textContent ?? ""}`),
	);
	expect(labels.join(" | ")).toMatch(/Audrey/);
	expect(labels.join(" | ")).toMatch(/Guest/);
	expect(labels.join(" | ")).toMatch(/Kai/);
	await d.page.screenshot({ path: shot("rt08-presence") });
	await avatars.filter({ hasText: /A/ }).first().hover().catch(() => undefined);
	await d.page.waitForTimeout(600);
	await d.page.screenshot({ path: shot("rt08-presence-hover"), clip: { x: 700, y: 0, width: 740, height: 200 } });

	// Kai is read-only and says why.
	await expect(topEditor(k.page)).toHaveAttribute("data-editable", "false");

	// RT-01/RT-10: Dennis at the start, Audrey and the guest at the end, all at once (~10 chars/s).
	const sD = `Cover charge ¥500–¥1,000 per bar ${tag}. `;
	const sA = `Cash only at most bars ${tag}.`;
	const sG = `Guest line ${tag}.`;
	await caretAtStart(d.page);
	await caretAtEnd(a.page);
	await a.page.keyboard.press("Enter");
	await caretAtEnd(g.page);
	await g.page.keyboard.press("Enter");
	await Promise.all([
		d.page.keyboard.type(sD, { delay: 90 }),
		a.page.keyboard.type(sA, { delay: 100 }),
		g.page.keyboard.type(sG, { delay: 110 }),
	]);
	await expect.poll(async () => (await text(d.page)).includes(sA.trim()) && (await text(d.page)).includes(sG), {
		timeout: 5_000,
	}).toBe(true);
	await expect.poll(async () => [await text(a.page), await text(g.page), await text(k.page)], { timeout: 5_000 }).toEqual([
		await text(d.page),
		await text(d.page),
		await text(d.page),
	]);
	const final = await text(d.page);
	expect(final).toContain(sD.trim());
	expect(final).toContain(sA);
	expect(final).toContain(sG);

	// RT-03: carets with names; the guest's reads "Guest".
	const carets = d.page.locator(".collaboration-carets__label");
	await expect(carets.filter({ hasText: "Audrey" })).toBeVisible({ timeout: 5_000 });
	await expect(carets.filter({ hasText: /Guest/ })).toBeVisible({ timeout: 5_000 });
	await d.page.screenshot({ path: shot("rt03-carets") });

	// RT-11: Dennis undoes his own typing only.
	await d.page.keyboard.press("Control+z");
	await d.page.keyboard.press("Control+z");
	await d.page.keyboard.press("Control+z");
	await expect.poll(() => text(a.page), { timeout: 5_000 }).not.toContain(sD.trim());
	expect(await text(a.page)).toContain(sA);
	expect(await text(a.page)).toContain(sG);
	// (Put it back so the note keeps Dennis's line.)
	await d.page.keyboard.press("Control+Shift+z");
	await d.page.keyboard.press("Control+Shift+z");
	await d.page.keyboard.press("Control+Shift+z");

	// After reloads, the same text.
	const settled = await text(d.page);
	await d.page.reload();
	await expectLive(d.page);
	await a.page.reload();
	await expectLive(a.page);
	await expect.poll(() => text(d.page), { timeout: 10_000 }).toBe(settled);
	await expect.poll(() => text(a.page), { timeout: 10_000 }).toBe(settled);

	// Audrey closes her tab: her caret leaves Dennis's editor within 30 s.
	await a.ctx.close();
	await expect(d.page.locator(".collaboration-carets__label", { hasText: "Audrey" })).toHaveCount(0, {
		timeout: 30_000,
	});
	expect(logs.messages).toEqual([]);
	await g.ctx.close();
	await k.ctx.close();
	await d.ctx.close();
});

test("RT-04/05: a reorder and a duration edit made at the same time both land for both people, live", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const day = "2027-10-05";
	const url = `/t/asia-2027/japan/tokyo?days=${day}`;
	const d = await open(browser, "dennis", url);
	const a = await open(browser, "audrey", url);
	type Gr = { items: { id: string; nodeId: string | null; dayId: string | null; durationMin: number; position: string }[]; nodes: { id: string; name: string }[]; days: { id: string; date: string }[] };
	const graph = (p: Page) => p.evaluate(() => (window as unknown as { __yonder: { graph: Gr } }).__yonder.graph);
	const g0 = await graph(d.page);
	const nodeId = (n: string) => g0.nodes.find((x) => x.name === n)?.id;
	const gg = g0.items.find((i) => i.nodeId === nodeId("Golden Gai") && i.dayId);
	const bb = g0.items.find((i) => i.nodeId === nodeId("Bar Benfiddich") && i.dayId);
	if (!gg || !bb) throw new Error("fixture items missing");
	const order = (p: Page) =>
		p
			.locator(`[data-testid="${P.daySection}"] [data-testid="${TESTID.timelineItem}"]`)
			.evaluateAll((els) => els.map((e) => e.getAttribute("data-item-id")));
	const o0 = await order(d.page);
	expect(o0.indexOf(bb.id)).toBeLessThan(o0.indexOf(gg.id));

	// Dennis drags Golden Gai above Bar Benfiddich while Audrey sets Golden Gai to 3h.
	const card = (p: Page, id: string) => p.locator(`[data-testid="${TESTID.timelineItem}"][data-item-id="${id}"]`).first();
	await card(d.page, gg.id).scrollIntoViewIfNeeded();
	const src = await card(d.page, gg.id).boundingBox();
	const dst = await card(d.page, bb.id).boundingBox();
	if (!src || !dst) throw new Error("no boxes");
	const call = a.page.evaluate(
		async ({ itemId }) => {
			const mod = (await import(/* @vite-ignore */ "/src/functions/items.functions.ts")) as Record<
				string,
				(o: { data: unknown }) => Promise<unknown>
			>;
			return mod.updateItem!({ data: { itemId, patch: { durationMin: 180 } } });
		},
		{ itemId: gg.id },
	);
	await d.page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
	await d.page.mouse.down();
	await d.page.mouse.move(src.x + src.width / 2, src.y + src.height / 2 - 10, { steps: 4 });
	await d.page.mouse.move(dst.x + dst.width / 2, dst.y + 6, { steps: 25 });
	await d.page.mouse.move(dst.x + dst.width / 2, dst.y + 7, { steps: 2 });
	await d.page.mouse.up();
	await call;
	const t0 = Date.now();
	await expect.poll(async () => {
		const o = await order(a.page);
		return o.indexOf(gg.id) < o.indexOf(bb.id);
	}, { timeout: 5_000 }).toBe(true);
	const ms = Date.now() - t0;
	await expect.poll(async () => (await graph(d.page)).items.find((i) => i.id === gg.id)?.durationMin, { timeout: 5_000 }).toBe(180);
	await expect.poll(async () => (await graph(a.page)).items.find((i) => i.id === gg.id)?.durationMin, { timeout: 5_000 }).toBe(180);
	const oD = await order(d.page);
	expect(oD.indexOf(gg.id)).toBeLessThan(oD.indexOf(bb.id));
	await a.page.waitForTimeout(500);
	await a.page.screenshot({ path: shot("rt04-audrey-after-reorder") });
	console.log(`[rt04] reorder reached Audrey ~${ms} ms after the drop settled`);

	// Restore: Golden Gai back after Bar Benfiddich, 2h30.
	await d.page.evaluate(
		async ({ itemId, afterId }) => {
			const mod = (await import(/* @vite-ignore */ "/src/functions/items.functions.ts")) as Record<
				string,
				(o: { data: unknown }) => Promise<unknown>
			>;
			await mod.updateItem!({ data: { itemId, patch: { durationMin: 150 } } });
			const dayId = (window as unknown as { __yonder: { graph: Gr } }).__yonder.graph.items.find((i) => i.id === itemId)?.dayId;
			await mod.moveItem!({ data: { itemId, dayId, afterItemId: afterId } });
		},
		{ itemId: gg.id, afterId: bb.id },
	);
	await d.ctx.close();
	await a.ctx.close();
});

test("RT-06: Audrey deletes the item Dennis has open; his panel says so and his next edit doesn't bring it back", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	type Gi = { items: { id: string; dayId: string | null; title: string | null }[]; days: { id: string; date: string }[] };
	const g = (p: Page) => p.evaluate(() => (window as unknown as { __yonder: { graph: Gi } }).__yonder.graph);
	const probe = await open(browser, "dennis", "/t/asia-2027/japan/tokyo");
	const g0 = await g(probe.page);
	const tue = g0.days.find((x) => x.date === "2027-10-05");
	const lunch = g0.items.find((i) => i.dayId === tue?.id && i.title === "Lunch");
	if (!lunch) throw new Error("no Tue lunch");
	await probe.ctx.close();
	const url = `/t/asia-2027/japan/tokyo?days=2027-10-05&sel=i.${lunch.id}`;
	const d = await open(browser, "dennis", url);
	const logs = collectConsole(d.page);
	const a = await open(browser, "audrey", "/t/asia-2027/japan/tokyo?days=2027-10-05");
	const ov = d.page.getByTestId(TESTID.itemOverview);
	await expect(ov).toBeVisible();
	const del = (await a.page.evaluate(async (itemId) => {
		const mod = (await import(/* @vite-ignore */ "/src/functions/items.functions.ts")) as Record<
			string,
			(o: { data: unknown }) => Promise<unknown>
		>;
		return mod.deleteItem!({ data: { itemId } });
	}, lunch.id)) as { deletedAt?: string };
	await expect.poll(async () => (await g(d.page)).items.some((i) => i.id === lunch.id), { timeout: 5_000 }).toBe(false);
	await d.page.waitForTimeout(800);
	await d.page.screenshot({ path: shot("rt06-dennis-after-delete") });
	const inspectorText = (await d.page.getByTestId(TESTID.inspector).innerText().catch(() => "")).replace(/\s+/g, " ");
	console.log(`[rt06] inspector now: ${inspectorText.slice(0, 200)}`);
	// If the overview is still there, an edit must not resurrect the row.
	if (await ov.isVisible().catch(() => false)) {
		const title = ov.getByTestId(P.overviewTitle).locator("input").first();
		if (await title.count()) {
			await title.fill("Lunch (edited)");
			await title.press("Enter");
			await d.page.waitForTimeout(1_500);
		}
	}
	// (Audrey's own tab never hears its own delete; ask Dennis's, which is live.)
	expect((await g(d.page)).items.some((i) => i.id === lunch.id), "not resurrected").toBe(false);
	expect(inspectorText).toMatch(/no longer exists|deleted/i);
	expect(inspectorText, "RT-06 wording: who deleted it").toMatch(/Audrey/);
	// Restore.
	await a.page.evaluate(
		async ({ itemId, deletedAt }) => {
			const mod = (await import(/* @vite-ignore */ "/src/functions/items.functions.ts")) as Record<
				string,
				(o: { data: unknown }) => Promise<unknown>
			>;
			return mod.restoreItem!({ data: { itemId, deletedAt } });
		},
		{ itemId: lunch.id, deletedAt: del.deletedAt ?? "" },
	).catch((e) => console.log("[rt06] restore:", String(e)));
	console.log(`[rt06] console: ${logs.messages.join(" | ")}`);
	await a.ctx.close();
	await d.ctx.close();
});

test("SUG-07 (server): a suggester who forces her editor editable still can't change the shared note", async ({ browser }) => {
	const url = `${GG}?tab=notes`;
	const d = await open(browser, "dennis", url);
	const m = await open(browser, "maya", url);
	const before = await text(d.page);
	const ed = topEditor(m.page);
	await expect(ed).toHaveAttribute("data-editable", "false", { timeout: 15_000 });
	const tag = `forced-${randomBytes(2).toString("hex")}`;
	await ed.evaluate((e, t) => {
		const editor = (e as unknown as { editor?: { setEditable: (b: boolean) => void; commands: { insertContentAt: (p: number, c: string) => boolean } } }).editor;
		editor?.setEditable(true);
		editor?.commands.insertContentAt(1, t);
	}, tag);
	await d.page.waitForTimeout(3_000);
	expect(await text(d.page)).toBe(before);
	await m.page.reload();
	await expectLive(m.page);
	await m.page.waitForTimeout(1_500);
	expect(await text(m.page)).not.toContain(tag);
	await d.ctx.close();
	await m.ctx.close();
});
