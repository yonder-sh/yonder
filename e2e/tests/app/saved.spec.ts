/**
 * Saved (owner, 2026-10-09): links shared into Yonder wait in a grid until
 * they go into a trip. Three links come in the way the iOS Shortcut and ⌘K
 * hand them over (`/share?url=`), each landing in the feed (Later keeps it);
 * the grid shows their re-hosted pictures (stubbed previews: a TikTok's
 * oEmbed thumbnail, an Instagram post's OpenGraph picture) and the Maps
 * place by name; the feed saves the place into the trip, deletes the reel
 * and leaves the TikTok.
 */
import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { SAVED_TESTID as S } from "../../../src/features/saved/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive, expectNoHorizontalOverflow } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

const TIKTOK = "https://www.tiktok.com/@kyoto.eats/video/7311111111111111111";
const REEL = "https://www.instagram.com/reel/C0SAVEDE2E/";
const MAPS = "https://www.google.com/maps/place/Kissa+Mado/@35.0037,135.7788,17z";

const activeCard = (page: Page) =>
	page.locator(`[data-testid="${S.card}"][data-active]`);

/** A link handed over like the Shortcut does: it opens in the feed; Later keeps it. */
async function share(page: Page, url: string, text?: string) {
	await page.goto(`/share?${new URLSearchParams({ url, ...(text ? { text } : {}) })}`);
	await expect(page).toHaveURL(/\/saved\?open=[0-9a-f-]{36}&from=share/, { timeout: 20_000 });
	await expect(page.getByTestId(S.feed)).toBeVisible();
	await activeCard(page).getByTestId(S.later).click();
	await expect(page.getByTestId(S.feed)).toHaveCount(0);
	await expect(page).toHaveURL(/\/saved$/);
}

