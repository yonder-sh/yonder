/**
 * I2 verifier "visual" (round 1): MOB, A11Y, UX and EMPTY scenarios
 * (qa/SCENARIOS §23, §24, §26) on the QA seed (`pnpm db:seed:qa`, trip
 * `asia-2027`, qa/SCENARIOS §1), checked against DESIGN.md.
 *
 * Every test is READ-ONLY on the seeded trip. The EMPTY-01/02 tests sign up a
 * brand-new user each run and create one empty trip for it. Tests titled
 * "DEFECT" encode the expected behaviour of an open bug and fail until it is
 * fixed; the others are passing guards.
 *
 * axe: `axe-core` is not an e2e dependency. The A11Y-01 test injects
 * `axe.min.js` from AXE_CORE_PATH (or a resolvable `axe-core`) and is skipped
 * without it.
 *
 *   APP_URL=http://localhost:<port> DEV_FIXED_OTP=000000 AXE_CORE_PATH=… \
 *     N pnpm e2e -- tests/app/qa-visual-a11y.spec.ts --project chromium
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { devices, expect, type Page, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { APP_URL } from "./_helpers/env";
import { expectNoHorizontalOverflow, hydrated, openOrganize } from "./_helpers/page";

const TRIP = "asia-2027";
const QA = {
	dennis: { email: "dennis@asia2027.test", first: "Dennis", last: "Tester" },
	audrey: { email: "audrey@asia2027.test", first: "Audrey", last: "Tester" },
} as const;
const GOLDEN_GAI_PATH = "japan/tokyo/shinjuku";

async function signIn(page: Page, who: keyof typeof QA): Promise<void> {
	const u = QA[who];
	await loginViaApi(page.request, u.email, { first: u.first, last: u.last });
}

async function openTrip(page: Page, url: string): Promise<void> {
	await page.goto(url);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(() => page.evaluate(() => !!(window as unknown as { __yonder?: unknown }).__yonder))
		.toBe(true);
	await page.waitForTimeout(1500);
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

const box = (page: Page, sel: string) =>
	page.locator(sel).first().evaluate((e) => {
		const r = e.getBoundingClientRect();
		return { w: Math.round(r.width), h: Math.round(r.height) };
	});

function axeSource(): string | null {
	const env = process.env.AXE_CORE_PATH;
	if (env && existsSync(env)) return readFileSync(env, "utf8");
	try {
		const req = createRequire(import.meta.url);
		return readFileSync(req.resolve("axe-core/axe.min.js"), "utf8");
	} catch {
		return null;
	}
}

type AxeHit = { id: string; impact: string; nodes: string[] };
async function axeSerious(page: Page, src: string): Promise<AxeHit[]> {
	await page.evaluate(src);
	return page.evaluate(async () => {
		const axe = (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe;
		const r = await axe.run(document, { resultTypes: ["violations"] });
		return r.violations
			.filter((v) => v.impact === "critical" || v.impact === "serious")
			.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
	});
}

// ---------------------------------------------------------------------------
// Desktop
// ---------------------------------------------------------------------------
test.describe("desktop", () => {
	test.beforeEach(({}, info) => {
		test.skip(info.project.name !== "chromium", "desktop project only");
	});
	test.use({ viewport: { width: 1440, height: 900 } });

	test("DEFECT A11Y-01: axe finds no critical or serious violations (light + dark)", async ({ page }) => {
		const src = axeSource();
		test.skip(!src, "set AXE_CORE_PATH to axe-core's axe.min.js");
		await signIn(page, "dennis");
		const found: string[] = [];
		for (const scheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: scheme });
			const pages: [string, string][] = [
				["dashboard", "/dashboard"],
				["timeline", `/t/${TRIP}/japan/tokyo?days=2027-10-05&lens=place`],
				["rollups", `/t/${TRIP}/japan/tokyo?tab=lists`],
				["money", `/t/${TRIP}?tab=money`],
			];
			for (const [name, url] of pages) {
				if (url === "/dashboard") {
					await page.goto(url);
					await page.waitForTimeout(2000);
				} else await openTrip(page, url);
				for (const v of await axeSerious(page, src as string))
					found.push(`${scheme} ${name}: ${v.id} (${v.impact}) ${v.nodes.join(" | ")}`);
			}
			await openTrip(page, `/t/${TRIP}/${GOLDEN_GAI_PATH}?lens=place`);
			const gg = await nodeId(page, "Golden Gai");
			await openTrip(page, `/t/${TRIP}/${GOLDEN_GAI_PATH}?lens=place&sel=n.${gg}`);
			for (const v of await axeSerious(page, src as string))
				found.push(`${scheme} inspector: ${v.id} (${v.impact}) ${v.nodes.join(" | ")}`);
			await page.getByTestId("share-button").click();
			await expect(page.getByTestId("share-dialog")).toBeVisible();
			// Let the open animation finish: axe reads the fading-in text as low contrast (round 3).
			await page.waitForTimeout(700);
			for (const v of await axeSerious(page, src as string))
				found.push(`${scheme} share: ${v.id} (${v.impact}) ${v.nodes.join(" | ")}`);
			await page.keyboard.press("Escape");
		}
		expect(found, found.join("\n")).toEqual([]);
	});

	test("DEFECT A11Y-03: the map region offers an ordered Stops list", async ({ page }) => {
		await signIn(page, "dennis");
		await openTrip(page, `/t/${TRIP}/japan/tokyo?days=2027-10-05&lens=place`);
		const map = page.getByTestId("trip-map");
		await expect(map.getByRole("region", { name: /^Map of Tokyo/ })).toBeVisible();
		// DESIGN §13 / QA A11Y-03: a text alternative with the same content as the pins and edges.
		await expect(map.getByRole("list", { name: /stops/i })).toBeVisible();
	});

	test("A11Y-02 guard: the Tue 5 Oct timeline is operable from the keyboard (nothing saved)", async ({ page }) => {
		await signIn(page, "dennis");
		await openTrip(page, `/t/${TRIP}/japan/tokyo?days=2027-10-05&lens=place`);
		const order = () =>
			page.locator('[data-testid="timeline-item"]').evaluateAll((els) => els.map((e) => e.textContent?.slice(0, 40)));
		await expect(page.locator('[data-testid="timeline-item"]').filter({ hasText: "Golden Gai" }).first()).toBeVisible();
		const before = await order();
		// "+" between cards: Enter opens Place… / Flight… / blocks; Esc closes it.
		await page.getByRole("button", { name: "Add here" }).last().focus();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("menuitem", { name: /Place/ })).toBeVisible();
		await expect(page.getByRole("menuitem", { name: "Rest" })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("menuitem", { name: "Rest" })).toHaveCount(0);
		// Keyboard drag: Space picks up, arrows move (announced), Esc cancels.
		const card = page.locator('[data-testid="timeline-item"]').filter({ hasText: "Golden Gai" }).first();
		await card.getByRole("button", { name: /^Move Golden Gai/ }).focus();
		await page.keyboard.press("Space");
		await page.waitForTimeout(300);
		await page.keyboard.press("ArrowUp");
		await page.waitForTimeout(300);
		await expect(page.locator("[aria-live]").filter({ hasText: /Golden Gai/ }).first()).toBeAttached();
		await page.keyboard.press("Escape");
		await page.waitForTimeout(500);
		// (That Esc also clears the day range: see the DEFECT test below. Reload the view.)
		await openTrip(page, `/t/${TRIP}/japan/tokyo?days=2027-10-05&lens=place`);
		expect(await order()).toEqual(before);
		// Duration and pin popovers open with Enter and close with Esc.
		await card.getByRole("button", { name: /^\d+h?\d*m?$/ }).first().focus();
		await page.keyboard.press("Enter");
		await expect(page.locator('[data-slot="popover-content"]')).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
		await card.getByRole("button", { name: /Set start time/ }).focus();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("textbox", { name: /Start time/ })).toBeFocused();
		await page.keyboard.press("Escape");
		// Enter on a card opens its details (the list path to Golden Gai, not the canvas).
		await card.getByRole("button", { name: "Golden Gai", exact: true }).focus();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("inspector")).toContainText("Golden Gai");
	});

	test("DEFECT A11Y-02: Esc that cancels a keyboard drag doesn't also run the Esc chain", async ({ page }) => {
		await signIn(page, "dennis");
		// Outline: cancelling a row drag must not zoom out.
		await openTrip(page, `/t/${TRIP}/${GOLDEN_GAI_PATH}?days=2027-10-05`);
		// One Yonder: the tree is Organize places'.
		const row = (await openOrganize(page)).getByRole("treeitem", { name: /^Golden Gai/ });
		await row.focus();
		await page.keyboard.press("Space");
		await page.waitForTimeout(400);
		await page.keyboard.press("ArrowDown");
		await page.waitForTimeout(300);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(1200);
		const afterTree = new URL(page.url());
		// Timeline: cancelling a card drag must not clear the day range.
		await openTrip(page, `/t/${TRIP}/japan/tokyo?days=2027-10-05&lens=place`);
		const card = page.locator('[data-testid="timeline-item"]').filter({ hasText: "Golden Gai" }).first();
		await card.getByRole("button", { name: /^Move Golden Gai/ }).focus();
		await page.keyboard.press("Space");
		await page.waitForTimeout(300);
		await page.keyboard.press("ArrowUp");
		await page.waitForTimeout(300);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(1200);
		const afterPlan = new URL(page.url());
		expect({ tree: afterTree.pathname + afterTree.search, plan: afterPlan.searchParams.get("days") }).toEqual({
			tree: `/t/${TRIP}/${GOLDEN_GAI_PATH}?days=2027-10-05`,
			plan: "2027-10-05",
		});
	});

	test("UX-04 guard: scope, day, lens and the open panel survive a copied URL", async ({ page, browser }) => {
		await signIn(page, "dennis");
		await openTrip(page, `/t/${TRIP}/${GOLDEN_GAI_PATH}?lens=place`);
		// "Show only …" filters to the day; its date only selects it (FB-08).
		await page.getByRole("button", { name: "Show only Tue 5 Oct" }).first().click();
		await page.locator('[data-testid="timeline-item"]').filter({ hasText: "Golden Gai" }).first().click();
		await expect(page.getByTestId("inspector")).toContainText("Golden Gai");
		const url = page.url();
		expect(url).toMatch(/days=2027-10-05/);
		expect(url).toMatch(/sel=/);
		const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: APP_URL });
		const other = await ctx.newPage();
		await signIn(other, "audrey");
		await openTrip(other, url);
		await expect(other.getByTestId("inspector")).toContainText("Golden Gai");
		await expect(other.getByTestId("where-button")).toContainText("Shinjuku");
		await ctx.close();
	});

	test("DEFECT: Trip settings shows the 'Public holidays' heading once", async ({ page }) => {
		await signIn(page, "dennis");
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		await page.getByRole("button", { name: /^Asia 2027/ }).first().click();
		await page.getByRole("menuitem", { name: /Trip settings/ }).click();
		const dlg = page.getByTestId("trip-settings-dialog");
		await expect(dlg).toBeVisible();
		await expect(dlg.getByText("Public holidays", { exact: true })).toHaveCount(1);
	});

	test("DEFECT: the share dialog's role select shows 'Can suggest' in full", async ({ page }) => {
		await signIn(page, "dennis");
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		await page.getByTestId("share-button").click();
		const trigger = page.getByTestId("share-dialog").getByRole("combobox").filter({ hasText: /Can sugg/ }).first();
		await expect(trigger).toBeVisible();
		const clipped = await trigger.evaluate((el) => {
			const span = el.querySelector("[data-slot=select-value]") ?? el;
			return span.scrollWidth > span.clientWidth + 1;
		});
		expect(clipped, "'Can suggest' is clipped in its Select trigger").toBe(false);
	});

	test("DEFECT: link cards never show raw HTML entities", async ({ page }) => {
		await signIn(page, "dennis");
		await openTrip(page, `/t/${TRIP}/japan/tokyo?tab=media`);
		const panel = page.getByTestId("center-panel");
		await expect(panel.getByText(/tokyocheapo/).first()).toBeVisible();
		await expect(panel).not.toContainText(/&#0?39;|&mdash;|&amp;/);
	});

	test("DEFECT EMPTY-05: a search with no results says so", async ({ page }) => {
		await signIn(page, "dennis");
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		await page.keyboard.press("Control+k");
		await page.keyboard.type("zzqxwv qqpl");
		await expect(page.getByRole("option", { name: /Pick on the map/ })).toBeVisible({ timeout: 15_000 });
		// DESIGN §12: "No matches. Try a broader name, or drop a pin."
		await expect(page.getByRole("dialog")).toContainText(/No matches/);
	});

	test("EMPTY-03/04 guard: an empty scope and a free day", async ({ page }) => {
		await signIn(page, "dennis");
		await openTrip(page, `/t/${TRIP}/south-korea/seoul?tab=lists`);
		await expect(page.getByTestId("center-panel").getByTestId("empty-state")).toContainText("Nothing to do in Seoul");
		await openTrip(page, `/t/${TRIP}/south-korea/seoul?tab=lists&list=shopping`);
		await expect(page.getByTestId("center-panel").getByTestId("empty-state")).toContainText("No shopping list for Seoul");
		await openTrip(page, `/t/${TRIP}?days=2027-10-12`);
		await expect(page.getByTestId("center-panel")).toContainText("A free day.");
		await expect(page.getByTestId("center-panel").getByRole("button", { name: /Add to this day/ })).toBeVisible();
	});

	test("EMPTY-01/02 guard: a new user's dashboard and first trip", async ({ page }) => {
		const email = `qa-visual-${Date.now()}@asia2027.test`;
		await loginViaApi(page.request, email, { first: "Nova", last: "Empty" });
		await page.goto("/dashboard");
		const dash = page.getByTestId("dashboard");
		await expect(dash).toContainText("Your next trip starts here.");
		await expect(dash).not.toContainText(/Shared with/i);
		await (await hydrated(page.getByTestId("new-trip-button").first())).click();
		await page.getByTestId("new-trip-name").fill("Empty QA");
		await page.getByTestId("new-trip-dialog").getByRole("button").filter({ hasText: "Pick dates" }).click();
		const days = page.getByRole("gridcell").getByRole("button");
		await days.filter({ hasText: /^25$/ }).first().click();
		await days.filter({ hasText: /^27$/ }).first().click();
		await page.getByTestId("new-trip-submit").click();
		await page.waitForURL(/\/t\//);
		await expect(page.getByTestId("workspace")).toBeVisible();
		// A new trip opens on its Plan, already asking where to first.
		await expect(page.getByTestId("add-place-dialog")).toContainText("Where to first?");
		await page.keyboard.press("Escape");
		// Skipped: the Plan keeps the start, and the Overview offers it too.
		await expect(page.getByTestId("split-route-start")).toContainText("Where to first?");
		await expect(page.getByTestId("center-panel")).toContainText("A free day.");
		const base = page.url().split("?")[0];
		await page.goto(`${base}?tab=overview`);
		await expect(page.getByTestId("overview-empty")).toContainText("Where to first?");
		await expect(page.getByTestId("overview-plan-route")).toBeVisible();
		await page.goto(`${base}?tab=plan`);
		await expect(page.getByTestId("workspace")).toBeVisible();
		await expect(page.getByTestId("trip-map")).toContainText("Nothing on the map here yet.");
		await page.goto(`${base}?tab=media`);
		await expect(page.getByTestId("center-panel").getByTestId("empty-state").last()).toContainText("No photos, videos, PDFs or links");
		await page.goto(`${base}?tab=lists`);
		await expect(page.getByTestId("center-panel").getByTestId("empty-state").last()).toContainText("Nothing to do in");
	});
});

// ---------------------------------------------------------------------------
// md (900px): the Inspector is a right Sheet
// ---------------------------------------------------------------------------
test.describe("md", () => {
	test.beforeEach(({}, info) => {
		test.skip(info.project.name !== "chromium", "desktop project only");
	});
	test.use({ viewport: { width: 900, height: 900 } });

	test("guard: the md Inspector Sheet has its own visible close button (over a cover photo too)", async ({ page }) => {
		await signIn(page, "dennis");
		await openTrip(page, `/t/${TRIP}/${GOLDEN_GAI_PATH}?lens=place`);
		const gg = await nodeId(page, "Golden Gai");
		await openTrip(page, `/t/${TRIP}/${GOLDEN_GAI_PATH}?lens=place&sel=n.${gg}`);
		// Fixed: like the desktop pane and the phone drawer, the md Sheet renders
		// `inspector-close` next to the title, below any cover photo (not Radix's ✕
		// in ink on top of it). The QA seed has no photos, so there may be no cover.
		await expect(page.getByTestId("inspector-close")).toBeVisible();
	});
});

// ---------------------------------------------------------------------------
// Phone (Pixel 7)
// ---------------------------------------------------------------------------
test.describe("phone", () => {
	test.beforeEach(({}, info) => {
		test.skip(info.project.name !== "chromium", "runs its own phone viewport");
	});
	const { defaultBrowserType: _ignored, ...pixel } = devices["Pixel 7"];
	test.use(pixel);

	test("MOB-01 guard: nothing scrolls sideways", async ({ page }) => {
		await page.goto("/login");
		await expectNoHorizontalOverflow(page);
		await signIn(page, "dennis");
		await page.goto("/dashboard");
		await page.waitForTimeout(1500);
		await expectNoHorizontalOverflow(page);
		for (const url of [
			`/t/${TRIP}/japan/tokyo?days=2027-10-05`,
			`/t/${TRIP}/japan/tokyo?tab=lists`,
			`/t/${TRIP}/japan/tokyo?tab=media`,
			`/t/${TRIP}/${GOLDEN_GAI_PATH}/golden-gai/bar-kuro`,
		]) {
			await openTrip(page, url);
			await expectNoHorizontalOverflow(page);
		}
	});

	test("DEFECT MOB-07: phone primary controls are at least 44×44", async ({ page }) => {
		await signIn(page, "dennis");
		await openTrip(page, `/t/${TRIP}/japan/tokyo?days=2027-10-05`);
		const small: string[] = [];
		const check = async (label: string, sel: string) => {
			const b = await box(page, sel);
			if (b.w < 44 || b.h < 44) small.push(`${label} ${b.w}×${b.h}`);
		};
		await check("pills ⋯ More", '[data-testid="mobile-pills"] [aria-label="More"]');
		await check("inbox bell", '[data-testid="mobile-pills"] [data-testid="inbox-bell"]');
		await check("where", '[data-testid="where-button"]');
		await check("map button", '[data-testid="mobile-map-toggle"]');
		await check("day stepper", '[data-testid="plan-range-bar"] button');
		await check("bottom tab", '[data-testid="center-tabs"] [role="tab"]');
		await page.getByTestId("mobile-map-toggle").tap();
		await check("map: fit", '[aria-label="Zoom to fit"]');
		await check("map: layers", '[aria-label="Map layers and legend"]');
		expect(small, small.join("\n")).toEqual([]);
	});

	test("DEFECT MOB-02: browser Back after switching tabs stays in the trip", async ({ page }) => {
		await signIn(page, "dennis");
		await page.goto("/dashboard");
		await openTrip(page, `/t/${TRIP}/japan/tokyo?days=2027-10-05`);
		const sheet = page.getByTestId("mobile-sheet");
		await sheet.getByRole("tab", { name: /Lists/ }).click();
		await expect(page).toHaveURL(/tab=lists/);
		await sheet.getByRole("tab", { name: /Places/ }).click();
		await expect(page).toHaveURL(/tab=places/);
		await page.goBack();
		await page.waitForTimeout(800);
		// Expected: back to the Lists tab, still inside the trip.
		expect(page.url()).toContain(`/t/${TRIP}/japan/tokyo`);
		expect(page.url()).toContain("tab=lists");
	});
});
