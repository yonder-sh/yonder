/**
 * The trip's address is its share link (owner decision 2026-09-25, like
 * Google Drive): `/t/<readable>-<tail>` is the one URL for everyone.
 * Members open it as members; while "Anyone with the link" is on, anyone
 * else gets its role (a signed-out visitor as an anonymous guest); while it
 * is off they get the "no access" page, the same as for an address that
 * doesn't exist. "Reset link" gives the trip a new tail: the old address is
 * dead and its link guests lose access at once. Trip settings edit only the
 * readable part. "Copy link" copies the address. Each test clones its own
 * demo trip (owner dev@example.com, Maya an editor).
 */
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { TESTID } from "../../../src/lib/testids";
import { storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { setTestLink, settled } from "./_helpers/link";
import { collectConsole, expectLive } from "./_helpers/page";

// `request` (the fixture clone) and `page` run as the owner.
test.use({ storageState: storageStateOf("dev") });
test.beforeEach(({}, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
});

const TAIL = "[23456789abcdefghjkmnpqrstuvwxyz]{8}";
/** Expected on purpose: the no-access answers and the revoked guest's refused calls. */
const EXPECTED = [/status of 40[134]/];

type Me = { role: string; isGuest: boolean; memberId: string | null };
const meOf = (page: Page) =>
	page.evaluate(
		() => (window as unknown as { __yonder?: { graph?: { me: Me; trip: { slug: string } } } }).__yonder?.graph ?? null,
	);

/** A fresh browser: nobody signed in (the spec's `use` would sign it in as dev). */
async function signedOut(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
	const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	return { ctx, page: await ctx.newPage() };
}

async function openShare(page: Page) {
	await page.getByTestId(TESTID.shareButton).click();
	const dialog = page.getByTestId(TESTID.shareDialog);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId(HOME_TESTID.memberRow).first()).toBeVisible();
	return dialog;
}

test("a member opens the trip's address as a member, link on or off", async ({ page, request, browser }) => {
	const c = await cloneFixtureTrip(request);
	// A readable part and an unguessable tail.
	expect(c.slug).toMatch(new RegExp(`^demo-${TAIL}$`));
	await page.goto(`/t/${c.slug}`);
	await expectLive(page);
	expect((await meOf(page))?.me).toMatchObject({ role: "owner", isGuest: false });

	// Maya, an editor member, at the same address, with the link on as "Can view":
	// she stays an editor member, never a link guest.
	await setTestLink(request, c.slug, "viewer");
	const maya = await browser.newContext({ storageState: storageStateOf("maya") });
	const mp = await maya.newPage();
	await mp.goto(`/t/${c.slug}`);
	await expectLive(mp);
	expect((await meOf(mp))?.me).toMatchObject({ role: "editor", isGuest: false });
	const dialog = await openShare(page);
	await expect(dialog.getByTestId(HOME_TESTID.guestRow)).toHaveCount(0);
	await maya.close();
});

