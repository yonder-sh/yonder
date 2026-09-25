/**
 * The circular crop on narrow phones (FB-16 follow-up). The stage was
 * `size-64 max-w-full`: below ~344 px the dialog is narrower than 256 px, so
 * only the width shrank and the square canvas was drawn into a 240 × 256 (at
 * 320 px) box: the circle became an oval and the photo was squashed. The
 * drag and wheel maths also took one scale from the width alone. Now the
 * stage is width-driven and square, and each axis is scaled on its own.
 * Checked at 320 and 280 px.
 */
import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { APP_URL, shotPath } from "./_helpers/env";
import { hydrated } from "./_helpers/page";

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

for (const width of [320, 280]) {
	test(`the crop stays a circle at ${width} px`, async ({ browser }, info) => {
		test.skip(info.project.name !== "mobile", "phone widths");
		const ctx = await browser.newContext({
			baseURL: APP_URL,
			storageState: { cookies: [], origins: [] },
			viewport: { width, height: 700 },
			isMobile: true,
			hasTouch: true,
			deviceScaleFactor: 2,
		});
		await loginViaApi(ctx.request, `crop-${randomBytes(4).toString("hex")}@example.com`, {
			first: "Nora",
			last: "Narrow",
		});
		const page = await ctx.newPage();
		await page.goto("/dashboard");
		await expect(page.getByTestId(TESTID.dashboard)).toBeVisible();
		// The menu opens once React has taken over the server-rendered page.
		await (await hydrated(page.getByTestId(TESTID.accountMenu))).click();
		await page.getByRole("menuitem", { name: "Profile" }).click();
		const dialog = page.getByTestId(TESTID.profileDialog);
		await expect(dialog).toBeVisible();
		await dialog.getByTestId(HOME_TESTID.avatarFile).setInputFiles({
			name: "me.png",
			mimeType: "image/png",
			buffer: await samplePhoto(page),
		});
		const cropper = dialog.getByTestId(HOME_TESTID.avatarCropper);
		const stage = cropper.getByRole("img", { name: /^Photo crop/ });
		await expect(stage).toBeVisible();
		await page.waitForTimeout(300); // the dialog's zoom-in
		const box = await stage.boundingBox();
		const d = await dialog.boundingBox();
		if (!box || !d) throw new Error("no stage");
		// Narrower than the 256 px stage, and square: a circle, not an oval.
		expect(box.width).toBeLessThan(256);
		expect(Math.abs(box.width - box.height), `stage ${box.width} × ${box.height}`).toBeLessThanOrEqual(1);
		// Inside the dialog, with its padding.
		expect(box.x).toBeGreaterThanOrEqual(d.x);
		expect(box.x + box.width).toBeLessThanOrEqual(d.x + d.width);
		// The round preview is square too (drawn round, not an ellipse).
		const preview = await cropper.locator("canvas[data-avatar-preview]").boundingBox();
		expect(Math.abs((preview?.width ?? 0) - (preview?.height ?? 1))).toBeLessThanOrEqual(0.5);
		// The ring is where a circle should be: the white ring's pixels sit at
		// the same distance from the centre horizontally and vertically.
		const ring = await stage.evaluate((c: HTMLCanvasElement) => {
			const g = c.getContext("2d") as CanvasRenderingContext2D;
			const { width: w, height: h } = c;
			const bright = (x: number, y: number) => {
				const p = g.getImageData(Math.round(x), Math.round(y), 1, 1).data;
				return (p[0] ?? 0) + (p[1] ?? 0) + (p[2] ?? 0) > 690;
			};
			// Walk out from the centre to the first near-white pixel on each axis.
			const out = (dx: number, dy: number) => {
				for (let r = w * 0.3; r < w / 2; r += 0.5)
					if (bright(w / 2 + dx * r, h / 2 + dy * r)) return r;
				return -1;
			};
			return { right: out(1, 0), down: out(0, 1), left: out(-1, 0), up: out(0, -1), w, h };
		});
		expect(ring.right).toBeGreaterThan(0);
		// Bitmap distances; on screen they're equal only if the box is square.
		const cssX = (ring.right * box.width) / ring.w;
		const cssY = (ring.down * box.height) / ring.h;
		expect(Math.abs(cssX - cssY), `ring radius ${cssX} × ${cssY} CSS px`).toBeLessThanOrEqual(1);
		await page.screenshot({ path: shotPath(`home/avatar-crop-${width}.png`), animations: "disabled" });

		// Drag and zoom still work, and the picture saves.
		const cx = box.x + box.width / 2;
		const cy = box.y + box.height / 2;
		await page.mouse.move(cx, cy);
		await page.mouse.down();
		await page.mouse.move(cx + 20, cy + 20, { steps: 5 });
		await page.mouse.up();
		await cropper.getByRole("slider", { name: "Zoom" }).focus();
		for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowRight");
		await page.screenshot({ path: shotPath(`home/avatar-crop-${width}-zoomed.png`), animations: "disabled" });
		await cropper.getByTestId(HOME_TESTID.avatarSave).click();
		await expect(page.getByText("Photo saved")).toBeVisible({ timeout: 20_000 });
		await ctx.close();
	});
}
