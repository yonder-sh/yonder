/**
 * The Asia 2027 import end to end (SPEC §17.3; qa/SCENARIOS §27 SEED): each
 * worker runs the REAL importer (`pnpm sheet:import`) into its own trip under
 * a random slug owned by the fixture user `dev` — the importer's equivalent of
 * `cloneFixtureTrip` (§18.5) — then opens it in the workspace and checks what
 * the zoom engine received (`window.__yonder`, VITE_E2E=1), the Plan and the
 * tab counts. Screenshots: `e2e/shots/seed/`.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { REPO_ROOT, shotPath, storageStateOf } from "./_helpers/env";
import { collectConsole, expectLive, expectNoHorizontalOverflow } from "./_helpers/page";

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

test.use({ storageState: storageStateOf("dev") });
test.describe.configure({ mode: "serial" });

/** Runs `pnpm sheet:import` in the repo; rejects with the output on a non-zero exit. */
async function importer(args: string[]): Promise<string> {
	const { stdout, stderr } = await exec("pnpm", ["--silent", "sheet:import", ...args], {
		cwd: REPO_ROOT,
		timeout: 180_000,
		maxBuffer: 8 * 1024 * 1024,
	});
	return `${stdout}${stderr}`;
}
async function importerFails(args: string[]): Promise<string> {
	try {
		await importer(args);
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; code?: number };
		expect(err.code).toBe(1);
		return `${err.stdout ?? ""}${err.stderr ?? ""}`;
	}
	throw new Error("the importer was expected to fail");
}

type Y = {
	graph: {
		trip: { startDate: string; endDate: string; coverAttachmentId: string | null };
		members: { name: string; status: string; role: string }[];
		days: { id: string; date: string; title: string | null; nightNodeId: string | null }[];
		nodes: { id: string; name: string; type: string; status: string; parentId: string | null; priorities: Record<string, string> }[];
		items: { id: string; dayId: string | null; nodeId: string | null; title: string | null; durationMin: number }[];
		legs: { id: string; mode: string | null; durationMin: number | null; source: string }[];
	};
	schedule: { days: Record<string, { activitiesMin: number }>; items: Record<string, unknown> };
};
const yonder = (page: Page) =>
	page.evaluate(() => (window as unknown as { __yonder?: Y }).__yonder ?? null);

let slug = "";
const baseArgs = (project: string) => [
	"--owner",
	"dev@example.com",
	"--slug",
	slug,
	"--name",
	"Asia 2027 (e2e)",
	"--no-autofill",
	"--report",
	"-",
	// Photos only once: the desktop project imports them, mobile skips the upload.
	...(project === "mobile" ? ["--no-media"] : []),
];

test.beforeAll(async ({ browserName: _b }, info) => {
	test.setTimeout(240_000);
	slug = `asia-e2e-${randomBytes(3).toString("hex")}`;
	const out = await importer(baseArgs(info.project.name));
	expect(out).toContain(`committed trip ${slug}`);
	expect(out).toContain("0 geocode fallbacks, 0 unmatched");
});

test.afterAll(async () => {
	// Leave the database as we found it (the importer's own --remove).
	if (slug) await importer(["--remove", "--slug", slug]).catch(() => "");
});

test("SEED-01/02: the imported tree reaches the workspace", async ({ page }, info) => {
	const logs = collectConsole(page);
	await page.goto(`/t/${slug}?tab=plan`);
	await expectLive(page);
	await expect.poll(async () => (await yonder(page))?.graph.nodes.length).toBe(191);
	const y = (await yonder(page)) as Y;
	const g = y.graph;
	const byType = (t: string) => g.nodes.filter((n) => n.type === t);
	expect(byType("country").map((n) => n.name).sort()).toEqual(["Japan", "South Korea", "Taiwan", "Vietnam"]);
	const cities = [...byType("city"), ...byType("region")];
	expect(cities).toHaveLength(31);
	expect(cities.filter((c) => c.status === "dropped")).toHaveLength(8);
	const named = (n: string) => g.nodes.find((x) => x.name === n);
	expect(named("Hoi An")?.parentId).toBe(named("Vietnam")?.id);
	expect(named("Mt. Fuji")?.type).toBe("region");
	expect(g.members.map((m) => [m.name, m.status, m.role])).toEqual([
		["Dev User", "active", "owner"],
		["Audrey", "placeholder", "editor"],
	]);
	// Audrey's ratings came with her placeholder (ADDENDUM §8).
	const audrey = g.members[1] as { name: string };
	expect(Object.keys(named("Golden Gai")?.priorities ?? {})).toHaveLength(2);
	expect(audrey.name).toBe("Audrey");
	expect(g.trip).toMatchObject({ startDate: "2027-10-02", endDate: "2027-11-07" });
	if (info.project.name === "chromium") {
		expect(g.trip.coverAttachmentId).not.toBeNull();
		await expect(page.getByTestId(TESTID.outline)).toContainText("Japan");
	}
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: shotPath(`seed/import-trip-${info.project.name}.png`), animations: "disabled" });
	expect(logs.messages).toEqual([]);
});

