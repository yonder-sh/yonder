/**
 * WP-Media end to end (SPEC §18.3 WP-Media, QA MED-01/04/05/06/07/11,
 * ROLL-09/10; ADDENDUM §9 PDFs + "Hide from guests"). Each test clones its
 * own demo trip (SPEC §18.5). The worker must be running (it is under
 * `pnpm dev`) so uploads become `ready`.
 */
import { expect, type Page, test } from "@playwright/test";
import { makePdf } from "../../../src/features/media/__tests__/make-pdf";
import { MEDIA_TESTID } from "../../../src/features/media/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { clearToasts } from "./media-helpers";
import { collectConsole, expectLive, expectNoHorizontalOverflow } from "./_helpers/page";
import { openLink } from "./_helpers/link";

test.use({ storageState: storageStateOf("dev") });

const S3 = process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:8080";

/** A small real JPEG (a gradient with a sun), made in the page so no fixture file is needed. */
async function jpegFromPage(page: Page, hue = 20): Promise<Buffer> {
	const b64 = await page.evaluate(async (h) => {
		const c = document.createElement("canvas");
		c.width = 640;
		c.height = 480;
		const g = c.getContext("2d") as CanvasRenderingContext2D;
		const grad = g.createLinearGradient(0, 0, 0, 480);
		grad.addColorStop(0, `hsl(${h} 70% 60%)`);
		grad.addColorStop(1, `hsl(${h + 200} 40% 25%)`);
		g.fillStyle = grad;
		g.fillRect(0, 0, 640, 480);
		g.fillStyle = "hsl(40 90% 70%)";
		g.beginPath();
		g.arc(420, 180, 70, 0, Math.PI * 2);
		g.fill();
		g.fillStyle = "hsl(230 30% 15%)";
		g.beginPath();
		g.moveTo(0, 480);
		g.lineTo(220, 250);
		g.lineTo(380, 400);
		g.lineTo(520, 300);
		g.lineTo(640, 480);
		g.fill();
		const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), "image/jpeg", 0.85));
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let s = "";
		for (const x of bytes) s += String.fromCharCode(x);
		return btoa(s);
	}, hue);
	return Buffer.from(b64, "base64");
}

async function openMedia(page: Page, slug: string, path = "japan/tokyo", search = "") {
	await page.goto(`/t/${slug}/${path}?tab=media${search}`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.mediaTab)).toBeVisible();
}

