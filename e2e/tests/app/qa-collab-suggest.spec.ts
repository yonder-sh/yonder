/**
 * I2 verifier "collab" (round 1): suggestion mode on the QA seed's Asia 2027
 * (EXTENSIONS §3.9, QA SUG), driven through the real UI in two browsers.
 *
 * Needs the QA seed (`pnpm db:seed:qa`) on the app under test and one
 * storageState per handle in `$QA_AUTH_DIR/<handle>.json` (dennis, maya,
 * audrey, kai). Screenshots go to `$QA_SHOTS_DIR` (else e2e/shots/qa-collab).
 * Each test restores what it changed, so the file can run again.
 */
import path from "node:path";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { PLAN_TESTID as P } from "../../../src/features/plan/testids";
import { SUGGEST_TESTID as S } from "../../../src/features/suggest/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath } from "./_helpers/env";
import { collectConsole, expectLive } from "./_helpers/page";

const AUTH = process.env.QA_AUTH_DIR ?? path.resolve("e2e/.auth");
const auth = (h: string) => path.join(AUTH, `${h}.json`);
const shot = (n: string) =>
	process.env.QA_SHOTS_DIR ? path.join(process.env.QA_SHOTS_DIR, `${n}.png`) : shotPath(`qa-collab/${n}.png`);

type G = {
	trip: { id: string; startDate: string };
	days: { id: string; date: string }[];
	items: { id: string; dayId: string | null; nodeId: string | null; title: string | null; durationMin: number }[];
	nodes: { id: string; name: string; parentId: string | null; type: string }[];
};
const graphOf = (page: Page) =>
	page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);

async function open(browser: Browser, handle: string, url: string, viewport = { width: 1440, height: 900 }) {
	const ctx = await browser.newContext({ storageState: auth(handle), viewport });
	const page = await ctx.newPage();
	await page.goto(url);
	await expectLive(page);
	await page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph);
	return { ctx, page };
}

async function itemByTitle(page: Page, title: string) {
	const g = await graphOf(page);
	const node = g.nodes.find((n) => n.name === title);
	const it = g.items.find((i) => i.dayId && (i.title === title || (node && i.nodeId === node.id)));
	if (!it) throw new Error(`no item ${title}`);
	const day = g.days.find((d) => d.id === it.dayId);
	return { ...it, date: day?.date ?? null };
}
const dayIdOf = async (page: Page, date: string) => {
	const d = (await graphOf(page)).days.find((x) => x.date === date);
	if (!d) throw new Error(`no day ${date}`);
	return d.id;
};

/** Picks a day in the item overview's Day select (the real "move to day" UI). */
async function moveViaOverview(page: Page, label: RegExp) {
	const overview = page.getByTestId(TESTID.itemOverview);
	await expect(overview).toBeVisible();
	await overview.getByTestId(P.overviewDay).click();
	await page.getByRole("option", { name: label }).click();
}

/** Scrolls a day into the Plan's window so its rows render (days are windowed). */
async function showDay(page: Page, dayId: string) {
	const sec = page.locator(`[data-testid="${P.daySection}"][data-day-id="${dayId}"]`).first();
	await sec.scrollIntoViewIfNeeded();
	await page.waitForTimeout(300);
}

async function dismissHint(page: Page) {
	const hint = page.getByTestId(S.firstHint);
	if (await hint.isVisible().catch(() => false)) await hint.getByRole("button", { name: "Got it" }).click();
}

