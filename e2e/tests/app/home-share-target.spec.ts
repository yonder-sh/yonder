/**
 * E8 Share to Yonder (EXTENSIONS §10, QA SHR-01/07) and the guest line
 * (SPEC §11.2 flow 7; ADDENDUM §10 "Are you Audrey?"). The share-target POST
 * itself needs the service worker (production build); here the page is fed
 * through "Paste a link", the iOS path, which saves the same way.
 */
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { APP_URL, shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive, expectNoHorizontalOverflow, hydrated } from "./_helpers/page";
import { openLink } from "./_helpers/link";

test.use({ storageState: storageStateOf("dev") });

test("a pasted Maps link becomes an idea filed under its city, with one tap", async ({
	page,
	request,
}, info) => {
	const mobile = info.project.name === "mobile";
	const c = await cloneFixtureTrip(request);
	// The default trip is the last one used: make it this test's clone.
	await page.goto("/share");
	await page.evaluate(
		(id) => localStorage.setItem("yonder:share-last-trip", id),
		c.tripId,
	);
	await page.reload();
	await expect(page.getByTestId(TESTID.shareInbox)).toContainText(
		"Nothing to save here.",
	);
	const name = `Kissa ${randomBytes(2).toString("hex")}`;
	await (await hydrated(page.getByTestId(HOME_TESTID.sharePaste))).fill(
		`https://www.google.com/maps/place/${encodeURIComponent(name)}/@35.0037,135.7788,17z`,
	);
	await page.getByRole("button", { name: "Use" }).click();
	await expect(page.getByTestId(HOME_TESTID.shareName)).toHaveValue(name);
	await expect(page.getByTestId(HOME_TESTID.shareSave)).toBeEnabled();
	await expect(page.getByTestId(TESTID.shareInbox)).toContainText("in Kyoto");
	await expectNoHorizontalOverflow(page);
	await page.screenshot({
		path: shotPath(`home/share-inbox-${mobile ? "mobile" : "desktop"}.png`),
		animations: "disabled",
	});
	if (mobile) return;
	await page.getByTestId(HOME_TESTID.shareSave).click();
	await expect(page.getByTestId(TESTID.shareInbox)).toContainText(
		"Saved to Kyoto ideas",
		{ timeout: 15_000 },
	);
	await page.screenshot({
		path: shotPath("home/share-inbox-saved-desktop.png"),
		animations: "disabled",
	});
	// The idea is in the trip, located, under Kyoto.
	await page.getByRole("link", { name: "Open in trip" }).click();
	await expect(page.getByTestId(TESTID.workspace)).toBeVisible();
	const idea = await page.evaluate(
		(n) =>
			(
				window as unknown as {
					__yonder?: {
						graph: {
							nodes: { name: string; parentId: string | null; lat: number | null }[];
						};
					};
				}
			).__yonder?.graph.nodes.find((x) => x.name === n),
		name,
	);
	expect(idea?.parentId).toBe(c.ids.nodes.kyoto);
	expect(idea?.lat).toBeCloseTo(35.0037, 3);
});

