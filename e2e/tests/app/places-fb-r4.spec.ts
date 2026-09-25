/**
 * WP-Places, owner feedback round 1 (docs/qa/FEEDBACK-1.md) and the round-3
 * QA bugs it owns, now in the Places tab (docs/PLACES.md §1b: the old Rate
 * screen is the tab's Rate view; `/t/<trip>/rate` redirects there):
 *
 * - FB-05 (Rate side): the place overview's "Rate N places in Tokyo" opens
 *   the Rate view at that scope inside the workspace (the trip's name stays
 *   in the top bar) and Back returns to the view you came from; a direct
 *   link opens at its scope, and on a phone the full-screen feed closes back
 *   to the Places list; "unrated by <my id>" links read "Unrated by me" and
 *   agree with the progress; ⌘K "rate" opens the Rate view.
 * - The Shinjuku gap: an area with no photos of its own shows its places'
 *   photos, labelled, in the Rate feed and the drawer, which offers "Add
 *   photo" / "Add link" (on a demo clone: the QA seed has no photos).
 * - VIS3-06: the ratings list shows full names and every avatar is a circle
 *   (the drawer's Ratings; the rate card's "Others" list became the reveal).
 * - PLAN-R3-03: a comment with two mentions saves at ~240 visible
 *   characters (it used to stop at "Mentions take extra room").
 *
 * The read-only tests use the QA seed (`pnpm db:seed:qa`, trip `asia-2027`,
 * dennis@asia2027.test); the comment test writes on its own demo clone.
 *
 *   APP_URL=http://localhost:<port> DEV_FIXED_OTP=000000 N pnpm e2e -- tests/app/places-fb-r4.spec.ts --project chromium
 */
import { expect, type Page, test } from "@playwright/test";
import { OUTLINE_TESTID } from "../../../src/features/outline/testids";
import { PLACES_TAB_TESTID as PT } from "../../../src/features/places/tab/testids";
import { PLACES_TESTID as P } from "../../../src/features/places/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";

const TRIP = "asia-2027";

test.beforeEach(({}, info) => {
	test.skip(info.project.name !== "chromium", "runs its own viewports on the desktop project");
});

async function signInDennis(page: Page): Promise<void> {
	for (let i = 0; ; i++) {
		try {
			return await loginViaApi(page.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
		} catch (e) {
			if (i >= 4) throw e;
			await new Promise((r) => setTimeout(r, 400 + Math.random() * 1200));
		}
	}
}

type Y = {
	graph: {
		me: { memberId: string | null };
		nodes: { id: string; name: string; priorities: Record<string, string>; ratingComments: Record<string, string> }[];
	};
};
const yonder = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: Y }).__yonder);

async function openTrip(page: Page, url: string): Promise<void> {
	await page.goto(url);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect.poll(() => page.evaluate(() => !!(window as unknown as { __yonder?: unknown }).__yonder)).toBe(true);
}

async function nodeId(page: Page, name: string): Promise<string> {
	const id = (await yonder(page)).graph.nodes.find((n) => n.name === name)?.id;
	if (!id) throw new Error(`no node ${name}`);
	return id;
}

/** The feed's card in view. */
const activeCard = (page: Page) => page.locator(`[data-testid=${PT.feedCard}][data-active]`);

