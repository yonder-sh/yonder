/**
 * Onboarding (owner, 2026-09-25):
 * - "Where things stand" on the Overview: the five lines, the next one with
 *   its action, Remind on the rating line; a 390 px phone;
 * - the welcome for people who join: an email invitee (the inviter's note,
 *   "Rate N places", remembered on the server, "How this trip works"), a link
 *   guest who names themselves first, and a viewer who can ask for edit
 *   access; a full-screen sheet at 390 px;
 * - "Remind": the button's state and the recipient's line in the trip;
 * - the shortlist level and leaving someone's ratings out (a place drops
 *   off the shortlist and comes back).
 * Screenshots land in `.data/onboard-shots/`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { STANDING_TESTID as S } from "../../../src/features/overview/testids-standing";
import { RATING_TESTID as R } from "../../../src/features/places/tab/rating-testids";
import { PLACES_TAB_TESTID as PT } from "../../../src/features/places/tab/testids";
import { WELCOME_TESTID as W } from "../../../src/features/welcome/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { APP_URL, REPO_ROOT, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";
import { openLink } from "./_helpers/link";
import { expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

test.beforeEach(({}, info) => {
	test.skip(info.project.name !== "chromium", "one browser (the phone checks set their own 390 px viewport)");
});

const shot = (name: string) => path.join(REPO_ROOT, ".data/onboard-shots", `${name}.png`);
const uniq = () => randomBytes(3).toString("hex");
const PHONE = { width: 390, height: 844 };
const NOTE = "Rate the Kyoto places before Sunday!";

type G = {
	trip: { name: string };
	me: { memberId: string | null };
	members: { id: string; name: string; status: string }[];
	nodes: { id: string; type: string; category: string | null; priorities: Record<string, string> }[];
};
const graphOf = (page: Page) =>
	page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);

/** A browser for someone: an account (signed in), or a guest (signed out). */
async function person(
	browser: Browser,
	who: { first: string; last: string } | "maya" | "guest",
	opts: { phone?: boolean; welcome?: boolean } = {},
) {
	const ctx = await browser.newContext({
		baseURL: APP_URL,
		viewport: opts.phone ? PHONE : { width: 1440, height: 900 },
		...(opts.phone ? { isMobile: true, hasTouch: true } : {}),
		storageState: who === "maya" ? storageStateOf("maya") : { cookies: [], origins: [] },
	});
	// e2e runs keep the welcome closed unless a spec asks for it.
	if (opts.welcome) await ctx.addInitScript(() => localStorage.setItem("yonder.e2e.welcome", "1"));
	let email = "";
	if (typeof who === "object") {
		email = `${who.first.toLowerCase()}-${uniq()}@example.test`;
		await loginViaApi(ctx.request, email, who);
	}
	return { ctx, email, page: await ctx.newPage() };
}

/** Calls a server function from `page`, as its user. */
async function callFn(page: Page, mod: string, fn: string, data: unknown): Promise<unknown> {
	return page.evaluate(
		async ({ mod, fn, data }) => {
			const m = await import(/* @vite-ignore */ mod);
			return m[fn]({ data });
		},
		{ mod, fn, data },
	);
}
const SHARING = "/src/features/home/sharing.functions.ts";

/** The owner invites `email` as `role` from the Share dialog, with a note. */
async function inviteFromDialog(page: Page, email: string, role: "Can edit" | "Can view", note: string) {
	await page.getByTestId(TESTID.shareButton).click();
	const dialog = page.getByTestId(TESTID.shareDialog);
	await dialog.getByTestId(HOME_TESTID.inviteEmail).fill(email);
	await dialog.getByTestId(HOME_TESTID.inviteNote).fill(note);
	await dialog.getByTestId(HOME_TESTID.inviteRole).click();
	await page.getByRole("option", { name: role }).click();
	await dialog.getByTestId(HOME_TESTID.inviteSubmit).click();
	await expect(page.getByText(`Added ${email}`)).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
}

const line = (page: Page, key: string) => page.locator(`[data-testid=${S.line}][data-key=${key}]`);