test("SEED-03/05/TL-10: days, durations, travel legs and the backup list", async ({ page }, info) => {
	await page.goto(`/t/${slug}?days=2027-10-07`);
	await expectLive(page);
	await expect.poll(async () => (await yonder(page))?.graph.items.length).toBe(62);
	const y = (await yonder(page)) as Y;
	const g = y.graph;
	const day = (date: string) => g.days.find((d) => d.date === date) as Y["graph"]["days"][number];
	expect(g.days).toHaveLength(37);
	expect(day("2027-10-05").title).toBe("Tokyo · Nakano + Shinjuku");
	expect(day("2027-10-03").title).toBe("Tokyo · Haneda + Shibuya (arrival)");
	const perDay = (date: string) => g.items.filter((i) => i.dayId === day(date).id);
	expect(["2027-10-03", "2027-10-04", "2027-10-05", "2027-10-06", "2027-10-07", "2027-10-08"].map((d) => perDay(d).length)).toEqual([
		11, 11, 9, 10, 8, 5,
	]);
	expect(y.schedule.days[day("2027-10-05").id]?.activitiesMin).toBe(13 * 60);
	expect(g.items.filter((i) => !i.dayId)).toHaveLength(8);
	// The sheet's three Travel rows (the worker's autofill adds estimated legs
	// for the other pairs in the merged app; those aren't the import's).
	expect(
		g.legs
			.filter((l) => l.source === "manual")
			.map((l) => `${l.mode} ${l.durationMin}`)
			.sort(),
	).toEqual(["other 75", "transit 120", "transit 150"]);
	// The ryokan night (§7.6) and the Plan shows the day's items.
	const ryokan = g.nodes.find((n) => n.name === "Kawaguchiko Ryokan");
	expect(day("2027-10-07").nightNodeId).toBe(ryokan?.id);
	if (info.project.name === "mobile") await expandSheet(page);
	const items = page.getByTestId(TESTID.timelineItem);
	await expect(items.filter({ hasText: "Drop bags at ryokan" }).first()).toBeVisible();
	await expect(items.filter({ hasText: "Oishi Park" }).first()).toBeVisible();
	await page.screenshot({ path: shotPath(`seed/import-day5-${info.project.name}.png`), animations: "disabled" });
});

test("SEED-05: Travel rows show their route in the Plan (line or label chip)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout; the 390 px shot is taken below");
	await page.goto(`/t/${slug}?days=2027-10-07..2027-10-08`);
	await expectLive(page);
	// The multi-stop route and the bus keep the sheet's text as one chip (F1i request 1)…
	const labels = page.getByTestId(TESTID.legSummaryLabel);
	await expect(labels.filter({ hasText: "Shiraito → Shin-Fuji → Nagoya" })).toBeVisible();
	await expect(labels.filter({ hasText: "Bus → Shiraito Falls" })).toBeVisible();
	// …and the direct ride shows its line.
	await expect(page.getByText("Fuji Excursion", { exact: true }).first()).toBeVisible();
	await page.getByText("Shiraito → Shin-Fuji → Nagoya").scrollIntoViewIfNeeded();
	await page.screenshot({ path: shotPath("seed/import-day6-legs-1440.png"), animations: "disabled" });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/t/${slug}?days=2027-10-08`);
	await expectLive(page);
	await expandSheet(page);
	await expect(page.getByTestId(TESTID.legSummaryLabel).filter({ hasText: "Bus → Shiraito Falls" })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: shotPath("seed/import-day6-legs-390.png"), animations: "disabled" });
});

test("SEED-06/07/09: lists and links roll up at the trip and at Tokyo", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "tab counts are on the desktop tab bar");
	await page.goto(`/t/${slug}?tab=plan`);
	await expectLive(page);
	const tabs = page.getByTestId(TESTID.centerTabs);
	// 32 todos (11 Book ahead + 21 Action Timeline) + 27 shopping; 94 photos +
	// 32 links, minus the 6 links on dropped cities (the tab counts what the
	// Media tab shows, and dropped places are hidden: WP-Shell scope counts).
	await expect(tabs).toContainText(/Lists\s*59/);
	await expect(tabs).toContainText(/Media\s*120/);
	await page.goto(`/t/${slug}/japan/tokyo?lens=area&tab=lists&list=shopping`);
	await expectLive(page);
	// ROLL-01: 19 shopping items inside Tokyo, plus its to-dos.
	// The tab counts what the Lists tab shows (WP-Shell scope counts through
	// the same rollup): 19 shopping + 15 to-dos (the 13 on Tokyo's places plus
	// the two on its visits and Haneda, which the Lists tab also rolls up).
	await expect(page.getByTestId(TESTID.centerTabs)).toContainText(/Lists\s*34/);
	await expect(page.getByText("Kitchen knives")).toBeVisible();
	await page.screenshot({ path: shotPath("seed/import-tokyo-lists-chromium.png"), animations: "disabled" });
});

test("SEED-10/13: a second run refuses, --replace replaces, bad input leaves nothing", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	test.setTimeout(240_000);
	const refused = await importerFails(baseArgs("mobile"));
	expect(refused).toContain(`a trip with the slug "${slug}" already exists`);

	const out = await importer([...baseArgs("mobile"), "--replace"]);
	expect(out).toMatch(/replacing [0-9a-f-]{36}/);
	await page.goto(`/t/${slug}?tab=plan`);
	await expectLive(page);
	await expect.poll(async () => (await yonder(page))?.graph.nodes.length).toBe(191);
	expect((await yonder(page))?.graph.items.length).toBe(62);

	const dir = mkdtempSync(path.join(tmpdir(), "sheet-e2e-"));
	try {
		cpSync(path.join(REPO_ROOT, "seed/data"), dir, { recursive: true });
		const f = path.join(dir, "places.json");
		const bad = JSON.parse(readFileSync(f, "utf8"));
		bad.headers = bad.headers.map((h: string) => (h === "City" ? "Town" : h));
		writeFileSync(f, JSON.stringify(bad));
		const badSlug = `${slug}-bad`;
		const msg = await importerFails(["--owner", "dev@example.com", "--slug", badSlug, "--no-media", "--no-autofill", "--report", "-", "--data-dir", dir]);
		expect(msg).toMatch(/places\.json: .*missing column "City"/);
		await page.goto(`/t/${badSlug}?tab=plan`);
		await expect(page.getByText("This trip doesn't exist or you don't have access.")).toBeVisible();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
