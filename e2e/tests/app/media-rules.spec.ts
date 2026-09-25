/**
 * WP-Media rules end to end: MED-06 (refused before upload), drop to attach
 * (the "Drop to attach to Tokyo" wash), the inspector's "This visit only" and
 * "Everything that day", MED-08 (cancel leaves nothing), ERR-05 (storage
 * down: a clear failure with Retry, no row), and the phone layout at
 * 390 × 844 (tab + PDF viewer).
 */
import { writeFileSync } from "node:fs";
import { devices, expect, type Page, test } from "@playwright/test";
import { makePdf } from "../../../src/features/media/__tests__/make-pdf";
import { MEDIA_TESTID } from "../../../src/features/media/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { clearToasts } from "./media-helpers";
import { collectConsole, expectLive, expectNoHorizontalOverflow } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

const S3 = process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:8080";
const tiles = (page: Page) => page.locator(`[data-testid=${TESTID.galleryItem}]`);

/** Server truth: the trip's media as the page's user sees it. */
async function listMedia(page: Page, tripId: string) {
	return page.evaluate(async (id) => {
		const m = await import("/src/features/media/media.functions.ts");
		return (await m.listTripMedia({ data: { tripId: id } })) as {
			id: string;
			kind: string;
			target: { kind: string };
			title: string | null;
		}[];
	}, tripId);
}

async function pngFromPage(page: Page): Promise<Buffer> {
	const b64 = await page.evaluate(async () => {
		const c = document.createElement("canvas");
		c.width = 320;
		c.height = 240;
		const g = c.getContext("2d") as CanvasRenderingContext2D;
		g.fillStyle = "#2cab70";
		g.fillRect(0, 0, 320, 240);
		g.fillStyle = "#f9fafd";
		g.fillRect(40, 60, 240, 120);
		const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), "image/png"));
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let s = "";
		for (const x of bytes) s += String.fromCharCode(x);
		return btoa(s);
	});
	return Buffer.from(b64, "base64");
}