async function openCount(page: Page): Promise<number> {
	return page.evaluate(async () => {
		const mod = (await import(/* @vite-ignore */ "/src/functions/proposals.functions.ts")) as Record<
			string,
			(o: { data: unknown }) => Promise<unknown>
		>;
		const y = (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder;
		const out = (await mod.listProposals!({ data: { tripId: y.graph.trip.id } })) as
			| { status: string }[]
			| { proposals: { status: string }[] };
		const list = Array.isArray(out) ? out : out.proposals;
		return list.filter((p) => p.status === "open").length;
	});
}

/** Withdraws the caller's open suggestions whose summary matches (leftovers of an earlier run). */
async function withdrawMine(page: Page, re: RegExp): Promise<number> {
	return page.evaluate(async (src) => {
		const mod = (await import(/* @vite-ignore */ "/src/functions/proposals.functions.ts")) as Record<
			string,
			(o: { data: unknown }) => Promise<unknown>
		>;
		const y = (window as unknown as { __yonder: { graph: { trip: { id: string } }; me?: unknown } }).__yonder;
		const list = (await mod.listProposals!({ data: { tripId: y.graph.trip.id } })) as {
			id: string;
			status: string;
			summary: string;
		}[];
		const re = new RegExp(src);
		let n = 0;
		for (const p of list)
			if (p.status === "open" && re.test(p.summary)) {
				try {
					await mod.withdrawProposal!({ data: { proposalId: p.id } });
					n++;
				} catch {
					// someone else's
				}
			}
		return n;
	}, re.source);
}

test.skip(({ isMobile }) => isMobile, "desktop flows; the phone has its own test");

test("SUG-01/06/02: Maya's move shows as a ghost for Dennis within 2 s, amends, withdraws on move-back, then an accept is solid", async ({
	browser,
}) => {
	const tokyo = "/t/asia-2027/japan/tokyo";
	const pre = await open(browser, "maya", tokyo);
	await withdrawMine(pre.page, /Itoya/);
	await pre.ctx.close();
	const d = await open(browser, "dennis", tokyo);
	const dLogs = collectConsole(d.page);
	const itoya = await itemByTitle(d.page, "Itoya (G.Itoya)");
	expect(itoya.date).toBe("2027-10-04");
	const before = await openCount(d.page);

	const m = await open(browser, "maya", `${tokyo}?sel=i.${itoya.id}`);
	const mLogs = collectConsole(m.page);
	await dismissHint(m.page);
	await expect(m.page.getByTestId(TESTID.suggestModeControl).first()).toContainText("Suggesting");

	// SUG-01: the move is a suggestion; Dennis sees a dashed card on Tue 5 Oct and an origin row on Mon 4 Oct.
	await moveViaOverview(m.page, /Tue 5 Oct/);
	const t0 = Date.now();
	await expect(m.page.getByText(/^Suggested — /).first()).toBeVisible();
	const tueId = await dayIdOf(d.page, "2027-10-05");
	const monId = await dayIdOf(d.page, "2027-10-04");
	await showDay(d.page, tueId);
	const ghost = d.page.getByTestId(TESTID.proposalGhost).filter({ hasText: "Itoya" }).first();
	await expect(ghost).toBeVisible({ timeout: 5_000 });
	const ghostMs = Date.now() - t0;
	const origin = d.page.getByTestId(P.originRow).filter({ hasText: "Itoya" });
	await expect(origin).toBeVisible();
	await expect(origin).toContainText("Maya");
	await ghost.scrollIntoViewIfNeeded();
	await d.page.waitForTimeout(400);
	await d.page.screenshot({ path: shot("sug01-dennis-ghost") });
	await m.page.screenshot({ path: shot("sug01-maya-after-move") });
	// Nothing moved on the server.
	expect((await itemByTitle(d.page, "Itoya (G.Itoya)")).date).toBe("2027-10-04");
	expect(ghostMs, "ghost reached the other browser").toBeLessThan(2_500);
	expect(await openCount(d.page)).toBe(before + 1);

	// SUG-06: moving it again amends the same suggestion.
	await moveViaOverview(m.page, /Wed 6 Oct/);
	await expect(m.page.getByText(/^Suggested — /).first()).toBeVisible();
	await expect.poll(() => openCount(d.page)).toBe(before + 1);
	await expect(d.page.getByTestId(P.originRow).filter({ hasText: "Itoya" })).toContainText(/Day 5|Wed/);

	// …and moving it back to its own day withdraws it.
	await moveViaOverview(m.page, /Mon 4 Oct/);
	await expect.poll(() => openCount(d.page), { timeout: 10_000 }).toBe(before);
	await expect(d.page.getByTestId(P.originRow).filter({ hasText: "Itoya" })).toHaveCount(0, { timeout: 5_000 });
	await m.page.screenshot({ path: shot("sug06-maya-after-moveback") });

	// SUG-02: suggest again, Dennis accepts from the ghost's ✓; the card is solid and Itoya moved.
	await moveViaOverview(m.page, /Tue 5 Oct/);
	await showDay(d.page, tueId);
	await expect(d.page.getByTestId(TESTID.proposalGhost).filter({ hasText: "Itoya" }).first()).toBeVisible({
		timeout: 5_000,
	});
	const g2 = d.page.getByTestId(TESTID.proposalGhost).filter({ hasText: "Itoya" }).first();
	await g2.scrollIntoViewIfNeeded();
	await g2.hover();
	const tick = d.page.getByTestId(S.ghostAccept).first();
	await expect(tick).toBeVisible();
	await d.page.screenshot({ path: shot("sug02-dennis-hover-actions") });
	await tick.click();
	await expect.poll(async () => (await itemByTitle(d.page, "Itoya (G.Itoya)")).date, { timeout: 10_000 }).toBe(
		"2027-10-05",
	);
	await expect(d.page.getByTestId(TESTID.proposalGhost).filter({ hasText: "Itoya" })).toHaveCount(0);
	await expect.poll(async () => (await itemByTitle(m.page, "Itoya (G.Itoya)")).date, { timeout: 5_000 }).toBe(
		"2027-10-05",
	);
	await m.page.waitForTimeout(500);
	await m.page.screenshot({ path: shot("sug02-maya-after-accept") });

	// The activity names both people.
	const act = await d.page.evaluate(async (tripId) => {
		const mod = (await import(/* @vite-ignore */ "/src/functions/graph.functions.ts")) as Record<
			string,
			(o: { data: unknown }) => Promise<unknown>
		>;
		const fn = mod.listActivity;
		return fn ? JSON.stringify(await fn({ data: { tripId } })) : `no activity fn: ${Object.keys(mod).join(",")}`;
	}, (await graphOf(d.page)).trip.id);
	expect(act).toContain("Maya (accepted by Dennis)");

	// Restore: Dennis (editing) moves it back into its old slot, after Nihonbashi Nishikawa.
	const prev = await itemByTitle(d.page, "Nihonbashi Nishikawa");
	await d.page.evaluate(
		async ({ itemId, dayId, afterItemId }) => {
			const mod = (await import(/* @vite-ignore */ "/src/functions/items.functions.ts")) as Record<
				string,
				(o: { data: unknown }) => Promise<unknown>
			>;
			await mod.moveItem!({ data: { itemId, dayId, afterItemId } });
			// This tab never hears its own change: refresh like the app's hooks would.
			const { appQueryClient } = await import(
				/* @vite-ignore */ "/src/features/suggest/__harness__/app-query-client.ts"
			);
			await appQueryClient()?.invalidateQueries();
		},
		{ itemId: itoya.id, dayId: monId, afterItemId: prev.id },
	);
	await expect.poll(async () => (await itemByTitle(d.page, "Itoya (G.Itoya)")).date, { timeout: 10_000 }).toBe(
		"2027-10-04",
	);
	expect(dLogs.messages, "Dennis console").toEqual([]);
	expect(mLogs.messages, "Maya console").toEqual([]);
	await m.ctx.close();
	await d.ctx.close();
});

export type { BrowserContext };
