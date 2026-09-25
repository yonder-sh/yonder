/**
 * FEEDBACK-4 (FB-21…FB-25), in real browsers on one cloned trip: A (Dev,
 * 1440×900) leads; B (Maya, 1120×720) follows from the presence card; a
 * phone (Pixel 7) and a link guest join through Spotlight.
 * - FB-21a plan folds (a stretch fold, "N days elsewhere", Collapse all);
 * - FB-21b the inspector tab (`itab` in the URL);
 * - FB-21c the media viewer: open / next / close, and an uploaded video's
 *   play / pause / seek;
 * - FB-21d a lists / map switch (the grouping, the layer panel);
 * - FB-22 the map camera at different window sizes (fit the view), and the
 *   follower's own move pausing it with "Back to Dev's view";
 * - FB-23 a drag ghost, the dimmed original and the drop line;
 * - FB-24 a form chip (on the flight row and in its inspector) and the
 *   follower's banner; a private to-do's editor shows nothing;
 * - FB-25 an open menu's ghost with the hovered entry and A's cursor on it;
 * - privacy: a guest follower never receives money, private rows, their
 *   drags, menus or editors.
 * Awareness and what each page received are exposed under VITE_E2E=1
 * (`window.__yonderCursors`, LiveCursors; `window.__tripMap`, MapCanvas).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Browser,
	type BrowserContext,
	devices,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import { MAP_TESTID } from "../../../src/features/map/testids";
import { MEDIA_TESTID } from "../../../src/features/media/testids";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
import { SHELL_TESTID as S } from "../../../src/features/shell/testids";
import { TRANSIT_TESTID } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath, storageStateOf } from "./_helpers/env";
import { type FixtureClone, cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

test.describe.configure({ mode: "serial" });

const A_SIZE = { width: 1440, height: 900 };
const B_SIZE = { width: 1120, height: 720 };

type Cam = { c: [number, number]; z: number; w: number; h: number; g: boolean };
type W = {
	__yonderCursors: {
		awareness: {
			getLocalState(): Record<string, unknown> | null;
			setLocalStateField(k: string, v: unknown): void;
		};
		probe: {
			drags: { userId: string; drag: unknown }[];
			menus: { userId: string; menu: { a: string } | null }[];
		};
	};
	__tripMap?: {
		jumpTo(o: unknown): void;
		getZoom(): number;
		getCenter(): { lng: number; lat: number };
		isMoving(): boolean;
	};
};

async function open(
	browser: Browser,
	who: string,
	url: string,
	opts: { viewport?: { width: number; height: number }; phone?: boolean } = {},
): Promise<{ ctx: BrowserContext; page: Page }> {
	const ctx = await browser.newContext({
		storageState: storageStateOf(who),
		...(opts.phone ? devices["Pixel 7"] : { viewport: opts.viewport ?? A_SIZE }),
	});
	const page = await ctx.newPage();
	await page.goto(url);
	await expectLive(page);
	await page.waitForFunction(() => !!(window as { __yonderCursors?: unknown }).__yonderCursors);
	return { ctx, page };
}

/** B follows A from A's avatar's hover card. */
async function follow(b: Page) {
	await b.getByTestId(TESTID.presenceAvatar).first().hover();
	await b.getByTestId(S.followButton).click();
	await b.mouse.move(700, 600);
	await expect(b.getByTestId(S.followBar)).toContainText("Following");
}

/** A starts a Spotlight; `pages` follow A. */
async function spotlight(a: Page, pages: Page[]) {
	await a.getByTestId(TESTID.tripMenu).click();
	await a.getByTestId(S.spotlightMenuItem).click();
	for (const p of pages)
		await expect(p.getByTestId(S.followBar)).toContainText("Following Dev", { timeout: 10_000 });
}

const localState = (p: Page) =>
	p.evaluate(() => (window as unknown as W).__yonderCursors.awareness.getLocalState());
const probe = (p: Page) => p.evaluate(() => (window as unknown as W).__yonderCursors.probe);

async function userIdOf(page: Page): Promise<string> {
	const r = await page.request.get("/api/auth/get-session");
	return ((await r.json()) as { user: { id: string } }).user.id;
}

