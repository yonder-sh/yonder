/**
 * WP-Places acceptance (SPEC §18.3): the ⌘K palette with Photon (no Google
 * key in dev), the filing chip, Save to Ideas → a hollow pin, Schedule after
 * the selected item, `locate`, and the viewer checks on the provider
 * functions and the photo proxy. Photon is live, so these search real OSM data.
 */
import { expect, type Page, test } from "@playwright/test";
import { PLACES_TESTID as P } from "../../../src/features/places/testids";
import { TESTID } from "../../../src/lib/testids";
import { APP_URL, shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

type Y = {
	__yonder?: {
		graph: {
			nodes: {
				id: string;
				name: string;
				parentId: string | null;
				type: string;
				lat: number | null;
				tz: string | null;
				osmRef?: string;
			}[];
			items: { id: string; dayId: string | null; nodeId: string | null; position: string }[];
		};
		ix: unknown;
		model: { pins: { repId: string; hollow: boolean }[] };
	};
};
const graphOf = (page: Page) =>
	page.evaluate(() => (window as unknown as Y).__yonder?.graph ?? null);

async function openPalette(page: Page) {
	await page.keyboard.press("Control+k");
	await expect(page.getByTestId(TESTID.addPlaceDialog)).toBeVisible();
}

async function callFn(page: Page, fn: string, data: unknown) {
	return page.evaluate(
		async ({ fn, data }) => {
			try {
				const m = await import("/src/features/places/places.functions.ts");
				return { ok: true, value: await (m as Record<string, (a: unknown) => Promise<unknown>>)[fn]?.({ data }) };
			} catch (e) {
				return { ok: false, error: e instanceof Error ? e.message : String(e) };
			}
		},
		{ fn, data },
	);
}

test("Itoya Ginza through Photon: filed under Japan › Tokyo › Ginza, saved as an idea with a hollow pin", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop palette");
	test.setTimeout(90_000);
	// Headless WebGL (MapLibre) logs driver performance notes.
	// (and the OpenFreeMap style's expression fallbacks).
	const logs = collectConsole(page, [/GL Driver Message|WebGL|layers\[[^\]]+\]\.filter/]);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=place`);
	await expectLive(page);
	await openPalette(page);
	await page.getByTestId(P.paletteInput).fill("Itoya Ginza");
	// "In this trip" finds the existing node; Photon finds the shop.
	await expect(page.getByTestId(P.paletteTripResult).first()).toContainText("Itoya Ginza");
	const result = page.getByTestId(P.paletteResult).filter({ hasText: "Itoya" }).first();
	await expect(result).toBeVisible({ timeout: 20_000 });
	await result.click();
	const preview = page.getByTestId(P.previewCard);
	await expect(preview.getByTestId(P.filingChip)).toContainText("Japan", { timeout: 20_000 });
	await expect(preview.getByTestId(P.filingChip)).toContainText(/Japan\s*›\s*Tokyo\s*›\s*Ginza\s*\(new\)/);
	// It notices the trip already has Itoya.
	await expect(preview).toContainText("Already in");
	await page.screenshot({ path: shotPath("places/palette-preview-1440.png"), animations: "disabled" });
	await preview.getByTestId(P.saveToIdeas).click();
	await expect(page.getByTestId(TESTID.addPlaceDialog)).toBeHidden();

	let created: { id: string; parentId: string | null } | undefined;
	await expect
		.poll(async () => {
			const g = await graphOf(page);
			const ginza = g?.nodes.find((n) => n.name === "Ginza" && n.type === "area");
			created = g?.nodes.find((n) => n.name === "Itoya" && n.parentId === ginza?.id);
			return created ? "ok" : "missing";
		}, { timeout: 15_000 })
		.toBe("ok");
	const g = await graphOf(page);
	const itoya = g?.nodes.find((n) => n.id === created?.id);
	expect(itoya?.lat).not.toBeNull();
	expect(itoya?.tz).toBe("Asia/Tokyo");
	// An idea: a hollow pin at the place lens.
	await expect
		.poll(() =>
			page.evaluate(
				(id) => (window as unknown as Y).__yonder?.model.pins.find((p) => p.repId === id)?.hollow ?? null,
				created?.id,
			),
		)
		.toBe(true);

	// The same OSM result again: matched by its OSM ref (GraphNode.osmRef), so the
	// notice names the new "Itoya" in Ginza, not the similar "Itoya Ginza".
	expect(itoya?.osmRef).toMatch(/^[NWR]\d+$/);
	await openPalette(page);
	await page.getByTestId(P.paletteInput).fill("Itoya Ginza");
	await page.getByTestId(P.paletteResult).filter({ hasText: "Itoya" }).first().click();
	await expect(preview).toContainText("Already in", { timeout: 20_000 });
	await expect(preview).toContainText(/Itoya\s*\(Ginza\)/);
	expect(logs.messages).toEqual([]);
});

test("Schedule inserts the new place right after the selected item", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop palette");
	test.setTimeout(90_000);
	const c = await cloneFixtureTrip(page.request);
	const hands = c.ids.items.hands as string;
	await page.goto(`/t/${c.slug}/japan/tokyo?sel=i.${hands}`);
	await expectLive(page);
	await openPalette(page);
	await page.getByTestId(P.paletteInput).fill("Tokyo Tower");
	const result = page.getByTestId(P.paletteResult).filter({ hasText: "Tokyo Tower" }).first();
	await expect(result).toBeVisible({ timeout: 20_000 });
	await result.click();
	const schedule = page.getByTestId(P.previewCard).getByTestId(P.schedule);
	await expect(schedule).toContainText("After Hands Shibuya", { timeout: 20_000 });
	await schedule.click();
	await expect(page.getByTestId(TESTID.addPlaceDialog)).toBeHidden();
	await expect
		.poll(async () => {
			const g = await graphOf(page);
			const day1 = g?.items
				.filter((i) => i.dayId === g.items.find((x) => x.id === hands)?.dayId)
				.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
			const at = day1?.findIndex((i) => i.id === hands) ?? -1;
			const next = day1?.[at + 1];
			return g?.nodes.find((n) => n.id === next?.nodeId)?.name ?? null;
		}, { timeout: 15_000 })
		.toMatch(/Tokyo Tower/);
});

test("locate gives a node without coordinates its location and zone", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop palette");
	test.setTimeout(90_000);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/kyoto`);
	await expectLive(page);
	// Add an unlocated place by name ("Add “…” as a new place in Kyoto").
	await openPalette(page);
	await page.getByTestId(P.paletteInput).fill("Nishiki Market");
	await page.getByRole("option", { name: /Add “Nishiki Market” as a new place in Kyoto/ }).click();
	let nodeId: string | undefined;
	await expect
		.poll(async () => {
			nodeId = (await graphOf(page))?.nodes.find((n) => n.name === "Nishiki Market")?.id;
			return nodeId ?? null;
		}, { timeout: 15_000 })
		.not.toBeNull();
	expect((await graphOf(page))?.nodes.find((n) => n.id === nodeId)?.lat).toBeNull();

	await page.goto(`/t/${c.slug}/japan/kyoto?sel=n.${nodeId}`);
	await page.getByTestId(P.setLocation).click();
	const dialog = page.getByTestId(TESTID.addPlaceDialog);
	await expect(dialog).toContainText("Set location for Nishiki Market");
	// The search starts from the node's name.
	await expect(page.getByTestId(P.paletteInput)).toHaveValue("Nishiki Market");
	const result = page.getByTestId(P.paletteResult).first();
	await expect(result).toBeVisible({ timeout: 20_000 });
	await result.click();
	await page.getByTestId(P.useLocation).click();
	await expect(dialog).toBeHidden();
	await expect
		.poll(async () => (await graphOf(page))?.nodes.find((n) => n.id === nodeId)?.tz ?? null, {
			timeout: 15_000,
		})
		.toBe("Asia/Tokyo");
});

