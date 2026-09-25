/**
 * I2 "content" verifier: QA TAG-01/02/03 on the imported Asia 2027 trip.
 */
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
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
	days: { id: string; date: string }[];
	members: { id: string; name: string; userId: string | null; status: string }[];
	me: { memberId: string | null; userId: string | null };
};
const graphOf = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
async function ctxFor(browser: Browser, h: string | null) {
	const ctx = await browser.newContext({ ...(h ? { storageState: state(h) } : {}), viewport: { width: 1440, height: 900 } });
	return { ctx, page: await ctx.newPage() };
}
const itemName = (g: G, id: string) => {
	const it = g.items.find((i) => i.id === id);
	return it?.title ?? g.nodes.find((n) => n.id === it?.nodeId)?.name ?? "?";
};
function findItem(g: G, name: string) {
	return g.items.find((i) => itemName(g, i.id) === name && i.dayId);
}

async function assignVia(page: Page, itemId: string, names: string[]) {
	await page.goto(`/t/asia-2027?sel=i.${itemId}`);
	await expectLive(page);
	const box = page.getByTestId(PLAN_TESTID.overviewAssignees);
	await expect(box).toBeVisible();
	await box.getByRole("button", { name: /Assign|Edit/ }).click();
	await page.waitForTimeout(300);
	const opts = await page.locator("[role=option],[cmdk-item]").allInnerTexts();
	for (const n of names) await page.locator("[role=option],[cmdk-item]").filter({ hasText: n }).first().click();
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
	return opts;
}

test("TAG-01/02 tag members on timeline items; avatars live; filter; guests never", async ({ browser }) => {
	// Guest-E active in the trip.
	const ge = await ctxFor(browser, null);
	await ge.page.goto("/join#t=qa-share-token-editor-asia-2027");
	await expect(ge.page).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
	await expectLive(ge.page);
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	const g = await graphOf(d.page);
	const audrey = g.members.find((m) => m.name.startsWith("Audrey"));
	const dennis = g.members.find((m) => m.name.startsWith("Dennis"));
	console.log("MEMBERS", JSON.stringify(g.members.map((m) => `${m.name}:${m.status}`)));
	const before = g.items.filter((i) => audrey && i.assigneeIds.includes(audrey.id)).map((i) => itemName(g, i.id));
	console.log("AUDREY TAGGED BEFORE", before.length, JSON.stringify(before));
	const samoyed = g.items.find((i) => /Samoyed/.test(itemName(g, i.id)));
	const uniqlo = g.items.find((i) => /Uniqlo Ginza/.test(itemName(g, i.id)));
	const golden = findItem(g, "Golden Gai");
	console.log("targets", samoyed && itemName(g, samoyed.id), uniqlo && itemName(g, uniqlo.id), golden && itemName(g, golden.id));
	if (!samoyed || !uniqlo || !golden || !audrey || !dennis) throw new Error("fixture items missing");
	const a = await ctxFor(browser, "audrey");
	const day6 = g.days.find((x) => x.date === "2027-10-06");
	await a.page.goto(`/t/asia-2027?tab=plan&sel=d.${day6?.id}`);
	await expectLive(a.page);
	const opts = await assignVia(d.page, samoyed.id, ["Audrey"]);
	console.log("TAG picker options", JSON.stringify(opts));
	expect(opts.join("|")).not.toMatch(/Guest/i);
	await shot(d.page, "15-tag01-samoyed");
	// Audrey sees the avatar on the Samoyed card live.
	const card = a.page.getByTestId(TESTID.timelineItem).filter({ hasText: /Samoyed/ }).first();
	await card.scrollIntoViewIfNeeded();
	const t0 = Date.now();
	await expect.poll(async () => (await card.innerText()).includes("AT") || (await card.locator("[data-member-id],[data-testid*=avatar]").count()) > 0, { timeout: 5_000 }).toBe(true);
	console.log("TAG-01 live ms", Date.now() - t0);
	await shot(a.page, "15-tag01-audrey-card");
	await assignVia(d.page, uniqlo.id, ["Audrey"]);
	await assignVia(d.page, golden.id, ["Dennis", "Audrey"]);
	const g2 = await graphOf(d.page);
	const tagged = g2.items.filter((i) => i.assigneeIds.includes(audrey.id)).map((i) => itemName(g2, i.id));
	console.log("AUDREY TAGGED AFTER", tagged.length, JSON.stringify(tagged));
	expect(g2.items.find((i) => i.id === golden.id)?.assigneeIds.sort()).toEqual([dennis.id, audrey.id].sort());
	// The Plan's person filter.
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	await d.page.getByRole("button", { name: /Someone/ }).click();
	await d.page.waitForTimeout(300);
	await shot(d.page, "15-tag01-filter-open");
	const fopts = await d.page.locator("[role=option],[role=menuitemradio],[role=menuitem],[cmdk-item]").allInnerTexts();
	console.log("PLAN person filter options", JSON.stringify(fopts));
	await d.page.locator("[role=option],[role=menuitemradio],[role=menuitem],[cmdk-item]").filter({ hasText: "Audrey" }).first().click();
	await d.page.waitForTimeout(1000);
	const shown = await d.page.getByTestId(TESTID.timelineItem).allInnerTexts();
	console.log("FILTER Audrey cards", shown.length, JSON.stringify(shown.map((s) => s.split("\n").slice(0, 3).join(" "))));
	console.log("URL", d.page.url());
	await shot(d.page, "15-tag01-filter-audrey");
	// TAG-02: a replayed tag request with a non-member id is refused and stores nothing.
	const res = await d.page.evaluate(
		async ({ itemId }) => {
			const m = await import("/src/functions/items.functions.ts");
			const out: string[] = [];
			for (const bad of ["00000000-0000-7000-8000-00000000abcd"]) {
				try {
					await m.setItemAssignees({ data: { itemId, memberIds: [bad] } });
					out.push("ACCEPTED");
				} catch (e) {
					out.push(`refused: ${(e as Error).message}`);
				}
			}
			return out;
		},
		{ itemId: golden.id },
	);
	console.log("TAG-02 replay", JSON.stringify(res));
	expect(res.join()).not.toMatch(/ACCEPTED/);
	// The guest's user id / session as a member id.
	const guestIds = await ge.page.evaluate(() => {
		const y = (window as unknown as { __yonder: { graph: G } }).__yonder;
		return { me: y.graph.me };
	});
	console.log("GUEST me", JSON.stringify(guestIds));
	const res2 = await d.page.evaluate(
		async ({ itemId, ids }) => {
			const m = await import("/src/functions/items.functions.ts");
			const out: string[] = [];
			for (const bad of ids) {
				try {
					await m.setItemAssignees({ data: { itemId, memberIds: [bad] } });
					out.push(`ACCEPTED ${bad}`);
				} catch (e) {
					out.push(`refused: ${(e as Error).message}`);
				}
			}
			return out;
		},
		{ itemId: golden.id, ids: [guestIds.me.userId, guestIds.me.memberId].filter((x): x is string => !!x) },
	);
	console.log("TAG-02 guest ids", JSON.stringify(res2));
	expect(res2.join()).not.toMatch(/ACCEPTED/);
	const g3 = await graphOf(d.page);
	expect(g3.items.find((i) => i.id === golden.id)?.assigneeIds.sort()).toEqual([dennis.id, audrey.id].sort());
	await ge.ctx.close();
	await d.ctx.close();
	await a.ctx.close();
});

