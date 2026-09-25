/**
 * PLACES §1c "Can rate" (owner, 2026-09-24): the trip link offers Can view ·
 * Can rate · Can suggest · Can edit. A signed-in friend who opens a "Can
 * rate" link becomes a rater member: they rate a place in the Rate feed
 * (their rating reaches the server) and everything else stays read-only, in
 * the UI (the place's drawer) and on the server. A plain viewer sees no
 * active rating controls (feed or drawer) and can't rate.
 * Each test makes its own owner (link resets are rate-limited per owner).
 */
import { randomBytes } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { PLACES_TAB_TESTID as PT } from "../../../src/features/places/tab/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { APP_URL, shotPath } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";

test.beforeEach(({}, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
});

type Me = { role: string; isGuest: boolean; memberId: string | null };
type G = {
	me: Me;
	nodes: { id: string; priorities: Record<string, string> }[];
};
const graphOf = (page: Page) =>
	page.evaluate(
		() =>
			(window as unknown as { __yonder?: { graph?: G } }).__yonder?.graph ??
			null,
	);

const uniq = () => randomBytes(3).toString("hex");

/** A signed-in browser for a brand-new account. */
async function account(browser: Browser, first: string, last: string) {
	const ctx = await browser.newContext({
		baseURL: APP_URL,
		viewport: { width: 1440, height: 900 },
		storageState: { cookies: [], origins: [] },
	});
	const email = `${first.toLowerCase()}-${uniq()}@example.test`;
	await loginViaApi(ctx.request, email, { first, last });
	return { ctx, email, page: await ctx.newPage() };
}

/** Calls a server function from the page, as that page's user. */
async function callFn(page: Page, mod: string, fn: string, data: unknown) {
	return page.evaluate(
		async ({ mod, fn, data }) => {
			try {
				const m = await import(/* @vite-ignore */ mod);
				await m[fn]({ data });
				return "ok";
			} catch (e) {
				const err = e as { code?: string; message?: string };
				const m =
					/\b(FORBIDDEN|NOT_FOUND|UNAUTHORIZED|VALIDATION|CONFLICT)\b/.exec(
						String(err?.message ?? e),
					);
				return String(err?.code ?? m?.[1] ?? err?.message ?? e);
			}
		},
		{ mod, fn, data },
	);
}
const NODES = "/src/functions/nodes.functions.ts";

/** The Rate feed's card in view. */
const activeCard = (page: Page) =>
	page.locator(`[data-testid=${PT.feedCard}][data-active]`);

/** The old Rate screen's link: the Places tab's Rate feed, on that place. */
async function openRate(page: Page, c: FixtureClone, nodeId: string) {
	await page.goto(`/t/${c.slug}/rate?n=${nodeId}`);
	await expect(page.getByTestId(PT.feed)).toBeVisible({ timeout: 20_000 });
	await expect(activeCard(page)).toHaveAttribute("data-place", nodeId);
}

/** The place's drawer in the Places tab. */
async function openDrawer(page: Page, c: FixtureClone, nodeId: string) {
	await page.goto(`/t/${c.slug}?tab=places&sel=n.${nodeId}`);
	const drawer = page.getByTestId(PT.drawer);
	await expect(drawer).toHaveAttribute("data-place", nodeId, {
		timeout: 20_000,
	});
	return drawer;
}

