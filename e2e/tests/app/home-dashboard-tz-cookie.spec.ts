/**
 * DASH-03 follow-up: the dashboard's server render reads the viewer's zone
 * from the `yonder-tz` cookie. A malformed one (a truncated percent-escape, a
 * made-up zone) must fall back to the server's date, never answer 500 (the
 * cookie lives a year, so that visitor would get a 500 on every visit).
 */
import { expect, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { APP_URL, shotPath, storageStateOf } from "./_helpers/env";

test.use({ storageState: storageStateOf("dev") });

for (const value of ["%E0%A4%A", "Mars%2FOlympus_Mons", "%", "Asia%2FTokyo"]) {
	test(`the dashboard renders with yonder-tz=${value}`, async ({ page, context }, info) => {
		test.skip(info.project.name !== "chromium", "server render, once");
		const { hostname } = new URL(APP_URL);
		await context.addCookies([{ name: "yonder-tz", value, domain: hostname, path: "/" }]);
		const res = await page.goto("/");
		expect(res?.status(), "the server render").toBe(200);
		await expect(page.getByTestId(TESTID.dashboard)).toBeVisible();
		await expect(page.getByRole("heading", { level: 1 })).toContainText(/^Good /, { timeout: 30_000 });
		if (value === "%E0%A4%A")
			await page.screenshot({ path: shotPath("home/dashboard-bad-tz-cookie.png"), animations: "disabled" });
	});
}
