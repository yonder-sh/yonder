/**
 * WP-Home sharing (DESIGN §8.4; QA SHARE-01/02/04/05/06/07; EXTENSIONS §1.4
 * "Can suggest"; ADDENDUM §10 placeholders ↔ accounts; owner feedback FB-13
 * one link per trip with a role, FB-14 no per-person join links, FB-15 "This
 * is me" asks first). Each test clones its own demo trip (owner
 * dev@example.com, Maya an editor, Audrey a person without an account).
 */
import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { APP_URL, shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import {
	collectConsole,
	expectLive,
	expectNoHorizontalOverflow,
} from "./_helpers/page";

// `request` (the fixture clone) runs as the owner.
test.use({ storageState: storageStateOf("dev") });

async function openShare(page: Page, mobile: boolean) {
	if (mobile) {
		await page.locator('button[aria-label="More"]').click();
		await page.getByRole("menuitem", { name: "Share" }).click();
	} else await page.getByTestId(TESTID.shareButton).click();
	await expect(page.getByTestId(TESTID.shareDialog)).toBeVisible();
	await expect(
		page.getByTestId(HOME_TESTID.memberRow).first(),
	).toBeVisible();
}

/** The trip ids of the caller's dashboard (the real server function). */
async function myTripIds(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const m = await import("/src/features/home/dashboard.functions.ts");
		const trips = (await m.listMyTrips()) as { id: string; role: string }[];
		return trips.map((t) => `${t.id}:${t.role}`);
	});
}

test("the owner invites, changes a role, and sees people, links and guests", async ({
	browser,
	request,
}, info) => {
	const mobile = info.project.name === "mobile";
	const c = await cloneFixtureTrip(request);
	const ctx = await browser.newContext({
		storageState: storageStateOf("dev"),
		...(mobile
			? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
			: {}),
	});
	const page = await ctx.newPage();
	// The refused repeat invite answers 409 on purpose.
	const log = collectConsole(page, [/status of 409/]);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	await openShare(page, mobile);
	const dialog = page.getByTestId(TESTID.shareDialog);
	await expect(dialog.getByTestId(HOME_TESTID.memberRow)).toHaveCount(3);
	await expect(
		dialog.locator(`[data-testid=${HOME_TESTID.memberRow}][data-status=placeholder]`),
	).toContainText("Audrey");
	// FB-13: ONE link, with what anyone who has it can do.
	const linkRow = dialog.getByTestId(TESTID.shareLinkRow);
	await expect(linkRow).toHaveCount(1);
	await expect(linkRow.getByTestId(HOME_TESTID.linkRole)).toBeVisible();
	// SHARE-08: the link says when it was made.
	await expect(linkRow).toContainText(/Created \w{3} \d{1,2} \w{3}/);
	// QA MOB-01 / VIS-14: names stay readable (the role sits under them on phones).
	const truncatedNames = () =>
		dialog
			.getByTestId(HOME_TESTID.memberRow)
			.locator("span.truncate.font-medium")
			.evaluateAll((els) =>
				els
					.filter((e) => e.scrollWidth > e.clientWidth + 0.5)
					.map((e) => e.textContent),
			);
	expect(await truncatedNames()).toEqual([]);

	// Invite someone without an account (SHARE-02) → "Pending".
	const email = `kai-${randomBytes(3).toString("hex")}@example.test`;
	await dialog.getByTestId(HOME_TESTID.inviteEmail).fill(email);
	await dialog.getByTestId(HOME_TESTID.inviteSubmit).click();
	await expect(
		dialog.locator(`[data-testid=${HOME_TESTID.memberRow}][data-status=invited]`),
	).toContainText("Pending");
	// Invite validation (SHARE-07): the same address again is refused inline.
	await dialog.getByTestId(HOME_TESTID.inviteEmail).fill(email);
	await dialog.getByTestId(HOME_TESTID.inviteSubmit).click();
	await expect(dialog.getByRole("alert")).toContainText("already invited");
	await dialog.getByTestId(HOME_TESTID.inviteEmail).fill("");
	await expectNoHorizontalOverflow(page);
	await page.waitForTimeout(300);
	await page.screenshot({
		path: shotPath(`home/share-dialog-${mobile ? "mobile" : "desktop"}.png`),
		animations: "disabled",
	});

	if (mobile) {
		// FB-13: the one link's row (switch, role, address) fits a phone.
		await linkRow.scrollIntoViewIfNeeded();
		await expectNoHorizontalOverflow(page);
		await page.screenshot({
			path: shotPath("home/share-link-mobile.png"),
			animations: "disabled",
		});
		// QA VIS-14 at 320 px (iPhone SE): "Dennis Tester (you)" was "I (you)".
		await page.setViewportSize({ width: 320, height: 640 });
		expect(await truncatedNames()).toEqual([]);
		await expectNoHorizontalOverflow(page);
	}
	if (!mobile) {
		// Maya becomes a suggester; her dashboard says "Can suggest" (SHARE-04).
		const maya = dialog
			.getByTestId(HOME_TESTID.memberRow)
			.filter({ hasText: "Maya" });
		await maya.getByTestId(HOME_TESTID.memberRole).click();
		await page.getByRole("option", { name: "Can suggest" }).click();
		await expect(maya.getByTestId(HOME_TESTID.memberRole)).toContainText(
			"Can suggest",
		);
		// QA HOME-8 / VIS-14: the label isn't clipped ("Can suggesı").
		const clipped = await maya
			.getByTestId(HOME_TESTID.memberRole)
			.locator("[data-slot=select-value]")
			.evaluate((e) => e.scrollWidth > e.clientWidth + 0.5);
		expect(clipped).toBe(false);
		const mayaCtx = await browser.newContext({
			storageState: storageStateOf("maya"),
		});
		const mayaPage = await mayaCtx.newPage();
		await mayaPage.goto("/dashboard");
		await expect(
			mayaPage.locator(`a[href="/t/${c.slug}"]`).locator(".."),
		).toContainText("Can suggest");
		await mayaCtx.close();
	}
	expect(log.messages).toEqual([]);
	await ctx.close();
});

