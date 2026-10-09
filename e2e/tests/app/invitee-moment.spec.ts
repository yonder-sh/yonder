/**
 * The invitee's first look (walkthrough, 2026-10-09): someone added by email
 * sees "New" on their dashboard card ("by <owner>") and "… added you to …"
 * in the inbox; a rater who joined by link only gets their own ratings as
 * "Next for you".
 */
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { OVERVIEW_TESTID } from "../../../src/features/overview/testids";
import { SHELL_TESTID } from "../../../src/features/shell/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { APP_URL, shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

test("an invitee sees the trip as new, the inbox says who added them, a rater only rates", async ({
	browser,
	page,
	request,
}, info) => {
	test.skip(info.project.name !== "chromium", "desktop");
	test.setTimeout(150_000);
	const c = await cloneFixtureTrip(request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const email = `ines-${randomBytes(3).toString("hex")}@example.test`;
	const joinPath = await page.evaluate(
		async ({ tripId, email }) => {
			const m = await import("/src/features/home/sharing.functions.ts");
			await m.inviteMember({ data: { tripId, email, role: "editor" } });
			const link = await m.createInviteLink({ data: { tripId, role: "rater" } });
			return new URL(link.url).pathname;
		},
		{ tripId: c.tripId, email },
	);

	// Ines, invited by email: New on the dashboard, "added you" in the inbox.
	const ictx = await browser.newContext({
		baseURL: APP_URL,
		storageState: { cookies: [], origins: [] },
		viewport: { width: 1440, height: 900 },
	});
	await loginViaApi(ictx.request, email, { first: "Ines", last: "Friend" });
	const ip = await ictx.newPage();
	await ip.goto("/dashboard");
	await expect(ip.getByTestId(HOME_TESTID.tripCardNew).first()).toHaveText("New", {
		timeout: 20_000,
	});
	await ip.screenshot({ path: shotPath("invitee/01-dashboard-new.png"), animations: "disabled" });
	// The bell answers once the page is ready.
	await expect(async () => {
		await ip.getByTestId(TESTID.inboxBell).click();
		await expect(ip.getByTestId(SHELL_TESTID.inboxPanel)).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 20_000 });
	const row = ip.getByTestId(SHELL_TESTID.inboxRow).filter({ hasText: "added you to" });
	await expect(row).toHaveCount(1, { timeout: 15_000 });
	await expect(row).toContainText("You can edit");
	await ip.screenshot({ path: shotPath("invitee/02-inbox.png"), animations: "disabled" });

	// Rafa, through a "Can rate" invite link: only his own ratings.
	const rctx = await browser.newContext({
		baseURL: APP_URL,
		storageState: { cookies: [], origins: [] },
		viewport: { width: 1440, height: 900 },
	});
	await loginViaApi(rctx.request, `rafa-${randomBytes(3).toString("hex")}@example.test`, {
		first: "Rafa",
		last: "Rater",
	});
	const rp = await rctx.newPage();
	await rp.goto(joinPath);
	await expect(rp).toHaveURL(new RegExp(`/t/${c.slug}`), { timeout: 20_000 });
	await expectLive(rp);
	await rp.goto(`/t/${c.slug}?tab=overview`);
	await expectLive(rp);
	const next = rp.getByTestId(OVERVIEW_TESTID.next);
	if (await next.count()) {
		await expect(next).not.toContainText("After that");
		await expect(next).toContainText(/Rate the \d+ places? you haven't yet|You're all caught up/);
	}
	await expect(rp.getByTestId(OVERVIEW_TESTID.wholeTrip)).toHaveCount(0);
	await rp.screenshot({ path: shotPath("invitee/03-rater-overview.png"), animations: "disabled" });
	await ictx.close();
	await rctx.close();
});
