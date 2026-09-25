/** I2 verifier "home": AUTH-14 (email sending fails) against a server with a dead SMTP host. */
import { expect, test } from "@playwright/test";
import { hydrated } from "./_helpers/page";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
});

test.beforeEach(({}, info) => {
	test.skip(process.env.QA_SMTP_FAIL !== "1", "needs a server with a dead SMTP host (QA_SMTP_FAIL=1)");
});


test("AUTH-14: a failed send says so, never 'Code sent'", async ({ page }) => {
	await page.goto("/login");
	await (await hydrated(page.getByTestId("login-email"))).fill(`qa-home-a14-${Date.now()}@asia2027.test`);
	await page.getByTestId("login-submit").click();
	await page.waitForTimeout(4000);
	const body = await page.locator("body").innerText();
	console.log("AUTH-14 page:", body.slice(0, 300).replace(/\n/g, " | "));
	await page.screenshot({ path: `${process.env.QA_SHOTS}/auth-14-smtp-fail.png` });
	await expect(page.getByTestId("auth-error")).toContainText(/couldn't send/i);
	await expect(page.getByTestId("otp-input")).toHaveCount(0);
});