test.describe("FB-05: arriving in the Rate view", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("from the workspace: 'Rate N places in Tokyo' opens the Rate view there, and Back returns to the same view", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		const tokyo = await nodeId(page, "Tokyo");
		await openTrip(page, `/t/${TRIP}?sel=n.${tokyo}&tab=media`);
		const from = new URL(page.url());
		// The place overview's "Rate N places in Tokyo".
		const link = page.getByTestId(P.rateLink).first();
		await expect(link).toHaveText(/Rate \d+ places in Tokyo/);
		await link.click();
		await expect(page.getByTestId(PT.feed)).toBeVisible({ timeout: 30_000 });
		await expect(activeCard(page)).toBeVisible();
		const url = new URL(page.url());
		expect(url.pathname).toBe(`/t/${TRIP}/japan/tokyo`);
		expect(url.searchParams.get("tab")).toBe("places");
		expect(url.searchParams.get("pv")).toBe("rate");
		// It's a view of the workspace now: the trip's name stays in the top bar.
		await expect(page.getByTestId(TESTID.tripMenu)).toContainText("Asia 2027");
		await page.screenshot({ path: shotPath("places/fb05-rate-header-1440.png"), animations: "disabled" });
		// Back: exactly the view we left (selection and tab).
		await page.goBack();
		await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await expect.poll(() => new URL(page.url()).pathname).toBe(from.pathname);
		expect(new URL(page.url()).searchParams.get("sel")).toBe(`n.${tokyo}`);
		expect(new URL(page.url()).searchParams.get("tab")).toBe("media");
		await expect(page.getByTestId(P.rateLink).first()).toBeVisible();
	});

	test("a direct link opens the Rate view at its scope; on a phone the full-screen feed closes to the Places list", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		const kyoto = await nodeId(page, "Kyoto");
		await page.goto(`/t/${TRIP}/rate?in=${kyoto}`);
		await expect(page.getByTestId(PT.feed)).toBeVisible({ timeout: 30_000 });
		const url = new URL(page.url());
		expect(url.pathname).toMatch(new RegExp(`^/t/${TRIP}/.*kyoto$`));
		expect(url.searchParams.get("tab")).toBe("places");
		expect(url.searchParams.get("pv")).toBe("rate");
		await page.setViewportSize({ width: 390, height: 844 });
		const close = page.getByRole("button", { name: "Close the feed" });
		await expect(close).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId(PT.feed)).toBeInViewport();
		await page.screenshot({ path: shotPath("places/fb05-rate-header-390.png"), animations: "disabled" });
		await close.click();
		await expect(page.getByTestId(PT.feed)).toHaveCount(0);
		await expect(page).not.toHaveURL(/pv=rate/);
		const after = new URL(page.url());
		expect(after.pathname).toBe(url.pathname);
		expect(after.searchParams.get("tab")).toBe("places");
	});

	test("an 'unrated by <my id>' link reads 'Unrated by me' and agrees with the progress", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		const me = (await yonder(page)).graph.me.memberId;
		await page.goto(`/t/${TRIP}/rate?f=u:${me}`);
		await expect(page.getByTestId(PT.feed)).toBeVisible({ timeout: 30_000 });
		expect(new URL(page.url()).searchParams.get("pv")).toBe("rate");
		const summary = page.getByTestId(PT.tab).getByTestId(OUTLINE_TESTID.filterSummary);
		await expect(summary).toContainText("Unrated by me");
		const text = (await summary.innerText()).replace(/\s+/g, " ");
		const shown = /(\d+) places?/.exec(text);
		expect(shown, text).not.toBeNull();
		const mine = page.getByTestId(PT.progress).locator(`[data-member="${me}"]`);
		const [rated, total] = ((await mine.innerText()).match(/(\d+)\/(\d+)/)?.slice(1) ?? []).map(Number);
		expect(total).toBeGreaterThan(0);
		expect(Number(shown?.[1])).toBe((total as number) - (rated as number));
		// The feed's pile is the same places.
		await expect(page.getByTestId(PT.feedLeft)).toHaveText(`${(total as number) - (rated as number)} left`);
	});

	test("⌘K: 'rate' offers Rate places in Tokyo, and Enter opens it", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}/japan/tokyo`);
		await page.keyboard.press("Control+k");
		await page.getByTestId(P.paletteInput).fill("rate");
		const item = page.getByTestId(P.paletteRate);
		await expect(item).toHaveText(/Rate places in Tokyo/);
		await expect(item).toHaveAttribute("aria-selected", "true");
		await page.screenshot({ path: shotPath("places/fb05-palette-rate.png"), animations: "disabled" });
		await page.keyboard.press("Enter");
		await expect(page.getByTestId(PT.feed)).toBeVisible({ timeout: 30_000 });
		const url = new URL(page.url());
		expect(url.pathname).toBe(`/t/${TRIP}/japan/tokyo`);
		expect(url.searchParams.get("tab")).toBe("places");
		expect(url.searchParams.get("pv")).toBe("rate");
	});
});

test.describe("the place's details", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("VIS3-06: the ratings list shows full names, and avatars are circles", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		const sky = await nodeId(page, "Shibuya Sky");
		await openTrip(page, `/t/${TRIP}?tab=places&sel=n.${sky}`);
		const drawer = page.getByTestId(PT.drawer);
		await expect(drawer).toHaveAttribute("data-place", sky, { timeout: 30_000 });
		const rows = await drawer.evaluate((el, id) =>
			[...el.querySelectorAll(`li[data-testid="${id}"]`)].map((li) => {
				const name = li.querySelector("span.truncate") as HTMLElement;
				const avatar = li.querySelector('[data-slot="avatar"]') as HTMLElement;
				const a = avatar.getBoundingClientRect();
				return {
					name: name.textContent,
					cut: name.scrollWidth > name.clientWidth + 1,
					round: a.width === a.height && Number.parseFloat(getComputedStyle(avatar).borderTopLeftRadius) >= a.width / 2,
				};
			}), PT.ratingRow,
		);
		expect(rows.length).toBeGreaterThanOrEqual(2);
		expect(rows.filter((r) => r.cut)).toEqual([]);
		expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(["Audrey Tester"]));
		expect(rows.every((r) => r.round)).toBe(true);
	});
});

test.describe("the Shinjuku gap", () => {
	test.use({ viewport: { width: 1440, height: 900 }, storageState: storageStateOf("dev") });

	// The QA seed has no photos (`db:seed:qa --no-media`): on a demo clone, Shibuya
	// (an area) has none of its own, and a photo goes on Shibuya Sky inside it.
	test("an area with no photos of its own shows its places' photos, labelled, with Add photo / Add link", async ({ page }) => {
		const c = await cloneFixtureTrip(page.request);
		const N = c.ids.nodes as Record<string, string>;
		await openTrip(page, `/t/${c.slug}?tab=plan`);
		// Like Shinjuku from the sheet, Shibuya is a destination in itself (it has a
		// description), so it is one of the places to rate.
		await page.evaluate(async (nodeId) => {
			const m = await import("/src/functions/nodes.functions.ts");
			await m.updateNode({ data: { nodeId, patch: { description: "Scramble crossing, shops and Shibuya Sky." } } });
		}, N.shibuya as string);
		await openTrip(page, `/t/${c.slug}?tab=places&sel=n.${N.shibuyaSky}`);
		const drawer = page.getByTestId(PT.drawer);
		await expect(drawer).toHaveAttribute("data-place", N.shibuyaSky as string, { timeout: 30_000 });
		// Shibuya Sky gets a photo through its drawer's "Add photo".
		const jpeg = Buffer.from(
			await page.evaluate(async () => {
				const c = document.createElement("canvas");
				c.width = 480;
				c.height = 270;
				const g = c.getContext("2d") as CanvasRenderingContext2D;
				g.fillStyle = "hsl(200 60% 50%)";
				g.fillRect(0, 0, 480, 270);
				g.fillStyle = "#fff";
				g.fillRect(200, 110, 60, 50);
				const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), "image/jpeg", 0.85));
				let out = "";
				for (const x of new Uint8Array(await blob.arrayBuffer())) out += String.fromCharCode(x);
				return btoa(out);
			}),
			"base64",
		);
		await drawer.getByTestId(P.rateAddPhotoInput).setInputFiles({ name: "sky.jpg", mimeType: "image/jpeg", buffer: jpeg });
		await expect(drawer.locator("button img").first()).toBeVisible({ timeout: 60_000 });
		// Shibuya (the area) in the Rate feed: its place's photo, labelled with the place.
		await page.goto(`/t/${c.slug}/rate?n=${N.shibuya}`);
		const card = activeCard(page);
		await expect(card).toHaveAttribute("data-place", N.shibuya as string, { timeout: 30_000 });
		await expect(card.getByTestId(P.rateMediaFrom)).toHaveText("Shibuya Sky", { timeout: 30_000 });
		await expect(card.locator("img").first()).toBeVisible();
		await page.screenshot({ path: shotPath("places/shinjuku-rate-1440.png"), animations: "disabled" });
		// Its drawer: the same photo, said to be its places', and a way to add its own.
		await openTrip(page, `/t/${c.slug}?tab=places&sel=n.${N.shibuya}`);
		await expect(drawer).toHaveAttribute("data-place", N.shibuya as string, { timeout: 30_000 });
		await expect(drawer).toContainText("Photos from places in Shibuya.");
		await expect(drawer.getByTestId(P.rateMediaFrom).first()).toHaveText("Shibuya Sky");
		await expect(drawer.locator("img").first()).toBeVisible();
		await expect(drawer.getByTestId(P.rateAddPhoto)).toBeEnabled();
		await expect(drawer.getByTestId(P.rateAddLink)).toBeEnabled();
		await page.screenshot({ path: shotPath("places/shinjuku-drawer-1440.png"), animations: "disabled" });
	});
});

test.describe("PLAN-R3-03: comments with mentions", () => {
	test.use({ viewport: { width: 1440, height: 900 }, storageState: storageStateOf("dev") });

	test("two mentions and ~240 visible characters save; the counter counts what you see", async ({ page }) => {
		const c = await cloneFixtureTrip(page.request);
		const N = c.ids.nodes;
		await page.goto(`/t/${c.slug}/rate?n=${N.sensoji}`);
		const card = activeCard(page);
		await expect(card).toHaveAttribute("data-place", N.sensoji as string, { timeout: 30_000 });
		// Rate (the feed stays on the card), then open the comment.
		await page.keyboard.press("1");
		await expect(card).toHaveAttribute("data-rated", "must");
		await expect(card).toHaveAttribute("data-place", N.sensoji as string);
		await card.getByRole("button", { name: "Add a comment" }).click();
		const editor = page.getByTestId(P.ratingComment);
		const field = editor.getByTestId(TESTID.mentionInput);
		await field.click();
		await page.keyboard.insertText("x".repeat(200));
		await page.keyboard.type(" ask @Aud");
		await page.getByRole("option", { name: /Audrey/ }).first().click();
		await page.keyboard.type(" and @May");
		await page.getByRole("option", { name: /Maya/ }).first().click();
		const count = editor.getByTestId(P.ratingCommentCount);
		const shown = Number((await count.innerText()).split("/")[0]);
		const visible = (await field.innerText()).trim().length;
		expect(shown).toBeGreaterThan(200);
		expect(Math.abs(shown - visible)).toBeLessThanOrEqual(2);
		await expect(editor.getByRole("alert")).toHaveCount(0);
		await expect(editor.getByRole("button", { name: "Save" })).toBeEnabled();
		await page.screenshot({ path: shotPath("places/plan-r3-03-comment.png"), animations: "disabled" });
		await editor.getByRole("button", { name: "Save" }).click();
		await expect
			.poll(async () => (await yonder(page)).graph.nodes.find((n) => n.id === N.sensoji)?.ratingComments[c.members.owner]?.length ?? 0)
			.toBeGreaterThan(280);
		const saved = (await yonder(page)).graph.nodes.find((n) => n.id === N.sensoji)?.ratingComments[c.members.owner] ?? "";
		expect(saved).toMatch(/\]\(mention:[0-9a-f-]{36}\).*\]\(mention:[0-9a-f-]{36}\)/);
		// Shown on the card as it reads (the mention as "@Audrey", never its token), and it survives a reload.
		await expect(card).toContainText("ask @Audrey");
		await expect(card).not.toContainText("](mention:");
		await page.reload();
		await expect(activeCard(page)).toHaveAttribute("data-place", N.sensoji as string, { timeout: 30_000 });
		await expect(activeCard(page)).toContainText("ask @Audrey");
		// The drawer shows it too.
		await page.goto(`/t/${c.slug}?tab=places&sel=n.${N.sensoji}`);
		const mine = page.getByTestId(PT.drawer).locator(`[data-testid=${PT.ratingRow}][data-member="${c.members.owner}"]`);
		await expect(mine).toContainText("ask @Audrey", { timeout: 30_000 });
	});
});