/** Dispatches a real drag-and-drop of files onto an element (dragenter → dragover → drop). */
async function dropFiles(
	page: Page,
	selector: string,
	files: { name: string; type: string; b64: string }[],
	opts: { holdMs?: number; shot?: string } = {},
) {
	const dt = await page.evaluateHandle((fs) => {
		const d = new DataTransfer();
		for (const f of fs) {
			const bin = atob(f.b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			d.items.add(new File([bytes], f.name, { type: f.type }));
		}
		return d;
	}, files);
	await page.dispatchEvent(selector, "dragenter", { dataTransfer: dt });
	await page.dispatchEvent(selector, "dragover", { dataTransfer: dt });
	await expect(page.getByTestId(MEDIA_TESTID.dropOverlay)).toBeVisible();
	if (opts.shot) await page.screenshot({ path: opts.shot, animations: "disabled" });
	await page.dispatchEvent(selector, "drop", { dataTransfer: dt });
	await expect(page.getByTestId(MEDIA_TESTID.dropOverlay)).toBeHidden();
}

test("refuses bad files and links before upload (MED-06)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=media`);
	await expectLive(page);
	const puts: string[] = [];
	page.on("request", (r) => {
		if (r.method() === "PUT" && r.url().startsWith(S3)) puts.push(r.url());
	});
	// Over the 50 MB PDF cap. Playwright can't send an in-memory file this big
	// (and can't mix paths with buffers): write both out.
	const huge = info.outputPath("huge-guide.pdf");
	writeFileSync(huge, Buffer.alloc(51 * 1024 * 1024, 0x20));
	const exe = info.outputPath("malware.exe");
	writeFileSync(exe, Buffer.from("MZ\x90\x00"));
	await page.getByTestId(MEDIA_TESTID.fileInput).setInputFiles([exe, huge]);
	await expect(page.getByText("malware.exe isn't a photo, video or PDF.")).toBeVisible();
	await expect(page.getByText(/huge-guide\.pdf is 51\.0 MB — PDFs can be up to 50\.0 MB\./)).toBeVisible();
	// Refused files say why in a toast and leave no tile behind.
	await expect(page.getByTestId(MEDIA_TESTID.uploadTile)).toHaveCount(0);
	await page.screenshot({ path: shotPath("media/refused-1440.png"), animations: "disabled" });
	expect(puts).toEqual([]);

	// Links: only http(s) (the dialog says so; the server refuses too).
	await page.getByTestId(MEDIA_TESTID.addButton).first().click();
	await page.getByTestId(MEDIA_TESTID.addLink).click();
	await page.getByTestId(MEDIA_TESTID.linkInput).fill("javascript:alert(1)");
	await page.getByTestId(MEDIA_TESTID.linkSubmit).click();
	await expect(page.getByText("That isn't a web link. Paste one that starts with https://")).toBeVisible();
	await page.getByTestId(MEDIA_TESTID.linkInput).fill("not a url");
	await page.getByTestId(MEDIA_TESTID.linkSubmit).click();
	await expect(page.getByText(/isn't a web link/)).toBeVisible();
	await page.keyboard.press("Escape");
	// Escape closed only the dialog: the scope is still Tokyo.
	await expect(page).toHaveURL(/\/japan\/tokyo/);
	const media = await listMedia(page, c.tripId);
	expect(media.filter((m) => m.kind !== "link" || m.title !== "SHIBUYA SKY")).toEqual([]);
});

test("drop to attach, This visit only, Everything that day", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop drag and inspector");
	test.setTimeout(90_000);
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);

	// Drop on the Tokyo Media tab: it attaches to Tokyo.
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=media`);
	await expectLive(page);
	const png = (await pngFromPage(page)).toString("base64");
	await dropFiles(page, `[data-testid=${TESTID.mediaTab}]`, [{ name: "street.png", type: "image/png", b64: png }], {
		shot: shotPath("media/drop-overlay-1440.png"),
	});
	await expect(tiles(page)).toHaveCount(2, { timeout: 20_000 });
	await expect.poll(async () => (await listMedia(page, c.tripId)).filter((m) => m.kind === "photo").map((m) => m.target.kind)).toEqual(["node"]);

	// A located item (Shibuya Sky on Day 1): its node's bundle, or this visit only.
	await page.goto(`/t/${c.slug}?sel=i.${c.ids.items.sky}`);
	await expectLive(page);
	const inspector = page.getByTestId(TESTID.inspector);
	await inspector.getByRole("tab", { name: "Media" }).click();
	const panel = inspector.getByTestId(TESTID.mediaPanel);
	await expect(panel.locator(`[data-testid=${TESTID.galleryItem}][data-kind=link]`)).toHaveCount(1);
	await panel.getByText("This visit only").click();
	await expect(panel.getByTestId(MEDIA_TESTID.empty)).toContainText("on this visit");
	await dropFiles(page, `[data-testid=${TESTID.mediaPanel}]`, [{ name: "visit.png", type: "image/png", b64: png }]);
	await expect(panel.locator(`[data-testid=${TESTID.galleryItem}]`)).toHaveCount(1, { timeout: 20_000 });
	await expect.poll(async () => (await listMedia(page, c.tripId)).filter((m) => m.target.kind === "item").length).toBe(1);
	await clearToasts(page);
	await page.screenshot({ path: shotPath("media/inspector-visit-1440.png"), animations: "disabled" });

	// A day: "This day" is empty; "Everything that day" rolls up its items.
	await page.goto(`/t/${c.slug}?sel=d.${c.ids.days.d1}`);
	await expectLive(page);
	await inspector.getByRole("tab", { name: "Media" }).click();
	await expect(panel.getByTestId(MEDIA_TESTID.empty)).toBeVisible();
	await panel.getByRole("radio", { name: "Everything that day" }).click();
	await expect(panel.locator(`[data-testid=${TESTID.galleryItem}]`)).toHaveCount(2);
	expect(logs.messages).toEqual([]);
});

test("cancel leaves nothing; storage down fails clearly and retries (MED-08, ERR-05)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=media`);
	await expectLive(page);
	const pdf = makePdf(["Ryokan booking", "Dinner menu"]);

	// Cancel mid-upload: the PUT hangs until we cancel.
	await page.route(`${S3}/**`, () => {
		/* never answer */
	});
	await page.getByTestId(MEDIA_TESTID.fileInput).setInputFiles({ name: "booking.pdf", mimeType: "application/pdf", buffer: pdf });
	const up = page.getByTestId(MEDIA_TESTID.uploadTile);
	await expect(up).toHaveAttribute("data-phase", "uploading");
	await up.getByTestId(MEDIA_TESTID.uploadCancel).click();
	await expect(up).toHaveCount(0);
	await page.unroute(`${S3}/**`);
	await expect.poll(async () => (await listMedia(page, c.tripId)).filter((m) => m.kind === "pdf").length).toBe(0);

	// Storage down: a clear message and Retry; no row.
	await page.route(`${S3}/**`, (r) => r.abort("connectionrefused"));
	await page.getByTestId(MEDIA_TESTID.fileInput).setInputFiles({ name: "booking.pdf", mimeType: "application/pdf", buffer: pdf });
	await expect(up).toHaveAttribute("data-phase", "failed");
	await expect(up).toContainText("The upload stopped — check your connection and retry.");
	await page.screenshot({ path: shotPath("media/upload-failed-1440.png"), animations: "disabled" });
	await expect.poll(async () => (await listMedia(page, c.tripId)).filter((m) => m.kind === "pdf").length).toBe(0);
	await page.unroute(`${S3}/**`);
	await up.getByTestId(MEDIA_TESTID.uploadRetry).click();
	await expect(page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=pdf]`)).toHaveAttribute("data-status", "ready", {
		timeout: 30_000,
	});
	await expect(up).toHaveCount(0);
});

/** A 2-second WebM recorded from an animated canvas in the page (no fixture file). */
async function webmFromPage(page: Page): Promise<Buffer> {
	const b64 = await page.evaluate(async () => {
		const c = document.createElement("canvas");
		c.width = 480;
		c.height = 270;
		const g = c.getContext("2d") as CanvasRenderingContext2D;
		const stream = c.captureStream(24);
		const rec = new MediaRecorder(stream, { mimeType: "video/webm" });
		const parts: Blob[] = [];
		rec.ondataavailable = (e) => parts.push(e.data);
		let t = 0;
		const draw = () => {
			g.fillStyle = `hsl(${(t * 3) % 360} 60% 50%)`;
			g.fillRect(0, 0, 480, 270);
			g.fillStyle = "#fff";
			g.fillRect((t * 6) % 480, 110, 60, 50);
			t += 1;
		};
		const timer = setInterval(draw, 40);
		rec.start(200);
		await new Promise((r) => setTimeout(r, 2000));
		rec.stop();
		await new Promise((r) => (rec.onstop = r));
		clearInterval(timer);
		const bytes = new Uint8Array(await new Blob(parts, { type: "video/webm" }).arrayBuffer());
		let s = "";
		for (const x of bytes) s += String.fromCharCode(x);
		return btoa(s);
	});
	return Buffer.from(b64, "base64");
}

test("a video on a transit leg gets a poster and plays (MED-02)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	test.setTimeout(90_000);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?sel=l.${c.ids.items.itoya}.${c.ids.items.dropBags}`);
	await expectLive(page);
	const video = await webmFromPage(page);
	const inspector = page.getByTestId(TESTID.inspector);
	await inspector.getByRole("tab", { name: "Media" }).click();
	await inspector.getByTestId(MEDIA_TESTID.fileInput).setInputFiles({
		name: "fuji-excursion-window.webm",
		mimeType: "video/webm",
		buffer: video,
	});
	const tile = inspector.locator(`[data-testid=${TESTID.galleryItem}][data-kind=video]`);
	await expect(tile).toHaveAttribute("data-status", "ready", { timeout: 40_000 });
	await expect
		.poll(async () => tile.locator("img").evaluate((i: HTMLImageElement) => i.naturalWidth).catch(() => 0), {
			timeout: 15_000,
		})
		.toBeGreaterThan(0);
	await tile.getByRole("button").first().click();
	const player = page.locator(".yonder-lightbox video");
	await expect(player).toBeVisible();
	await expect
		.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 })
		.toBeGreaterThanOrEqual(1);
	await page.keyboard.press("Escape");
	await expect(page.locator(".yonder-lightbox")).toBeHidden();
	// The selection survived the Escape (the lightbox owns it).
	await expect(page).toHaveURL(/sel=l\./);
});