test("TAG-03 who can tag: Kai and Guest-V can't; Guest-E can (members only)", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	const g = await graphOf(d.page);
	const golden = findItem(g, "Golden Gai");
	if (!golden) throw new Error("no Golden Gai item");
	await d.ctx.close();
	for (const who of ["kai", "guest-v", "guest-e"] as const) {
		const c = await ctxFor(browser, who === "kai" ? "kai" : null);
		if (who !== "kai") {
			await c.page.goto(`/join#t=qa-share-token-${who === "guest-v" ? "viewer" : "editor"}-asia-2027`);
			await expect(c.page).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
		}
		await c.page.goto(`/t/asia-2027?sel=i.${golden.id}`);
		await expectLive(c.page);
		const box = c.page.getByTestId(PLAN_TESTID.overviewAssignees);
		await expect(box).toBeVisible();
		const btn = box.getByRole("button", { name: /Assign|Edit/ });
		const enabled = (await btn.count()) > 0 && (await btn.isEnabled());
		console.log(`TAG-03 ${who}: sees "${(await box.innerText()).replace(/\n/g, " ")}", picker enabled=${enabled}`);
		await shot(c.page, `15-tag03-${who}`);
		if (enabled) {
			await btn.click();
			await c.page.waitForTimeout(300);
			const opts = await c.page.locator("[role=option],[cmdk-item]").allInnerTexts();
			console.log(`TAG-03 ${who} options`, JSON.stringify(opts));
			await c.page.keyboard.press("Escape");
		}
		// Server check: a direct call.
		const r = await c.page.evaluate(
			async ({ itemId, ids }) => {
				const m = await import("/src/functions/items.functions.ts");
				try {
					await m.setItemAssignees({ data: { itemId, memberIds: ids } });
					return "ACCEPTED";
				} catch (e) {
					return `refused: ${(e as Error).message}`;
				}
			},
			{ itemId: golden.id, ids: golden.assigneeIds },
		);
		console.log(`TAG-03 ${who} server`, r);
		if (who !== "guest-e") expect(r).not.toBe("ACCEPTED");
		await c.ctx.close();
	}
});