test("three shared links in the grid; the feed saves one to a trip, deletes one, leaves one", async ({
	page,
	request,
}, info) => {
	test.skip(info.project.name !== "chromium", "sizes are set here: 1440 and 390");
	test.setTimeout(120_000);
	const c = await cloneFixtureTrip(request);
	await page.goto("/dashboard");
	await page.evaluate((id) => localStorage.setItem("yonder:share-last-trip", id), c.tripId);

	await share(page, TIKTOK, `Matcha parfait at Tsujiri ${TIKTOK}`);
	await share(page, REEL);
	await share(page, MAPS);
	// The same TikTok again (a reload, the share sheet twice): the one already there.
	const before = new URL(page.url());
	await page.goto(`/share?${new URLSearchParams({ url: TIKTOK, text: `Matcha parfait at Tsujiri ${TIKTOK}` })}`);
	await expect(page).toHaveURL(/\/saved\?open=/, { timeout: 20_000 });
	const again = new URL(page.url()).searchParams.get("open");
	await activeCard(page).getByTestId(S.later).click();
	await expect(page).toHaveURL(before.href);

	// The grid: newest first, each with its source and one line; the pictures
	// arrive when the preview job has re-hosted them.
	const tiles = page.getByTestId(S.tile);
	await expect(tiles).toHaveCount(3);
	await expect(tiles.nth(0).getByTestId(S.tileBadge)).toHaveText("Maps");
	await expect(tiles.nth(0).getByTestId(S.tileLine)).toHaveText("Kissa Mado", { timeout: 20_000 });
	await expect(tiles.nth(1).getByTestId(S.tileBadge)).toHaveText("Instagram");
	await expect(tiles.nth(2).getByTestId(S.tileBadge)).toHaveText("TikTok");
	await expect(tiles.nth(2)).toHaveAttribute("data-saved", again ?? "");
	for (const i of [1, 2])
		await expect(tiles.nth(i).locator('img[src^="/api/saved/"]')).toBeVisible({ timeout: 20_000 });
	await expect(tiles.nth(1).getByTestId(S.tileLine)).toHaveText("Tamago sando at Kissa Mado");
	// The words shared with it name it; the caption is the preview's.
	await expect(tiles.nth(2).getByTestId(S.tileLine)).toHaveText("Matcha parfait at Tsujiri");
	await expect
		.poll(() => tiles.nth(1).locator("img").evaluate((i) => (i as HTMLImageElement).naturalWidth))
		.toBeGreaterThan(0);
	await page.screenshot({ path: shotPath("saved/grid-1440.png"), animations: "disabled" });
	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: shotPath("saved/grid-390.png"), animations: "disabled" });

	// The feed at the Maps place: phone first (the media, then the details).
	await tiles.nth(0).click();
	await expect(page).toHaveURL(/\/saved\?open=/);
	const card = activeCard(page);
	await expect(card).toHaveAttribute("aria-label", "Kissa Mado");
	await page.screenshot({ path: shotPath("saved/feed-390.png"), animations: "disabled" });
	await card.getByTestId(S.bar).click();
	await expect(card.getByTestId(HOME_TESTID.shareName)).toHaveValue("Kissa Mado");
	await expect(card.getByTestId(HOME_TESTID.shareSave)).toBeInViewport();
	await page.waitForTimeout(400);
	await page.screenshot({ path: shotPath("saved/feed-details-390.png"), animations: "disabled" });

	// Wide: the media beside the details; the trip is the one used last (it has Kyoto).
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(card.getByTestId(HOME_TESTID.shareTrip)).toContainText(/\w/);
	await expect(card.getByTestId(HOME_TESTID.shareSave)).toBeEnabled({ timeout: 15_000 });
	await expect(card.getByTestId(S.info)).toBeInViewport({ ratio: 1 });
	await page.screenshot({ path: shotPath("saved/feed-1440.png"), animations: "disabled" });
	await card.getByTestId(HOME_TESTID.shareSave).click();
	await expect(page.locator(`[data-testid="${S.card}"][data-done="saved"]`)).toHaveCount(1, { timeout: 15_000 });
	await expect(page.getByText(/^Saved to .+ · /)).toBeVisible();
	// On to the next one by itself: the reel. Delete it.
	await expect(activeCard(page)).toHaveAttribute("aria-label", "Tamago sando at Kissa Mado", { timeout: 10_000 });
	await page.screenshot({ path: shotPath("saved/feed-next-1440.png"), animations: "disabled" });
	await activeCard(page).getByTestId(S.delete).click();
	await expect(page.locator(`[data-testid="${S.card}"][data-done="deleted"]`)).toHaveCount(1);
	// The TikTok stays: scroll past it to the end.
	await expect(activeCard(page)).toHaveAttribute("aria-label", "Matcha parfait at Tsujiri", { timeout: 10_000 });
	await expect(activeCard(page)).toContainText("Matcha parfait at Tsujiri, worth the queue");
	await page.keyboard.press("ArrowDown");
	await expect(page.getByTestId(S.end)).toContainText("That's everything you saved");
	await page.getByTestId(S.endBack).click();
	await expect(page.getByTestId(S.feed)).toHaveCount(0);
	await expect(tiles).toHaveCount(1);
	await expect(tiles.nth(0).getByTestId(S.tileBadge)).toHaveText("TikTok");

	// The dashboard's way in counts it.
	await page.goto("/dashboard");
	await expect(page.getByTestId(S.entry)).toContainText("1 to add to a trip");

	// Select in the grid: delete it, Undo brings it back; delete it for good.
	await page.goto("/saved");
	await page.getByTestId(S.select).click();
	await tiles.nth(0).click();
	await expect(page.getByTestId(S.selectCount)).toHaveText("1 selected");
	await page.screenshot({ path: shotPath("saved/select-1440.png"), animations: "disabled" });
	await page.getByTestId(S.deleteSelected).click();
	await expect(tiles).toHaveCount(0);
	await page.getByRole("button", { name: "Undo" }).click();
	await expect(tiles).toHaveCount(1);
	await page.getByTestId(S.select).click();
	await tiles.nth(0).click();
	await page.getByTestId(S.deleteSelected).click();
	await expect(page.getByTestId(S.empty)).toBeVisible();

	// The place is in the trip.
	await page.goto(`/t/${c.slug}`);
	await expectLive(page);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(
						window as unknown as { __yonder?: { graph: { nodes: { name: string; lat: number | null }[] } } }
					).__yonder?.graph.nodes.find((n) => n.name === "Kissa Mado")?.lat ?? null,
			),
		)
		.toBeCloseTo(35.0037, 3);
	await expect(page.getByTestId(TESTID.workspace)).toBeVisible();
});

