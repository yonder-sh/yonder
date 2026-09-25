/**
 * WP-Media with more than one person (QA MED-01 "Dennis sees it within 2 s",
 * MED-04, MED-07, MED-11, ROLL-10; EXTENSIONS E7 for media): a second member
 * sees adds and deletes live and Undo brings a photo back; a viewer member can
 * hide things from guests but can't upload or delete; a suggester's delete is
 * a suggestion (a struck-through ghost), not a delete; a guest editor can
 * upload; TikTok, Reels and the three YouTube forms become embeds that open
 * in the lightbox (arrows, Esc, a plain link under each embed). Each test
 * clones its own demo trip (SPEC §18.5).
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import { MEDIA_TESTID } from "../../../src/features/media/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { clearToasts } from "./media-helpers";
import { collectConsole, expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

/** A small real JPEG drawn in the page (no fixture file). */
async function jpegFromPage(page: Page, hue = 200): Promise<Buffer> {
	const b64 = await page.evaluate(async (h) => {
		const c = document.createElement("canvas");
		c.width = 600;
		c.height = 400;
		const g = c.getContext("2d") as CanvasRenderingContext2D;
		const grad = g.createLinearGradient(0, 0, 600, 400);
		grad.addColorStop(0, `hsl(${h} 60% 62%)`);
		grad.addColorStop(1, `hsl(${h + 60} 45% 30%)`);
		g.fillStyle = grad;
		g.fillRect(0, 0, 600, 400);
		g.fillStyle = "hsl(35 90% 75%)";
		g.beginPath();
		g.arc(150, 120, 50, 0, Math.PI * 2);
		g.fill();
		const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), "image/jpeg", 0.85));
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let s = "";
		for (const x of bytes) s += String.fromCharCode(x);
		return btoa(s);
	}, hue);
	return Buffer.from(b64, "base64");
}

async function openMedia(page: Page, slug: string, path = "japan/tokyo") {
	await page.goto(`/t/${slug}/${path}?tab=media`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.mediaTab)).toBeVisible();
}

const tiles = (page: Page, kind?: string) =>
	page.locator(`[data-testid=${TESTID.galleryItem}]${kind ? `[data-kind=${kind}]` : ""}`);

async function openTileMenu(page: Page, tile: ReturnType<typeof tiles>) {
	await tile.hover();
	await tile.getByTestId(MEDIA_TESTID.tileMenu).click();
	return page.getByRole("menu");
}

async function asMaya(browser: Browser) {
	const ctx = await browser.newContext({ storageState: storageStateOf("maya") });
	return { ctx, page: await ctx.newPage() };
}

test("another member sees adds and deletes live; Undo brings the photo back (MED-01, MED-07)", async ({
	page,
	browser,
}, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	test.setTimeout(90_000);
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const maya = await asMaya(browser);
	await openMedia(page, c.slug);
	await openMedia(maya.page, c.slug);

	await page.getByTestId(MEDIA_TESTID.fileInput).setInputFiles({
		name: "chureito-sunrise.jpg",
		mimeType: "image/jpeg",
		buffer: await jpegFromPage(page),
	});
	await expect(tiles(page, "photo")).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
	const shown = Date.now();
	await expect(tiles(maya.page, "photo")).toHaveCount(1, { timeout: 5_000 });
	info.annotations.push({ type: "live add", description: `${Date.now() - shown} ms after ready` });
	// The picture itself loads for her (same-origin thumb).
	await expect
		.poll(() => tiles(maya.page, "photo").locator("img").first().evaluate((i: HTMLImageElement) => i.naturalWidth), {
			timeout: 15_000,
		})
		.toBeGreaterThan(0);

	// Delete: gone for both within a moment; Undo restores it for both.
	const menu = await openTileMenu(page, tiles(page, "photo"));
	await menu.getByRole("menuitem", { name: "Delete" }).click();
	await expect(tiles(page, "photo")).toHaveCount(0);
	const deleted = Date.now();
	await expect(tiles(maya.page, "photo")).toHaveCount(0, { timeout: 5_000 });
	info.annotations.push({ type: "live delete", description: `${Date.now() - deleted} ms` });
	await page.getByRole("button", { name: "Undo" }).click();
	await expect(tiles(page, "photo")).toHaveCount(1);
	await expect(tiles(maya.page, "photo")).toHaveCount(1, { timeout: 5_000 });
	await maya.ctx.close();
	expect(logs.messages).toEqual([]);
});

