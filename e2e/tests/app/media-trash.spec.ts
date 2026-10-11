/**
 * Trash (owner, 2026-10-11): a deleted photo waits in the account's Trash
 * (reached from the account menu) with its days left; Restore puts it back
 * in the trip's gallery; deleted again, Delete forever (after a confirm)
 * takes it for good.
 */
import { expect, type Page, test } from "@playwright/test";
import { MEDIA_TESTID } from "../../../src/features/media/testids";
import { TRASH_TESTID } from "../../../src/features/trash/testids";
import { TESTID } from "../../../src/lib/testids";
import { storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";
import { clearToasts } from "./media-helpers";

test.use({ storageState: storageStateOf("dev") });

/** A small real JPEG drawn in the page. */
async function jpeg(page: Page): Promise<Buffer> {
	const b64 = await page.evaluate(async () => {
		const c = document.createElement("canvas");
		c.width = 320;
		c.height = 240;
		const g = c.getContext("2d") as CanvasRenderingContext2D;
		g.fillStyle = "hsl(200 60% 55%)";
		g.fillRect(0, 0, 320, 240);
		const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), "image/jpeg", 0.85));
		let s = "";
		for (const x of new Uint8Array(await blob.arrayBuffer())) s += String.fromCharCode(x);
		return btoa(s);
	});
	return Buffer.from(b64, "base64");
}

const photos = (page: Page) => page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=photo]`);

async function deletePhoto(page: Page) {
	await photos(page).hover();
	await photos(page).getByTestId(MEDIA_TESTID.tileMenu).click();
	await page.getByRole("menu").getByRole("menuitem", { name: "Delete" }).click();
	await expect(photos(page)).toHaveCount(0);
	await clearToasts(page);
}

test("a deleted photo waits in Trash: Restore brings it back, Delete forever takes it", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	test.setTimeout(90_000);
	const c = await cloneFixtureTrip(page.request);
	const media = `/t/${c.slug}/japan/tokyo?tab=media`;
	await page.goto(media);
	await expectLive(page);
	await page.getByTestId(MEDIA_TESTID.fileInput).setInputFiles({
		name: "trash-me.jpg",
		mimeType: "image/jpeg",
		buffer: await jpeg(page),
	});
	await expect(photos(page)).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
	const id = await photos(page).getAttribute("data-id");
	await deletePhoto(page);

	// Trash, from the account menu: the photo with 30 days left.
	await page.goto("/dashboard");
	// The menu opens once the page has hydrated.
	await expect(async () => {
		await page.getByTestId(TESTID.accountMenu).click();
		await expect(page.getByTestId(TRASH_TESTID.entry)).toBeVisible({ timeout: 1_000 });
	}).toPass({ timeout: 15_000 });
	await page.getByTestId(TRASH_TESTID.entry).click();
	await expect(page).toHaveURL(/\/trash$/);
	const tile = page.locator(`[data-trash="a:${id}"]`);
	await expect(tile.getByTestId(TRASH_TESTID.daysLeft)).toHaveText("30d");
	await expect(page.getByTestId(TRASH_TESTID.note)).toContainText("count toward your storage");

	// Restore: back where it was.
	await tile.click();
	await expect(page.getByTestId(TRASH_TESTID.detail)).toContainText("Back where it was");
	await page.getByTestId(TRASH_TESTID.restore).click();
	await expect(page.getByText("Restored 1 item")).toBeVisible();
	await expect(tile).toHaveCount(0);
	await page.goto(media);
	await expectLive(page);
	await expect(photos(page)).toHaveCount(1);

	// Deleted again, then for good (after a confirm).
	await deletePhoto(page);
	await page.goto("/trash");
	await tile.click();
	await page.getByTestId(TRASH_TESTID.deleteForever).click();
	const confirm = page.getByTestId(TRASH_TESTID.confirm);
	await confirm.getByRole("button", { name: "Delete forever" }).click();
	await expect(page.getByText("Deleted 1 item for good")).toBeVisible();
	await expect(tile).toHaveCount(0);
});
