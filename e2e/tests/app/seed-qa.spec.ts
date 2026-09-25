/**
 * The QA seed (SPEC §17.2; qa/SCENARIOS TI-3, F1–F4; EXTENSIONS §2.1):
 * `pnpm db:seed:qa` imports Asia 2027 for Dennis Tester with the fixtures,
 * links Audrey, adds Kai, Eve and Maya (suggester), the F2 trips, the three
 * share links, three expenses and Maya's two suggestions, and writes one
 * storageState per handle. This spec runs it once (desktop project only: the QA seed owns
 * the fixed slug `asia-2027` and the QA accounts, so it can't run in two
 * workers at once) and checks what each person sees.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { E2E_ROOT, REPO_ROOT, shotPath } from "./_helpers/env";
import { collectConsole, expectLive } from "./_helpers/page";

const exec = promisify(execFile);

/** Drags the mobile plan sheet from its peek up to the top snap (compact layouts). */
async function expandSheet(page: Page): Promise<void> {
	const sheet = page.getByTestId(TESTID.mobileSheet);
	const box = await sheet.boundingBox();
	if (!box) return;
	const x = box.width / 2;
	const y0 = box.y + 8;
	await page.mouse.move(x, y0);
	await page.mouse.down();
	for (let i = 1; i <= 20; i++) await page.mouse.move(x, y0 - (i * (y0 - 120)) / 20);
	await page.mouse.up();
	await expect.poll(async () => (await sheet.boundingBox())?.y ?? 9999).toBeLessThan(200);
}
const qaState = (handle: string) => path.join(E2E_ROOT, ".auth", `qa-${handle}.json`);

test.describe.configure({ mode: "serial" });

type Y = {
	graph: {
		me: { role: string; name: string };
		members: { name: string; status: string; role: string }[];
		days: { id: string; date: string; startTime: string }[];
		nodes: { id: string; name: string }[];
		items: { id: string; dayId: string | null; nodeId: string | null; title: string | null }[];
		legs: { id: string; mode: string | null; details: { kind?: string; flight?: { flightNumber?: string } } }[];
	};
	schedule: { items: Record<string, { start: string; tz: string }> };
};

/** Local HH:mm of an item's scheduled start, read from the engine in the page. */
async function startOf(page: Page, date: string, title: string): Promise<string | null> {
	return page.evaluate(
		([date, title]) => {
			const y = (window as unknown as { __yonder?: Y }).__yonder;
			if (!y) return null;
			const day = y.graph.days.find((d) => d.date === date);
			const names = new Map(y.graph.nodes.map((n) => [n.id, n.name]));
			const it = y.graph.items.find(
				(i) => i.dayId === day?.id && (i.title ?? names.get(i.nodeId ?? "")) === title,
			);
			const s = it ? y.schedule.items[it.id] : undefined;
			if (!s) return null;
			return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: s.tz }).format(
				new Date(s.start),
			);
		},
		[date, title] as const,
	);
}

test.beforeAll(async ({ browserName: _b }, info) => {
	test.skip(info.project.name !== "chromium", "the QA seed owns fixed slugs and accounts: one worker");
	test.setTimeout(240_000);
	const { stdout } = await exec("pnpm", ["--silent", "db:seed:qa", "--no-media", "--no-autofill"], {
		cwd: REPO_ROOT,
		timeout: 180_000,
		maxBuffer: 8 * 1024 * 1024,
	});
	expect(stdout).toContain("[db:seed:qa] trip asia-2027");
	expect(stdout).toContain("storageStates:");
});

test("TI-3: a storageState per QA handle", async ({}, info) => {
	test.skip(info.project.name !== "chromium", "desktop only");
	for (const h of ["dennis", "audrey", "kai", "eve", "maya"]) expect(existsSync(qaState(h)), h).toBe(true);
});