test("a viewer hides from guests but can't upload or delete; a suggester's delete is a suggestion (MED-07, E7)", async ({
	page,
	browser,
}, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	test.setTimeout(90_000);

	// Maya as a viewer member.
	const v = await cloneFixtureTrip(page.request, { mayaRole: "viewer" });
	const maya = await asMaya(browser);
	await openMedia(maya.page, v.slug);
	const link = tiles(maya.page, "link");
	await expect(link).toHaveCount(1);
	await expect(maya.page.getByTestId(MEDIA_TESTID.addButton).first()).toBeDisabled();
	let menu = await openTileMenu(maya.page, link);
	await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
	await expect(menu.getByRole("menuitem", { name: /caption/ })).toBeDisabled();
	// "Hide from guests" is for every member, viewers included (ADDENDUM §9).
	await menu.getByRole("menuitem", { name: "Hide from guests" }).click();
	await expect(link).toHaveAttribute("data-visibility", "members");
	await expect(link.getByTestId(MEDIA_TESTID.hiddenChip)).toBeAttached();
	await maya.page.mouse.move(5, 5);
	await clearToasts(maya.page);
	await maya.page.screenshot({ path: shotPath("media/viewer-1440.png"), animations: "disabled" });
	// The owner sees it hidden too.
	await openMedia(page, v.slug);
	await expect(tiles(page, "link")).toHaveAttribute("data-visibility", "members");

	// Maya as a suggester: her delete becomes a suggestion; the tile stays, struck through.
	const s = await cloneFixtureTrip(page.request, { mayaRole: "suggester" });
	await openMedia(maya.page, s.slug);
	menu = await openTileMenu(maya.page, tiles(maya.page, "link"));
	await menu.getByRole("menuitem", { name: "Delete" }).click();
	await expect(maya.page.getByText(/^Suggested — /)).toBeVisible();
	await expect(tiles(maya.page, "link")).toHaveCount(1);
	const ghost = maya.page.locator(`[data-proposed=delete]`).filter({ has: tiles(maya.page, "link") });
	await expect(ghost).toBeVisible({ timeout: 10_000 });
	await maya.page.mouse.move(5, 5);
	await maya.page.screenshot({ path: shotPath("media/suggested-delete-1440.png"), animations: "disabled" });
	// The owner (a reviewer) sees the same ghost; nothing was deleted.
	await openMedia(page, s.slug);
	await expect(page.locator(`[data-proposed=delete]`).filter({ has: tiles(page, "link") })).toBeVisible();
	await maya.ctx.close();
});

test("a guest editor can upload; a guest viewer can't (MED-11)", async ({ page, browser }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	test.setTimeout(90_000);
	const c = await cloneFixtureTrip(page.request);
	const photo = await (async () => {
		await page.goto("/");
		return jpegFromPage(page, 20);
	})();
	for (const role of ["editor", "viewer"] as const) {
		const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
		const guest = await ctx.newPage();
		await guest.goto(`/join#t=${c.shareTokens[role]}`);
		await expect(guest).toHaveURL(new RegExp(`/t/${c.slug}`), { timeout: 20_000 });
		await openMedia(guest, c.slug);
		const add = guest.getByTestId(MEDIA_TESTID.addButton).first();
		if (role === "viewer") {
			await expect(add).toBeDisabled();
			// The editor-guest's photo is there for the viewer-guest.
			await expect(tiles(guest, "photo")).toHaveCount(1);
		} else {
			await expect(add).toBeEnabled();
			await guest.getByTestId(MEDIA_TESTID.fileInput).setInputFiles({
				name: "golden-gai-alley.jpg",
				mimeType: "image/jpeg",
				buffer: photo,
			});
			await expect(tiles(guest, "photo")).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
			// Guests never get the lock (it's a members' control).
			await expect(guest.getByTestId(MEDIA_TESTID.visibility)).toHaveCount(0);
		}
		await ctx.close();
	}
});