test("a viewer can't use the provider functions or the preview photo route", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const ownerCtx = await browser.newContext({ storageState: storageStateOf("dev") });
	const owner = await ownerCtx.newPage();
	const c = await cloneFixtureTrip(owner.request);
	// A signed-out browser (test.use's storageState would otherwise sign it in as the owner).
	const guestCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const guest = await guestCtx.newPage();
	const logs = collectConsole(guest, [/Failed to load resource: the server responded with a status of 40[34]/]);
	await guest.goto(`${APP_URL}/join#t=${c.shareTokens.viewer}`);
	await expect(guest).toHaveURL(new RegExp(`/t/${c.slug}`), { timeout: 20_000 });
	await expectLive(guest);

	const preview = await callFn(guest, "getPlacePreview", {
		tripId: c.tripId,
		provider: "photon",
		ref: "osm:W608331102",
		sessionToken: "x",
	});
	expect(preview.ok).toBe(false);
	expect(preview.ok ? "" : preview.error).toMatch(/FORBIDDEN|permission|name/i);
	const search = await callFn(guest, "searchPlaces", { tripId: c.tripId, q: "Itoya", sessionToken: "x" });
	expect(search.ok).toBe(false);

	// The preview photo route needs searchPlaces: a viewer gets 403.
	const photo = await guest.request.get(
		`/api/places/photo/p?tripId=${c.tripId}&placeId=ChIJ8T1GpMGOGGARDYGSgpooDWw&idx=0&w=400`,
	);
	expect(photo.status()).toBe(403);
	// A forged or unknown reference never reaches Google: bad input is refused.
	const forged = await owner.request.get(
		`/api/places/photo/p?tripId=${c.tripId}&placeId=places%2F..%2F..%2Fx&idx=0&w=400`,
	);
	expect([400, 404]).toContain(forged.status());
	const badIdx = await owner.request.get(`/api/places/photo/p?nodeId=${c.ids.nodes.itoya}&idx=99&w=400`);
	expect(badIdx.status()).toBe(400);
	// Search affordances are hidden for the viewer: the palette only finds places in the trip.
	await guest.keyboard.press("Control+k");
	await expect(guest.getByTestId(P.paletteInput)).toHaveAttribute("placeholder", /Find a place in this trip/);
	expect(logs.messages.filter((m) => !/403|FORBIDDEN/.test(m))).toEqual([]);
	await guestCtx.close();
	await ownerCtx.close();
});

