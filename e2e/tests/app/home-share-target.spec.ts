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
	// No provider knows the name: the pin is filed by its spot's address,
	// Photon's reverse geocode (Kyoto › Higashiyama Ward › Rinka-cho), under
	// Kyoto in a new neighbourhood. ("in Kyoto" alone is only the guess shown
	// while that answer is on its way.)
	await expect(page.getByTestId(TESTID.shareInbox)).toContainText(
		"in Rinka-cho (new)",
	);
	await expectNoHorizontalOverflow(page);
	await page.screenshot({
		path: shotPath(`home/share-inbox-${mobile ? "mobile" : "desktop"}.png`),
		animations: "disabled",
	});
	if (mobile) return;
	await page.getByTestId(HOME_TESTID.shareSave).click();
	await expect(page.getByTestId(TESTID.shareInbox)).toContainText(
		"Saved to Rinka-cho ideas",
		{ timeout: 15_000 },
	);
	await page.screenshot({
		path: shotPath("home/share-inbox-saved-desktop.png"),
		animations: "disabled",
	});
	// The idea is in the trip, located, under Kyoto's new Rinka-cho.
	await page.getByRole("link", { name: "Open in trip" }).click();
	await expect(page.getByTestId(TESTID.workspace)).toBeVisible();
	const nodes = await page.evaluate(
		() =>
			(
				window as unknown as {
					__yonder?: {
						graph: {
							nodes: { id: string; name: string; parentId: string | null; lat: number | null }[];
						};
					};
				}
			).__yonder?.graph.nodes ?? [],
	);
	const idea = nodes.find((x) => x.name === name);
	const area = nodes.find((x) => x.id === idea?.parentId);
	expect(area?.name).toBe("Rinka-cho");
	expect(area?.parentId).toBe(c.ids.nodes.kyoto);
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

test("a signed-in guest named Audrey gets Join the trip, no claim; the owner's 'Add to trip' makes her Audrey", async ({
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
	// A link never makes her a member by itself (QA A-10): she can join, but
	// only the owner can make her Audrey.
	const nudge = guest.getByTestId(TESTID.guestNudge);
	await expect(nudge.getByTestId(HOME_TESTID.joinTrip)).toBeVisible();
	await expect(nudge.getByTestId(HOME_TESTID.claimPrompt)).toHaveCount(0);
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

test("the iOS Shortcut's address opens the saver on the shared link, no paste", async ({ page, request }, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const c = await cloneFixtureTrip(request);
	await page.goto("/share");
	await page.evaluate((id) => localStorage.setItem("yonder:share-last-trip", id), c.tripId);
	const tag = randomBytes(2).toString("hex");
	const url = "https://www.tiktok.com/@kyoto.eats/video/7302";
	await page.goto(`/share?${new URLSearchParams({ url, text: `Hojicha ${tag} at Kagizen ${url}` })}`);
	await expect(page.getByTestId(HOME_TESTID.shareName)).toHaveValue(`Hojicha ${tag} at Kagizen`);
	await expect(page.getByTestId(TESTID.shareInbox)).toContainText("Social video");
	await expect(page.getByTestId(HOME_TESTID.shareSave)).toBeEnabled();
});

test("⌘K: a pasted reel goes onto the open place in one step", async ({ page, request }, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const c = await cloneFixtureTrip(request);
	const place = c.ids.nodes.harajuku as string;
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/t/${c.slug}?tab=plan&sel=n.${place}`);
	await expectLive(page);
	await page.keyboard.press("Control+k");
	await expect(page.getByTestId(TESTID.addPlaceDialog)).toBeVisible();
	const reel = `https://www.instagram.com/reel/C9${randomBytes(3).toString("hex")}/`;
	await page.getByTestId("places-palette-input").fill(reel);
	await expect(page.getByText(/as a new/)).toHaveCount(0);
	// D10: asked right here, the open place among the choices.
	await expect(page.getByText("Add it to a place, or save a new one?")).toBeVisible();
	await expect(page.getByTestId("places-link-preview")).toContainText("Instagram reel");
	await page.getByTestId("places-add-link-to").click();
	await expect(page.getByText(/^Link added to /)).toBeVisible();
	await expect
		.poll(async () =>
			page.evaluate(
				async ({ tripId, reel }) => {
					const m = await import(/* @vite-ignore */ "/src/features/media/media.functions.ts");
					const all = (await m.listTripMedia({ data: { tripId } })) as { url: string | null; target: { kind: string; nodeId?: string } }[];
					return all.find((x) => x.url === reel)?.target ?? null;
				},
				{ tripId: c.tripId, reel },
			),
		)
		.toEqual({ kind: "node", nodeId: place });
});

test("⌘K: ⌘Enter is New place…: the search makes the place, and the reel goes on it", async ({ page, request }, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
	const c = await cloneFixtureTrip(request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=plan`);
	await expectLive(page);
	await page.keyboard.press("Control+k");
	await expect(page.getByTestId(TESTID.addPlaceDialog)).toBeVisible();
	const reel = `https://www.instagram.com/reel/C9${randomBytes(3).toString("hex")}/`;
	const input = page.getByTestId("places-palette-input");
	await input.fill(reel);
	await expect(page.getByTestId("places-link-new-place")).toContainText("Filed under Japan › Tokyo");
	await page.keyboard.press("Control+Enter");
	// D10: the search, empty, the link waiting (never a place named after the caption).
	await expect(input).toHaveValue("");
	await expect(page.getByTestId("places-link-pending")).toContainText("Adding the link:");
	const name = `Kissa ${randomBytes(2).toString("hex")}`;
	await input.fill(name);
	await page.getByRole("option", { name: `Add “${name}” as a new place in Tokyo` }).click();
	await expect(page.getByText(`Added ${name}`)).toBeVisible();
	await expect
		.poll(async () =>
			page.evaluate(
				async ({ tripId, reel }) => {
					const m = await import(/* @vite-ignore */ "/src/features/media/media.functions.ts");
					const all = (await m.listTripMedia({ data: { tripId } })) as { url: string | null; target: { kind: string; nodeId?: string } }[];
					const id = all.find((x) => x.url === reel)?.target.nodeId;
					const g = (window as unknown as { __yonder?: { graph: { nodes: { id: string; type: string; name: string; parentId: string | null }[] } } }).__yonder?.graph;
					const n = g?.nodes.find((x) => x.id === id);
					return n ? { type: n.type, name: n.name, parentId: n.parentId } : null;
				},
				{ tripId: c.tripId, reel },
			),
		)
		.toEqual({ type: "place", name, parentId: c.ids.nodes.tokyo });
});