test("signed out: the link's role while it's on, the not-found page while it's off", async ({ page, request, browser }) => {
	const c = await cloneFixtureTrip(request);
	const log = collectConsole(page);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);

	// Off (a fresh clone): a signed-out visitor gets "no access", which reads
	// exactly like an address that doesn't exist, and offers to sign in.
	const off = await signedOut(browser);
	await off.page.goto(`/t/${c.slug}`);
	await expect(off.page.getByTestId(TESTID.tripNoAccess)).toBeVisible({ timeout: 30_000 });
	const offText = await off.page.getByTestId(TESTID.tripNoAccess).innerText();
	await off.page.goto(`/t/demo-${"z".repeat(8)}`);
	await expect(off.page.getByTestId(TESTID.tripNoAccess)).toBeVisible({ timeout: 30_000 });
	expect(await off.page.getByTestId(TESTID.tripNoAccess).innerText()).toBe(offText);
	await expect(off.page.getByTestId(TESTID.tripNoAccessSignIn)).toBeVisible();
	await expect(off.page.getByTestId(TESTID.workspace)).toHaveCount(0);
	await off.ctx.close();

	// The owner turns "Anyone with the link" on, as "Can edit".
	const dialog = await openShare(page);
	const row = dialog.getByTestId(TESTID.shareLinkRow);
	await row.getByTestId(TESTID.shareLinkSwitch).click();
	await expect(row).toHaveAttribute("data-enabled", "true");
	await row.getByTestId(HOME_TESTID.linkRole).click();
	await page.getByRole("option", { name: "Can edit" }).click();
	await expect(row).toHaveAttribute("data-role", "editor");
	// Turning it on keeps the address (it already has its tail).
	await expect(row.getByTestId(TESTID.shareLinkUrl)).toHaveValue(new RegExp(`/t/${c.slug}$`));

	// The same address, signed out: an anonymous guest with that role, on the Overview.
	const guest = await signedOut(browser);
	const glog = collectConsole(guest.page, EXPECTED);
	await guest.page.goto(`/t/${c.slug}`);
	await expectLive(guest.page);
	expect(new URL(guest.page.url()).pathname).toBe(`/t/${c.slug}`);
	expect((await meOf(guest.page))?.me).toMatchObject({ role: "editor", isGuest: true, memberId: null });
	await expect(
		guest.page.getByTestId(TESTID.centerTabs).locator('[role=tab][aria-selected="true"]'),
	).toHaveAttribute("data-tab", "overview");
	// The owner sees them as a guest who joined with the link.
	await expect(dialog.getByTestId(HOME_TESTID.guestRow)).toHaveCount(1, { timeout: 15_000 });

	// Off again: the guest's page says so at once, and a new visitor gets "no access".
	await row.getByTestId(TESTID.shareLinkSwitch).click();
	await expect(row).toHaveAttribute("data-enabled", "false");
	await expect(guest.page.getByTestId(TESTID.workspace)).toHaveCount(0, { timeout: 15_000 });
	await expect(guest.page.getByText("This link is no longer active.")).toBeVisible();
	const late = await signedOut(browser);
	await late.page.goto(`/t/${c.slug}`);
	await expect(late.page.getByTestId(TESTID.tripNoAccess)).toBeVisible({ timeout: 30_000 });
	await late.ctx.close();

	// Trip pages are never indexed.
	const res = await request.get(`/t/${c.slug}`);
	expect(res.headers()["x-robots-tag"]).toMatch(/noindex/);
	expect(log.messages).toEqual([]);
	expect(glog.messages).toEqual([]);
	await guest.ctx.close();
});