/** The graph role the guest's open workspace shows (`window.__yonder`, VITE_E2E). */
const graphRole = (p: Page) =>
	p.evaluate(
		() =>
			(
				window as unknown as {
					__yonder?: { graph?: { me: { role: string } } };
				}
			).__yonder?.graph?.me.role ?? null,
	);

test("FB-13: one link per trip; its role changes everyone who joined with it, and off removes them", async ({
	browser,
}, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	// Its own owner: link resets are rate-limited per owner (SECURITY §10).
	const ctx = await browser.newContext({
		baseURL: APP_URL,
		storageState: { cookies: [], origins: [] },
	});
	await loginViaApi(
		ctx.request,
		`link-${randomBytes(3).toString("hex")}@example.test`,
		{ first: "Lina", last: "Owner" },
	);
	const c = await cloneFixtureTrip(ctx.request);
	const page = await ctx.newPage();
	const log = collectConsole(page);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	await openShare(page, false);
	const dialog = page.getByTestId(TESTID.shareDialog);
	const row = dialog.getByTestId(TESTID.shareLinkRow);
	// A fresh link, "Can view" (the fixture's clones carry two old links).
	await row.getByTestId(TESTID.shareLinkReset).click();
	await dialog.getByTestId(HOME_TESTID.resetConfirm).click();
	await row.getByTestId(HOME_TESTID.linkRole).click();
	await page.getByRole("option", { name: "Can view" }).click();
	await expect(row).toHaveAttribute("data-role", "viewer");
	await expect(row).toContainText("They can see the plan.");
	const url = await row.getByTestId(TESTID.shareLinkUrl).inputValue();
	expect(url).toMatch(/\/join#t=[A-Za-z0-9_-]{43}$/);
	await page.screenshot({
		path: shotPath("home/share-link-desktop.png"),
		animations: "disabled",
	});

	// A guest opens it (no account): they can view.
	const guestCtx = await browser.newContext({
		baseURL: APP_URL,
		storageState: { cookies: [], origins: [] },
	});
	const guest = await guestCtx.newPage();
	await guest.goto(url);
	await expect(guest).toHaveURL(new RegExp(`/t/${c.slug}`), {
		timeout: 20_000,
	});
	await expectLive(guest);
	await expect.poll(() => graphRole(guest)).toBe("viewer");
	await expect(
		dialog.getByTestId(HOME_TESTID.guestRow).first(),
	).toContainText("Can view");

	// Same link, new role: the guest can edit without a new link or a reload.
	await row.getByTestId(HOME_TESTID.linkRole).click();
	await page.getByRole("option", { name: "Can edit" }).click();
	await expect(row).toHaveAttribute("data-role", "editor");
	await expect(row.getByTestId(TESTID.shareLinkUrl)).toHaveValue(url);
	await expect.poll(() => graphRole(guest), { timeout: 15_000 }).toBe("editor");
	await expect(
		dialog.getByTestId(HOME_TESTID.guestRow).first(),
	).toContainText("Can edit");

	// Off removes them at once (revocation still kicks guests).
	await row.getByTestId(TESTID.shareLinkSwitch).click();
	await expect(row).toHaveAttribute("data-enabled", "false");
	await expect(row).toContainText("Only the people above can open the trip.");
	await expect(dialog.getByTestId(HOME_TESTID.guestRow)).toHaveCount(0);
	await expect(guest.getByTestId(TESTID.workspace)).toHaveCount(0, {
		timeout: 15_000,
	});
	await page.screenshot({
		path: shotPath("home/share-link-off-desktop.png"),
		animations: "disabled",
	});
	expect(log.messages).toEqual([]);
	await guestCtx.close();
	await ctx.close();
});

test("FB-14/FB-15: no per-person join link; 'This is me' explains the merge and asks first", async ({
	browser,
	request,
}, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const c = await cloneFixtureTrip(request);
	const ctx = await browser.newContext({ storageState: storageStateOf("dev") });
	const page = await ctx.newPage();
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	await openShare(page, false);
	const dialog = page.getByTestId(TESTID.shareDialog);
	const audrey = dialog.locator(
		`[data-testid=${HOME_TESTID.memberRow}][data-status=placeholder]`,
	);
	await audrey.getByTestId(HOME_TESTID.memberMenu).click();
	const menu = page.getByRole("menu");
	// Editors still tie a placeholder to an email or a member; no join link.
	await expect(menu.getByRole("menuitem", { name: /Link an email/ })).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: /Same person as/ })).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: /Join link/ })).toHaveCount(0);

	// "This is me" never merges on the first click.
	await page.getByTestId(HOME_TESTID.placeholderClaim).click();
	const confirm = page.getByTestId(HOME_TESTID.claimConfirm);
	await expect(confirm).toBeVisible();
	await expect(confirm).toContainText("Are you Audrey?");
	await expect(confirm).toContainText("This can't be undone.");
	// It stays open (the menu → dialog hand-off doesn't close it: FB-07's race).
	await page.waitForTimeout(800);
	await expect(confirm).toBeVisible();
	await page.screenshot({
		path: shotPath("home/claim-confirm-desktop.png"),
		animations: "disabled",
	});
	await confirm.getByRole("button", { name: "Cancel" }).click();
	await expect(confirm).toHaveCount(0);
	await expect(audrey).toHaveCount(1);

	await audrey.getByTestId(HOME_TESTID.memberMenu).click();
	await page.getByTestId(HOME_TESTID.placeholderClaim).click();
	await page.getByTestId(HOME_TESTID.claimConfirmYes).click();
	await expect(confirm).toHaveCount(0);
	await expect(audrey).toHaveCount(0);
	await ctx.close();
});

