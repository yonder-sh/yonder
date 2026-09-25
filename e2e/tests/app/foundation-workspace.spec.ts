/**
 * Foundation workspace checks (the I1 review's runtime findings):
 * - a leg-mode change shows in the tab that made it, without a reload (that
 *   tab skips its own live event, so the mutation must invalidate itself);
 * - tablet widths (768, 820, 1024) never scroll sideways and keep the
 *   breadcrumb readable;
 * - an unknown or renamed scope path is corrected and says so;
 * - a trip that doesn't exist shows the not-found view with a quiet console;
 * - a cross-site POST to a server function is refused (CSRF, SECURITY §9);
 * - on mobile the peek sheet doesn't cut the tab bar in half.
 */
import { expect, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive, expectNoHorizontalOverflow } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

type YonderWindow = { __yonder?: { graph: { legs: { id: string; mode: string | null }[] } } };

test("a leg's new mode shows in the tab that changed it", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop inspector");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await page.goto(`/t/${c.slug}?sel=l.${I.hands}.${I.loft}`);
	await expectLive(page);
	const select = page.getByTestId(TESTID.legOverview).getByTestId(TESTID.legMode);
	await expect(select).toContainText(/walk/i);
	await select.click();
	await page.getByRole("option", { name: "transit" }).click();
	await expect(select).toContainText(/transit/i, { timeout: 5_000 });
	await expect
		.poll(() =>
			page.evaluate(
				(legId) => (window as unknown as YonderWindow).__yonder?.graph.legs.find((l) => l.id === legId)?.mode,
				c.ids.legs.handsLoft,
			),
		)
		.toBe("transit");
	expect(logs.messages).toEqual([]);
});

test("tablet widths don't scroll sideways and keep the breadcrumb readable", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "viewport sizes set here");
	const c = await cloneFixtureTrip(page.request);
	for (const width of [768, 820, 1024]) {
		await page.setViewportSize({ width, height: 900 });
		await page.goto(`/t/${c.slug}/japan/tokyo`);
		await expectLive(page);
		await expectNoHorizontalOverflow(page);
		const crumb = page.getByTestId(TESTID.scopeBreadcrumb);
		await expect(crumb).toContainText("Tokyo");
		const box = await crumb.boundingBox();
		expect(box?.width ?? 0, `breadcrumb width at ${width}`).toBeGreaterThan(40);
		await page.screenshot({ path: shotPath(`foundation/resize-${width}.png`), animations: "disabled" });
	}
});

test("an unknown scope path is corrected to the deepest place that resolves", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/nowhere-at-all`);
	await expect(page).toHaveURL(new RegExp(`/t/${c.slug}/japan(\\?|$)`));
	await expect(page.getByText("That place was renamed or removed")).toBeVisible();
});

test("a trip that doesn't exist shows the not-found view, quietly", async ({ page }) => {
	const logs = collectConsole(page, [/status of 404/]);
	await page.goto("/t/does-not-exist-xyz?tab=plan");
	await expect(page.getByText("This trip doesn't exist or you don't have access.")).toBeVisible();
	expect(logs.messages).toEqual([]);
});

test("a cross-site POST to a server function is refused (CSRF)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	await page.goto("/");
	await expect(page.getByTestId(TESTID.dashboard)).toBeVisible();
	const url = await page.evaluate(
		async () => (await import("/src/functions/trips.functions.ts")).updateTrip.url as string,
	);
	expect(url).toMatch(/^\/_serverFn\//);
	const crossSite = await page.request.post(url, {
		headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example", "Content-Type": "application/json" },
		data: { data: { tripId: "00000000-0000-7000-8000-000000000001", name: "x" } },
	});
	expect(crossSite.status()).toBe(403);
	const wrongOrigin = await page.request.post(url, {
		headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
		data: { data: { tripId: "00000000-0000-7000-8000-000000000001", name: "x" } },
	});
	expect(wrongOrigin.status()).toBe(403);
});

test("mobile: the peek sheet hides the tab bar instead of cutting it", async ({ page }, info) => {
	test.skip(info.project.name !== "mobile", "mobile layout");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const tabs = page.getByTestId(TESTID.mobileSheet).getByTestId(TESTID.centerTabs);
	await expect(tabs.locator("xpath=..")).toHaveAttribute("aria-hidden", "true");
	await page.screenshot({ path: shotPath("foundation/mobile-peek.png"), animations: "disabled" });
});