test.describe("where things stand", () => {
	test("the Overview's checklist: five lines, rating next, Rate N places opens the Rate step", async ({ page }) => {
		const c = await cloneFixtureTrip(page.request);
		await page.goto(`/t/${c.slug}`);
		await expectLive(page);
		const card = page.getByTestId(S.card);
		await expect(card).toBeVisible({ timeout: 20_000 });
		await expect(card).toContainText("Where things stand");
		await expect(page.getByTestId(S.line)).toHaveCount(5);
		await expect(line(page, "places")).toHaveAttribute("data-done", "true");
		await expect(line(page, "places")).toContainText(/^\s*Done: \d+ places added/);
		await expect(line(page, "rating")).toHaveAttribute("data-next", "true");
		await expect(line(page, "rating")).toContainText(/Rating: You, (Audrey and Maya|Maya and Audrey) haven't started\./);
		await expect(line(page, "cities")).toContainText("How long in each city:");
		await expect(line(page, "days")).toContainText(/What to do each day: .*favourite/);
		await expect(line(page, "stays")).toContainText(/Where you're staying: \d+ nights? not set yet/);
		// Remind Maya (an account); Audrey has none.
		await expect(line(page, "rating").getByTestId(R.remind)).toHaveText(["Remind Maya"]);
		await page.screenshot({ path: shot("desktop-checklist"), animations: "disabled" });
		const action = line(page, "rating").getByTestId(S.action);
		await expect(action).toHaveText(/^Rate \d+ places$/);
		await action.click();
		await expect(page).toHaveURL(/tab=places/);
		await expect(page).toHaveURL(/pv=rate/);
		await expect(page.getByTestId(PT.feed)).toBeVisible({ timeout: 20_000 });
	});

	test("phone, 390 px: the checklist fits", async ({ browser }) => {
		const owner = await browser.newContext({
			baseURL: APP_URL,
			viewport: PHONE,
			isMobile: true,
			hasTouch: true,
			storageState: storageStateOf("dev"),
		});
		const page = await owner.newPage();
		const c = await cloneFixtureTrip(page.request);
		await page.goto(`/t/${c.slug}`);
		await expectLive(page);
		const card = page.getByTestId(S.card);
		await card.scrollIntoViewIfNeeded({ timeout: 30_000 });
		await expect(card).toBeVisible();
		const box = await card.boundingBox();
		expect(box && box.x >= 0 && box.x + box.width <= PHONE.width).toBe(true);
		for (const key of ["places", "rating", "cities", "days", "hotels"]) {
			const b = await line(page, key).boundingBox();
			expect(b && b.x + b.width <= PHONE.width).toBe(true);
		}
		await page.screenshot({ path: shot("phone-checklist"), animations: "disabled" });
		await owner.close();
	});
});

test.describe("the welcome", () => {
	test("an email invitee: the note, Rate N places, remembered, and How this trip works", async ({ page, browser }) => {
		const c = await cloneFixtureTrip(page.request);
		const kai = await person(browser, { first: "Kai", last: "Invitee" }, { welcome: true });
		await page.goto(`/t/${c.slug}?tab=plan`);
		await expectLive(page);
		await inviteFromDialog(page, kai.email, "Can edit", NOTE);

		await kai.page.goto(`/t/${c.slug}`);
		const dialog = kai.page.getByTestId(W.dialog);
		await expect(dialog).toBeVisible({ timeout: 30_000 });
		await expect(dialog.getByRole("heading", { level: 2 }).first()).toBeVisible();
		await expect(dialog.getByTestId(W.note)).toContainText(`“${NOTE}”`);
		await expect(dialog.getByTestId(W.note)).toContainText("— Dev");
		await expect(dialog.getByTestId(W.who)).toHaveText(/^Dev invited you · with (Maya and Audrey|Audrey and Maya)$/);
		await expect(dialog.getByTestId(W.dates)).toContainText(/Oct/);
		await expect(dialog.getByTestId(S.card)).toBeVisible();
		const primary = dialog.getByTestId(W.primary);
		await expect(primary).toHaveAttribute("data-kind", "rate");
		await expect(primary).toHaveText(/^Rate \d+ places$/);
		await expect(primary).toBeFocused();
		await kai.page.screenshot({ path: shot("desktop-welcome-invitee"), animations: "disabled" });
		await primary.click();
		await expect(dialog).toBeHidden();
		await expect(kai.page).toHaveURL(/pv=rate/);
		await expect(kai.page.getByTestId(PT.feed)).toBeVisible({ timeout: 20_000 });

		// Remembered on the server: not again after a reload (or on another device).
		await kai.page.goto(`/t/${c.slug}`);
		await expectLive(kai.page);
		await kai.page.waitForTimeout(1500);
		await expect(kai.page.getByTestId(W.dialog)).toHaveCount(0);
		// "How this trip works" opens it again; Escape is "Look around".
		await kai.page.getByTestId(TESTID.tripMenu).click();
		await kai.page.getByTestId(W.menuItem).click();
		await expect(kai.page.getByTestId(W.dialog)).toBeVisible();
		await kai.page.keyboard.press("Escape");
		await expect(kai.page.getByTestId(W.dialog)).toBeHidden();
		await kai.ctx.close();
	});

	test("a guest through the link: their name first, then the trip, with the link's note", async ({ page, browser }) => {
		const c = await cloneFixtureTrip(page.request);
		await page.goto(`/t/${c.slug}?tab=plan`);
		await expectLive(page);
		// The owner turns the link on (Can edit) and leaves a note for people who join.
		await page.getByTestId(TESTID.shareButton).click();
		const share = page.getByTestId(TESTID.shareDialog);
		const row = share.getByTestId(TESTID.shareLinkRow);
		await row.getByTestId(TESTID.shareLinkSwitch).click();
		await expect(row).toHaveAttribute("data-enabled", "true");
		await row.getByTestId(HOME_TESTID.linkRole).click();
		await page.getByRole("option", { name: "Can edit" }).click();
		await expect(row).toHaveAttribute("data-role", "editor");
		await row.getByTestId(HOME_TESTID.linkNote).fill("Add anything you want to see");
		await row.getByTestId(HOME_TESTID.linkNote).press("Enter");
		await expect(page.getByText("Note saved")).toBeVisible();
		await page.keyboard.press("Escape");

		const guest = await person(browser, "guest", { welcome: true });
		await openLink(guest.page, c.slug, "editor");
		const dialog = guest.page.getByTestId(W.dialog);
		await expect(dialog).toHaveAttribute("data-step", "name", { timeout: 30_000 });
		await expect(dialog).toContainText("What should the group call you?");
		await expect(dialog.getByTestId(W.signIn)).toHaveText("Sign in");
		await expect(dialog).toContainText("Sign in to keep this trip on your other devices.");
		await guest.page.screenshot({ path: shot("desktop-welcome-guest-name"), animations: "disabled" });
		await dialog.getByTestId(W.nameInput).fill("Sam");
		await dialog.getByTestId(W.nameContinue).click();
		await expect(dialog).toHaveAttribute("data-step", "main");
		await expect(dialog.getByTestId(W.who)).toContainText("You're joining through the trip link");
		await expect(dialog.getByTestId(W.note)).toContainText("“Add anything you want to see”");
		await expect(dialog.getByTestId(W.primary)).toHaveText("See the plan");
		await dialog.getByTestId(W.primary).click();
		await expect(dialog).toBeHidden();
		// The group calls them Sam now.
		await expect(guest.page.getByTestId(TESTID.guestNudge)).toContainText("Sam");
		await guest.ctx.close();
	});

	test("a viewer: See the plan, and a message asking for edit access", async ({ page, browser }) => {
		const c = await cloneFixtureTrip(page.request);
		const vic = await person(browser, { first: "Vic", last: "Viewer" }, { welcome: true });
		await page.goto(`/t/${c.slug}?tab=plan`);
		await expectLive(page);
		await callFn(page, SHARING, "inviteMember", { tripId: c.tripId, email: vic.email, role: "viewer" });

		await vic.page.goto(`/t/${c.slug}`);
		const dialog = vic.page.getByTestId(W.dialog);
		await expect(dialog).toBeVisible({ timeout: 30_000 });
		await expect(dialog.getByTestId(W.who)).toContainText("Dev invited you");
		await expect(dialog.getByTestId(W.primary)).toHaveText("See the plan");
		// Read-only: the checklist has no actions.
		await expect(dialog.getByTestId(S.action)).toHaveCount(0);
		await dialog.getByTestId(W.askAccess).click();
		await expect(dialog.getByTestId(W.askAccess)).toHaveText("Ask Dev for edit access");
		const trip = (await graphOf(vic.page)).trip.name;
		await expect(dialog.getByTestId(W.askText)).toHaveValue(
			new RegExp(`^Hi Dev, could you give me edit access to ${trip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\? http.*/t/${c.slug}$`),
		);
		await vic.page.screenshot({ path: shot("desktop-welcome-viewer"), animations: "disabled" });
		await dialog.getByTestId(W.primary).click();
		await expect(dialog).toBeHidden();
		await expect(vic.page).toHaveURL(/tab=plan|\/t\/[^?]+$/);
		await vic.ctx.close();
	});

	test("phone, 390 px: a full-screen sheet", async ({ page, browser }) => {
		const c = await cloneFixtureTrip(page.request);
		const lee = await person(browser, { first: "Lee", last: "Phone" }, { welcome: true, phone: true });
		await page.goto(`/t/${c.slug}?tab=plan`);
		await expectLive(page);
		await callFn(page, SHARING, "inviteMember", { tripId: c.tripId, email: lee.email, role: "editor", note: NOTE });
		await lee.page.goto(`/t/${c.slug}`);
		const dialog = lee.page.getByTestId(W.dialog);
		await expect(dialog).toBeVisible({ timeout: 30_000 });
		const box = await dialog.boundingBox();
		expect(box).toMatchObject({ x: 0, y: 0, width: PHONE.width });
		await expect(dialog.getByTestId(W.primary)).toBeVisible();
		await lee.page.screenshot({ path: shot("phone-welcome"), animations: "disabled" });
		await dialog.getByTestId(W.lookAround).click();
		await expect(dialog).toBeHidden();
		await lee.ctx.close();
	});
});

test.describe("Remind", () => {
	test("Remind Maya: Reminded for 12 hours; Maya sees the line in the trip", async ({ page, browser }) => {
		const c = await cloneFixtureTrip(page.request);
		await page.goto(`/t/${c.slug}?tab=places&pv=table`);
		await expectLive(page);
		const maya = page.locator(`[data-testid=${R.person}][data-member="${c.members.maya}"]`);
		const remind = maya.getByTestId(R.remind);
		await expect(remind).toHaveText("Remind");
		// Never you, never Audrey (no account).
		await expect(page.locator(`[data-testid=${R.person}][data-member="${c.members.owner}"]`).getByTestId(R.remind)).toHaveCount(0);
		await expect(page.locator(`[data-testid=${R.person}][data-member="${c.members.audrey}"]`).getByTestId(R.remind)).toHaveCount(0);
		await remind.click();
		await expect(page.getByText("Reminded Maya")).toBeVisible();
		await expect(remind).toHaveText("Reminded");
		await expect(remind).toBeDisabled();
		await page.reload();
		await expectLive(page);
		await expect(remind).toHaveAttribute("data-state", "reminded");
		await expect(remind).toBeDisabled();

		const m = await person(browser, "maya");
		await m.page.goto(`/t/${c.slug}?tab=plan`);
		await expectLive(m.page);
		const lineEl = m.page.getByTestId(R.reminderLine);
		await expect(lineEl).toHaveText(/^Dev reminded you to rate \d+ places\s*Rate now$/);
		await m.page.screenshot({ path: shot("desktop-reminder-line"), animations: "disabled" });
		await lineEl.getByTestId(R.reminderRate).click();
		await expect(m.page).toHaveURL(/pv=rate/);
		await expect(m.page.getByTestId(PT.feed)).toBeVisible({ timeout: 20_000 });
		// On the Rate step it steps aside; elsewhere it stays until closed.
		await expect(lineEl).toHaveCount(0);
		await m.page.goto(`/t/${c.slug}?tab=plan`);
		await expect(lineEl).toBeVisible();
		await lineEl.getByTestId(R.reminderClose).click();
		await expect(lineEl).toHaveCount(0);
		await m.page.reload();
		await expectLive(m.page);
		await m.page.waitForTimeout(1000);
		await expect(lineEl).toHaveCount(0);
		await m.ctx.close();
	});
});

test.describe("the shortlist", () => {
	/** Two new places in Tokyo, not on a day: Tokyo Tower and Mori Art Museum. */
	async function addPlaces(page: Page, c: FixtureClone): Promise<[string, string]> {
		const ids: [string, string] = [randomUUID(), randomUUID()];
		await page.evaluate(
			async ({ tripId, parentId, ids }) => {
				const m = await import(/* @vite-ignore */ "/src/functions/nodes.functions.ts");
				const names = ["Tokyo Tower", "Mori Art Museum"];
				for (const [i, id] of ids.entries())
					await m.createNode({
						data: { tripId, parentId, id, type: "place", category: "viewpoint", name: names[i], lat: 35.6586, lng: 139.7454 },
					});
			},
			{ tripId: c.tripId, parentId: c.ids.nodes.tokyo as string, ids },
		);
		return ids;
	}

	/** You and Audrey rate every place Want; `x` gets Audrey's Really want (+3). */
	async function rateAll(page: Page, c: FixtureClone, x: string) {
		await page.evaluate(
			async ({ me, audrey, x }) => {
				const { isRateable } = await import(/* @vite-ignore */ "/src/features/places/lib/rate.ts");
				const m = await import(/* @vite-ignore */ "/src/functions/nodes.functions.ts");
				const g = (window as unknown as { __yonder: { graph: { nodes: never[] } } }).__yonder.graph;
				for (const n of g.nodes.filter((n) => isRateable(n)) as { id: string }[]) {
					await m.setNodePriority({ data: { nodeId: n.id, memberId: me, priority: "want" } });
					await m.setNodePriority({
						data: { nodeId: n.id, memberId: audrey, priority: n.id === x ? "really_want" : "want" },
					});
				}
			},
			{ me: c.members.owner, audrey: c.members.audrey, x },
		);
	}

	const rowOf = (page: Page, id: string) => page.locator(`[data-testid=${PT.row}][data-row-id="${id}"]`);

	test("the level scales the bar; leaving Audrey out drops a place, counting her again brings it back", async ({ page }) => {
		const c = await cloneFixtureTrip(page.request);
		await page.goto(`/t/${c.slug}?tab=places&pv=table`);
		await expectLive(page);
		const [x, y] = await addPlaces(page, c);
		await page.reload();
		await expectLive(page);
		await expect(rowOf(page, x)).toBeVisible({ timeout: 20_000 });
		await rateAll(page, c, x);
		await page.reload();
		await expectLive(page);
		// Two people rating, halfway between Want and Really want: +3. Tokyo
		// Tower (+3) is on, Mori Art Museum (+2) isn't.
		await expect(rowOf(page, x)).toHaveAttribute("data-score", "3");
		await expect(rowOf(page, x)).toHaveAttribute("data-status", "shortlist");
		await expect(rowOf(page, y)).toHaveAttribute("data-status", "idea");
		// The name cell (the rating cells open their pickers).
		await rowOf(page, x).locator("td").first().click();
		await expect(page.getByTestId(R.reason)).toHaveText(
			"On the shortlist: the group gave it +3, and it needs +3 with 2 people rating.",
		);

		// The setting: Really want → +4 (Tokyo Tower drops off), Want → +2 (both on).
		await page.getByTestId(PT.threshold).click();
		const level = page.getByTestId(R.level);
		await expect(page.getByText("With 2 people rating, a place needs +3.")).toBeVisible();
		await level.locator(`[data-testid=${R.levelOption}][data-value="2"]`).click();
		await expect(page.getByText("With 2 people rating, a place needs +4.")).toBeVisible();
		await expect(rowOf(page, x)).toHaveAttribute("data-status", "idea");
		await page.screenshot({ path: shot("desktop-shortlist-level"), animations: "disabled" });
		await level.locator(`[data-testid=${R.levelOption}][data-value="1"]`).click();
		await expect(page.getByText("With 2 people rating, a place needs +2.")).toBeVisible();
		await expect(rowOf(page, y)).toHaveAttribute("data-status", "shortlist");
		await level.locator(`[data-testid=${R.levelOption}][data-value="1.5"]`).click();
		await expect(page.getByText("With 2 people rating, a place needs +3.")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(rowOf(page, x)).toHaveAttribute("data-status", "shortlist");
		await expect(rowOf(page, y)).toHaveAttribute("data-status", "idea");

		// Leave Audrey out: one person rating (+2), and Tokyo Tower is only +1.
		const audrey = page.locator(`[data-testid=${R.person}][data-member="${c.members.audrey}"]`).first();
		await audrey.getByTestId(R.personMenu).click();
		await page.getByTestId(R.leaveOut).click();
		await expect(audrey).toHaveAttribute("data-counted", "false");
		await expect(audrey).toContainText("not counted");
		await expect(rowOf(page, x)).toHaveAttribute("data-score", "1");
		await expect(rowOf(page, x)).toHaveAttribute("data-status", "idea");
		await expect(page.getByTestId(R.reason)).toHaveText(
			"Not on the shortlist yet: the group gave it +1, and it needs +2 with 1 person rating.",
		);
		await page.screenshot({ path: shot("desktop-left-out"), animations: "disabled" });

		// Count her again: exactly as before.
		await audrey.getByTestId(R.personMenu).click();
		await page.getByTestId(R.countAgain).click();
		await expect(audrey).toHaveAttribute("data-counted", "true");
		await expect(rowOf(page, x)).toHaveAttribute("data-score", "3");
		await expect(rowOf(page, x)).toHaveAttribute("data-status", "shortlist");
		const g = await graphOf(page);
		expect(g.nodes.find((n) => n.id === x)?.priorities[c.members.audrey]).toBe("really_want");
	});
});