test("small PDFs of the last trip open offline (ADDENDUM §9)", async ({ page, context }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	test.setTimeout(90_000);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=media`);
	await expectLive(page);
	await page.getByTestId(MEDIA_TESTID.fileInput).setInputFiles({
		name: "Ghibli Museum tickets.pdf",
		mimeType: "application/pdf",
		buffer: makePdf(["Ghibli Museum", "Entry 10:00"]),
	});
	const pdfTile = page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=pdf]`);
	await expect(pdfTile).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
	const id = await pdfTile.getAttribute("data-id");
	// The sync keeps the rendered pages in this trip's document cache.
	await expect
		.poll(
			() =>
				page.evaluate(async (tripId) => {
					const cache = await caches.open(`yonder-docs-${tripId}`);
					return (await cache.keys()).map((r) => new URL(r.url).pathname).sort();
				}, c.tripId),
			{ timeout: 20_000 },
		)
		.toEqual([`/media/${id}/page-1`, `/media/${id}/page-2`, `/media/${id}/thumb`]);
	await context.setOffline(true);
	await pdfTile.getByRole("button").first().click();
	const viewer = page.getByTestId(MEDIA_TESTID.pdfViewer);
	await expect(viewer.getByTestId(MEDIA_TESTID.pdfPage)).toHaveCount(2);
	await expect
		.poll(() =>
			viewer
				.getByRole("img", { name: /Page 2 of/ })
				.evaluate((i: HTMLImageElement) => (i.complete ? i.naturalWidth : 0))
				.catch(() => 0),
		)
		.toBeGreaterThan(100);
	await expect(viewer.getByTestId(MEDIA_TESTID.pdfDownload)).toBeDisabled();
	await clearToasts(page);
	await page.screenshot({ path: shotPath("media/pdf-offline-1440.png"), animations: "disabled" });
	await context.setOffline(false);
});

