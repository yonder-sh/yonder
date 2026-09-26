/**
 * WP-Places fixes from the I2 QA round, on the QA seed (`pnpm db:seed:qa`,
 * trip `asia-2027`). Read-only: palettes and pickers are opened and closed,
 * nothing is saved, so the file can run against any tree with the seed.
 *
 * - SHR-07: a shared Maps link to Itoya finds "Itoya (G.Itoya)" (~110 m off).
 * - HIER-12: Set location takes a pasted "lat, lng" and refuses 135, 500.
 * - PLAN-R2-01/02: the pasted pair replaces the stale name search (no
 *   Ningbo or Vancouver hits above it; "Use this location" is the chosen
 *   option), and its preview is the node itself, never the nearest bar.
 * - PLAN-R2-10 (HIER-10): "Shinjuku" also lists the Fuji Excursion leg.
 * - PLAN-I2-07: the Places tab (the old Rate screen's table) counts places
 *   and neighbourhoods, not the importer's wards (Fujinomiya, Haneda,
 *   Setagaya…).
 * - A11Y-02 (VIS-23): choosing or closing a ⌘K result never drops focus to <body>.
 * - A11Y-01 (VIS-08, VIS-21): the place panel's controls are named; the
 *   Rate feed card's mini-map has nothing focusable inside role="img" and
 *   logs no style warnings (the Yonder basemap, PLAN-I2-16).
 *
 *   APP_URL=http://localhost:<port> DEV_FIXED_OTP=000000 N pnpm e2e -- tests/app/places-qa-fixes.spec.ts --project chromium
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type Page, test } from "@playwright/test";
import { PLACES_TAB_TESTID as PT } from "../../../src/features/places/tab/testids";
import { PLACES_TESTID as P } from "../../../src/features/places/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";

const TRIP = "asia-2027";

async function openTrip(page: Page, url: string): Promise<void> {
	await page.goto(url);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(() => page.evaluate(() => !!(window as unknown as { __yonder?: unknown }).__yonder))
		.toBe(true);
}

async function nodeId(page: Page, name: string): Promise<string> {
	const id = await page.evaluate(
		(n) =>
			(
				window as unknown as { __yonder: { graph: { nodes: { id: string; name: string }[] } } }
			).__yonder.graph.nodes.find((x) => x.name === n)?.id,
		name,
	);
	if (!id) throw new Error(`no node ${name}`);
	return id;
}

const activeInfo = (page: Page) =>
	page.evaluate(() => {
		const a = document.activeElement;
		return {
			body: a === document.body || a === null,
			inInspector: !!a?.closest('[data-testid="inspector"]'),
		};
	});

function axeSource(): string | null {
	const env = process.env.AXE_CORE_PATH;
	if (env && existsSync(env)) return readFileSync(env, "utf8");
	try {
		return readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
	} catch {
		return null;
	}
}

async function axeIds(page: Page, src: string, scope?: string): Promise<{ id: string; targets: string[] }[]> {
	await page.evaluate(src);
	return page.evaluate(async (sel) => {
		const axe = (
			window as unknown as {
				axe: {
					run: (
						c: Element | Document,
						o: object,
					) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }>;
				};
			}
		).axe;
		const root = sel ? (document.querySelector(sel) ?? document) : document;
		const r = await axe.run(root, { resultTypes: ["violations"] });
		return r.violations
			.filter((v) => v.impact === "critical" || v.impact === "serious")
			.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target.join(" ")) }));
	}, scope ?? null);
}

test.beforeEach(async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one desktop run is enough");
	await loginViaApi(page.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
	const res = await page.goto(`/t/${TRIP}?tab=plan`);
	test.skip(!res || res.status() >= 400, "needs the QA seed (pnpm db:seed:qa)");
});

test("SHR-07: a shared Maps link to Itoya finds the Itoya already in the trip", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	await page.keyboard.press("Control+k");
	const dialog = page.getByTestId(TESTID.addPlaceDialog);
	await dialog.getByTestId(P.paletteInput).fill("https://www.google.com/maps/place/Itoya/@35.6739,139.7676,17z");
	await dialog.getByRole("option", { name: /Save the place in this Maps link/ }).click();
	const preview = dialog.getByTestId(P.previewCard);
	await expect(preview).toContainText(/Already in .*: Itoya \(G\.Itoya\)/, { timeout: 20_000 });
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
});

test("HIER-12: Set location takes pasted coordinates and refuses an out-of-range pair", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	const bar = await nodeId(page, "Bar Kuro");
	await openTrip(page, `/t/${TRIP}?sel=n.${bar}`);
	await page.getByTestId("inspector").getByTestId(P.setLocation).click();
	const dialog = page.getByTestId(TESTID.addPlaceDialog);
	const input = dialog.getByTestId(P.paletteInput);
	await input.fill("35.6941, 139.7045");
	await expect(dialog.getByTestId(P.coordsResult)).toContainText("Use this location");
	await expect(dialog.getByTestId(P.coordsResult)).toContainText("35.69410, 139.70450");
	await input.fill("135, 500");
	await expect(dialog.getByTestId(P.coordsError)).toContainText(/out of range/);
	await expect(dialog.getByTestId(P.coordsResult)).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
});

test("PLAN-R2-01/02: pasted coordinates replace the stale search; Enter previews the node at that spot", async ({
	page,
}) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	const bar = await nodeId(page, "Bar Kuro");
	await openTrip(page, `/t/${TRIP}?sel=n.${bar}`);
	await page.getByTestId("inspector").getByTestId(P.setLocation).click();
	const dialog = page.getByTestId(TESTID.addPlaceDialog);
	const input = dialog.getByTestId(P.paletteInput);
	// The dialog searches "Bar Kuro" first (around Golden Gai); let it land.
	await page.waitForTimeout(2500);
	await input.fill("35.6941, 139.7045");
	await expect(dialog.getByTestId(P.coordsResult)).toHaveAttribute("aria-selected", "true");
	await page.waitForTimeout(800);
	await expect(dialog.getByTestId(P.paletteResult)).toHaveCount(0);
	await expect(dialog.getByRole("option").first()).toHaveAttribute("data-testid", P.coordsResult);
	// ↵ chooses the pasted spot: the preview is Bar Kuro there, not a bar nearby.
	await page.keyboard.press("Enter");
	const preview = dialog.getByTestId(P.previewCard);
	await expect(preview).toContainText("Bar Kuro", { timeout: 20_000 });
	await expect(preview).toContainText("35.69410, 139.70450");
	await expect(preview.getByRole("heading")).toHaveText("Bar Kuro");
	// Nothing saved: back out.
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
});

test("PLAN-R2-10 (HIER-10): searching 'Shinjuku' lists the ward once and the Fuji Excursion leg", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	await page.keyboard.press("Control+k");
	const dialog = page.getByTestId(TESTID.addPlaceDialog);
	await dialog.getByTestId(P.paletteInput).fill("Shinjuku");
	await expect(dialog.getByTestId(P.paletteTripResult).filter({ hasText: /^Shinjuku/ })).toHaveCount(1);
	const leg = dialog.getByTestId(P.paletteTripLeg).filter({ hasText: "Fuji Excursion" });
	await expect(leg).toHaveCount(1);
	await expect(leg).toContainText(/Leg · Day \d+/);
	await dialog.getByTestId(P.paletteInput).fill("fuji excursion");
	await expect(dialog.getByTestId(P.paletteTripLeg).filter({ hasText: "Fuji Excursion" })).toHaveCount(1);
	// Enter jumps to the leg.
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/sel=l\./);
});

test("A11Y-02: choosing or closing a ⌘K result keeps the focus visible, never on <body>", async ({ page }) => {
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	await page.keyboard.press("Control+k");
	const dialog = page.getByTestId(TESTID.addPlaceDialog);
	await dialog.getByTestId(P.paletteInput).fill("golden gai");
	await expect(dialog.getByTestId(P.paletteTripResult).first()).toContainText("Golden Gai");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/sel=n\./);
	await expect.poll(() => activeInfo(page)).toEqual({ body: false, inInspector: true });
	// Esc: back where it was (a hotkey from nowhere lands on the ⌘K button).
	await page.keyboard.press("Control+k");
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect.poll(async () => (await activeInfo(page)).body).toBe(false);
});

test("A11Y-01: named selects in the place inspector; a clean, image-only mini-map on the Rate feed's card", async ({ page }) => {
	const src = axeSource();
	await openTrip(page, `/t/${TRIP}?tab=plan`);
	const gg = await nodeId(page, "Golden Gai");
	await openTrip(page, `/t/${TRIP}/japan/tokyo/shinjuku?lens=place&sel=n.${gg}`);
	// The category in the place's header; the time needed (a button named by its value) in its About.
	await expect(page.getByTestId(TESTID.inspector).getByRole("combobox", { name: "Category" })).toBeVisible();
	await expect(page.getByTestId(TESTID.nodeOverview).getByTestId(PT.timeCell)).toBeVisible();
	if (src) {
		const hits = await axeIds(page, src, '[data-testid="inspector"]');
		expect(hits.filter((h) => h.id === "button-name")).toEqual([]);
	}

	const warnings: string[] = [];
	page.on("console", (m) => {
		const t = m.text();
		if (/layers\[[^\]]+\]|could not be loaded|openfreemap\.org\/styles/.test(t)) warnings.push(t);
	});
	const styleUrls: string[] = [];
	page.on("request", (r) => {
		if (/tiles\.openfreemap\.org\/styles\//.test(r.url())) styleUrls.push(r.url());
	});
	const sky = await nodeId(page, "Shibuya Sky");
	for (const scheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		// The old Rate screen's link: the Places tab's Rate feed, on Shibuya Sky (no photos: its mini-map).
		await page.goto(`/t/${TRIP}/rate?n=${sky}`);
		const card = page.locator(`[data-testid="${PT.feedCard}"][data-active]`);
		await expect(card).toHaveAttribute("data-place", sky, { timeout: 30_000 });
		await expect(card.getByRole("img", { name: /Shibuya Sky/ })).toBeVisible({ timeout: 15_000 });
		await page.waitForTimeout(2500);
		if (src) {
			const hits = await axeIds(page, src, `[data-testid="${PT.feedCard}"][data-active]`);
			expect(hits.filter((h) => h.id === "nested-interactive")).toEqual([]);
		}
	}
	expect(styleUrls).toEqual([]);
	expect(warnings).toEqual([]);
});

test("PLAN-I2-07: the Places tab lists places and neighbourhoods, not structural wards", async ({ page }) => {
	// The old Rate screen's table link opens the Places tab's table.
	await page.goto(`/t/${TRIP}/rate?view=table`);
	await expect(page.getByTestId(PT.table)).toBeVisible({ timeout: 30_000 });
	const rows = page.getByTestId(PT.row);
	await expect(rows.first()).toBeVisible();
	const ids = await page.evaluate(() => {
		const g = (window as unknown as { __yonder?: { graph: { nodes: { id: string; name: string }[] } } }).__yonder
			?.graph;
		const byName = (n: string) => g?.nodes.find((x) => x.name === n)?.id ?? null;
		return {
			shinjuku: byName("Shinjuku"),
			wards: ["Fujinomiya", "Haneda", "Setagaya", "Nagoya Station"].map(byName),
		};
	});
	expect(ids.shinjuku).toBeTruthy();
	await expect(page.locator(`[data-testid="${PT.row}"][data-row-id="${ids.shinjuku}"]`)).toHaveCount(1);
	for (const id of ids.wards) {
		expect(id).toBeTruthy();
		await expect(page.locator(`[data-testid="${PT.row}"][data-row-id="${id}"]`)).toHaveCount(0);
	}
	const progress = await page
		.getByTestId(PT.progress)
		.locator("[data-member][data-counted]")
		.evaluateAll((els) => els.map((e) => e.textContent ?? ""));
	const totals = progress.map((t) => Number(/\d+\/(\d+)/.exec(t)?.[1]));
	expect(totals.length).toBeGreaterThan(0);
	// The sheet's 125 Places rows plus the QA fixtures' own places; never the 156 with wards.
	for (const t of totals) expect(t).toBeLessThan(140);
	test.info().annotations.push({ type: "progress", description: progress.join(" | ") });
});

