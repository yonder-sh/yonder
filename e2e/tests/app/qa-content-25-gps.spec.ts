/** I2 "content" verifier: can a view-link guest download a photo original with its EXIF GPS? */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { MEDIA_TESTID as MT } from "../../../src/features/media/testids";
import { TESTID } from "../../../src/lib/testids";
import { E2E_ROOT } from "./_helpers/env";
import { expectLive } from "./_helpers/page";
import { openLink } from "./_helpers/link";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
// The photo fixtures are committed (e2e/fixtures/make-photos.mjs regenerates them).
const FIX = path.join(E2E_ROOT, "fixtures");
test("guest-v original keeps GPS", async ({ browser }) => {
	const d = await browser.newContext({ storageState: path.join(AUTH, "dennis.json"), viewport: { width: 1440, height: 900 } });
	const dp = await d.newPage();
	await dp.goto("/t/asia-2027/japan/mt-fuji/fujiyoshida/chureito-pagoda?tab=media");
	await expectLive(dp);
	const before = await dp.getByTestId(TESTID.galleryItem).evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
	await dp.getByTestId(MT.fileInput).first().setInputFiles({ name: "chureito-sunrise.jpg", mimeType: "image/jpeg", buffer: readFileSync(path.join(FIX, "chureito-sunrise.jpg")) });
	await expect.poll(async () => (await dp.getByTestId(TESTID.galleryItem).count()), { timeout: 20_000 }).toBeGreaterThan(before.length);
	const after = await dp.getByTestId(TESTID.galleryItem).evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
	const id = after.find((x) => !before.includes(x));
	await expect(dp.locator(`[data-testid=${TESTID.galleryItem}][data-id="${id}"]`)).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
	const g = await browser.newContext();
	const gp = await g.newPage();
	await openLink(gp, "asia-2027", "viewer");
	await expect(gp).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
	const r = await gp.request.get(`/media/${id}/original`, { maxRedirects: 0 });
	console.log("guest original:", r.status(), (r.headers().location ?? "").slice(0, 60));
	const body = await (await gp.request.get(r.headers().location)).body();
	// GPS IFD pointer tag 0x8825 in either byte order.
	console.log("guest original has GPS IFD:", body.includes(Buffer.from([0x88, 0x25])) || body.includes(Buffer.from([0x25, 0x88])), "bytes", body.length);
	await d.close();
	await g.close();
});