test("the palette is full-screen on phones, with the preview stacked", async ({ page }, info) => {
	test.skip(info.project.name !== "mobile", "phone layout");
	test.setTimeout(90_000);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo`);
	await expectLive(page);
	await page.getByTestId(TESTID.fab).click();
	// The merged shell's + opens a small menu (place, expense…) first.
	const place = page.getByTestId("fab-place");
	await expect(place.or(page.getByTestId(P.paletteInput))).toBeVisible();
	if (await place.isVisible()) await place.click();
	await page.getByTestId(P.paletteInput).fill("Senso-ji");
	const result = page.getByTestId(P.paletteResult).first();
	await expect(result).toBeVisible({ timeout: 20_000 });
	await result.click();
	await expect(page.getByTestId(P.previewCard).getByTestId(P.filingChip)).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId(P.saveToIdeas)).toBeInViewport();
	await page.screenshot({ path: shotPath("places/palette-preview-390.png"), animations: "disabled" });
});

test("a shared Google Maps link resolves to its place and notices it's already in the trip (E8)", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	test.setTimeout(60_000);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const r = await callFn(page, "resolveSharedLink", {
		tripId: c.tripId,
		url: "https://www.google.com/maps/place/Itoya/@35.6729,139.7678,17z/data=!3m1!4b1!4m6!3m5!8m2!3d35.6729335!4d139.7678324",
	});
	expect(r.ok).toBe(true);
	const value = (r as { value: { preview: { name: string; filing: unknown } | null; existing?: { nodeId: string; crumb: string } } }).value;
	expect(value.preview?.name).toMatch(/Itoya/);
	expect(value.existing?.nodeId).toBe(c.ids.nodes.itoya);
	expect(value.existing?.crumb).toBe("Japan › Tokyo");
	// Anything that isn't a Google Maps URL resolves to nothing (and is never fetched).
	const other = await callFn(page, "resolveSharedLink", { tripId: c.tripId, url: "http://169.254.169.254/latest" });
	expect(other.ok).toBe(true);
	expect((other as { value: { preview: unknown } }).value.preview).toBeNull();
});
