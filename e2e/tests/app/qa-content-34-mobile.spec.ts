/**
 * I2 "content" verifier, round 2: lists, notes, media and the PDF viewer on a
 * phone (Pixel 7), looked at by eye.
 */
import path from "node:path";
import { devices, expect, type Page, test } from "@playwright/test";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { MEDIA_TESTID as MT } from "../../../src/features/media/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";
import { ensureQaPdfs } from "./_helpers/qa-pdfs";

test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");
const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
const { defaultBrowserType: _d, ...pixel } = devices["Pixel 7"];
test.use({ ...pixel, storageState: path.join(AUTH, "dennis.json") });

// The PDF the phone opens (qa-content-17 uploads the same ones).
test.beforeAll(async ({ browser }) => {
	const ctx = await browser.newContext({ ...pixel, storageState: path.join(AUTH, "dennis.json") });
	const page = await ctx.newPage();
	await page.goto("/t/asia-2027?tab=plan");
	await expectLive(page);
	await ensureQaPdfs(page);
	await ctx.close();
});

async function pullSheet(page: Page) {
	const sheet = page.getByTestId(TESTID.mobileSheet);
	const box = await sheet.boundingBox();
	if (!box) throw new Error("no sheet");
	await page.mouse.move(195, box.y + 12);
	await page.mouse.down();
	await page.mouse.move(195, box.y - 250, { steps: 8 });
	await page.mouse.move(195, 60, { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(800);
}

test("phone: lists main view, row checkbox hit area, add row", async ({ page }) => {
	await page.goto("/t/asia-2027?tab=lists&list=todo");
	await expectLive(page);
	await page.waitForTimeout(1500);
	await pullSheet(page);
	await shot(page, "34-m-lists-todo");
	const box = await page.getByTestId(L.rowCheck).first().boundingBox();
	console.log("row check box", JSON.stringify(box));
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	console.log("horizontal overflow px", overflow);
	await page.goto("/t/asia-2027/japan/tokyo/asakusa?tab=lists&list=shopping");
	await expectLive(page);
	await page.waitForTimeout(1200);
	await pullSheet(page);
	await shot(page, "34-m-lists-shopping");
	expect(overflow).toBeLessThanOrEqual(0);
});

test("phone: media gallery, a PDF in the viewer", async ({ page }) => {
	await page.goto("/t/asia-2027/japan/tokyo?tab=media&mf=documents");
	await expectLive(page);
	await page.waitForTimeout(1500);
	await pullSheet(page);
	await shot(page, "34-m-media-docs");
	const tile = page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=pdf]`).first();
	await expect(tile).toBeVisible({ timeout: 15_000 });
	await tile.getByRole("button").first().click();
	const v = page.getByTestId(MT.pdfViewer);
	await expect(v).toBeVisible();
	await expect(v.getByTestId(MT.pdfPage).first()).toBeVisible({ timeout: 15_000 });
	await page.waitForTimeout(1000);
	await shot(page, "34-m-pdf-viewer");
	const vb = await v.boundingBox();
	console.log("viewer box", JSON.stringify(vb), "viewport", JSON.stringify(page.viewportSize()));
});

test("phone: notes on Golden Gai", async ({ page }) => {
	await page.goto("/t/asia-2027/japan/tokyo/shinjuku/golden-gai?tab=notes");
	await expectLive(page);
	await page.waitForTimeout(1500);
	await pullSheet(page);
	await shot(page, "34-m-notes");
});