test("two photos shared from another app: uploaded with progress, one tile, slides in the feed, onto a place", async ({
	page,
	request,
}, info) => {
	test.skip(info.project.name !== "chromium", "sizes are set here");
	test.setTimeout(120_000);
	const c = await cloneFixtureTrip(request);
	const place = c.ids.nodes.shibuyaSky as string;
	await page.goto("/share");
	await page.evaluate((id) => localStorage.setItem("yonder:share-last-trip", id), c.tripId);
	const photosOn = () =>
		page.evaluate(
			async ({ tripId, place }) => {
				const m = await import(/* @vite-ignore */ "/src/features/media/media.functions.ts");
				const all = (await m.listTripMedia({ data: { tripId } })) as { kind: string; target: { nodeId?: string } }[];
				return all.filter((x) => x.kind === "photo" && x.target.nodeId === place).length;
			},
			{ tripId: c.tripId, place },
		);
	const had = await photosOn();
	// What the share target's service worker does: the files on the device, then /share?id=.
	const id = `e2e-${randomBytes(4).toString("hex")}`;
	await page.evaluate(async (id) => {
		const jpeg = async (colour: string) => {
			const canvas = new OffscreenCanvas(640, 960);
			const g = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
			g.fillStyle = colour;
			g.fillRect(0, 0, 640, 960);
			return canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
		};
		const files = [];
		for (const [i, colour] of ["#b5651d", "#2f6f8f"].entries()) {
			const blob = await jpeg(colour);
			files.push({ name: `IMG_000${i}.jpg`, type: "image/jpeg", size: blob.size, blob });
		}
		const store = await import(/* @vite-ignore */ "/src/features/offline/share-store.ts");
		await store.putShared({ id, createdAt: Date.now(), title: null, text: "Sky deck at dusk", url: null, files });
	}, id);
	// Slow the uploads down a little, to see them going.
	await page.route("**/*original.upload*", async (route) => {
		await new Promise((r) => setTimeout(r, 1500));
		await route.continue();
	});
	await page.goto(`/share?id=${id}`);
	const uploading = page.getByTestId(HOME_TESTID.shareUploading);
	await expect(uploading).toContainText("Uploading 2 photos…");
	await page.screenshot({ path: shotPath("saved/uploading-1440.png"), animations: "disabled" });
	// Up: the feed at it.
	await expect(page).toHaveURL(/\/saved\?open=.+&from=share/, { timeout: 30_000 });
	await activeCard(page).getByTestId(S.later).click();
	const tile = page.getByTestId(S.tile);
	await expect(tile).toHaveCount(1);
	await expect(tile.getByTestId(S.tileBadge)).toHaveText("Photos");
	await expect(tile.getByTestId(S.tileLine)).toHaveText("Sky deck at dusk");
	await expect(tile.locator('img[src^="/api/saved-file/"]')).toBeVisible({ timeout: 20_000 });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: shotPath("saved/photos-grid-390.png"), animations: "disabled" });
	await page.setViewportSize({ width: 1440, height: 900 });
	// The feed: two slides; step to the second.
	await tile.click();
	await expect(page).toHaveURL(/\/saved\?open=/);
	const card = page.locator(`[data-testid="${S.card}"][data-saved="${new URL(page.url()).searchParams.get("open")}"]`);
	const slides = card.getByTestId(S.slides);
	await expect(slides.getByTestId(S.slide)).toHaveCount(2);
	await expect(slides.getByRole("img", { name: "Photo 1 of 2" })).toBeVisible();
	await slides.getByRole("button", { name: "Next photo" }).click();
	await expect(slides).toHaveAttribute("data-slide", "1");
	await page.screenshot({ path: shotPath("saved/photos-feed-1440.png"), animations: "disabled" });
	// Onto Shibuya Sky: the same files, now in the trip.
	await card.getByRole("button", { name: /Add to existing/ }).click();
	await card.getByLabel("Place").click();
	await page.getByRole("option", { name: "Shibuya Sky" }).click();
	await card.getByTestId(HOME_TESTID.shareSave).click();
	await expect(card.getByTestId(HOME_TESTID.shareSaved)).toContainText("Saved to Shibuya Sky", { timeout: 15_000 });
	await expect.poll(photosOn, { timeout: 15_000 }).toBe(had + 2);
	// Gone from the grid (it's in the trip now).
	await page.getByTestId(S.close).click();
	await expect(page.getByTestId(S.empty)).toBeVisible();
});
