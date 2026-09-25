/** I2 "content" verifier: the guest editor's review drawer (hidden-PDF suggestion leak, UI). */
import path from "node:path";
import { expect, test } from "@playwright/test";
import { expectLive } from "./_helpers/page";
import { openLink } from "./_helpers/link";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const SHOTS = process.env.QA_SHOTS ?? "/tmp";
test("guest-e review drawer", async ({ browser }) => {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await openLink(page, "asia-2027", "editor");
	await expect(page).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
	await expectLive(page);
	await page.getByRole("button", { name: /^\d+$|suggestions? to review|Review/ }).first().click().catch(async () => {
		await page.getByText("4", { exact: true }).first().click();
	});
	await page.waitForTimeout(1500);
	await page.screenshot({ path: path.join(SHOTS, "23-guest-e-review-drawer.png") });
	const body = await page.locator("body").innerText();
	console.log("drawer shows NH 9.pdf:", /NH 9\.pdf/.test(body), "SECRETREF:", /SECRETREF/.test(body), "ZK4P7Q:", /ZK4P7Q/.test(body));
	await ctx.close();
});
