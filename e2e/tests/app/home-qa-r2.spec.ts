/**
 * WP-Home QA round 2 (SPEC §18.5: each test clones its own trip).
 *
 * - DASH at 390×844: every Upcoming deadlines row shows its whole trip name
 *   (the due label no longer squeezes it to "Asi…").
 * - A11Y-02: Share and Trip settings opened from the keyboard take focus,
 *   Tab stays inside, one Esc closes them and focus goes back to the opener.
 * - COLLAB-R2-06: a link guest who signs in to keep the trip is their account
 *   at once (`graph.me`, the guest line), without a reload.
 */
import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { logOffset, readOtp } from "./_helpers/otp";
import { expectLive, hydrated } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

const hex = () => randomBytes(4).toString("hex");
/** `browser.newContext` takes the file's `storageState` unless told otherwise. */
const signedOut = { storageState: { cookies: [], origins: [] } };

type Me = { userId: string | null; isGuest: boolean; name: string };
const me = (page: Page) =>
	page.evaluate(
		() =>
			(window as unknown as { __yonder?: { graph?: { me: Me } } }).__yonder
				?.graph?.me ?? null,
	);

test("DASH at 390×844: every deadline row names its whole trip", async ({
	browser,
}, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const ctx = await browser.newContext({
		viewport: { width: 390, height: 844 },
	});
	const page = await ctx.newPage();
	// Its own account: only these two trips' deadlines.
	await loginViaApi(page.request, `dl-${hex()}@example.com`, {
		first: "Dee",
		last: "Line",
	});
	const a = await cloneFixtureTrip(page.request);
	const b = await cloneFixtureTrip(page.request);
	await page.goto("/");
	await expect(page.getByTestId(TESTID.dashboard)).toBeVisible();
	const dueDate = new Date(Date.now() + 7 * 86_400_000)
		.toISOString()
		.slice(0, 10);
	await page.evaluate(
		async ({ trips, dueDate }) => {
			const t = await import("/src/functions/trips.functions.ts");
			const l = await import("/src/features/lists/lists.functions.ts");
			for (const [tripId, name] of trips) {
				await t.updateTrip({ data: { tripId, name } });
				await l.createListItem({
					data: {
						tripId,
						target: { kind: "trip" },
						list: "todo",
						text: "Chase → Aeroplan transfer (20% bonus)",
						dueDate,
						dueTime: "23:59",
						dueTz: "America/New_York",
					},
				});
			}
		},
		{
			trips: [
				[a.tripId, "Asia 2027"],
				[b.tripId, "Asia 2027 backup"],
			],
			dueDate,
		},
	);
	await page.reload();
	const rows = page
		.getByTestId(HOME_TESTID.deadlineRow)
		.filter({ hasText: "Aeroplan" });
	await expect(rows).toHaveCount(2);
	const names = rows.getByTestId(HOME_TESTID.deadlineTrip);
	await expect(names.first()).toBeVisible();
	expect((await names.allInnerTexts()).sort()).toEqual([
		"Asia 2027",
		"Asia 2027 backup",
	]);
	const cut = await names.evaluateAll((els) =>
		els
			.filter((e) => e.scrollWidth > e.clientWidth + 1)
			.map((e) => e.textContent),
	);
	expect(cut, "trip names cut short").toEqual([]);
	await page.getByTestId(HOME_TESTID.deadlines).screenshot({
		path: shotPath("home/deadlines-phone.png"),
		animations: "disabled",
	});
	await ctx.close();
});

test("A11Y-02: Share and Trip settings from the keyboard keep focus inside and close on one Esc", async ({
	page,
	request,
}, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const c = await cloneFixtureTrip(request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const inside = (testid: string) =>
		page.evaluate(
			(id) => !!document.activeElement?.closest(`[data-testid="${id}"]`),
			testid,
		);
	const tabStaysIn = async (testid: string) => {
		await expect.poll(() => inside(testid)).toBe(true);
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press("Tab");
			expect(await inside(testid), `Tab ${i + 1} left the dialog`).toBe(true);
		}
	};

	const share = await hydrated(page.getByTestId(TESTID.shareButton).first());
	await share.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId(TESTID.shareDialog)).toBeVisible();
	await tabStaysIn(TESTID.shareDialog);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId(TESTID.shareDialog)).toHaveCount(0);
	await expect(share).toBeFocused();

	const menu = page.getByTestId(TESTID.tripMenu);
	await menu.focus();
	await page.keyboard.press("Enter");
	await page.getByRole("menuitem", { name: "Trip settings" }).focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId(TESTID.tripSettingsDialog)).toBeVisible();
	await tabStaysIn(TESTID.tripSettingsDialog);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId(TESTID.tripSettingsDialog)).toHaveCount(0);
	await expect(menu).toBeFocused();
});

test("COLLAB-R2-06: a link guest who signs in to keep the trip is their account at once", async ({
	browser,
	request,
}, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const c = await cloneFixtureTrip(request);
	const email = `keep-${hex()}@example.com`;
	// Kip already holds the edit link as himself (as Eve did in the QA run),
	// so signing in changes nothing on the trip that would refetch it.
	const acct = await browser.newContext(signedOut);
	await loginViaApi(acct.request, email, { first: "Kip", last: "Keeper" });
	const kip = await acct.newPage();
	await kip.goto(`/join#t=${c.shareTokens.editor}`);
	await expect(kip).toHaveURL(new RegExp(`/t/${c.slug}`), { timeout: 20_000 });
	await acct.close();

	const ctx = await browser.newContext({
		...signedOut,
		viewport: { width: 1440, height: 900 },
	});
	const page = await ctx.newPage();
	await page.goto(`/join#t=${c.shareTokens.editor}`);
	await expect(page).toHaveURL(new RegExp(`/t/${c.slug}`), {
		timeout: 20_000,
	});
	// A later visit (a full load, as in the QA run): the graph comes from the
	// cache at once, and nothing on the trip changes when Kip signs in.
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	await page.waitForFunction(
		() =>
			!!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder
				?.graph,
	);
	const guest = await me(page);
	expect(guest?.isGuest).toBe(true);
	const nudge = page.getByTestId(TESTID.guestNudge);
	await expect(nudge).toContainText("viewing as");

	await nudge.getByText("Sign in to keep this trip").click();
	await page.getByTestId("login-email").fill(email);
	const since = logOffset();
	await page.getByTestId("login-submit").click();
	const otp = page.getByTestId("otp-input");
	await expect(otp).toBeVisible({ timeout: 15_000 });
	await otp.click();
	await page.keyboard.type(await readOtp(email, { since }));
	await expect(page).toHaveURL(new RegExp(`/t/${c.slug}`), {
		timeout: 30_000,
	});
	await expect(page.getByTestId(TESTID.workspace)).toBeVisible();
	// No reload, and from the first paint: the workspace is Kip's (still a
	// link guest, now signed in), never the guest's cached graph.
	expect(await nudge.innerText()).toMatch(/a guest here as\s+Kip Keeper/);
	await expect.poll(async () => (await me(page))?.name).toBe("Kip Keeper");
	expect((await me(page))?.userId).not.toBe(guest?.userId);
	await ctx.close();
});