test("FB-15: the 'Are you Audrey?' line above the trip asks first too", async ({
	browser,
	request,
}, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const c = await cloneFixtureTrip(request);
	// Audrey signs up on her own (not through the invite email) and is added.
	const email = `audrey-${randomBytes(3).toString("hex")}@example.test`;
	const actx = await browser.newContext({
		baseURL: APP_URL,
		storageState: { cookies: [], origins: [] },
	});
	await loginViaApi(actx.request, email, { first: "Audrey", last: "Nguyen" });
	const octx = await browser.newContext({ storageState: storageStateOf("dev") });
	const owner = await octx.newPage();
	await owner.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(owner);
	await owner.evaluate(
		async ({ tripId, email }) => {
			const m = await import("/src/features/home/sharing.functions.ts");
			await m.inviteMember({ data: { tripId, email, role: "editor" } });
		},
		{ tripId: c.tripId, email },
	);
	const page = await actx.newPage();
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const nudge = page.getByTestId(HOME_TESTID.claimPrompt);
	await expect(nudge).toContainText("Are you Audrey?");
	await nudge.getByTestId(HOME_TESTID.claimButton).click();
	const confirm = page.getByTestId(HOME_TESTID.claimConfirm);
	await expect(confirm).toBeVisible();
	await expect(confirm).toContainText("This can't be undone.");
	await page.screenshot({
		path: shotPath("home/claim-confirm-nudge-desktop.png"),
		animations: "disabled",
	});
	await page.getByTestId(HOME_TESTID.claimConfirmYes).click();
	await expect(confirm).toHaveCount(0);
	await expect(page.getByText("You're Audrey on this trip now")).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(
				(id) =>
					(
						window as unknown as {
							__yonder?: {
								graph?: { members: { id: string; status: string }[] };
							};
						}
					).__yonder?.graph?.members.find((m) => m.id === id)?.status ?? null,
				c.members.audrey,
			),
		)
		.toBe("removed");
	await actx.close();
	await octx.close();
});

