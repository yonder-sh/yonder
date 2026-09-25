/**
 * The Share dialog on phones (owner's report at 390 px: "Owner" and each
 * role Select dropped onto their own lines, the list read loose). From 380 px
 * a member is one line (avatar, name, role, ⋯); narrower phones keep the role
 * under the name so names stay readable. The link's role Select is flush with
 * the address row under it. Nothing scrolls sideways at 390 or 320 px.
 */
import { expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

async function openShare(page: Page) {
	await page.locator('button[aria-label="More"]').click();
	await page.getByRole("menuitem", { name: "Share" }).click();
	const dialog = page.getByTestId(TESTID.shareDialog);
	await expect(dialog).toBeVisible();
	await expect(page.getByTestId(HOME_TESTID.memberRow).first()).toBeVisible();
	return dialog;
}

for (const width of [390, 320]) {
	test(`Share at ${width} px: tidy member rows and link row`, async ({ page }, info) => {
		test.skip(info.project.name !== "mobile", "phone layout");
		await page.setViewportSize({ width, height: 844 });
		const c = await cloneFixtureTrip(page.request);
		await page.goto(`/t/${c.slug}?tab=plan`);
		await expectLive(page);
		const dialog = await openShare(page);
		const link = dialog.getByTestId(TESTID.shareLinkRow);
		if ((await link.getAttribute("data-enabled")) !== "true") {
			await dialog.getByTestId(TESTID.shareLinkSwitch).click();
			await expect(link).toHaveAttribute("data-enabled", "true");
		}
		await expect(dialog.getByTestId(TESTID.shareLinkUrl)).toBeVisible();
		await page.waitForTimeout(400);
		await page.screenshot({ path: shotPath(`home/share-phone-${width}.png`), animations: "disabled" });
		await link.scrollIntoViewIfNeeded();
		await page.screenshot({ path: shotPath(`home/share-phone-${width}-link.png`), animations: "disabled" });

		// Each member: the role sits on the name's line from 380 px, under it below.
		const rows = dialog.getByTestId(HOME_TESTID.memberRow);
		const n = await rows.count();
		expect(n).toBeGreaterThanOrEqual(2);
		for (let i = 0; i < n; i++) {
			const row = rows.nth(i);
			const name = await row.locator(".font-medium").first().boundingBox();
			const role = await row
				.locator(`[data-testid="${HOME_TESTID.memberRole}"], span:text-is("Owner")`)
				.first()
				.boundingBox();
			if (!name || !role) continue;
			const sameLine = role.y < name.y + name.height && role.y + role.height > name.y;
			expect(sameLine, `row ${i}: role on the name's line`).toBe(width >= 380);
			// The row never runs past the dialog.
			const box = await dialog.boundingBox();
			expect(role.x + role.width).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? width) + 0.5);
		}

		// The link's role Select is flush with the address row under it.
		const select = await dialog.getByTestId(HOME_TESTID.linkRole).boundingBox();
		const url = await dialog.getByTestId(TESTID.shareLinkUrl).boundingBox();
		expect(Math.abs((select?.x ?? 0) - (url?.x ?? 99))).toBeLessThanOrEqual(1);

		// No sideways scroll anywhere.
		const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
		expect(overflow).toBeLessThanOrEqual(0);
	});
}
