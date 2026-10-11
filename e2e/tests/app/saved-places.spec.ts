/**
 * Saved as an inventory (owner, 2026-10-11): a share asks "Where is this?"
 * first (search once, then one tap on its chip), the grid groups by country
 * and city with Unsorted last, an item added to a trip stays ("In …") and
 * "Hide ones in trips" hides it (remembered); a trip's gallery saves its
 * photos and links into Saved under the trip's city, viewers too.
 */
import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { MEDIA_TESTID } from "../../../src/features/media/testids";
import { SAVED_TESTID as S } from "../../../src/features/saved/testids";
import { TESTID } from "../../../src/lib/testids";
import { APP_URL, shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive, expectNoHorizontalOverflow } from "./_helpers/page";
import { clearToasts } from "./media-helpers";

test.use({ storageState: storageStateOf("dev") });

let n = 0;
const tiktok = () => `https://www.tiktok.com/@kyoto.eats/video/73${Date.now()}${n++}`;

/** Shares a link like the Shortcut does; the feed opens on it, asking where it is. */
async function share(page: Page, text: string) {
	const url = tiktok();
	await page.goto(`/share?${new URLSearchParams({ url, text: `${text} ${url}` })}`);
	await expect(page).toHaveURL(/\/saved\?open=[0-9a-f-]{36}&from=share/, { timeout: 20_000 });
	const ask = page.getByTestId(S.whereAsk);
	await expect(ask).toBeVisible();
	await expect(ask).toContainText("Where is this?");
	return ask;
}

const section = (page: Page, label: string) => page.locator(`[data-testid="${S.section}"][aria-label="${label}"]`);

test("a share asks where it is; one tap files it; the grid groups by place; ones in trips can be hidden", async ({
	page,
	request,
}, info) => {
	test.skip(info.project.name !== "chromium", "sizes are set here: 1440 and 390");
	test.setTimeout(150_000);
	const c = await cloneFixtureTrip(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/dashboard");
	await page.evaluate((id) => {
		localStorage.setItem("yonder:share-last-trip", id);
		localStorage.removeItem("yonder:saved-hide-in-trips");
	}, c.tripId);
	const tag = randomBytes(2).toString("hex");

	// First: search for the city (the chips are my trips' places so far).
	let ask = await share(page, `Matcha ${tag}`);
	await expect(ask.getByTestId(S.whereChip).first()).toBeVisible();
	await page.screenshot({ path: shotPath("saved/where-1440.png"), animations: "disabled" });
	await ask.getByTestId(S.whereSearch).fill("Kyoto");
	await ask.getByTestId(S.whereResult).filter({ hasText: "Kyoto" }).first().click();
	await expect(page.getByTestId(S.feed)).toHaveCount(0);
	await expect(page).toHaveURL(/\/saved$/);
	await expect(page.getByText("Saved in Kyoto, Japan")).toBeVisible();

	// Then Kyoto is the first chip: one tap.
	ask = await share(page, `Tofu ${tag}`);
	const first = ask.getByTestId(S.whereChip).first();
	await expect(first).toHaveAccessibleName("Kyoto, Japan");
	await first.click();
	await expect(page).toHaveURL(/\/saved$/);

	// On a phone: the question is a sheet over the reel.
	await page.setViewportSize({ width: 390, height: 844 });
	ask = await share(page, `Bibimbap ${tag}`);
	await expect(ask).toBeInViewport();
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: shotPath("saved/where-390.png"), animations: "disabled" });
	await ask.getByTestId(S.whereSearch).fill("Seoul");
	await page.screenshot({ path: shotPath("saved/where-search-390.png"), animations: "disabled" });
	await ask.getByTestId(S.whereResult).filter({ hasText: "Seoul" }).first().click();
	await expect(page).toHaveURL(/\/saved$/);
	// Skip: Unsorted.
	ask = await share(page, `Mystery ${tag}`);
	await ask.getByTestId(S.whereSkip).click();
	await expect(page).toHaveURL(/\/saved$/);

	// The grid: Korea (newest), Japan › Kyoto · 2, then Unsorted.
	const labels = () => page.getByTestId(S.section).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
	await expect.poll(labels).toEqual(["South Korea", "Japan", "Unsorted"]);
	await expect(section(page, "Japan").getByTestId(S.sectionCity).locator("h3")).toHaveText("Kyoto · 2");
	await expect(section(page, "South Korea").getByTestId(S.tile)).toHaveCount(1);
	await expect(section(page, "Unsorted").getByTestId(S.tile)).toHaveCount(1);
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: shotPath("saved/grid-places-390.png"), animations: "disabled", fullPage: true });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.screenshot({ path: shotPath("saved/grid-places-1440.png"), animations: "disabled", fullPage: true });

	// Its place shows in the feed; Change moves it.
	await section(page, "Unsorted").getByTestId(S.tile).click();
	const card = page.locator(`[data-testid="${S.card}"][data-active]`);
	await expect(card.getByTestId(S.whereRow)).toContainText("Unsorted");
	await card.getByTestId(S.whereChange).click();
	const dialog = page.getByTestId(S.whereDialog);
	await dialog.getByRole("button", { name: "South Korea", exact: true }).click();
	await expect(card.getByTestId(S.whereRow)).toContainText("South Korea");

	// Into the trip from the feed: it stays in Saved, "In …".
	await page.getByTestId(S.close).click();
	await section(page, "Japan").getByTestId(S.tile).first().click();
	const kyoto = page.locator(`[data-testid="${S.card}"][data-active]`);
	await kyoto.getByTestId(HOME_TESTID.shareName).fill(`Tofu ${tag}`);
	// The saved city is the area: the trip's Kyoto.
	await expect(kyoto.getByTestId(HOME_TESTID.shareParent)).toHaveAccessibleName(/Kyoto/);
	await kyoto.getByTestId(HOME_TESTID.shareSave).click();
	await expect(page.locator(`[data-testid="${S.card}"][data-done="saved"]`)).toHaveCount(1, { timeout: 15_000 });
	await page.getByTestId(S.close).click();
	await expect(page.getByTestId(S.tileTrips)).toHaveCount(1);
	await expect(page.getByTestId(S.tileTrips)).toContainText(/^In /);
	await page.screenshot({ path: shotPath("saved/in-trip-1440.png"), animations: "disabled" });
	const before = await page.getByTestId(S.tile).count();
	await page.getByTestId(S.hideInTrips).click();
	await expect(page.getByTestId(S.tile)).toHaveCount(before - 1);
	await expect(page.getByTestId(S.tileTrips)).toHaveCount(0);
	// Remembered on this device.
	await page.reload();
	await expect(page.getByTestId(S.hideInTrips)).toBeChecked();
	await expect(page.getByTestId(S.tile)).toHaveCount(before - 1);
});

