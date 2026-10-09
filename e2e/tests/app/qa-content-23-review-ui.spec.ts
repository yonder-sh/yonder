/** I2 "content" verifier: an edit-link guest gets no review drawer (hidden-PDF suggestion leak, UI). */
import path from "node:path";
import { expect, test } from "@playwright/test";
import { expectLive } from "./_helpers/page";
import { openLink } from "./_helpers/link";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const SHOTS = process.env.QA_SHOTS ?? "/tmp";
test("guest-e: no review drawer, nothing of the suggestions leaks", async ({ browser }) => {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await openLink(page, "asia-2027", "editor");
	await expect(page).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
	await expectLive(page);
	// Link guests only view (owner, 2026-10-09): no proposals, so nothing to review.
	await page.waitForTimeout(1500);
	await expect(page.getByRole("button", { name: /suggestions? to review|^Review/ })).toHaveCount(0);
	await page.screenshot({ path: path.join(SHOTS, "23-guest-e-no-review.png") });
	const body = await page.locator("body").innerText();
	expect(body).not.toMatch(/NH 9\.pdf|SECRETREF|ZK4P7Q/);
	await ctx.close();
});
