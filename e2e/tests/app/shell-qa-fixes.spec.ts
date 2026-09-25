/**
 * WP-Shell fixes from QA round 1, on the QA seed (`pnpm db:seed:qa`, trip
 * `asia-2027`). Read-only on the seeded trip.
 *
 * - VIS-02 / MOB-07: the phone chrome's own controls (pills ⋯, bell, lens
 *   segments, sheet tabs) are at least 44×44.
 * - VIS-13: the md Inspector Sheet shows `inspector-close` next to the title,
 *   below the cover photo.
 * - COLLAB-4: the trip root overview has the visited cities' climate table.
 * - COLLAB-9 / PLAN-I2-15: every timed deadline chip carries its zone label.
 * - PLAN-I2-13: "Days per city" header and table footer are one number.
 * - PLAN-I2-11: at Golden Gai depth (6 crumbs) nothing is squeezed.
 *
 *   APP_URL=http://localhost:<port> DEV_FIXED_OTP=000000 \
 *     N pnpm e2e -- tests/app/shell-qa-fixes.spec.ts --project chromium
 */
import { devices, expect, type Page, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";

const TRIP = "asia-2027";
const DENNIS = {
	email: "dennis@asia2027.test",
	first: "Dennis",
	last: "Tester",
};

/** Other specs sign the same QA user in on a shared server: a code can be spent under us. */
async function signIn(page: Page): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await loginViaApi(page.request, DENNIS.email, {
				first: DENNIS.first,
				last: DENNIS.last,
			});
			return;
		} catch (e) {
			if (attempt >= 3 || !/INVALID_OTP/.test(String(e))) throw e;
			await page.waitForTimeout(1000 * attempt);
		}
	}
}

async function openTrip(page: Page, url: string): Promise<void> {
	await page.goto(url);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(() =>
			page.evaluate(
				() => !!(window as unknown as { __yonder?: unknown }).__yonder,
			),
		)
		.toBe(true);
	await page.waitForTimeout(1000);
}

async function nodeId(page: Page, name: string): Promise<string> {
	const id = await page.evaluate(
		(n) =>
			(
				window as unknown as {
					__yonder: { graph: { nodes: { id: string; name: string }[] } };
				}
			).__yonder.graph.nodes.find((x) => x.name === n)?.id,
		name,
	);
	if (!id) throw new Error(`no node ${name}`);
	return id;
}

type Box = { label: string; w: number; h: number };
async function boxes(
	page: Page,
	label: string,
	selector: string,
): Promise<Box[]> {
	return page.locator(selector).evaluateAll(
		(els, l) =>
			els
				.filter((e) => (e as HTMLElement).offsetParent !== null)
				.map((e, i) => {
					const r = e.getBoundingClientRect();
					return {
						label: `${l} #${i} ${(e.textContent ?? "").trim().slice(0, 12)}`,
						w: Math.round(r.width),
						h: Math.round(r.height),
					};
				}),
		label,
	);
}

test.describe("desktop", () => {
	test.beforeEach(({}, info) => {
		test.skip(info.project.name !== "chromium", "desktop project only");
	});
	test.use({ viewport: { width: 1440, height: 900 } });

	test("trip root: climate table, zone-labelled deadlines, one unallocated number", async ({
		page,
	}) => {
		await signIn(page);
		// The climate table and the deadlines moved to the Overview page (docs/OVERVIEW.md §7).
		await openTrip(page, `/t/${TRIP}?tab=overview`);
		const page1 = page.getByTestId("overview");
		await expect(page1).toBeVisible();
		// COLLAB-4
		const climate = page1.getByTestId("climate-card");
		await expect(climate).toHaveCount(1);
		await expect(climate).toHaveAttribute("data-nodeid", "root");
		await expect(climate).toContainText("typical for your visit");
		// COLLAB-9 / PLAN-I2-15: a chip with a time always names its zone.
		const chips = await page1
			.getByTestId("trip-deadline-chip")
			.allInnerTexts();
		for (const c of chips)
			if (/\d{1,2}:\d{2}/.test(c))
				expect(c, c).toMatch(/\d{1,2}:\d{2}(?:[ap]m)? (?:[A-Z]{2,5}|GMT[+-]\d+)$/);
		// "Still to plan" stays in the root inspector.
		await openTrip(page, `/t/${TRIP}?sel=root`);
		await expect(page.getByTestId("trip-overview")).toBeVisible();
		// PLAN-I2-13
		const stp = page.getByTestId("still-to-plan");
		const hint = (await stp.innerText()).match(
			/Days per city · (\d+(?:\.\d)?) of \d+ unallocated/,
		)?.[1];
		await stp.getByRole("button", { name: /Days per city/ }).click();
		const table = (await stp.innerText()).match(
			/Unallocated\s+(\d+(?:\.\d)?)\s+day/,
		)?.[1];
		if (hint || table) expect(table).toBe(hint);
	});

	test("PLAN-I2-14: 'still to book' expands to its to-dos; one opens its own context", async ({
		page,
	}) => {
		await signIn(page);
		await openTrip(page, `/t/${TRIP}?sel=root`);
		const row = page.locator(
			'[data-testid="still-to-plan-row"][data-row="book"]',
		);
		test.skip((await row.count()) === 0, "nothing left to book in the seed");
		await row.getByRole("button", { name: /still to book/ }).click();
		const items = row.getByTestId("still-to-plan-item");
		await expect(items.first()).toBeVisible();
		await items.first().click();
		await expect(page).toHaveURL(/tab=lists/);
		await expect(page).toHaveURL(/list=todo/);
	});

	test("PLAN-I2-11: six crumbs stay readable", async ({ page }) => {
		await signIn(page);
		await openTrip(page, `/t/${TRIP}/japan/tokyo/shinjuku/golden-gai`);
		const crumb = page.getByTestId("scope-breadcrumb");
		await expect(crumb).toContainText("Golden Gai");
		const cut = await crumb
			.locator("[data-crumb-label]")
			.evaluateAll((els) =>
				els
					.filter((e) => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1)
					.map((e) => e.textContent),
			);
		expect(cut).toEqual([]);
	});
});