test("a trip's gallery saves into my Saved under the trip's city, marked in the trip (a viewer too)", async ({
	page,
	browser,
	request,
}, info) => {
	test.skip(info.project.name !== "chromium", "desktop run");
	test.setTimeout(120_000);
	const c = await cloneFixtureTrip(request, { mayaRole: "viewer" });
	await page.setViewportSize({ width: 1440, height: 900 });

	// A photo I uploaded to Tokyo: Save keeps the same picture in Saved.
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=media`);
	await expectLive(page);
	const body = await page.evaluate(async () => {
		const canvas = new OffscreenCanvas(640, 480);
		const g = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
		g.fillStyle = "#3a7ca5";
		g.fillRect(0, 0, 640, 480);
		const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
		return [...new Uint8Array(await blob.arrayBuffer())];
	});
	await page.getByTestId(MEDIA_TESTID.fileInput).setInputFiles({
		name: "tokyo-blue.jpg",
		mimeType: "image/jpeg",
		buffer: Buffer.from(body),
	});
	const photo = page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=photo]`).first();
	await expect(photo).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
	await clearToasts(page);
	await photo.hover();
	await photo.getByTestId(MEDIA_TESTID.tileMenu).click();
	await page.screenshot({ path: shotPath("saved/gallery-save-1440.png"), animations: "disabled" });
	await page.getByTestId(MEDIA_TESTID.save).click();
	await expect(page.locator("[data-sonner-toast]").filter({ hasText: /^Saved/ })).toBeVisible();
	// Saved once: the menu says so now.
	await photo.hover();
	await photo.getByTestId(MEDIA_TESTID.tileMenu).click();
	await expect(page.getByTestId(MEDIA_TESTID.saved)).toBeVisible();
	await page.keyboard.press("Escape");
	await page.goto("/saved");
	const tokyo = page.locator(`[data-testid="${S.sectionCity}"][data-city="JP|tokyo"]`);
	await expect(tokyo.locator("h3")).toContainText("Tokyo");
	const mine = tokyo.getByTestId(S.tile).first();
	await expect(mine.getByTestId(S.tileTrips)).toContainText(/^In /);
	await expect
		.poll(() => mine.locator('img[src^="/api/saved-file/"]').evaluate((i) => (i as HTMLImageElement).naturalWidth), { timeout: 20_000 })
		.toBeGreaterThan(0);
	await page.screenshot({ path: shotPath("saved/from-trip-1440.png"), animations: "disabled" });

	// Maya only views the trip: she can still keep its Shibuya Sky link.
	const ctx = await browser.newContext({ baseURL: APP_URL, storageState: storageStateOf("maya"), viewport: { width: 1440, height: 900 } });
	const maya = await ctx.newPage();
	await maya.goto(`/t/${c.slug}/japan/tokyo?tab=media`);
	await expectLive(maya);
	const link = maya.locator(`[data-testid=${TESTID.galleryItem}][data-kind=link]`).first();
	await link.hover();
	await link.getByTestId(MEDIA_TESTID.tileMenu).click();
	await maya.getByTestId(MEDIA_TESTID.save).click();
	await expect(maya.locator("[data-sonner-toast]").filter({ hasText: /^Saved/ })).toBeVisible();
	await maya.goto("/saved");
	const hers = maya.locator(`[data-testid="${S.section}"][aria-label="Japan"]`);
	await expect(hers.getByTestId(S.sectionCity).locator("h3")).toContainText([/Tokyo/]);
	await expect(hers.getByTestId(S.tileTrips)).toContainText(/^In /);
	await ctx.close();
});
