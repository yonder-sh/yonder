/**
 * Foundation check 4: a brand-new person through the real UI.
 * Visit the app → sign in with an email → read the code from the app's log →
 * verify → onboarding refuses a missing last name → dashboard → create a trip →
 * the trip workspace, live. Screenshots per project (desktop / mobile).
 *
 * Needs E2E_APP_LOG (the dev server's output file); the code is read from its
 * `[auth] OTP … code=NNNNNN` line.
 */
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { shotPath } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { logOffset, readOtpFromLog } from "./_helpers/otp";
import { collectConsole, expectLive, hydrated } from "./_helpers/page";

test("sign in, onboarding, dashboard, new trip, workspace", async ({ page }, info) => {
	const email = `e2e-${info.project.name}-${randomBytes(4).toString("hex")}@example.com`;
	const logs = collectConsole(page);

	await page.goto("/");
	await expect(page).toHaveURL(/\/login/);
	await (await hydrated(page.getByTestId("login-email"))).fill(email);
	const since = logOffset();
	await page.getByTestId("login-submit").click();
	await expect(page.getByTestId("otp-input")).toBeVisible();
	await page.screenshot({ path: shotPath(`foundation/01-code-${info.project.name}.png`), animations: "disabled" });

	const code = await readOtpFromLog(email, since);
	await page.getByTestId("otp-input").click();
	await page.keyboard.type(code);

	// A new account must give both names before anything else.
	await expect(page).toHaveURL(/\/welcome/);
	await (await hydrated(page.getByTestId("welcome-first-name"))).fill("Ada");
	await page.getByTestId("welcome-submit").click();
	await expect(page).toHaveURL(/\/welcome/);
	await expect(page.locator("[aria-invalid=true]")).toBeVisible();
	await page.goto("/"); // the guard sends a nameless account back
	await expect(page).toHaveURL(/\/welcome/);
	await (await hydrated(page.getByTestId("welcome-first-name"))).fill("Ada");
	await page.getByTestId("welcome-last-name").fill("Lovelace");
	await page.getByTestId("welcome-submit").click();

	await expect(page.getByTestId(TESTID.dashboard)).toBeVisible();
	await page.screenshot({ path: shotPath(`foundation/02-dashboard-${info.project.name}.png`), animations: "disabled" });

	await (await hydrated(page.getByTestId(TESTID.newTripButton))).click();
	await expect(page.getByTestId(TESTID.newTripDialog)).toBeVisible();
	const tripName = `Lisbon ${randomBytes(2).toString("hex")}`;
	await page.getByTestId(TESTID.newTripName).fill(tripName);
	await page.getByTestId(TESTID.newTripSubmit).click();

	await expect(page).toHaveURL(/\/t\/lisbon-/);
	await expect(page.getByTestId(TESTID.workspace)).toBeVisible();
	await expectLive(page);
	// A new trip opens the "Where to first?" palette; close it.
	const palette = page.getByTestId(TESTID.addPlaceDialog);
	await expect(palette).toBeVisible();
	await expect(palette).toContainText("Where to first?");
	await page.keyboard.press("Escape");
	await expect(palette).toBeHidden();
	await page.screenshot({ path: shotPath(`foundation/03-workspace-${info.project.name}.png`), animations: "disabled" });

	// The same person's copy of the demo trip: a populated workspace.
	const demo = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${demo.slug}?tab=plan`);
	await expectLive(page);
	await expect(page.getByText("Hands Shibuya").first()).toBeVisible();
	// The map mounts lazily: wait for it before the screenshot.
	await expect(page.getByTestId(TESTID.tripMap)).toBeVisible({ timeout: 15_000 });
	await page.screenshot({ path: shotPath(`foundation/04-demo-${info.project.name}.png`), animations: "disabled" });
	expect(logs.messages).toEqual([]);
});