test("a suggester's shared video becomes a suggestion where they filed it (SHR-02/05)", async ({
	browser,
	request,
}, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const c = await cloneFixtureTrip(request, { mayaRole: "suggester" });
	const ctx = await browser.newContext({
		baseURL: APP_URL,
		storageState: storageStateOf("maya"),
		viewport: { width: 1440, height: 900 },
	});
	const page = await ctx.newPage();
	await page.goto("/share");
	await page.evaluate(
		(id) => localStorage.setItem("yonder:share-last-trip", id),
		c.tripId,
	);
	await page.reload();
	const tag = randomBytes(2).toString("hex");
	await (await hydrated(page.getByTestId(HOME_TESTID.sharePaste))).fill(
		`Matcha parfait ${tag} at Tsujiri #kyoto 🍵 https://www.tiktok.com/@kyoto.eats/video/7301`,
	);
	await page.getByRole("button", { name: "Use" }).click();
	const name = `Matcha parfait ${tag} at Tsujiri`;
	await expect(page.getByTestId(HOME_TESTID.shareName)).toHaveValue(name);
	await expect(page.getByTestId(TESTID.shareInbox)).toContainText(
		"Social video",
	);
	await expect(page.getByTestId(TESTID.shareInbox)).toContainText(
		"an editor reviews it first",
	);
	// No coordinates: it would go to the top level; file it under Harajuku.
	await page.getByTestId(HOME_TESTID.shareParent).click();
	await page.getByPlaceholder("Search the trip…").fill("Haraj");
	await page.getByRole("option", { name: "Harajuku" }).click();
	await expect(page.getByTestId(HOME_TESTID.shareParent)).toHaveAccessibleName(
		/Tokyo › Harajuku/,
	);
	await page.screenshot({
		path: shotPath("home/share-inbox-suggest-desktop.png"),
		animations: "disabled",
	});
	await page.getByTestId(HOME_TESTID.shareSave).click();
	const saved = page.getByTestId(HOME_TESTID.shareSaved);
	await expect(saved).toContainText("Suggested to", { timeout: 15_000 });
	// (The link then chains onto the proposed place through its id; before
	// WP-Media's `attachment.link` core lands, the card says it couldn't.)
	await page.getByRole("link", { name: "Open in trip" }).click();
	await expect(page.getByTestId(TESTID.workspace)).toBeVisible();
	// Her own suggestion shows as a ghost under Harajuku.
	await expect
		.poll(() =>
			page.evaluate(
				(n) =>
					(
						window as unknown as {
							__yonder?: {
								ix: { outline: { name: string; parentId: string | null }[] };
							};
						}
					).__yonder?.ix.outline.find((x) => x.name === n)?.parentId ?? null,
				name,
			),
		)
		.toBe(c.ids.nodes.harajuku);
	await ctx.close();
});

test("a signed-in guest is asked 'Are you Audrey?'; the owner's 'Add to trip' makes her Audrey", async ({
	browser,
	page,
	request,
}, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const c = await cloneFixtureTrip(request);
	const ctx = await browser.newContext({ baseURL: APP_URL });
	await loginViaApi(
		ctx.request,
		`audrey-${randomBytes(3).toString("hex")}@example.test`,
		{ first: "Audrey", last: "Nguyen" },
	);
	const guest = await ctx.newPage();
	await openLink(guest, c.slug, "viewer");
	await expect(guest).toHaveURL(new RegExp(`/t/${c.slug}`), {
		timeout: 20_000,
	});
	await expectLive(guest);
	// A link never makes her a member by itself (QA A-10): she asks the owner.
	const nudge = guest.getByTestId(TESTID.guestNudge);
	await expect(nudge.getByTestId(HOME_TESTID.claimPrompt)).toContainText(
		"Are you Audrey? Ask the owner to add you",
	);
	await expect(nudge.getByTestId(HOME_TESTID.claimButton)).toHaveCount(0);
	await guest.screenshot({
		path: shotPath("home/guest-claim-desktop.png"),
		animations: "disabled",
	});
	// The owner adds her: the menu says Audrey's tags become hers.
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	await (await hydrated(page.getByTestId(TESTID.shareButton).first())).click();
	const dlg = page.getByTestId(TESTID.shareDialog);
	const grow = dlg
		.getByTestId(HOME_TESTID.guestRow)
		.filter({ hasText: "Audrey Nguyen" });
	await grow.getByTestId(HOME_TESTID.guestPromote).click();
	await expect(page.getByTestId(HOME_TESTID.guestPromoteTwin)).toContainText(
		"They become Audrey",
	);
	await page.getByRole("menuitem", { name: "Can view" }).click();
	await expect(
		dlg.getByTestId(HOME_TESTID.memberRow).filter({ hasText: "Audrey Nguyen" }),
	).toContainText("Can view");
	// The placeholder merged into her membership (no "No account yet" Audrey left).
	await expect(dlg.locator(`[data-member="${c.members.audrey}"]`)).toHaveCount(
		0,
	);
	await guest.reload();
	await expect
		.poll(() =>
			guest.evaluate(
				() =>
					(
						window as unknown as {
							__yonder?: {
								graph: { me: { role: string; isGuest: boolean } };
							};
						}
					).__yonder?.graph.me,
			),
		)
		.toMatchObject({ role: "viewer", isGuest: false });
	await ctx.close();
});
