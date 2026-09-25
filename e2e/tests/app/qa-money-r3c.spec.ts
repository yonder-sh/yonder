/**
 * QA I2 "money" verifier, round 3, part c: a read-only spot-check of a few
 * non-money bugs from the round-2 list on the Asia 2027 QA seed (map dashes,
 * the Cities filter label, "still to book" rows, the Fuji Excursion chips).
 * Screenshots only; nothing is written.
 */
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

const BASE = process.env.APP_URL ?? "http://localhost:5350";
const SHOTS = process.env.QA_SHOTS ?? "/tmp/qa-money-shots";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "desktop project only");
});

async function login(request: APIRequestContext, email: string) {
	const H = { Origin: BASE, "Content-Type": "application/json" };
	const send = await request.post("/api/auth/email-otp/send-verification-otp", { data: { email, type: "sign-in" }, headers: H });
	expect(send.ok()).toBeTruthy();
	const sign = await request.post("/api/auth/sign-in/email-otp", { data: { email, otp: "000000" }, headers: H });
	expect(sign.ok()).toBeTruthy();
}
async function open(page: Page, url: string) {
	await page.goto(url);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1200);
}

test("spot-check: map edge dashes, Cities label, still-to-book rows, Fuji Excursion chips", async ({ page }) => {
	const out: Record<string, unknown> = {};
	await login(page.request, "dennis@asia2027.test");
	await open(page, "/t/asia-2027?lens=country");
	await expect
		.poll(() => page.evaluate(() => !!(window as unknown as { __tripMap?: unknown }).__tripMap), { timeout: 20_000 })
		.toBe(true);
	await page.waitForTimeout(1500);
	out.dashes = await page.evaluate(() => {
		const m = (window as unknown as { __tripMap?: { map?: unknown } }).__tripMap;
		const map = (m?.map ?? m) as { getStyle(): { layers: { id: string; type: string; paint?: Record<string, unknown> }[] } };
		return map
			.getStyle()
			.layers.filter((l) => l.id.startsWith("yonder-edges"))
			.map((l) => [l.id, JSON.stringify(l.paint?.["line-dasharray"] ?? null)]);
	});
	await page.screenshot({ path: `${SHOTS}/r3c-map-country.png` });
	// Outline ⋯ → Show › Cities
	await page.getByTestId("outline-header-menu").click().catch(async () => page.getByRole("button", { name: /Outline options|More/ }).first().click());
	await page.waitForTimeout(300);
	out.menu = await page.getByRole("menuitem").allInnerTexts();
	const show = page.getByRole("menuitem", { name: /^Show/ });
	if (await show.count()) {
		await show.first().hover();
		await page.waitForTimeout(300);
		const cities = page.getByRole("menuitemradio", { name: /Cities/ }).or(page.getByRole("menuitem", { name: /Cities/ }));
		if (await cities.count()) {
			await cities.first().click();
			await page.waitForTimeout(800);
			out.hiddenLabels = (await page.getByText(/\d+ places?$/).allInnerTexts()).slice(0, 10);
			await page.screenshot({ path: `${SHOTS}/r3c-outline-cities.png` });
		}
	}
	await page.keyboard.press("Escape");
	// Still to plan › still to book
	await open(page, "/t/asia-2027?sel=root");
	const stp = page.getByTestId("still-to-plan");
	await stp.getByRole("button", { name: /still to book/ }).click();
	await page.waitForTimeout(400);
	const rows = stp.getByTestId("still-to-plan-item");
	out.bookRows = (await rows.allInnerTexts()).slice(0, 12);
	await page.screenshot({ path: `${SHOTS}/r3c-still-to-book.png` });
	await rows.first().click();
	await page.waitForTimeout(1500);
	out.afterClickUrl = page.url().replace(BASE, "");
	out.afterClickSel = await page.evaluate(() => new URL(location.href).searchParams.get("sel"));
	await page.screenshot({ path: `${SHOTS}/r3c-still-to-book-click.png` });
	// Fuji Excursion 7 route chips on Thu 7 Oct
	await open(page, "/t/asia-2027?days=2027-10-07&lens=place");
	out.day7 = (await page.getByTestId("plan-day-header").first().innerText()).replace(/\s+/g, " ");
	out.fujiRow = (await page.getByText(/Fuji Excursion 7/).allInnerTexts()).slice(0, 4);
	await page.screenshot({ path: `${SHOTS}/r3c-thu7.png` });
	console.log(JSON.stringify(out, null, 1));
});
