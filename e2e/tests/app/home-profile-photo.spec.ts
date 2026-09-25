/**
 * Owner feedback FB-16 (WP-Home Profile UI): upload a profile picture, place
 * it with the CIRCULAR crop (round mask, drag + zoom), save it (the square
 * bounding the circle, resized server-side and served through
 * `/api/avatar/…`), see it round in the Profile dialog and the top bar, then
 * remove it (initials again). Its own account, so no other spec's picture
 * interferes.
 */
import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { APP_URL, shotPath } from "./_helpers/env";
import { collectConsole } from "./_helpers/page";

/** A 900×600 PNG drawn in the page: a sky, a hill and a "face" left of centre. */
async function samplePhoto(page: Page): Promise<Buffer> {
	const b64 = await page.evaluate(() => {
		const c = document.createElement("canvas");
		c.width = 900;
		c.height = 600;
		const g = c.getContext("2d") as CanvasRenderingContext2D;
		const sky = g.createLinearGradient(0, 0, 0, 600);
		sky.addColorStop(0, "#9cc3e6");
		sky.addColorStop(1, "#f3d9b1");
		g.fillStyle = sky;
		g.fillRect(0, 0, 900, 600);
		g.fillStyle = "#6f8f5a";
		g.beginPath();
		g.ellipse(450, 640, 620, 220, 0, 0, Math.PI * 2);
		g.fill();
		g.fillStyle = "#e0b48f";
		g.beginPath();
		g.arc(330, 260, 110, 0, Math.PI * 2);
		g.fill();
		g.fillStyle = "#3b2a22";
		g.beginPath();
		g.arc(330, 215, 112, Math.PI, Math.PI * 2);
		g.fill();
		g.fillStyle = "#2a2a2a";
		for (const x of [292, 368]) {
			g.beginPath();
			g.arc(x, 262, 9, 0, Math.PI * 2);
			g.fill();
		}
		return c.toDataURL("image/png").split(",")[1] ?? "";
	});
	return Buffer.from(b64, "base64");
}