test("TikTok, Reels and every YouTube form become embeds; the lightbox steps through them (MED-04, ROLL-10)", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	test.setTimeout(90_000);
	// No third-party players in the test: the embed frames are blocked, which
	// is also MED-04's "the card falls back to a plain link that still works".
	await page.route(/youtube-nocookie\.com|tiktok\.com|instagram\.com/, (r) => r.abort("blockedbyclient"));
	const c = await cloneFixtureTrip(page.request);
	await openMedia(page, c.slug);
	const urls = [
		"https://www.tiktok.com/@fixture/video/7300000000000000001",
		"https://www.instagram.com/reel/C0FIXTURE01/",
		"https://www.youtube.com/watch?v=FIXTURE0001",
		"https://youtu.be/FIXTURE0002",
		"https://www.youtube.com/shorts/FIXTURE0003",
	];
	for (const url of urls) {
		await page.getByTestId(MEDIA_TESTID.addButton).first().click();
		await page.getByTestId(MEDIA_TESTID.addLink).click();
		await page.getByTestId(MEDIA_TESTID.linkInput).fill(url);
		await page.getByTestId(MEDIA_TESTID.linkSubmit).click();
		await expect(page.getByTestId(MEDIA_TESTID.linkInput)).toBeHidden();
	}
	const embeds = tiles(page, "embed");
	await expect(embeds).toHaveCount(5);
	await expect(page.locator(`[data-testid=${TESTID.galleryItem}][data-provider=youtube]`)).toHaveCount(3);
	await expect(page.locator(`[data-testid=${TESTID.galleryItem}][data-provider=tiktok]`)).toHaveCount(1);
	await expect(page.locator(`[data-testid=${TESTID.galleryItem}][data-provider=instagram]`)).toHaveCount(1);
	await page.mouse.move(5, 5);
	await clearToasts(page);
	await page.screenshot({ path: shotPath("media/embeds-1440.png"), animations: "disabled" });

	// The first embed opens in the lightbox; → steps to the next; each slide
	// has its player frame and a plain "Open on …" link.
	await embeds.first().getByRole("button").first().click();
	// yet-another-react-lightbox renders into a portal (`.yonder-lightbox`).
	const box = page.locator(".yonder-lightbox");
	await expect(box).toBeVisible();
	const frame = page.locator(`.yarl__slide_current [data-testid=${MEDIA_TESTID.embedFrame}]`);
	await expect(frame).toHaveAttribute("src", /^https:\/\/www\.(tiktok|instagram|youtube-nocookie)\.com\//);
	const first = await frame.getAttribute("src");
	await expect(page.locator(".yarl__slide_current").getByRole("link", { name: /^Open on / })).toHaveAttribute(
		"rel",
		/noopener/,
	);
	// Step through all five (→ waits for each slide to change).
	const srcs = new Set<string>([first ?? ""]);
	let prev = first;
	for (let i = 0; i < 4; i++) {
		await page.keyboard.press("ArrowRight");
		await expect.poll(() => frame.getAttribute("src")).not.toBe(prev);
		prev = await frame.getAttribute("src");
		srcs.add(prev ?? "");
	}
	expect(srcs.size).toBe(5);
	// All three YouTube forms resolve to nocookie embeds.
	expect([...srcs].filter((s) => s.startsWith("https://www.youtube-nocookie.com/embed/")).sort()).toEqual([
		"https://www.youtube-nocookie.com/embed/FIXTURE0001?playsinline=1&rel=0",
		"https://www.youtube-nocookie.com/embed/FIXTURE0002?playsinline=1&rel=0",
		"https://www.youtube-nocookie.com/embed/FIXTURE0003?playsinline=1&rel=0",
	]);
	await page.waitForTimeout(300);
	await clearToasts(page);
	await page.screenshot({ path: shotPath("media/lightbox-embed-1440.png"), animations: "disabled" });
	await page.keyboard.press("Escape");
	await expect(box).toBeHidden();
	// Esc closed only the lightbox: still Tokyo.
	await expect(page).toHaveURL(/\/japan\/tokyo/);
});