test("a friend joins with the \"Can rate\" link, rates a place, and can't change anything else", async ({
	browser,
}) => {
	const owner = await account(browser, "Olive", "Owner");
	const c = await cloneFixtureTrip(owner.ctx.request);
	const sensoji = c.ids.nodes.sensoji as string;
	const page = owner.page;
	const log = collectConsole(page);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);

	// The owner makes the one link "Can rate" (a fresh link: clones carry old ones).
	await page.getByTestId(TESTID.shareButton).click();
	const dialog = page.getByTestId(TESTID.shareDialog);
	const row = dialog.getByTestId(TESTID.shareLinkRow);
	await row.getByTestId(TESTID.shareLinkReset).click();
	await dialog.getByTestId(HOME_TESTID.resetConfirm).click();
	await row.getByTestId(HOME_TESTID.linkRole).click();
	await expect(page.getByRole("option")).toHaveText([
		"Can view",
		"Can rate",
		"Can suggest",
		"Can edit",
	]);
	await page.getByRole("option", { name: "Can rate" }).click();
	await expect(row).toHaveAttribute("data-role", "rater");
	await expect(row).toContainText("rate places once they sign in");
	const url = await row.getByTestId(TESTID.shareLinkUrl).inputValue();
	expect(url).toMatch(/\/join#t=[A-Za-z0-9_-]{43}$/);
	await page.screenshot({
		path: shotPath("home/share-link-can-rate.png"),
		animations: "disabled",
	});

	// A signed-in friend opens it: a rater MEMBER (a rating needs a member row).
	const rita = await account(browser, "Rita", "Rater");
	await rita.page.goto(url);
	await expect(rita.page).toHaveURL(new RegExp(`/t/${c.slug}`), {
		timeout: 20_000,
	});
	await expectLive(rita.page);
	await expect
		.poll(async () => (await graphOf(rita.page))?.me ?? null)
		.toMatchObject({ role: "rater", isGuest: false });
	const me = (await graphOf(rita.page))?.me.memberId as string;
	expect(me).toBeTruthy();

	// She rates Senso-ji in the Rate feed: the buttons are live for her.
	await openRate(rita.page, c, sensoji);
	const card = activeCard(rita.page);
	const must = card.locator(
		`[data-testid=${PT.feedButton}][data-priority=must]`,
	);
	await expect(must).toBeEnabled();
	await must.click();
	await expect
		.poll(
			async () =>
				(await graphOf(rita.page))?.nodes.find((n) => n.id === sensoji)
					?.priorities[me] ?? null,
		)
		.toBe("must");
	// The owner sees her rating live, and her under People as "Can rate".
	await expect
		.poll(
			async () =>
				(await graphOf(page))?.nodes.find((n) => n.id === sensoji)
					?.priorities[me] ?? null,
			{ timeout: 15_000 },
		)
		.toBe("must");
	await expect(
		dialog.getByTestId(HOME_TESTID.memberRow).filter({ hasText: "Rita" }),
	).toContainText("Can rate");

	// Everything else is read-only for her: the UI (the place's drawer: her
	// own rating is live, scheduling and dropping aren't)...
	const drawer = await openDrawer(rita.page, c, sensoji);
	await expect(
		drawer
			.getByTestId(PT.myRating)
			.locator(`[data-testid=${PT.feedButton}][data-priority=must]`),
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		drawer.getByTestId(PT.myRating).getByTestId(PT.feedButton).first(),
	).toBeEnabled();
	await expect(drawer.getByTestId(PT.addToDay)).toBeDisabled();
	await expect(drawer.getByTestId(PT.dropButton)).toBeDisabled();
	await rita.page.screenshot({
		path: shotPath("places/rate-as-rater.png"),
		animations: "disabled",
	});
	// ...and the server (never a suggestion either).
	expect(
		await callFn(rita.page, NODES, "updateNode", {
			nodeId: sensoji,
			patch: { name: "Renamed by a rater" },
		}),
	).toBe("FORBIDDEN");
	expect(
		await callFn(rita.page, NODES, "setNodePriority", {
			nodeId: sensoji,
			memberId: c.members.audrey,
			priority: "nah",
		}),
	).toBe("FORBIDDEN");
	expect(
		(await graphOf(rita.page))?.nodes.find((n) => n.id === sensoji)
			?.priorities[c.members.audrey] ?? null,
	).not.toBe("nah");

	expect(log.messages).toEqual([]);
	await rita.ctx.close();
	await owner.ctx.close();
});

test("a plain viewer sees no active rating controls and can't rate", async ({
	browser,
}) => {
	const owner = await account(browser, "Oscar", "Owner");
	const c = await cloneFixtureTrip(owner.ctx.request);
	const sensoji = c.ids.nodes.sensoji as string;
	const vic = await account(browser, "Vic", "Viewer");
	// The owner adds her as a "Can view" member.
	await owner.page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(owner.page);
	expect(
		await callFn(
			owner.page,
			"/src/features/home/sharing.functions.ts",
			"inviteMember",
			{ tripId: c.tripId, email: vic.email, role: "viewer" },
		),
	).toBe("ok");

	await vic.page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(vic.page);
	await expect
		.poll(async () => (await graphOf(vic.page))?.me ?? null)
		.toMatchObject({ role: "viewer", isGuest: false });
	const me = (await graphOf(vic.page))?.me.memberId as string;
	expect(me).toBeTruthy();

	await openRate(vic.page, c, sensoji);
	const buttons = activeCard(vic.page).getByTestId(PT.feedButton);
	await expect(buttons).toHaveCount(6);
	for (const b of await buttons.all()) await expect(b).toBeDisabled();
	// Her drawer too: no live rating buttons, and no way to rate for anyone else.
	const drawer = await openDrawer(vic.page, c, sensoji);
	const mine = drawer.getByTestId(PT.myRating).getByTestId(PT.feedButton);
	await expect(mine).toHaveCount(6);
	for (const b of await mine.all()) await expect(b).toBeDisabled();
	await vic.page.screenshot({
		path: shotPath("places/rate-as-viewer.png"),
		animations: "disabled",
	});
	// The server agrees: her own rating is refused too.
	expect(
		await callFn(vic.page, NODES, "setNodePriority", {
			nodeId: sensoji,
			memberId: me,
			priority: "must",
		}),
	).toBe("FORBIDDEN");
	await vic.ctx.close();
	await owner.ctx.close();
});
