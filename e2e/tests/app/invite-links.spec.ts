/**
 * Invite links (owner, 2026-10-09): the owner makes one in Invite ("joins as
 * Can edit" by default), a friend opens it, signs in and lands in the trip as
 * a member; the ✕ deletes it and it stops working. The trip's own link only
 * lets guests look (they join through "Join the trip").
 */
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

test("an invite link joins a friend as a member; its ✕ stops it working", async ({ browser, page, request }, info) => {
	test.skip(info.project.name !== "chromium", "desktop");
	test.setTimeout(120_000);
	const c = await cloneFixtureTrip(request);
	const log = collectConsole(page, [/status of 404/]);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	await page.getByTestId(TESTID.shareButton).click();
	const dialog = page.getByTestId(TESTID.shareDialog);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId(HOME_TESTID.inviteLinkRole)).toContainText("Can edit");
	await dialog.getByTestId(HOME_TESTID.inviteLinkNew).click();
	const row = dialog.getByTestId(HOME_TESTID.inviteLink);
	await expect(row).toHaveCount(1, { timeout: 15_000 });
	await expect(row).toHaveAttribute("data-role", "editor");
	const url = (await row.locator(".font-mono").textContent()) ?? "";
	expect(url).toMatch(/\/join\/[A-Za-z0-9_-]{22}$/);
	await page.screenshot({ path: shotPath("invite-links/01-made.png"), animations: "disabled" });

	// A friend opens it signed in: a member who can edit, in the trip.
	const friend = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(friend.request, `inv-${randomBytes(3).toString("hex")}@example.com`, {
		first: "Ines",
		last: "Friend",
	});
	const fp = await friend.newPage();
	await fp.goto(new URL(url).pathname);
	await expect(fp).toHaveURL(new RegExp(`/t/${c.slug}`), { timeout: 20_000 });
	await expectLive(fp);
	await expect
		.poll(() =>
			fp.evaluate(() => {
				const w = window as unknown as { __yonder?: { graph?: { me: { role: string; isGuest: boolean } } } };
				return w.__yonder?.graph?.me ?? null;
			}),
		)
		.toMatchObject({ role: "editor", isGuest: false });
	await expect(row).toContainText("opened 1×", { timeout: 15_000 });

	// The ✕: it stops working; Ines stays on the trip.
	await row.getByTestId(HOME_TESTID.inviteLinkDelete).click();
	await expect(dialog.getByTestId(HOME_TESTID.inviteLink)).toHaveCount(0);
	const late = await browser.newContext();
	await loginViaApi(late.request, `late-${randomBytes(3).toString("hex")}@example.com`, {
		first: "Lee",
		last: "Late",
	});
	const lp = await late.newPage();
	await lp.goto(new URL(url).pathname);
	await expect(lp.getByTestId("join-invalid")).toContainText("This invite link doesn't work any more", {
		timeout: 20_000,
	});
	await lp.screenshot({ path: shotPath("invite-links/02-deleted.png"), animations: "disabled" });
	await friend.close();
	await late.close();
	expect(log.messages).toEqual([]);
});