test("F1/F4-a: Dennis owns Asia 2027 and NH 9 lands at 05:00", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop only");
	const ctx = await browser.newContext({ storageState: qaState("dennis"), viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	const logs = collectConsole(page);
	await page.goto("/t/asia-2027?days=2027-10-03");
	await expectLive(page);
	await expect.poll(() => startOf(page, "2027-10-03", "Arrival formalities")).toBe("05:00");
	expect(await startOf(page, "2027-10-03", "Anamori Inari Shrine")).toBe("06:40");
	expect(await startOf(page, "2027-10-03", "JAL Sky Museum")).toBe("09:30");
	const y = (await page.evaluate(() => (window as unknown as { __yonder: Y }).__yonder)) as Y;
	expect(y.graph.me.role).toBe("owner");
	expect(y.graph.members.map((m) => [m.name, m.role])).toEqual([
		["Dennis Tester", "owner"],
		["Audrey Tester", "editor"],
		["Kai Viewer", "viewer"],
		["Maya Suggester", "suggester"],
	]);
	const flights = y.graph.legs.filter((l) => l.mode === "flight").map((l) => l.details.flight?.flightNumber);
	expect(flights.sort()).toEqual(["KE724", "NH9", "TK11", "TK25", "VJ981", "VN576"]);
	await expect(page.getByTestId(TESTID.timelineItem).filter({ hasText: "Arrival formalities" })).toBeVisible();
	await page.screenshot({ path: shotPath("seed/qa-arrival-1440.png"), animations: "disabled" });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/t/asia-2027?days=2027-10-07");
	await expectLive(page);
	await expandSheet(page);
	await expect(page.getByTestId(TESTID.timelineItem).filter({ hasText: "Drop bags at ryokan" })).toBeVisible();
	await page.screenshot({ path: shotPath("seed/qa-day5-390.png"), animations: "disabled" });
	expect(logs.messages).toEqual([]);
	await ctx.close();
});

test("F1/F2: Audrey edits, Kai views, Eve has no access, the side trips exist", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop only");
	const open = async (handle: string, url: string) => {
		const ctx = await browser.newContext({ storageState: qaState(handle) });
		const page = await ctx.newPage();
		await page.goto(url);
		return { ctx, page };
	};
	const role = (page: Page) =>
		page.evaluate(() => (window as unknown as { __yonder?: Y }).__yonder?.graph.me.role ?? null);

	const a = await open("audrey", "/t/asia-2027?tab=plan");
	await expectLive(a.page);
	await expect.poll(() => role(a.page)).toBe("editor");
	await a.page.goto("/");
	await expect(a.page.getByTestId(TESTID.dashboard)).toContainText("Phu Quoc detour");
	await expect(a.page.getByTestId(TESTID.dashboard)).toContainText("Delete me");
	await a.ctx.close();

	const k = await open("kai", "/t/asia-2027?tab=plan");
	await expectLive(k.page);
	await expect.poll(() => role(k.page)).toBe("viewer");
	await k.ctx.close();

	const e = await open("eve", "/t/asia-2027?tab=plan");
	await expect(e.page.getByText("This trip doesn't exist or you don't have access.")).toBeVisible();
	await e.ctx.close();

	const d = await open("dennis", "/");
	await expect(d.page.getByTestId(TESTID.dashboard)).toContainText("Phu Quoc detour");
	await d.ctx.close();
});

const hasGhost = (page: Page, name: string) =>
	page.evaluate(
		(name) =>
			(window as unknown as { __yonder?: { ix: { graph: { nodes: { name: string }[] } } } }).__yonder?.ix.graph.nodes.some(
				(n) => n.name === name,
			) ?? null,
		name,
	);

test("EXTENSIONS §2.1: Maya suggests, Dennis sees her suggestions, Kai doesn't", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop only");
	const open = async (handle: string) => {
		const ctx = await browser.newContext({ storageState: qaState(handle), viewport: { width: 1440, height: 900 } });
		const page = await ctx.newPage();
		await page.goto("/t/asia-2027/japan/kyoto");
		await expectLive(page);
		return { ctx, page };
	};
	const m = await open("maya");
	await expect.poll(() => m.page.evaluate(() => (window as unknown as { __yonder?: Y }).__yonder?.graph.me.role ?? null)).toBe("suggester");
	// Her own open suggestions show to her as ghosts (the overlay), and nothing is applied.
	await expect.poll(() => hasGhost(m.page, "Tōfuku-ji")).toBe(true);
	expect((await m.page.evaluate(() => (window as unknown as { __yonder: Y }).__yonder)).graph.nodes.some((n) => n.name === "Tōfuku-ji")).toBe(false);
	await m.ctx.close();
	const d = await open("dennis");
	await expect.poll(() => hasGhost(d.page, "Tōfuku-ji")).toBe(true);
	await d.page.screenshot({ path: shotPath("seed/qa-kyoto-suggestions-1440.png"), animations: "disabled" });
	await d.ctx.close();
	const k = await open("kai");
	await expect.poll(() => hasGhost(k.page, "Kyoto")).toBe(true);
	expect(await hasGhost(k.page, "Tōfuku-ji")).toBe(false);
	await k.ctx.close();
});

test("EXTENSIONS §2.1: the suggester link makes a guest a suggester", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop only");
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto("/join#t=qa-share-token-suggester-asia-2027");
	await expect(page).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
	await expectLive(page);
	await expect
		.poll(() => page.evaluate(() => (window as unknown as { __yonder?: Y }).__yonder?.graph.me.role ?? null))
		.toBe("suggester");
	await ctx.close();
});

test("F2: the QA viewer link opens the trip for an anonymous guest", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop only");
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto("/join#t=qa-share-token-viewer-asia-2027");
	await expect(page).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
	await expectLive(page);
	await expect
		.poll(() => page.evaluate(() => (window as unknown as { __yonder?: Y }).__yonder?.graph.me.role ?? null))
		.toBe("viewer");
	await ctx.close();
});