test.describe("md", () => {
	test.beforeEach(({}, info) => {
		test.skip(info.project.name !== "chromium", "desktop project only");
	});
	test.use({ viewport: { width: 900, height: 900 } });

	test("VIS-13: the Inspector Sheet's close control sits by the title", async ({
		page,
	}) => {
		await signIn(page);
		await openTrip(page, `/t/${TRIP}/japan/tokyo/shinjuku?lens=place`);
		const gg = await nodeId(page, "Golden Gai");
		await openTrip(
			page,
			`/t/${TRIP}/japan/tokyo/shinjuku?lens=place&sel=n.${gg}`,
		);
		const inspector = page.getByTestId("inspector");
		const close = inspector.getByTestId("inspector-close");
		await expect(close).toBeVisible();
		await expect(inspector.getByRole("button", { name: "Close" })).toHaveCount(
			1,
		);
		// Below the cover photo, not on it.
		const cover = inspector.getByTestId("cover-strip").first();
		if (await cover.count()) {
			const c = await cover.boundingBox();
			const b = await close.boundingBox();
			if (c && b) expect(b.y).toBeGreaterThanOrEqual(c.y + c.height - 1);
		}
		await close.click();
		await expect(inspector).toHaveCount(0);
		await expect(page).not.toHaveURL(/sel=/);
	});
});

test.describe("phone", () => {
	test.beforeEach(({}, info) => {
		test.skip(info.project.name !== "chromium", "runs its own phone viewport");
	});
	const { defaultBrowserType: _ignored, ...pixel } = devices["Pixel 7"];
	test.use(pixel);

	test("VIS-02 / MOB-07: the shell's phone controls are at least 44×44", async ({
		page,
	}) => {
		await signIn(page);
		await openTrip(page, `/t/${TRIP}/japan/tokyo?days=2027-10-05`);
		const all: Box[] = [
			...(await boxes(
				page,
				"pills ⋯ More",
				'[data-testid="mobile-pills"] [aria-label="More"]',
			)),
			...(await boxes(
				page,
				"your trips",
				'[data-testid="mobile-pills"] [aria-label="Your trips"]',
			)),
			...(await boxes(
				page,
				"zoom out",
				'[data-testid="mobile-pills"] [aria-label="Zoom out"]',
			)),
			...(await boxes(
				page,
				"inbox bell",
				'[data-testid="mobile-pills"] [data-testid="inbox-bell"]',
			)),
			...(await boxes(page, "lens", '[data-testid="lens-control"] [role="radio"]')),
		];
		// Bring the sheet to half so its tab bar shows.
		const sheet = page.getByTestId("mobile-sheet");
		const b = await sheet.boundingBox();
		if (!b) throw new Error("no sheet");
		await page.mouse.move(200, b.y + 8);
		await page.mouse.down();
		await page.mouse.move(200, b.y - 330, { steps: 15 });
		await page.mouse.up();
		await page.waitForTimeout(800);
		all.push(
			...(await boxes(page, "sheet tab", '[data-testid="mobile-sheet"] [role="tab"][data-tab]')),
		);
		expect(all.filter((x) => x.label.startsWith("sheet tab")).length).toBeGreaterThan(3);
		const small = all.filter((x) => x.w < 44 || x.h < 44);
		expect(small, small.map((s) => `${s.label} ${s.w}×${s.h}`).join("\n")).toEqual(
			[],
		);
	});
});