/** A 320 × 240 red HEIC (made with libheif's heif-enc), 477 bytes. */
const HEIC_B64 =
	"AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAVNtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAAImlsb2MAAAAAREAAAQABAAAAAAF3AAEAAAAAAAAAZgAAACNpaW5mAAAAAAABAAAAFWluZmUCAAAAAAEAAGh2YzEAAAAA02lwcnAAAAC0aXBjbwAAAHVodmNDAQNwAAAAAAAAAAAAPPAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAPLoCQGEAAQAoQgEBA3AAAAMAkAAAAwAAAwA8oAoIDxZbqSSmubAgAAADAyAAAAMAIWIAAQAHRAHBcrBiQAAAABNjb2xybmNseAABAA0ABoAAAAAUaXNwZQAAAAAAAAFAAAAA8AAAABBwaXhpAAAAAAMICAgAAAAXaXBtYQAAAAAAAAABAAEEgQIDBAAAAG5tZGF0AAAAYigBrwnIaI8+ITl1X//7O////Qc3Ifq/unQcw8u401nh+vczF3QAAFkAASOi9zMXdAAAZAAA5wALwANikwAA/wAMIAAAAwAAAwDlgIcAAAMAAAMAAAMAAAMAAAMAAAMAAA94";

test("a HEIC photo becomes a JPEG, or is refused with a message (MED-06)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	test.setTimeout(60_000);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=media`);
	await expectLive(page);
	await page.getByTestId(MEDIA_TESTID.fileInput).setInputFiles({
		name: "pagoda-portrait.heic",
		mimeType: "image/heic",
		buffer: Buffer.from(HEIC_B64, "base64"),
	});
	const photo = page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=photo]`);
	const refused = page.getByText("Couldn't convert this HEIC photo — export it as JPEG and try again").first();
	await expect(photo.or(refused)).toBeVisible({ timeout: 30_000 });
	const converted = (await photo.count()) > 0;
	info.annotations.push({ type: "heic", description: converted ? "converted to JPEG" : "refused with the message" });
	if (converted) {
		await expect(photo).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
		const media = await listMedia(page, c.tripId);
		expect(media.some((m) => m.kind === "photo")).toBe(true);
	}
});

test("phone layout: the Media tab and the PDF viewer at 390 × 844", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "the viewport is set here");
	test.setTimeout(90_000);
	const ctx = await browser.newContext({
		...devices["iPhone 13"],
		defaultBrowserType: undefined,
		storageState: storageStateOf("dev"),
	} as Parameters<typeof browser.newContext>[0]);
	const page = await ctx.newPage();
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=media`);
	await expect(page.getByTestId(TESTID.workspace)).toBeVisible({ timeout: 20_000 });
	// Pull the sheet up from its peek to the top snap.
	const sheet = page.getByTestId(TESTID.mobileSheet);
	const box = await sheet.boundingBox();
	if (!box) throw new Error("no sheet");
	await page.mouse.move(195, box.y + 12);
	await page.mouse.down();
	await page.mouse.move(195, box.y - 250, { steps: 8 });
	await page.mouse.move(195, 60, { steps: 8 });
	await page.mouse.up();
	await expect(sheet.getByTestId(TESTID.mediaTab)).toBeVisible();
	await expect(sheet.getByTestId(TESTID.centerTabs).locator("xpath=..")).not.toHaveAttribute("aria-hidden", "true");
	await page.getByTestId(MEDIA_TESTID.fileInput).first().setInputFiles({
		name: "Suica guide.pdf",
		mimeType: "application/pdf",
		buffer: makePdf(["Suica guide", "Top-ups", "Refunds"]),
	});
	const pdfTile = page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=pdf]`);
	await expect(pdfTile).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
	await expectNoHorizontalOverflow(page);
	await clearToasts(page);
	await page.screenshot({ path: shotPath("media/tab-tokyo-390.png"), animations: "disabled" });
	await pdfTile.getByRole("button").first().click();
	const viewer = page.getByTestId(MEDIA_TESTID.pdfViewer);
	await expect(viewer.getByTestId(MEDIA_TESTID.pdfPage)).toHaveCount(3);
	await expect(viewer.getByRole("img", { name: /Page 1 of/ })).toBeVisible();
	await page.waitForTimeout(300);
	await clearToasts(page);
	await page.screenshot({ path: shotPath("media/pdf-viewer-390.png"), animations: "disabled" });
	await ctx.close();
});