test("Reset link gives a new tail: the old address is dead and its guests lose access live", async ({ page, request, browser }) => {
	const c = await cloneFixtureTrip(request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const dialog = await openShare(page);
	const row = dialog.getByTestId(TESTID.shareLinkRow);
	await row.getByTestId(TESTID.shareLinkSwitch).click();
	await expect(row).toHaveAttribute("data-enabled", "true");

	const guest = await signedOut(browser);
	await guest.page.goto(`/t/${c.slug}`);
	await expectLive(guest.page);
	expect((await meOf(guest.page))?.me).toMatchObject({ role: "viewer", isGuest: true });

	await row.getByTestId(TESTID.shareLinkReset).click();
	await dialog.getByTestId(HOME_TESTID.resetConfirm).click();
	const input = row.getByTestId(TESTID.shareLinkUrl);
	await expect(input).not.toHaveValue(new RegExp(`/t/${c.slug}$`), { timeout: 10_000 });
	const next = new URL(await input.inputValue()).pathname.replace(/^\/t\//, "");
	// The readable part stays; only the tail is new.
	expect(next).toMatch(new RegExp(`^demo-${TAIL}$`));
	expect(next).not.toBe(c.slug);

	// The guest who came in through the link is out within seconds.
	const t0 = Date.now();
	await expect(guest.page.getByTestId(TESTID.workspace)).toHaveCount(0, { timeout: 6_000 });
	console.log(`[trip-link] guest out after ${Date.now() - t0} ms`);
	await expect(guest.page.getByText("This link is no longer active.")).toBeVisible();
	await guest.ctx.close();
	// The owner's own tab follows the new address.
	await expect(page).toHaveURL(new RegExp(`/t/${next}(\\?|$)`), { timeout: 15_000 });

	// The old address opens nothing; the new one works (the link stays on).
	const old = await signedOut(browser);
	await old.page.goto(`/t/${c.slug}`);
	await expect(old.page.getByTestId(TESTID.tripNoAccess)).toBeVisible({ timeout: 30_000 });
	await old.ctx.close();
	const fresh = await signedOut(browser);
	await fresh.page.goto(`/t/${next}`);
	await expectLive(fresh.page);
	expect((await meOf(fresh.page))?.me).toMatchObject({ role: "viewer", isGuest: true });
	await fresh.ctx.close();
});

test("trip settings edit the readable part of the address; the tail stays", async ({ page, request, browser }) => {
	const c = await cloneFixtureTrip(request);
	const tail = c.slug.slice(-8);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	await page.getByTestId(TESTID.tripMenu).click();
	await page.getByRole("menuitem", { name: "Trip settings" }).click();
	const dialog = page.getByTestId(TESTID.tripSettingsDialog);
	const input = dialog.getByTestId(HOME_TESTID.settingsSlug);
	await expect(input).toHaveValue("demo");
	await expect(dialog.getByTestId(HOME_TESTID.settingsSlugTail)).toHaveText(`-${tail}`);
	await input.fill("Tokyo Spring");
	await expect(input).toHaveValue("tokyo-spring");
	await dialog.getByTestId(HOME_TESTID.settingsSave).click();
	await expect(dialog).toBeHidden();

	// The new address keeps the tail, and this tab moves to it.
	const next = `tokyo-spring-${tail}`;
	await expect(page).toHaveURL(new RegExp(`/t/${next}(\\?|$)`), { timeout: 15_000 });
	await expect.poll(async () => (await meOf(page))?.trip.slug).toBe(next);
	await page.getByTestId(TESTID.tripMenu).click();
	await page.getByRole("menuitem", { name: "Trip settings" }).click();
	await expect(input).toHaveValue("tokyo-spring");
	await expect(dialog.getByTestId(HOME_TESTID.settingsSlugTail)).toHaveText(`-${tail}`);
	await page.keyboard.press("Escape");

	// A reload at the new address works; the old one is gone.
	await page.goto(`/t/${next}?tab=plan`);
	await expectLive(page);
	const old = await signedOut(browser);
	await setTestLink(request, next, "viewer");
	await old.page.goto(`/t/${c.slug}`);
	await expect(old.page.getByTestId(TESTID.tripNoAccess)).toBeVisible({ timeout: 30_000 });
	await old.page.goto(`/t/${next}`);
	await settled(old.page);
	await expect(old.page.getByTestId(TESTID.workspace)).toBeVisible();
	await old.ctx.close();
});

test("Copy link copies the trip's address, for the owner and for members", async ({ page, request, browser }) => {
	const c = await cloneFixtureTrip(request);
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const address = `${new URL(page.url()).origin}/t/${c.slug}`;
	const dialog = await openShare(page);
	await expect(dialog.getByTestId(TESTID.shareLinkUrl)).toHaveValue(address);
	await dialog.getByTestId(TESTID.shareLinkCopy).click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(address);

	// Maya (an editor member) copies the same address.
	const maya = await browser.newContext({ storageState: storageStateOf("maya") });
	await maya.grantPermissions(["clipboard-read", "clipboard-write"]);
	const mp = await maya.newPage();
	await mp.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(mp);
	const md = await openShare(mp);
	await expect(md.getByTestId(TESTID.shareLinkRow)).toHaveCount(0);
	await expect(md.getByTestId(TESTID.shareLinkUrl)).toHaveValue(address);
	await md.getByTestId(TESTID.shareLinkCopy).click();
	await expect.poll(() => mp.evaluate(() => navigator.clipboard.readText())).toBe(address);
	await maya.close();
});
