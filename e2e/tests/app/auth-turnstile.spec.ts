/**
 * Cloudflare Turnstile on the sign-in email step, with Cloudflare's test
 * keys. Runs only when the app (and this harness) has TURNSTILE_SITE_KEY and
 * TURNSTILE_SECRET_KEY; with the always-pass secret (1x…) the code goes out
 * and sign-in finishes, with the always-fail secret (2x…) the form says the
 * check didn't pass. The widget follows the app's theme; the CSP allows
 * challenges.cloudflare.com only while Turnstile is on.
 *
 *   TURNSTILE_SITE_KEY=1x00000000000000000000AA TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
 *   TURNSTILE_SITE_KEY=1x00000000000000000000AA TURNSTILE_SECRET_KEY=2x0000000000000000000000000000000AA
 */
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { APP_URL } from "./_helpers/env";
import { logOffset, readOtp } from "./_helpers/otp";
import { hydrated } from "./_helpers/page";

const on = !!process.env.TURNSTILE_SITE_KEY && !!process.env.TURNSTILE_SECRET_KEY;
const passes = process.env.TURNSTILE_SECRET_KEY?.startsWith("1x") ?? false;

test.skip(!on, "Turnstile is off: start the app with the test keys (see the file comment)");

for (const scheme of ["light", "dark"] as const)
	test(`the widget sits on the email step in the ${scheme} theme; the code goes out only with a passing token`, async ({ browser }, info) => {
		test.skip(info.project.name !== "chromium", "one desktop run");
		test.setTimeout(90_000);
		const ctx = await browser.newContext({ baseURL: APP_URL, colorScheme: scheme });
		const page = await ctx.newPage();
		const res = await page.goto("/login");
		const csp = res?.headers()["content-security-policy"] ?? "";
		expect(csp).toMatch(/script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
		expect(csp).toMatch(/frame-src [^;]*https:\/\/challenges\.cloudflare\.com/);

		// The widget's iframe lives in a closed shadow root: find it among the frames.
		await expect(page.getByTestId("turnstile")).toBeVisible();
		await expect
			.poll(() => page.frames().find((f) => f.url().includes("challenges.cloudflare.com"))?.url() ?? "", {
				timeout: 30_000,
			})
			.toContain(`/${scheme}/`);

		const email = `turnstile-${scheme}-${randomBytes(3).toString("hex")}@example.test`;
		await (await hydrated(page.getByTestId("login-email"))).fill(email);
		const since = logOffset();
		await page.getByTestId("login-submit").click();
		if (!passes) {
			await expect(page.getByTestId("auth-error")).toHaveText("The security check didn't pass. Try again.");
			await expect(page.getByTestId("otp-input")).toHaveCount(0);
			await ctx.close();
			return;
		}
		await expect(page.getByTestId("otp-input")).toBeVisible();
		const code = await readOtp(email, { since });
		await page.getByTestId("otp-input").click();
		await page.keyboard.type(code);
		await expect(page).toHaveURL(/\/welcome/);
		await ctx.close();
	});

test("a send without a token is refused by the server", async ({ request }) => {
	const res = await request.post("/api/auth/email-otp/send-verification-otp", {
		data: { email: `raw-${randomBytes(3).toString("hex")}@example.test`, type: "sign-in" },
		headers: { Origin: APP_URL, "Content-Type": "application/json" },
	});
	expect(res.status()).toBe(400);
	expect(await res.json()).toMatchObject({ code: "MISSING_RESPONSE" });
});