test("removing a member cuts their access (SHARE-05); editors can't manage people (SHARE-06)", async ({
	browser,
	request,
}, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const c = await cloneFixtureTrip(request);
	const mayaCtx = await browser.newContext({
		storageState: storageStateOf("maya"),
	});
	const mayaPage = await mayaCtx.newPage();
	await mayaPage.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(mayaPage);
	// Maya (editor) sees the people but no invite, no links, no role selects.
	await openShare(mayaPage, false);
	const md = mayaPage.getByTestId(TESTID.shareDialog);
	await expect(md.getByTestId(HOME_TESTID.inviteEmail)).toHaveCount(0);
	await expect(md.getByTestId(TESTID.shareLinkRow)).toHaveCount(0);
	await expect(md.getByTestId(HOME_TESTID.memberRole)).toHaveCount(0);
	await mayaPage.keyboard.press("Escape");
	expect((await myTripIds(mayaPage)).some((t) => t.startsWith(c.tripId))).toBe(
		true,
	);

	const ctx = await browser.newContext({ storageState: storageStateOf("dev") });
	const page = await ctx.newPage();
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	await openShare(page, false);
	const dialog = page.getByTestId(TESTID.shareDialog);
	const maya = dialog
		.getByTestId(HOME_TESTID.memberRow)
		.filter({ hasText: "Maya" });
	await maya.getByTestId(HOME_TESTID.memberMenu).click();
	await page.getByRole("menuitem", { name: "Remove from trip" }).click();
	await expect(maya).toHaveCount(0);
	// Her open tab loses the trip, and it's gone from her trips.
	await expect
		.poll(async () =>
			(await myTripIds(mayaPage)).some((t) => t.startsWith(c.tripId)),
		)
		.toBe(false);
	await mayaCtx.close();
	await ctx.close();
});
