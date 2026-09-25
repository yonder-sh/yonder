/**
 * Storage quota (ADDENDUM §12): with a tiny override (set with the real
 * `set-quota` script), an upload that doesn't fit is refused BEFORE any
 * bytes go to storage, the toast says how much is needed and left, no tile
 * stays; the profile shows the usage with its bar.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { MEDIA_TESTID } from "../../../src/features/media/testids";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { APP_URL, REPO_ROOT } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

function setQuota(email: string, gb: string): string {
	return execFileSync(path.join(REPO_ROOT, "node_modules/.bin/tsx"), ["scripts/set-quota.ts", email, gb], {
		cwd: REPO_ROOT,
		env: process.env,
		encoding: "utf8",
	});
}

test("an upload over the quota is refused before any bytes go up; the profile shows the usage", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "one desktop run");
	test.setTimeout(90_000);
	const email = `quota-${randomBytes(4).toString("hex")}@example.test`;
	const ctx = await browser.newContext({ baseURL: APP_URL });
	await loginViaApi(ctx.request, email, { first: "Quinn", last: "Quota" });
	const c = await cloneFixtureTrip(ctx.request);
	// 0.0001 GB ≈ 105 KB for this account only (whatever the clone brought counts).
	const set = setQuota(email, "0.0001");
	const used = /: (.+) of 105 KB used \(override\)/.exec(set)?.[1];
	expect(used, set).toBeTruthy();

	const page = await ctx.newPage();
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=media`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.mediaTab)).toBeVisible();
	const puts: string[] = [];
	page.on("request", (r) => {
		if (r.method() === "PUT") puts.push(r.url());
	});
	// A 300 KB "photo" (a JPEG header is enough: the quota refuses it first).
	const jpeg = Buffer.alloc(300 * 1024, 0);
	jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0);
	await page.getByTestId(MEDIA_TESTID.fileInput).setInputFiles({ name: "big.jpg", mimeType: "image/jpeg", buffer: jpeg });
	await expect(
		page.getByText(
			new RegExp(
				`^This upload needs 300 KB but you have \\d+ (B|KB) left \\(${used} of 105 KB used\\)\\. Delete some uploads or ask the trip owner\\.$`,
			),
		),
	).toBeVisible();
	expect(puts).toEqual([]);
	await expect(page.getByTestId(MEDIA_TESTID.uploadTile)).toHaveCount(0);

	// The profile: "… of 105 KB used" and its bar.
	await page.getByTestId(TESTID.accountMenu).click();
	await page.getByRole("menuitem", { name: "Profile" }).click();
	const storage = page.getByTestId(HOME_TESTID.profileStorage);
	await expect(storage).toContainText(`${used} of 105 KB used`);
	await expect(storage.getByRole("progressbar")).toBeVisible();

	// Back to the default: the dashboard account has 5 GB again.
	expect(setQuota(email, "default")).toContain("of 5 GB used (the default, 5 GB)");
	await ctx.close();
});