const card = (p: Page, id: string) => p.locator(`[data-cursor-anchor="item:${id}"]`);

let trip: FixtureClone;
let devId = "";

test.beforeAll(async ({ browser }) => {
	const owner = await browser.newContext({ storageState: storageStateOf("dev") });
	trip = await cloneFixtureTrip(owner.request);
	devId = await userIdOf(await owner.newPage());
	await owner.close();
});

test.beforeEach(({}, info) => {
	test.skip(info.project.name !== "chromium", "several windows of their own sizes (one of them a phone)");
});

test("FB-21a/b/d: folds, the inspector tab and view switches follow", async ({ browser }) => {
	const url = `/t/${trip.slug}/japan/tokyo?lens=area`;
	const a = await open(browser, "dev", url);
	const b = await open(browser, "maya", `/t/${trip.slug}?tab=plan`, { viewport: B_SIZE });
	await follow(b.page);
	await expect(b.page).toHaveURL(/japan\/tokyo\?lens=area/, { timeout: 10_000 });

	// A stretch fold ("· 2 stops elsewhere ·") inside a day.
	const stretch = (p: Page) => p.locator(`[data-testid="${PLAN_TESTID.fold}"]:not([data-reason])`).first();
	await expect(stretch(a.page)).toBeVisible();
	await expect(stretch(b.page)).toHaveAttribute("aria-expanded", "false");
	await stretch(a.page).click();
	await expect(stretch(a.page)).toHaveAttribute("aria-expanded", "true");
	await expect(stretch(b.page)).toHaveAttribute("aria-expanded", "true", { timeout: 8_000 });

	// "N days elsewhere" (the scope's other days), opened and closed again.
	const elsewhere = (p: Page) => p.locator(`[data-testid="${PLAN_TESTID.fold}"][data-reason="scope"]`).first();
	if (await elsewhere(a.page).count()) {
		await elsewhere(a.page).click();
		await expect(elsewhere(b.page)).toHaveAttribute("aria-expanded", "true", { timeout: 8_000 });
		await b.page.screenshot({ path: shotPath("follow-r4/b-folds-follow.png") });
		await elsewhere(a.page).click();
		await expect(elsewhere(b.page)).toHaveAttribute("aria-expanded", "false", { timeout: 8_000 });
	}

	// Collapse all (country bands) at the country lens.
	await a.page.goto(`/t/${trip.slug}?lens=country`);
	await expectLive(a.page);
	await expect(b.page).toHaveURL(new RegExp(`/t/${trip.slug}\\?lens=country`), { timeout: 10_000 });
	await a.page.getByRole("button", { name: "Collapse all" }).click();
	await expect(b.page.getByRole("button", { name: "Expand all" })).toBeVisible({ timeout: 8_000 });
	await expect(b.page.getByTestId(PLAN_TESTID.daySection)).toHaveCount(0);
	await b.page.screenshot({ path: shotPath("follow-r4/b-collapse-all.png") });
	await a.page.getByRole("button", { name: "Expand all" }).click();
	await expect(b.page.getByRole("button", { name: "Collapse all" })).toBeVisible({ timeout: 8_000 });

	// FB-21b: the inspector tab is in the URL and follows.
	const sky = trip.ids.items.sky as string;
	await a.page.goto(`/t/${trip.slug}?lens=place&sel=i.${sky}`);
	await expectLive(a.page);
	const tabsA = a.page.getByTestId(S.inspectorTabs);
	await tabsA.getByRole("tab", { name: /Lists/ }).click();
	await expect(a.page).toHaveURL(/itab=lists/);
	await expect(b.page).toHaveURL(/itab=lists/, { timeout: 10_000 });
	await expect(b.page.getByTestId(S.inspectorTabs).getByRole("tab", { name: /Lists/ })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	// A link opens on it too.
	const c = await b.ctx.newPage();
	await c.goto(`/t/${trip.slug}?lens=place&sel=i.${sky}&itab=notes`);
	await expect(c.getByTestId(S.inspectorTabs).getByRole("tab", { name: /Notes/ })).toHaveAttribute(
		"aria-selected",
		"true",
		{ timeout: 20_000 },
	);
	await c.close();
	// A new selection opens on its Overview (for both).
	await card(a.page, trip.ids.items.meiji as string).click();
	await expect(a.page).not.toHaveURL(/itab=/);
	await expect(b.page).not.toHaveURL(/itab=/, { timeout: 10_000 });

	// FB-21d: the lists grouping (not in the URL) follows.
	await a.page.goto(`/t/${trip.slug}?tab=lists&list=todo`);
	await expectLive(a.page);
	await expect(b.page).toHaveURL(/tab=lists/, { timeout: 10_000 });
	const viewA = a.page.getByTestId("lists-view").first();
	await viewA.click();
	await a.page.getByRole("option", { name: /Person/ }).click();
	await expect(b.page.getByTestId("lists-view").first()).toContainText(/Person/, { timeout: 8_000 });
	await expect
		.poll(async () => ((await localState(b.page))?.view as { ui?: { lists?: { tgroup?: string } } })?.ui?.lists?.tgroup)
		.toBe("person");
	await b.page.screenshot({ path: shotPath("follow-r4/b-lists-view-follow.png") });
	// …and the map's layer panel.
	await a.page.goto(`/t/${trip.slug}?tab=plan`);
	await expectLive(a.page);
	await a.page.getByTestId(MAP_TESTID.layersButton).click();
	await expect(a.page.getByTestId(MAP_TESTID.layerMenu)).toBeVisible();
	await expect(b.page.getByTestId(MAP_TESTID.layerMenu)).toBeVisible({ timeout: 10_000 });
	await b.page.screenshot({ path: shotPath("follow-r4/b-layer-panel-follow.png") });
	await a.page.keyboard.press("Escape");
	await expect(b.page.getByTestId(MAP_TESTID.layerMenu)).toBeHidden({ timeout: 8_000 });
	await a.ctx.close();
	await b.ctx.close();
});

test("FB-22: the map camera follows at other window sizes; my own move pauses it", async ({ browser }) => {
	const url = `/t/${trip.slug}/japan`;
	const a = await open(browser, "dev", url);
	const mapUp = async (p: Page) =>
		expect
			.poll(
				() =>
					p.evaluate(() => {
						const m = (window as unknown as W).__tripMap as { loaded?(): boolean } | undefined;
						return !!m?.loaded?.();
					}),
				{ timeout: 30_000 },
			)
			.toBe(true);
	await expect(a.page.getByTestId(MAP_TESTID.canvas)).toBeVisible({ timeout: 30_000 });
	await mapUp(a.page);
	const b = await open(browser, "maya", url, { viewport: { width: 1000, height: 640 } });
	await mapUp(b.page);
	// A phone joins through Spotlight (the map sits behind the sheet there).
	const phone = await browser.newContext({ ...devices["Pixel 7"] });
	await loginViaApi(phone.request, `pia-${randomBytes(3).toString("hex")}@example.com`, { first: "Pia", last: "Phone" });
	const pp = await phone.newPage();
	await pp.goto(`/join#t=${trip.shareTokens.editor}`);
	await expect(pp).toHaveURL(new RegExp(`/t/${trip.slug}`), { timeout: 20_000 });
	await expectLive(pp);
	await mapUp(pp);
	await follow(b.page);
	await spotlight(a.page, [pp]);

	// A frames Kyoto at bearing 20.
	await a.page.evaluate(() =>
		(window as unknown as W).__tripMap?.jumpTo({ center: [135.768, 35.011], zoom: 11.2, bearing: 20, pitch: 25 }),
	);
	const camOf = async (p: Page) => (await localState(p))?.cam as Cam | undefined;
	await expect.poll(async () => (await camOf(a.page))?.z ?? 0, { timeout: 8_000 }).toBeGreaterThan(11);
	const ca = (await camOf(a.page)) as Cam;
	const fits = async (p: Page, lead: Cam = ca) => {
		const ca = lead;
		const cb = await camOf(p);
		if (!cb) return "no cam";
		const want = ca.z + Math.log2(Math.min(cb.w / ca.w, cb.h / ca.h));
		const dc = Math.hypot(cb.c[0] - ca.c[0], cb.c[1] - ca.c[1]);
		return dc < 0.01 && Math.abs(cb.z - want) < 0.08 ? "fits" : `off: dc=${dc.toFixed(4)} z=${cb.z} want=${want.toFixed(3)}`;
	};
	await expect.poll(() => fits(b.page), { timeout: 10_000 }).toBe("fits");
	await expect.poll(() => fits(pp), { timeout: 10_000 }).toBe("fits");
	const cb = (await camOf(b.page)) as Cam;
	console.log(`[follow-r4] A ${ca.w}×${ca.h} z${ca.z} → B ${cb.w}×${cb.h} z${cb.z}`);
	await a.page.screenshot({ path: shotPath("follow-r4/a-map-kyoto.png") });
	await b.page.screenshot({ path: shotPath("follow-r4/b-map-follows.png") });
	await pp.screenshot({ path: shotPath("follow-r4/phone-map-follows.png") });

	// B drags its own map: map-following pauses (the rest of follow goes on).
	const mapB = b.page.getByTestId(MAP_TESTID.canvas);
	const box = await mapB.boundingBox();
	if (!box) throw new Error("no map");
	await b.page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
	await b.page.mouse.down();
	await b.page.mouse.move(box.x + box.width * 0.3 + 120, box.y + box.height * 0.5 + 40, { steps: 8 });
	await b.page.mouse.up();
	const chip = b.page.getByTestId(MAP_TESTID.followChip);
	await expect(chip).toBeVisible();
	await expect(chip).toContainText("Back to Dev");
	await expect(b.page.getByTestId(S.followBar)).toBeVisible();
	await b.page.screenshot({ path: shotPath("follow-r4/b-map-paused-chip.png") });
	// Let the drag's inertia settle, then A moves: B stays where B put it.
	await expect
		.poll(() => b.page.evaluate(() => (window as unknown as W).__tripMap?.isMoving()), { timeout: 5_000 })
		.toBe(false);
	await b.page.waitForTimeout(300);
	const held = (await camOf(b.page)) as Cam;
	await a.page.evaluate(() =>
		(window as unknown as W).__tripMap?.jumpTo({ center: [139.767, 35.681], zoom: 10, bearing: 0, pitch: 0 }),
	);
	await b.page.waitForTimeout(1_200);
	const still = (await camOf(b.page)) as Cam;
	expect(Math.hypot(still.c[0] - held.c[0], still.c[1] - held.c[1])).toBeLessThan(0.001);
	// The phone kept following.
	const ca2 = (await camOf(a.page)) as Cam;
	await expect
		.poll(async () => {
			const cp = await camOf(pp);
			return cp ? Math.hypot(cp.c[0] - ca2.c[0], cp.c[1] - ca2.c[1]) < 0.01 : false;
		}, { timeout: 10_000 })
		.toBe(true);
	// "Back to Dev's view" resumes it.
	await chip.click();
	await expect(chip).toBeHidden();
	await expect
		.poll(async () => {
			const c2 = await camOf(b.page);
			return c2 ? Math.hypot(c2.c[0] - ca2.c[0], c2.c[1] - ca2.c[1]) < 0.01 : false;
		}, { timeout: 10_000 })
		.toBe(true);
	// The phone's sheet rises (A opens the Lists tab): the phone refits A's
	// view into the part of its map the sheet leaves.
	await a.page.getByRole("tab", { name: /Lists/ }).click();
	await expect(pp).toHaveURL(/tab=lists/, { timeout: 10_000 });
	await pp.waitForTimeout(800);
	await expect.poll(() => fits(pp, ca2), { timeout: 10_000 }).toBe("fits");
	await pp.screenshot({ path: shotPath("follow-r4/phone-map-refit-sheet.png") });
	await a.page.getByTestId(S.spotlightEnd).click();
	await phone.close();
	await a.ctx.close();
	await b.ctx.close();
});

test("FB-23 / FB-25: a drag ghost with its drop line, and an open menu's ghost", async ({ browser }) => {
	const url = `/t/${trip.slug}?lens=place`;
	const a = await open(browser, "dev", url);
	const b = await open(browser, "maya", url, { viewport: B_SIZE });
	const meiji = trip.ids.items.meiji as string;
	const sky = trip.ids.items.sky as string;
	await card(b.page, meiji).scrollIntoViewIfNeeded();

	// FB-25: A opens the card's ⋯ menu and hovers an entry.
	await card(a.page, meiji).scrollIntoViewIfNeeded();
	await card(a.page, meiji).hover();
	await card(a.page, meiji).getByTestId(PLAN_TESTID.itemMenu).click();
	const menuA = a.page.getByRole("menu");
	await expect(menuA).toBeVisible();
	const ghost = b.page.locator(`[data-testid="remote-menu"][data-user-id="${devId}"]`);
	await expect(ghost).toBeVisible({ timeout: 8_000 });
	await expect(ghost).toHaveAttribute("data-anchor", `item:${meiji}`);
	const ghostItems = ghost.getByTestId("remote-menu-item");
	const firstLabel = ((await menuA.getByRole("menuitem").first().innerText()).split("\n")[0] ?? "").trim();
	await expect(ghostItems.first()).toHaveText(firstLabel);
	const second = menuA.getByRole("menuitem").nth(1);
	const secondLabel = ((await second.innerText()).split("\n")[0] ?? "").trim();
	await second.hover();
	const hi = ghost.locator('[data-testid="remote-menu-item"][data-hi]');
	await expect(hi).toHaveText(secondLabel, { timeout: 5_000 });
	// A's cursor sits on the ghost, on that entry.
	const cursorB = b.page.locator(`[data-testid="remote-cursor"][data-user-id="${devId}"]`);
	await expect(cursorB).toHaveAttribute("data-state", "on", { timeout: 5_000 });
	const rowBox = await hi.boundingBox();
	const at = await cursorB.evaluate((el) => {
		const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec((el as HTMLElement).style.transform);
		return { x: Number(m?.[1]), y: Number(m?.[2]) };
	});
	if (!rowBox) throw new Error("no ghost row");
	expect(at.y).toBeGreaterThan(rowBox.y - 6);
	expect(at.y).toBeLessThan(rowBox.y + rowBox.height + 6);
	await b.page.screenshot({ path: shotPath("follow-r4/b-menu-ghost.png") });
	await a.page.keyboard.press("Escape");
	await expect(ghost).toBeHidden({ timeout: 5_000 });

	// FB-23: A drags Meiji towards Shibuya Sky (and holds it there).
	await card(a.page, sky).scrollIntoViewIfNeeded();
	const src = await card(a.page, meiji).boundingBox();
	const dst = await card(a.page, sky).boundingBox();
	if (!src || !dst) throw new Error("no cards");
	await a.page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
	await a.page.mouse.down();
	await a.page.mouse.move(src.x + src.width / 2, src.y + src.height / 2 - 10, { steps: 4 });
	await a.page.mouse.move(dst.x + dst.width / 2, dst.y + 8, { steps: 20 });
	const drag = b.page.locator(`[data-testid="remote-drag"][data-user-id="${devId}"]`);
	await expect(drag).toBeVisible({ timeout: 8_000 });
	await expect(drag.getByTestId("remote-drag-label")).toHaveText(/^Dev is moving /);
	await expect(b.page.locator(`[data-testid="remote-drop"][data-user-id="${devId}"]`)).toBeVisible();
	await expect
		.poll(() => card(b.page, meiji).evaluate((el) => getComputedStyle(el).opacity))
		.toBe("0.45");
	await b.page.screenshot({ path: shotPath("follow-r4/b-drag-ghost.png") });
	// Esc cancels: everything goes.
	await a.page.keyboard.press("Escape");
	await a.page.mouse.up();
	await expect(drag).toBeHidden({ timeout: 5_000 });
	await expect
		.poll(() => card(b.page, meiji).evaluate((el) => getComputedStyle(el).opacity))
		.toBe("1");
	await a.ctx.close();
	await b.ctx.close();
});

test("FB-24: form chips and the follower's banner; FB-21c media and video follow", async ({ browser }) => {
	test.setTimeout(180_000);
	const kix = trip.ids.items.kix as string;
	const icn = trip.ids.items.icn as string;
	const a = await open(browser, "dev", `/t/${trip.slug}?lens=place`);
	const b = await open(browser, "maya", `/t/${trip.slug}?lens=place`, { viewport: B_SIZE });
	await follow(b.page);

	// A edits the KIX → ICN flight in its inspector.
	await a.page.goto(`/t/${trip.slug}?lens=place&sel=l.${kix}.${icn}`);
	await expectLive(a.page);
	await expect(b.page).toHaveURL(new RegExp(`sel=l\\.${kix}\\.${icn}`), { timeout: 10_000 });
	await a.page.getByTestId(TRANSIT_TESTID.flightEdit).click();
	const form = a.page.getByTestId(TRANSIT_TESTID.flightForm);
	await expect(form).toBeVisible();
	await form.locator("input").first().focus();
	await expect(b.page.getByTestId(S.followFormBanner)).toHaveText(/Dev opened ‘Edit flight’/, { timeout: 8_000 });
	await expect(b.page.getByTestId(S.inspectorFormChip)).toHaveText(/^Dev is editing KE ?724/);
	// …and on the flight's own row in the plan.
	await b.page.locator(`[data-cursor-anchor="leg:l.${kix}.${icn}"]`).scrollIntoViewIfNeeded();
	const chipB = b.page.locator(`[data-testid="remote-form-chip"][data-user-id="${devId}"]`);
	await expect(chipB).toBeVisible({ timeout: 8_000 });
	await expect(chipB).toHaveText(/^Dev is editing KE ?724/);
	await b.page.screenshot({ path: shotPath("follow-r4/b-form-chip-flight.png") });
	await a.page.getByTestId(TESTID.inspector).getByRole("button", { name: /Cancel/ }).first().click();
	await expect(chipB).toBeHidden({ timeout: 8_000 });

	// A opens Add expense: the banner says so; marking it private hides it.
	await a.page.goto(`/t/${trip.slug}?tab=money`);
	await expectLive(a.page);
	await a.page.getByTestId("money-add").click();
	await expect(b.page.getByTestId(S.followFormBanner)).toHaveText(/Dev opened ‘Add expense’/, { timeout: 8_000 });
	await b.page.screenshot({ path: shotPath("follow-r4/b-banner-add-expense.png") });
	const privateSwitch = a.page.getByTestId("expense-private");
	if (await privateSwitch.isVisible()) {
		await privateSwitch.click();
		await expect(b.page.getByTestId(S.followFormBanner)).toHaveCount(0, { timeout: 8_000 });
	}
	await a.page.keyboard.press("Escape");
	await expect(b.page.getByTestId(S.followFormBanner)).toHaveCount(0, { timeout: 8_000 });

	// FB-21c: media. A uploads a photo and a short video to Tokyo.
	const ffmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
	let video: Buffer | null = null;
	try {
		const dir = mkdtempSync(join(tmpdir(), "follow-r4-"));
		const out = join(dir, "clip.webm");
		execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=20:size=320x240:rate=10", "-c:v", "libvpx", "-b:v", "200k", out]);
		video = readFileSync(out);
	} catch {
		video = null;
	}
	await a.page.goto(`/t/${trip.slug}/japan/tokyo?tab=media`);
	await expectLive(a.page);
	const jpeg = Buffer.from(
		await a.page.evaluate(async () => {
			const c = document.createElement("canvas");
			c.width = 320;
			c.height = 240;
			const g = c.getContext("2d") as CanvasRenderingContext2D;
			g.fillStyle = "#7aa";
			g.fillRect(0, 0, 320, 240);
			const blob = await new Promise<Blob>((r) => c.toBlob((x) => r(x as Blob), "image/jpeg", 0.8));
			let s = "";
			for (const x of new Uint8Array(await blob.arrayBuffer())) s += String.fromCharCode(x);
			return btoa(s);
		}),
		"base64",
	);
	await a.page.getByTestId(MEDIA_TESTID.fileInput).first().setInputFiles({ name: "tokyo.jpg", mimeType: "image/jpeg", buffer: jpeg });
	const tileA = (kind: string) => a.page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=${kind}]`);
	await expect(tileA("photo")).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
	if (video) {
		await a.page.getByTestId(MEDIA_TESTID.fileInput).first().setInputFiles({ name: "clip.webm", mimeType: "video/webm", buffer: video });
		await expect(tileA("video")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
	}
	await expect(b.page).toHaveURL(/tab=media/, { timeout: 10_000 });

	// A opens the photo: B's lightbox opens on it; A goes next; A closes.
	await tileA("photo").first().click();
	await expect(b.page.getByTestId(MEDIA_TESTID.lightbox)).toBeAttached({ timeout: 10_000 });
	const lbB = b.page.locator(".yonder-lightbox");
	await expect(lbB).toBeVisible({ timeout: 10_000 });
	const mediaOf = async (p: Page) => (await localState(p))?.media as { id: string; p?: { s: string; t: number } | null } | null;
	const photoId = await tileA("photo").first().getAttribute("data-id");
	await expect.poll(async () => (await mediaOf(b.page))?.id, { timeout: 8_000 }).toBe(photoId);
	await b.page.screenshot({ path: shotPath("follow-r4/b-lightbox-follows.png") });
	if (video) {
		const videoId = await tileA("video").first().getAttribute("data-id");
		await a.page.keyboard.press("ArrowRight");
		await expect.poll(async () => (await mediaOf(a.page))?.id, { timeout: 8_000 }).toBe(videoId);
		await expect.poll(async () => (await mediaOf(b.page))?.id, { timeout: 8_000 }).toBe(videoId);
		// Play / seek / pause stay in step (within 1.5 s).
		const vid = (p: Page) => p.locator(".yonder-lightbox .yarl__slide_current video");
		await expect(vid(a.page)).toBeVisible();
		await vid(a.page).evaluate((v: HTMLVideoElement) => {
			v.muted = true;
			return v.play();
		});
		await expect.poll(() => vid(b.page).evaluate((v: HTMLVideoElement) => !v.paused), { timeout: 10_000 }).toBe(true);
		await vid(a.page).evaluate((v: HTMLVideoElement) => {
			v.currentTime = 9;
		});
		await expect
			.poll(async () => {
				const [ta, tb] = [
					await vid(a.page).evaluate((v: HTMLVideoElement) => v.currentTime),
					await vid(b.page).evaluate((v: HTMLVideoElement) => v.currentTime),
				];
				return Math.abs(ta - tb) < 1.5;
			}, { timeout: 10_000 })
			.toBe(true);
		await vid(a.page).evaluate((v: HTMLVideoElement) => v.pause());
		await expect.poll(() => vid(b.page).evaluate((v: HTMLVideoElement) => v.paused), { timeout: 10_000 }).toBe(true);
		await b.page.screenshot({ path: shotPath("follow-r4/b-video-in-step.png") });
	}
	await a.page.keyboard.press("Escape");
	await expect(lbB).toBeHidden({ timeout: 8_000 });
	await a.ctx.close();
	await b.ctx.close();
});

test("privacy: a guest follower never gets money, private rows, their drags, menus or editors", async ({ browser }) => {
	test.setTimeout(120_000);
	const a = await open(browser, "dev", `/t/${trip.slug}?tab=lists&list=todo`);
	const mk = (text: string, isPrivate: boolean) =>
		a.page.evaluate(
			async ({ tripId, text, isPrivate }) => {
				const m = await import(/* @vite-ignore */ "/src/features/lists/lists.functions.ts");
				return (await m.createListItem({
					data: { tripId, target: { kind: "trip" }, list: "todo", text, isPrivate },
				})) as { id: string };
			},
			{ tripId: trip.tripId, text, isPrivate },
		);
	const gift = await mk(`Gift for Maya ${randomBytes(2).toString("hex")}`, true);
	await a.page.reload();
	await expectLive(a.page);
	await a.page.waitForFunction(() => !!(window as { __yonderCursors?: unknown }).__yonderCursors);
	const b = await open(browser, "maya", `/t/${trip.slug}?tab=lists&list=todo`, { viewport: B_SIZE });
	// The guest: a phone on the viewer link.
	const gctx = await browser.newContext({ ...devices["Pixel 7"] });
	await loginViaApi(gctx.request, `guest-${randomBytes(3).toString("hex")}@example.com`, { first: "Gina", last: "Guest" });
	const g = await gctx.newPage();
	await g.goto(`/join#t=${trip.shareTokens.viewer}`);
	await expect(g).toHaveURL(new RegExp(`/t/${trip.slug}`), { timeout: 20_000 });
	await expectLive(g);
	await g.waitForFunction(() => !!(window as { __yonderCursors?: unknown }).__yonderCursors);
	await follow(b.page);
	await spotlight(a.page, [g]);

	// A edits the private to-do: nobody sees a chip, a banner or a menu.
	const row = a.page.locator(`[data-cursor-anchor="list:${gift.id}"]`);
	await expect(row).toBeVisible();
	await row.getByTestId("list-row-text").click();
	await a.page.waitForTimeout(1_000);
	await expect(b.page.locator('[data-testid="remote-form-chip"]')).toHaveCount(0);
	await expect(b.page.getByTestId(S.followFormBanner)).toHaveCount(0);
	await expect(g.getByTestId(S.followFormBanner)).toHaveCount(0);
	await a.page.keyboard.press("Escape");
	// Even a client that sends one anyway: the server drops it.
	await a.page.evaluate((id) => {
		const w = (window as unknown as W).__yonderCursors.awareness;
		w.setLocalStateField("form", { k: "list", m: "edit", t: `list:${id}`, v: "all", f: "Text" });
		w.setLocalStateField("drag", { a: `list:${id}`, o: null, v: "all" });
		w.setLocalStateField("menu", { a: `list:${id}`, fx: 0, fy: 1, items: ["Delete gift"], hi: 0, v: "all" });
	}, gift.id);
	await a.page.waitForTimeout(1_200);
	for (const p of [b.page, g]) {
		const got = await probe(p);
		expect(got.drags.filter((d) => JSON.stringify(d).includes(gift.id))).toEqual([]);
		expect(got.menus.filter((m) => JSON.stringify(m).includes(gift.id))).toEqual([]);
		await expect(p.getByTestId(S.followFormBanner)).toHaveCount(0);
	}
	await a.page.evaluate(() => {
		const w = (window as unknown as W).__yonderCursors.awareness;
		w.setLocalStateField("form", null);
		w.setLocalStateField("drag", null);
		w.setLocalStateField("menu", null);
	});

	// Money: the member follows A onto the Money tab and into Add expense; the guest never.
	// (In-app navigation: a reload would end A's Spotlight.)
	await a.page.getByRole("tab", { name: /Money/ }).click();
	await expect(a.page).toHaveURL(/tab=money/);
	await expect(b.page).toHaveURL(/tab=money/, { timeout: 10_000 });
	await a.page.getByTestId("money-add").click();
	await expect(b.page.getByTestId(S.followFormBanner)).toHaveText(/Add expense/, { timeout: 8_000 });
	await g.waitForTimeout(1_000);
	await expect(g).not.toHaveURL(/tab=money/);
	await expect(g.getByTestId(S.followFormBanner)).toHaveCount(0);
	const gstate = await g.evaluate(() => {
		const aw = (window as unknown as W).__yonderCursors.awareness as unknown as {
			getStates(): Map<number, Record<string, unknown>>;
		};
		return JSON.stringify([...aw.getStates().values()]);
	});
	expect(gstate).not.toMatch(/"k":"expense"|tab=money|itab=money|"money":\{/);
	expect(gstate).not.toContain(gift.id);
	await g.screenshot({ path: shotPath("follow-r4/guest-follower-no-money.png") });
	await b.page.screenshot({ path: shotPath("follow-r4/member-follower-money.png") });
	await a.page.keyboard.press("Escape");
	await a.page.getByTestId(S.spotlightEnd).click();
	await gctx.close();
	await a.ctx.close();
	await b.ctx.close();
});