function tile(page: Page, kind: string) {
	return page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=${kind}]`);
}

test("photos, PDFs and links: upload, roll up, view, hide from guests", async ({ page, browser }, info) => {
	test.skip(info.project.name !== "chromium", "desktop run; the phone layout has its own test");
	test.setTimeout(120_000);
	const logs = collectConsole(page, [/Failed to load resource: the server responded with a status of 404/]);
	const c = await cloneFixtureTrip(page.request);
	await openMedia(page, c.slug);

	// MED-01: the bytes go straight to S3 with a presigned PUT; a tile appears.
	const photo = await jpegFromPage(page);
	const putReq = page.waitForRequest((r) => r.method() === "PUT" && r.url().startsWith(S3));
	await page.getByTestId(MEDIA_TESTID.fileInput).setInputFiles({
		name: "chureito-sunrise.jpg",
		mimeType: "image/jpeg",
		buffer: photo,
	});
	const put = await putReq;
	expect(new URL(put.url()).searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
	await expect(tile(page, "photo")).toHaveAttribute("data-status", "ready", { timeout: 30_000 });

	// A PDF on the flight: booking confirmations start hidden from guests.
	const pdf = makePdf(["E-ticket KE724", "Baggage allowance", "Fare rules"], { title: "Korean Air KE724" });
	await page.goto(`/t/${c.slug}?sel=l.${c.ids.items.kix}.${c.ids.items.icn}`);
	await expectLive(page);
	const inspector = page.getByTestId(TESTID.inspector);
	await inspector.getByRole("tab", { name: "Media" }).click();
	await inspector.getByTestId(MEDIA_TESTID.fileInput).setInputFiles({
		name: "E-ticket KE724.pdf",
		mimeType: "application/pdf",
		buffer: pdf,
	});
	const pdfTile = inspector.locator(`[data-testid=${TESTID.galleryItem}][data-kind=pdf]`);
	await expect(pdfTile).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
	await expect(pdfTile).toHaveAttribute("data-visibility", "members");
	await expect(pdfTile.getByTestId(MEDIA_TESTID.hiddenChip)).toBeAttached();
	const flightPdfId = await pdfTile.getAttribute("data-id");
	await clearToasts(page);
	await page.screenshot({ path: shotPath("media/inspector-pdf-1440.png"), animations: "disabled" });

	// A general PDF (a map) in Tokyo, a guide link and a YouTube link.
	await openMedia(page, c.slug);
	await page.getByTestId(MEDIA_TESTID.fileInput).setInputFiles({
		name: "Tokyo subway map.pdf",
		mimeType: "application/pdf",
		buffer: makePdf(["Tokyo subway map"], { title: "Tokyo Metro" }),
	});
	for (const url of [
		"https://www.japan-guide.com/e/e3000.html",
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	]) {
		await page.getByTestId(MEDIA_TESTID.addButton).first().click();
		await page.getByTestId(MEDIA_TESTID.addLink).click();
		await page.getByTestId(MEDIA_TESTID.linkInput).fill(url);
		await page.getByTestId(MEDIA_TESTID.linkSubmit).click();
		await expect(page.getByTestId(MEDIA_TESTID.linkInput)).toBeHidden();
	}
	await expect(tile(page, "embed")).toHaveCount(1);
	// The demo trip already has the Shibuya Sky link (in the Shibuya group).
	await expect(tile(page, "link")).toHaveCount(2);
	await expect(tile(page, "pdf")).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
	// MED-05: guide links open in a new tab, rel=noopener.
	const guideLink = tile(page, "link").locator("a").first();
	await expect(guideLink).toHaveAttribute("target", "_blank");
	await expect(guideLink).toHaveAttribute("rel", /noopener/);

	// The Documents filter (mf=documents) shows only PDFs.
	await page.locator(`[data-testid=${MEDIA_TESTID.filterChip}][data-filter=documents]`).click();
	await expect(page).toHaveURL(/mf=documents/);
	await expect(page.locator(`[data-testid=${TESTID.galleryItem}]`)).toHaveCount(1);
	await expect(tile(page, "pdf")).toHaveCount(1);
	await page.locator(`[data-testid=${MEDIA_TESTID.filterChip}][data-filter=all]`).click();
	await expect(page).not.toHaveURL(/mf=/);
	await page.mouse.move(10, 10);
	await clearToasts(page);
	await page.screenshot({ path: shotPath("media/tab-tokyo-1440.png"), animations: "disabled" });
	await expectNoHorizontalOverflow(page);

	// The PDF viewer: pages, zoom, download, the lock.
	await tile(page, "pdf").getByRole("button").first().click();
	const viewer = page.getByTestId(MEDIA_TESTID.pdfViewer);
	await expect(viewer).toBeVisible();
	await expect(viewer.getByTestId(MEDIA_TESTID.pdfPage)).toHaveCount(1);
	await expect(viewer.getByRole("img", { name: /Page 1 of/ })).toBeVisible();
	await expect
		.poll(() => viewer.getByRole("img", { name: /Page 1 of/ }).evaluate((i: HTMLImageElement) => i.naturalWidth))
		.toBeGreaterThan(500);
	await expect(viewer.getByTestId(MEDIA_TESTID.pdfDownload)).toHaveAttribute("href", /\/original\?download=1$/);
	await viewer.getByTestId(MEDIA_TESTID.pdfZoomIn).click();
	await expect(viewer).toContainText("125%");
	await clearToasts(page);
	await page.screenshot({ path: shotPath("media/pdf-viewer-1440.png"), animations: "disabled" });
	const lock = viewer.getByTestId(MEDIA_TESTID.visibility).first();
	await expect(lock).toHaveAttribute("data-state", "visible");
	await lock.click();
	await expect(lock).toHaveAttribute("data-state", "hidden");
	await expect(lock).toContainText("Hidden from guests");
	await page.keyboard.press("Escape");
	await expect(viewer).toBeHidden();

	// The lightbox: the photo opens with its caption line and closes with Esc.
	await tile(page, "photo").getByRole("button").first().click();
	await expect(page.locator(".yonder-lightbox")).toBeVisible();
	await expect(page.locator(".yarl__portal_open")).toBeVisible();
	await expect(page.locator(".yarl__slide_current img")).toBeVisible();
	await page.waitForTimeout(400); // the fade-in (a CSS transition) settles
	await clearToasts(page);
	await page.screenshot({ path: shotPath("media/lightbox-1440.png"), animations: "disabled" });
	await page.keyboard.press("Escape");
	await expect(page.locator(".yonder-lightbox")).toBeHidden();

	// Everything survives a reload.
	await page.reload();
	await expectLive(page);
	await expect(page.locator(`[data-testid=${TESTID.galleryItem}]`)).toHaveCount(5);

	// MED-11 + ADDENDUM §9: a viewer-link guest sees photos, links and the
	// general PDF, never the hidden ones, and has no upload or lock controls.
	// A clean context: `test.use({ storageState })` would otherwise sign it in as dev.
	const guestCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const guest = await guestCtx.newPage();
	await openLink(guest, c.slug, "viewer");
	await expect(guest).toHaveURL(new RegExp(`/t/${c.slug}`), { timeout: 20_000 });
	await openMedia(guest, c.slug);
	await expect(guest.locator(`[data-testid=${TESTID.galleryItem}][data-kind=photo]`)).toHaveCount(1);
	await expect(guest.locator(`[data-testid=${TESTID.galleryItem}][data-kind=link]`)).toHaveCount(2);
	await expect(guest.locator(`[data-testid=${TESTID.galleryItem}][data-kind=pdf]`)).toHaveCount(0);
	await expect(guest.getByTestId(MEDIA_TESTID.visibility)).toHaveCount(0);
	await expect(guest.getByTestId(MEDIA_TESTID.addButton).first()).toBeDisabled();
	// The flight's e-ticket isn't reachable by URL either.
	const res = await guest.request.get(`/media/${flightPdfId}/thumb`);
	expect(res.status()).toBe(404);
	await clearToasts(guest);
	await guest.screenshot({ path: shotPath("media/guest-view-1440.png"), animations: "disabled" });
	await guestCtx.close();

	expect(logs.messages).toEqual([]);
});
