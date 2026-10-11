/**
 * Saved into trips, many at once, on a phone: Select ticks two Kyoto items,
 * Add to trip puts them in a trip I own ("In …", Undo takes them back out),
 * then "Plan a new trip" makes a trip named for them that opens on its
 * route with Kyoto on it.
 */
import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { SPLIT_TESTID } from "../../../src/features/plan/day-split/testids";
import { SAVED_TESTID as S } from "../../../src/features/saved/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectNoHorizontalOverflow } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

let n = 0;
const tiktok = () => `https://www.tiktok.com/@kyoto.eats/video/74${Date.now()}${n++}`;

/** Shares a link and files it under Kyoto. */
async function shareToKyoto(page: Page, text: string) {
	const url = tiktok();
	await page.goto(`/share?${new URLSearchParams({ url, text: `${text} ${url}` })}`);
	await expect(page).toHaveURL(/\/saved\?open=[0-9a-f-]{36}&from=share/, { timeout: 20_000 });
	const ask = page.getByTestId(S.whereAsk);
	await ask.getByTestId(S.whereSearch).fill("Kyoto");
	await ask.getByTestId(S.whereResult).filter({ hasText: "Kyoto" }).first().click();
	await expect(page).toHaveURL(/\/saved$/);
}

test("Select adds many to a trip (Undo), or plans a new trip from them", async ({ page, request }, info) => {
	test.skip(info.project.name !== "chromium", "a phone size is set here");
	test.setTimeout(150_000);
	const c = await cloneFixtureTrip(request);
	await page.setViewportSize({ width: 390, height: 844 });
	const tag = randomBytes(2).toString("hex");
	await shareToKyoto(page, `Matcha ${tag}`);
	await shareToKyoto(page, `Tofu ${tag}`);
	const mine = page.getByTestId(S.tile).filter({ hasText: tag });
	await expect(mine).toHaveCount(2);

	// Select both, Add to trip: only trips I can edit.
	await page.getByTestId(S.select).click();
	await mine.nth(0).click();
	await mine.nth(1).click();
	await expect(page.getByTestId(S.selectCount)).toHaveText("2 selected");
	await expectNoHorizontalOverflow(page);
	await page.screenshot({ path: shotPath("saved/bulk-select-390.png"), animations: "disabled" });
	await page.getByTestId(S.addSelected).click();
	const dialog = page.getByTestId(S.addDialog);
	await expect(dialog).toContainText("Add 2 items to a trip");
	await page.screenshot({ path: shotPath("saved/bulk-add-390.png"), animations: "disabled" });
	await dialog.locator(`[data-testid="${S.addTrip}"][data-trip="${c.tripId}"]`).click();
	await expect(page.getByText(/^Added 2 items to /)).toBeVisible({ timeout: 15_000 });
	await expect(mine.getByTestId(S.tileTrips)).toHaveCount(2);
	// Undo: out of the trip again.
	await page.getByRole("button", { name: "Undo" }).click();
	await expect(mine.getByTestId(S.tileTrips)).toHaveCount(0, { timeout: 15_000 });

	// Plan a new trip from them: named for the city, opens on the route.
	await page.getByTestId(S.select).click();
	await mine.nth(0).click();
	await mine.nth(1).click();
	await page.getByTestId(S.addSelected).click();
	await dialog.getByTestId(S.planTrip).click();
	await expect(dialog.getByTestId(S.planName)).toHaveValue("Kyoto");
	await dialog.getByTestId(S.planName).fill(`Kyoto ${tag}`);
	await page.screenshot({ path: shotPath("saved/bulk-plan-390.png"), animations: "disabled" });
	await dialog.getByTestId(S.planCreate).click();
	await expect(page).toHaveURL(/\/t\/[^/?]+\?tab=plan/, { timeout: 20_000 });
	await expect(page.getByTestId(SPLIT_TESTID.splitRow).filter({ hasText: "Kyoto" }).first()).toBeVisible({
		timeout: 20_000,
	});
	await page.screenshot({ path: shotPath("saved/bulk-planned-390.png"), animations: "disabled" });

	// Back in Saved: both are in it.
	await page.goto("/saved");
	await expect(mine.getByTestId(S.tileTrips)).toHaveCount(2);
	await expect(mine.getByTestId(S.tileTrips).first()).toContainText(`Kyoto ${tag}`);
});