test("FB-16: upload a photo with the circular crop, see it round everywhere, remove it", async ({
	browser,
}, info) => {
	const mobile = info.project.name === "mobile";
	const ctx = await browser.newContext({
		baseURL: APP_URL,
		storageState: { cookies: [], origins: [] },
		...(mobile
			? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
			: { viewport: { width: 1280, height: 860 } }),
	});
	await loginViaApi(
		ctx.request,
		`photo-${randomBytes(4).toString("hex")}@example.com`,
		{ first: "Nora", last: "Photo" },
	);
	const page = await ctx.newPage();
	// The spec itself reads the crop stage's pixels twice (Chrome's hint).
	const log = collectConsole(page, [/willReadFrequently/]);
	await page.goto("/dashboard");
	await expect(page.getByTestId(TESTID.dashboard)).toBeVisible();
	await expect(page.getByRole("heading", { level: 1 })).toContainText(
		/^Good /,
		{ timeout: 30_000 },
	);
	await page.getByTestId(TESTID.accountMenu).click();
	await page.getByRole("menuitem", { name: "Profile" }).click();
	const dialog = page.getByTestId(TESTID.profileDialog);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId(HOME_TESTID.avatarEdit)).toHaveText(
		/Upload a photo/,
	);
	await expect(dialog.getByTestId(HOME_TESTID.avatarRemove)).toHaveCount(0);

	// Pick a photo: the crop opens with a round mask.
	await dialog.getByTestId(HOME_TESTID.avatarFile).setInputFiles({
		name: "me.png",
		mimeType: "image/png",
		buffer: await samplePhoto(page),
	});
	const cropper = dialog.getByTestId(HOME_TESTID.avatarCropper);
	await expect(cropper).toBeVisible();
	const stage = cropper.getByRole("img", { name: /^Photo crop/ });
	await expect(stage).toBeVisible();
	// The round preview of the avatar-to-be sits under the stage.
	const preview = cropper.locator("canvas[data-avatar-preview]");
	await expect(preview).toBeVisible();
	expect(
		await preview.evaluate(
			(el) =>
				Number.parseFloat(getComputedStyle(el).borderRadius) >=
				el.getBoundingClientRect().width / 2,
		),
	).toBe(true);
	// The crop has the dialog to itself (no second "Save" to confuse), and
	// the dialog fits the screen: its title isn't pushed off the top.
	await expect(dialog.getByTestId(HOME_TESTID.profileFirst)).toBeHidden();
	await expect(dialog.getByTestId(HOME_TESTID.profileSave)).toBeHidden();
	const title = await dialog
		.getByRole("heading", { name: "Profile" })
		.boundingBox();
	expect(title?.y ?? -1).toBeGreaterThanOrEqual(0);
	// The corner of the stage is dimmed (outside the circle); the middle isn't.
	const pixel = (x: number, y: number) =>
		stage.evaluate(
			(c: HTMLCanvasElement, [px, py]) => {
				const k = c.width / c.getBoundingClientRect().width;
				const d = (c.getContext("2d") as CanvasRenderingContext2D).getImageData(
					Math.round(px * k),
					Math.round(py * k),
					1,
					1,
				).data;
				return (d[0] ?? 0) + (d[1] ?? 0) + (d[2] ?? 0);
			},
			[x, y],
		);
	const corner = await pixel(6, 6);
	const centre = await pixel(128, 40);
	expect(corner).toBeLessThan(centre);

	// Drag the face into the circle, then zoom in with the slider's keys.
	const box = await stage.boundingBox();
	if (!box) throw new Error("no crop stage");
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	await page.mouse.move(cx, cy);
	await page.mouse.down();
	await page.mouse.move(cx + 40, cy + 10, { steps: 6 });
	await page.mouse.up();
	await cropper.getByRole("slider", { name: "Zoom" }).focus();
	for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
	await expect(cropper.getByRole("slider", { name: "Zoom" })).toHaveAttribute(
		"aria-valuenow",
		/^1\.[3-9]|^[2-4]/,
	);
	await page.waitForTimeout(200);
	await page.screenshot({
		path: shotPath(`home/avatar-crop-${mobile ? "mobile" : "desktop"}.png`),
		animations: "disabled",
	});

	// Save: the Profile avatar is the new picture, drawn round.
	await cropper.getByTestId(HOME_TESTID.avatarSave).click();
	await expect(page.getByText("Photo saved")).toBeVisible({ timeout: 20_000 });
	await expect(cropper).toHaveCount(0);
	await expect(dialog.getByTestId(HOME_TESTID.profileFirst)).toHaveValue(
		"Nora",
	);
	const avatar = dialog.locator("[data-avatar-image]").first();
	await expect(avatar).toBeVisible();
	const img = avatar.locator("img");
	await expect(img).toHaveAttribute("src", /^\/api\/avatar\/[^?]+\?v=\w+&s=\d+$/);
	await expect
		.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth))
		.toBeGreaterThan(0);
	// Round: the corner radius is at least half the size (Tailwind's `rounded-full`).
	const round = await avatar.evaluate(
		(el) =>
			Number.parseFloat(getComputedStyle(el).borderRadius) >=
			el.getBoundingClientRect().width / 2,
	);
	expect(round).toBe(true);
	// Served square (the square bounding the circle), resized on the server.
	const src = (await img.getAttribute("src")) ?? "";
	const served = await ctx.request.get(src);
	expect(served.status()).toBe(200);
	expect(served.headers()["content-type"]).toContain("image/webp");
	const size = await img.evaluate((i: HTMLImageElement) => [
		i.naturalWidth,
		i.naturalHeight,
	]);
	expect(size[0]).toBe(size[1]);
	await expect(dialog.getByTestId(HOME_TESTID.avatarEdit)).toHaveText(
		/Change photo/,
	);
	await page.screenshot({
		path: shotPath(`home/avatar-saved-${mobile ? "mobile" : "desktop"}.png`),
		animations: "disabled",
	});

	// The top bar's account avatar shows it too.
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByTestId(TESTID.accountMenu).locator("[data-avatar-image] img"),
	).toBeVisible();
	await page.screenshot({
		path: shotPath(`home/avatar-topbar-${mobile ? "mobile" : "desktop"}.png`),
		clip: { x: 0, y: 0, width: mobile ? 390 : 1280, height: 72 },
		animations: "disabled",
	});

	// Remove: initials in the presence colour again.
	await page.getByTestId(TESTID.accountMenu).click();
	await page.getByRole("menuitem", { name: "Profile" }).click();
	await dialog.getByTestId(HOME_TESTID.avatarRemove).click();
	await expect(page.getByText("Photo removed")).toBeVisible();
	await expect(dialog.locator("[data-avatar-image]")).toHaveCount(0);
	await expect(dialog.getByTestId(HOME_TESTID.avatarEdit)).toHaveText(
		/Upload a photo/,
	);
	await expect(dialog).toContainText("NP");
	expect(log.messages).toEqual([]);
	await ctx.close();
});
