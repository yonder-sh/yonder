/**
 * FB-17 live cursors, in two (or three) real browsers on one cloned trip:
 * - A's cursor over a card shows on B's screen over the SAME card at the same
 *   fractions, although B's window is another size; over the map it lands on
 *   the same lng/lat;
 * - Follow scrolls B to keep A's anchored card in view;
 * - Spotlight ("Ask everyone to follow me"): B follows, can break away, A ends it;
 * - cursor chat (`/`) and emoji reactions (`E`) reach B;
 * - a PRIVATE to-do's anchor never reaches another member, even when a client
 *   sends it anyway (the server drops it);
 * - a link guest never receives a money anchor (the server strips members-only
 *   anchors outbound), while a member does.
 *
 * The page's own awareness and a record of what it received are exposed under
 * `VITE_E2E=1` as `window.__yonderCursors` (LiveCursors).
 */
import { randomBytes } from "node:crypto";
import {
	type Browser,
	type BrowserContext,
	devices,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import { SHELL_TESTID as S } from "../../../src/features/shell/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath, storageStateOf } from "./_helpers/env";
import { type FixtureClone, cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

test.describe.configure({ mode: "serial" });

type Anchor =
	| { k: "map"; lng: number; lat: number }
	| { k: "el"; id: string; fx: number; fy: number; p?: { id: string } };
type Probe = {
	seen: { userId: string; anchor: Anchor | null; vis: string }[];
	reacts: { userId: string; e: string; anchor: Anchor }[];
	chats: { userId: string; text: string }[];
};

const A_SIZE = { width: 1440, height: 900 };
const B_SIZE = { width: 1120, height: 720 };

async function open(
	browser: Browser,
	who: string | { ctx: BrowserContext },
	url: string,
	viewport = A_SIZE,
): Promise<{ ctx: BrowserContext; page: Page }> {
	const ctx =
		typeof who === "string"
			? await browser.newContext({ storageState: storageStateOf(who), viewport })
			: who.ctx;
	const page = await ctx.newPage();
	await page.goto(url);
	await expectLive(page);
	await page.waitForFunction(() => !!(window as { __yonderCursors?: unknown }).__yonderCursors);
	return { ctx, page };
}

const probeOf = (page: Page) =>
	page.evaluate(() => (window as unknown as { __yonderCursors: { probe: Probe } }).__yonderCursors.probe);

/** Every anchor id a page received (primary and enclosing). */
async function receivedIds(page: Page): Promise<string[]> {
	const p = await probeOf(page);
	const ids = new Set<string>();
	for (const s of p.seen)
		if (s.anchor?.k === "el") {
			ids.add(s.anchor.id);
			if (s.anchor.p) ids.add(s.anchor.p.id);
		}
	for (const r of p.reacts) if (r.anchor.k === "el") ids.add(r.anchor.id);
	return [...ids];
}

/** Moves the mouse to fractions (fx, fy) of `el`'s box, in a few steps (pointermove fires). */
async function hover(page: Page, el: Locator, fx: number, fy: number) {
	await el.scrollIntoViewIfNeeded();
	const b = await el.boundingBox();
	if (!b) throw new Error("no box");
	await page.mouse.move(b.x + b.width * fx - 30, b.y + b.height * fy - 20);
	await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy, { steps: 6 });
}

/** The remote cursor's drawn position (its tip) once it has settled. */
async function cursorAt(page: Page, userId: string) {
	const c = page.locator(`[data-testid="remote-cursor"][data-user-id="${userId}"]`);
	await expect(c).toHaveAttribute("data-state", "on", { timeout: 10_000 });
	let last = { x: Number.NaN, y: Number.NaN };
	await expect
		.poll(
			async () => {
				const now = await c.evaluate((el) => {
					const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec((el as HTMLElement).style.transform);
					return { x: Number(m?.[1]), y: Number(m?.[2]) };
				});
				const still = Math.abs(now.x - last.x) < 0.5 && Math.abs(now.y - last.y) < 0.5;
				last = now;
				return still;
			},
			{ timeout: 5_000, intervals: [120] },
		)
		.toBe(true);
	return last;
}

async function userIdOf(page: Page): Promise<string> {
	const r = await page.request.get("/api/auth/get-session");
	const j = (await r.json()) as { user: { id: string } };
	return j.user.id;
}

let trip: FixtureClone;
let devId = "";

test.beforeAll(async ({ browser }) => {
	const owner = await browser.newContext({ storageState: storageStateOf("dev") });
	trip = await cloneFixtureTrip(owner.request);
	const p = await owner.newPage();
	devId = await userIdOf(p);
	await owner.close();
});

test.beforeEach(({}, info) => {
	test.skip(info.project.name !== "chromium", "two desktop windows of different sizes");
});

test("A's cursor lands on the same card and the same map spot on B's differently sized screen", async ({ browser }) => {
	const url = `/t/${trip.slug}?tab=plan`;
	const a = await open(browser, "dev", url, A_SIZE);
	const b = await open(browser, "maya", url, B_SIZE);
	const sky = trip.ids.items.sky as string;
	const cardA = a.page.locator(`[data-cursor-anchor="item:${sky}"]`);
	const cardB = b.page.locator(`[data-cursor-anchor="item:${sky}"]`);
	await cardB.scrollIntoViewIfNeeded();
	await hover(a.page, cardA, 0.3, 0.6);

	const at = await cursorAt(b.page, devId);
	const box = await cardB.boundingBox();
	if (!box) throw new Error("no card on B");
	expect(Math.abs(at.x - (box.x + 0.3 * box.width))).toBeLessThan(3);
	expect(Math.abs(at.y - (box.y + 0.6 * box.height))).toBeLessThan(3);
	const boxA = await cardA.boundingBox();
	console.log(`[cursors] card A ${boxA?.width}×${boxA?.height} → B ${box.width}×${box.height}; B cursor at`, at);
	await b.page.screenshot({ path: shotPath("cursors/b-sees-a-over-card.png") });

	// The map: A points at a pin; B draws A's cursor where that lng/lat is on B's map.
	const pinA = a.page.getByTestId(TESTID.tripMap).getByTestId(TESTID.pin).first();
	await expect(pinA).toBeVisible();
	await a.page.waitForTimeout(1_200); // the map's own fit animation settles
	await hover(a.page, pinA, 0.5, 0.5);
	const pinBox = await pinA.boundingBox();
	if (!pinBox) throw new Error("no pin");
	// What A's own map says is under A's mouse…
	const aUnder = await a.page.evaluate(
		({ x, y }) =>
			(
				window as unknown as {
					__yonderCursors: { map(): { unproject(x: number, y: number): { lng: number; lat: number } } };
				}
			).__yonderCursors
				.map()
				.unproject(x, y),
		{ x: pinBox.x + pinBox.width / 2, y: pinBox.y + pinBox.height / 2 },
	);
	// …is what B receives.
	await expect
		.poll(
			async () => {
				const last = (await probeOf(b.page)).seen.at(-1)?.anchor;
				return last?.k === "map" && Math.abs(last.lng - aUnder.lng) < 1e-4 && Math.abs(last.lat - aUnder.lat) < 1e-4;
			},
			{ timeout: 5_000 },
		)
		.toBe(true);
	const sent = aUnder;
	const expected = await b.page.evaluate(
		({ lng, lat }) =>
			(
				window as unknown as {
					__yonderCursors: { map(): { project(lng: number, lat: number): { x: number; y: number } } };
				}
			).__yonderCursors
				.map()
				.project(lng, lat),
		sent,
	);
	const mapAt = await cursorAt(b.page, devId);
	expect(Math.abs(mapAt.x - expected.x)).toBeLessThan(3);
	expect(Math.abs(mapAt.y - expected.y)).toBeLessThan(3);
	console.log(`[cursors] map lng/lat ${sent.lng},${sent.lat} → B at`, mapAt, "expected", expected);
	await b.page.screenshot({ path: shotPath("cursors/b-sees-a-over-map.png") });

	// B looks elsewhere on its map (zoomed into Seoul): A's cursor is off B's
	// map, so an edge arrow with A's name points at it; clicking it pans there.
	await b.page.evaluate(() => {
		const map = (window as unknown as { __tripMap?: { jumpTo(o: unknown): void } }).__tripMap;
		map?.jumpTo({ center: [126.98, 37.57], zoom: 9 });
	});
	test.skip(
		!(await b.page.evaluate(() => !!(window as unknown as { __tripMap?: unknown }).__tripMap)),
		"no WebGL map in this browser",
	);
	await a.page.mouse.move(pinBox.x + pinBox.width / 2 + 3, pinBox.y + pinBox.height / 2 + 2);
	const mapEdge = b.page.locator(`[data-testid="remote-cursor-edge"][data-user-id="${devId}"]`);
	await expect(mapEdge).toHaveAttribute("data-state", "on", { timeout: 8_000 });
	await b.page.screenshot({ path: shotPath("cursors/b-map-edge-arrow.png") });
	await mapEdge.click();
	await expect(b.page.locator(`[data-testid="remote-cursor"][data-user-id="${devId}"]`)).toHaveAttribute(
		"data-state",
		"on",
		{ timeout: 8_000 },
	);
	await expect(mapEdge).toHaveAttribute("data-state", "off");
	await a.page.screenshot({ path: shotPath("cursors/a-over-map.png") });
	await a.ctx.close();
	await b.ctx.close();
});

test("a day drawn in two bands: A's cursor on its second drawing lands on B's second drawing", async ({ browser }) => {
	// Day 5 (KIX → ICN) crosses Japan and South Korea: at the country lens it
	// is drawn under both bands. Each drawing has its own anchor id (QA verify72:
	// B drew A on the FIRST drawing, 244 px off).
	const url = `/t/${trip.slug}?lens=country`;
	const a = await open(browser, "dev", url, A_SIZE);
	const b = await open(browser, "maya", url, B_SIZE);
	const d5 = trip.ids.days.d5 as string;
	const kix = trip.ids.items.kix as string;
	const icn = trip.ids.items.icn as string;
	const heads = (p: Page) => p.locator(`[data-cursor-anchor^="dayh:${d5}"]`);
	for (const p of [a.page, b.page]) {
		await expect(heads(p)).toHaveCount(2);
		await expect(heads(p).nth(0)).toHaveAttribute("data-cursor-anchor", `dayh:${d5}_${kix}`);
		await expect(heads(p).nth(1)).toHaveAttribute("data-cursor-anchor", `dayh:${d5}_${icn}`);
		// No anchor id is rendered twice.
		const dupes = await p.evaluate(() => {
			const n = new Map<string, number>();
			for (const el of document.querySelectorAll("[data-cursor-anchor]")) {
				const r = el.getBoundingClientRect();
				if (r.width < 1 || r.height < 1) continue;
				const id = el.getAttribute("data-cursor-anchor") ?? "";
				n.set(id, (n.get(id) ?? 0) + 1);
			}
			return [...n].filter(([, c]) => c > 1).map(([id]) => id);
		});
		expect(dupes).toEqual([]);
	}
	for (const [i, fx, fy] of [
		[1, 0.3, 0.5],
		[0, 0.6, 0.4],
	] as const) {
		const onB = heads(b.page).nth(i);
		await onB.scrollIntoViewIfNeeded();
		await hover(a.page, heads(a.page).nth(i), fx, fy);
		const at = await cursorAt(b.page, devId);
		const box = await onB.boundingBox();
		if (!box) throw new Error("no header on B");
		expect(Math.abs(at.x - (box.x + fx * box.width))).toBeLessThan(3);
		expect(Math.abs(at.y - (box.y + fy * box.height))).toBeLessThan(3);
		if (i === 1) await b.page.screenshot({ path: shotPath("cursors/b-sees-a-on-second-drawing.png") });
	}
	// A card in the second drawing falls back to the second drawing, never the first.
	await hover(a.page, a.page.locator(`[data-cursor-anchor="item:${icn}"]`), 0.4, 0.5);
	await expect
		.poll(async () => {
			const last = (await probeOf(b.page)).seen.at(-1)?.anchor;
			return last?.k === "el" ? `${last.id} ${last.p?.id}` : null;
		})
		.toBe(`item:${icn} day:${d5}_${icn}`);
	await a.ctx.close();
	await b.ctx.close();
});

test("Follow keeps the followed person's card in view; the follower shows on A's avatar", async ({ browser }) => {
	const url = `/t/${trip.slug}?tab=plan`;
	const a = await open(browser, "dev", url, A_SIZE);
	const b = await open(browser, "maya", url, { width: 1120, height: 640 });
	// B follows A from the presence hover card.
	await b.page.getByTestId(TESTID.presenceAvatar).first().hover();
	await b.page.getByTestId(S.followButton).click();
	await b.page.mouse.move(700, 600); // the hover card closes
	await expect(b.page.getByTestId(S.followBar)).toContainText("Following");
	await expect(a.page.getByTestId(S.followersBadge)).toBeVisible();
	await expect(a.page.getByTestId(S.followersBadge)).toHaveAttribute("aria-label", /Maya is following you/);
	await a.page.getByTestId(TESTID.accountMenu).screenshot({ path: shotPath("cursors/a-followed-badge.png") });

	// A goes to the last card of the plan; B's plan scrolls to keep it in view.
	const icn = trip.ids.items.icn as string;
	const cardB = b.page.locator(`[data-cursor-anchor="item:${icn}"]`);
	await b.page.locator('[data-cursor-anchor="pane:plan"]').evaluate((el) => el.scrollTo(0, 0));
	await expect(cardB).not.toBeInViewport();
	await hover(a.page, a.page.locator(`[data-cursor-anchor="item:${icn}"]`), 0.5, 0.5);
	await expect(cardB).toBeInViewport({ timeout: 8_000 });
	await expect(b.page.locator(`[data-testid="remote-cursor"][data-user-id="${devId}"]`)).toHaveAttribute(
		"data-state",
		"on",
	);
	await b.page.screenshot({ path: shotPath("cursors/b-follow-scrolled.png") });

	// Without Follow, an off-screen cursor is an edge arrow; clicking it jumps there.
	await b.page.getByTestId(S.followBar).getByRole("button", { name: "Stop" }).click();
	await b.page.locator('[data-cursor-anchor="pane:plan"]').evaluate((el) => el.scrollTo(0, 0));
	await a.page.mouse.move(5, 500);
	await hover(a.page, a.page.locator(`[data-cursor-anchor="item:${icn}"]`), 0.4, 0.5);
	const edge = b.page.locator(`[data-testid="remote-cursor-edge"][data-user-id="${devId}"]`);
	await expect(edge).toHaveAttribute("data-state", "on", { timeout: 8_000 });
	await b.page.screenshot({ path: shotPath("cursors/b-edge-arrow.png") });
	await edge.click();
	await expect(cardB).toBeInViewport({ timeout: 8_000 });
	await a.ctx.close();
	await b.ctx.close();
});

test("Spotlight: everyone follows the presenter, B breaks away, A ends it", async ({ browser }) => {
	const url = `/t/${trip.slug}?tab=plan`;
	const a = await open(browser, "dev", url, A_SIZE);
	const b = await open(browser, "maya", url, B_SIZE);
	await expect(a.page.getByTestId(TESTID.presenceAvatar)).toHaveCount(1);
	await a.page.getByTestId(TESTID.tripMenu).click();
	await a.page.getByTestId(S.spotlightMenuItem).click();
	await expect(a.page.getByTestId(S.spotlightBar)).toBeVisible();
	await expect(b.page.getByTestId(S.followBar)).toContainText("Following Dev", { timeout: 8_000 });
	await expect(a.page.getByTestId(S.spotlightBar)).toContainText("Maya is following you");
	await a.page.screenshot({ path: shotPath("cursors/a-presenting.png") });
	await b.page.screenshot({ path: shotPath("cursors/b-spotlight-following.png") });
	// A link guest on a phone, arriving mid-spotlight, follows too.
	const gctx = await browser.newContext({ ...devices["Pixel 7"] });
	await loginViaApi(gctx.request, `phone-${randomBytes(3).toString("hex")}@example.com`, { first: "Pia", last: "Phone" });
	const gpage = await gctx.newPage();
	await gpage.goto(`/join#t=${trip.shareTokens.editor}`);
	await expect(gpage).toHaveURL(new RegExp(`/t/${trip.slug}`), { timeout: 20_000 });
	await expectLive(gpage);
	await expect(gpage.getByTestId(S.followBar)).toContainText("Following Dev", { timeout: 8_000 });
	await expect(a.page.getByTestId(S.spotlightBar)).toContainText("2 people are following you");
	// B mirrors A.
	await a.page.getByRole("tab", { name: /Lists/ }).click();
	await expect(b.page).toHaveURL(/tab=lists/, { timeout: 8_000 });
	await expect(gpage).toHaveURL(/tab=lists/, { timeout: 8_000 });
	await gpage.waitForTimeout(600);
	await gpage.screenshot({ path: shotPath("cursors/phone-guest-spotlight.png") });
	await gctx.close();
	// B breaks away; A's spotlight doesn't pull B back.
	await b.page.getByTestId(S.followBar).getByRole("button", { name: "Stop" }).click();
	await expect(b.page.getByTestId(S.followBar)).toHaveCount(0);
	await a.page.getByRole("tab", { name: /Media/ }).click();
	await b.page.waitForTimeout(1_500);
	await expect(b.page).not.toHaveURL(/tab=media/);
	await expect(b.page.getByTestId(S.followBar)).toHaveCount(0);
	// A ends it.
	await a.page.getByTestId(S.spotlightEnd).click();
	await expect(a.page.getByTestId(S.spotlightBar)).toHaveCount(0);
	// A new spotlight asks B again; ending it stops B.
	await a.page.getByTestId(TESTID.tripMenu).click();
	await a.page.getByTestId(S.spotlightMenuItem).click();
	await expect(b.page.getByTestId(S.followBar)).toContainText("Following Dev", { timeout: 8_000 });
	await a.page.getByTestId(S.spotlightEnd).click();
	await expect(b.page.getByTestId(S.followBar)).toHaveCount(0, { timeout: 8_000 });
	await a.ctx.close();
	await b.ctx.close();
});

test("cursor chat and emoji reactions reach the other screen", async ({ browser }) => {
	const url = `/t/${trip.slug}?tab=plan`;
	const a = await open(browser, "dev", url, A_SIZE);
	const b = await open(browser, "maya", url, B_SIZE);
	const meiji = trip.ids.items.meiji as string;
	await b.page.locator(`[data-cursor-anchor="item:${meiji}"]`).scrollIntoViewIfNeeded();
	await hover(a.page, a.page.locator(`[data-cursor-anchor="item:${meiji}"]`), 0.6, 0.5);
	await a.page.keyboard.press("/");
	const input = a.page.getByTestId(S.cursorChatInput);
	await expect(input).toBeFocused();
	await input.pressSequentially("meet here at 3?", { delay: 20 });
	const chatB = b.page.locator(`[data-testid="remote-cursor"][data-user-id="${devId}"] [data-testid="remote-cursor-chat"]`);
	await expect(chatB).toHaveText("meet here at 3?", { timeout: 5_000 });
	await input.press("Enter");
	await expect(a.page.getByTestId(S.cursorChatSent)).toHaveText("meet here at 3?");
	await expect(chatB).toBeVisible();
	await b.page.screenshot({ path: shotPath("cursors/b-sees-chat.png") });
	await a.page.screenshot({ path: shotPath("cursors/a-chat-sent.png") });

	// A reaction at A's cursor floats on B's screen.
	await a.page.keyboard.press("e");
	const palette = a.page.getByTestId(S.reactionPalette);
	await expect(palette).toBeVisible();
	await a.page.screenshot({ path: shotPath("cursors/a-reaction-palette.png") });
	await palette.getByRole("button", { name: /🔥/ }).click();
	await expect(b.page.getByTestId("remote-reaction").filter({ hasText: "🔥" })).toBeVisible({ timeout: 5_000 });
	await b.page.screenshot({ path: shotPath("cursors/b-sees-reaction.png") });
	const got = await probeOf(b.page);
	expect(got.reacts.some((r) => r.e === "🔥" && r.anchor.k === "el" && r.anchor.id === `item:${meiji}`)).toBe(true);
	expect(got.chats.some((c) => c.text === "meet here at 3?")).toBe(true);
	await a.ctx.close();
	await b.ctx.close();
});

test("a private to-do's anchor never reaches another member", async ({ browser }) => {
	const url = `/t/${trip.slug}?tab=lists&list=todo`;
	const a = await open(browser, "dev", url, A_SIZE);
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
	const secret = await mk(`Gift for Maya ${randomBytes(2).toString("hex")}`, true);
	const open1 = await mk(`Book the ryokan ${randomBytes(2).toString("hex")}`, false);
	// This tab skips its own change events: load the new rows.
	await a.page.reload();
	await expectLive(a.page);
	await a.page.waitForFunction(() => !!(window as { __yonderCursors?: unknown }).__yonderCursors);
	const b = await open(browser, "maya", url, B_SIZE);
	const rowA = (id: string) => a.page.locator(`[data-cursor-anchor="list:${id}"]`);
	await expect(rowA(open1.id)).toBeVisible();
	// The private row carries its mark: my cursor over it is shared with nobody.
	await expect(rowA(secret.id)).toHaveAttribute("data-cursor-vis", "private");
	await hover(a.page, rowA(secret.id), 0.5, 0.5);
	await a.page.waitForTimeout(600);
	await hover(a.page, rowA(open1.id), 0.5, 0.5); // the positive control
	await expect.poll(async () => (await receivedIds(b.page)).includes(`list:${open1.id}`)).toBe(true);
	// Even a client that sends it anyway: the server drops the anchor.
	await a.page.evaluate((id) => {
		const w = window as unknown as {
			__yonderCursors: { awareness: { setLocalStateField(k: string, v: unknown): void } };
		};
		w.__yonderCursors.awareness.setLocalStateField("cursor", {
			a: { k: "el", id: `list:${id}`, fx: 0.5, fy: 0.5 },
			v: "all",
			m: "mouse",
			chat: { n: 99, text: "shh, the gift" },
		});
	}, secret.id);
	await a.page.waitForTimeout(1_000);
	const ids = await receivedIds(b.page);
	expect(ids).not.toContain(`list:${secret.id}`);
	const chats = (await probeOf(b.page)).chats.map((c) => c.text);
	expect(chats).not.toContain("shh, the gift");
	// …and B's screen doesn't have the row at all.
	await expect(b.page.locator(`[data-cursor-anchor="list:${secret.id}"]`)).toHaveCount(0);
	await a.ctx.close();
	await b.ctx.close();
});

test("a link guest never receives a money anchor; a member does", async ({ browser }) => {
	// A cost to point at.
	const a = await open(browser, "dev", `/t/${trip.slug}?tab=money`, A_SIZE);
	const exp = await a.page.evaluate(
		async ({ tripId, owner }) => {
			const m = await import(/* @vite-ignore */ "/src/features/money/money.functions.ts");
			return (await m.createExpense({
				data: {
					tripId,
					target: { kind: "trip" },
					title: "Cursor ramen",
					amountMinor: 1200,
					currency: "JPY",
					split: { mode: "equal", shares: [{ memberId: owner }] },
				},
			})) as { id: string };
		},
		{ tripId: trip.tripId, owner: trip.members.owner },
	);
	await a.page.reload();
	await expectLive(a.page);
	await a.page.waitForFunction(() => !!(window as { __yonderCursors?: unknown }).__yonderCursors);
	// The guest: a fresh named account on the viewer link (a grant, no membership).
	const gctx = await browser.newContext({ viewport: B_SIZE });
	await loginViaApi(gctx.request, `guest-${randomBytes(3).toString("hex")}@example.com`, { first: "Gina", last: "Guest" });
	const gpage = await gctx.newPage();
	await gpage.goto(`/join#t=${trip.shareTokens.viewer}`);
	await expect(gpage).toHaveURL(new RegExp(`/t/${trip.slug}`), { timeout: 20_000 });
	await expectLive(gpage);
	await gpage.waitForFunction(() => !!(window as { __yonderCursors?: unknown }).__yonderCursors);
	const b = await open(browser, "maya", `/t/${trip.slug}?tab=money`, B_SIZE);

	const summary = a.page.locator('[data-cursor-anchor="money:summary"]');
	await expect(summary).toBeVisible();
	await hover(a.page, summary, 0.3, 0.4);
	await a.page.waitForTimeout(300);
	const expRow = a.page.locator(`[data-cursor-anchor="exp:${exp.id}"]`);
	await expect(expRow).toBeVisible();
	await hover(a.page, expRow, 0.5, 0.5);
	await a.page.waitForTimeout(300);
	await hover(a.page, a.page.locator('[data-cursor-anchor="tab:money"]').first(), 0.5, 0.5);
	await a.page.waitForTimeout(300);
	// A client claiming a money anchor is for everyone: the server knows better.
	await a.page.evaluate(() => {
		const w = window as unknown as {
			__yonderCursors: { awareness: { setLocalStateField(k: string, v: unknown): void } };
		};
		w.__yonderCursors.awareness.setLocalStateField("cursor", {
			a: { k: "el", id: "money:balances", fx: 0.5, fy: 0.5 },
			v: "all",
			m: "mouse",
		});
		w.__yonderCursors.awareness.setLocalStateField("react", {
			n: 7,
			e: "🔥",
			a: { k: "el", id: "money:summary", fx: 0.5, fy: 0.5 },
			v: "all",
		});
	});
	// The member sees them (members-only)…
	await expect
		.poll(async () => {
			const ids = await receivedIds(b.page);
			return ["money:summary", `exp:${exp.id}`, "tab:money", "money:balances"].every((x) => ids.includes(x));
		}, { timeout: 8_000 })
		.toBe(true);
	const member = await probeOf(b.page);
	expect(member.seen.filter((s) => s.anchor?.k === "el" && s.anchor.id.startsWith("money:")).every((s) => s.vis === "members")).toBe(true);
	await b.page.screenshot({ path: shotPath("cursors/member-sees-money-cursor.png") });
	// …the guest never does.
	await gpage.waitForTimeout(1_000);
	const guest = await probeOf(gpage);
	const gids = await receivedIds(gpage);
	console.log(`[cursors] guest received ${guest.seen.length} cursor states; ids:`, gids);
	expect(guest.seen.length).toBeGreaterThan(0); // A's cursor did reach the guest (hidden)
	expect(gids.filter((x) => /^(money|exp|budget):|^(tab|pane):money$/.test(x))).toEqual([]);
	expect(guest.seen.every((s) => s.vis === "all")).toBe(true);
	expect(guest.reacts).toEqual([]);
	// Nor does any "where" chip name the Money tab to the guest (A reads as on the Plan here).
	await expect(gpage.getByText(/Money tab/)).toHaveCount(0);
	// The guest does get A's cursor where the guest can see it: a card on the plan.
	await a.page.getByRole("tab", { name: /Plan/ }).click();
	const sky = trip.ids.items.sky as string;
	await gpage.locator(`[data-cursor-anchor="item:${sky}"]`).scrollIntoViewIfNeeded();
	await hover(a.page, a.page.locator(`[data-cursor-anchor="item:${sky}"]`), 0.5, 0.5);
	await expect.poll(async () => (await receivedIds(gpage)).includes(`item:${sky}`), { timeout: 8_000 }).toBe(true);
	await expect(gpage.locator(`[data-testid="remote-cursor"][data-user-id="${devId}"]`)).toHaveAttribute(
		"data-state",
		"on",
	);
	await gpage.screenshot({ path: shotPath("cursors/guest-view.png") });
	await a.ctx.close();
	await b.ctx.close();
	await gctx.close();
});
