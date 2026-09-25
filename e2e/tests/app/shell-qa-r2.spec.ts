/**
 * WP-Shell fixes from QA round 2, on the QA seed (`pnpm db:seed:qa`, trip
 * `asia-2027`). Read-only on the seeded trip.
 *
 * - PLAN-R2-05 / COLLAB-R2-13 / VIS2-04: every "still to book" row names what
 *   it's for, and one opens a view filtered to it (the to-do list at its
 *   place, the inspector on that selection's Lists tab).
 * - COLLAB-R2-05: the trip overview never scrolls sideways in the inspector.
 * - VIS2-02: the inbox popover is a named dialog.
 * - VIS2-13: on a phone, Upcoming deadlines titles stay readable.
 * - VIS2-08 (A11Y-04 / MOB-09): at 640×360 (200% zoom, a phone on its side)
 *   neither the + button nor the sheet covers a map control.
 *
 *   APP_URL=http://localhost:<port> DEV_FIXED_OTP=000000 \
 *     N pnpm e2e -- tests/app/shell-qa-r2.spec.ts --project chromium
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

test.describe("desktop", () => {
	test.beforeEach(({}, info) => {
		test.skip(info.project.name !== "chromium", "desktop project only");
	});
	test.use({ viewport: { width: 1440, height: 900 } });

	test("PLAN-R2-05: 'still to book' rows say what they're for and open a filtered view", async ({
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
		const texts = (await items.allInnerTexts()).map((t) =>
			t.replace(/\s+/g, " ").trim(),
		);
		expect(texts.filter((t) => t === "Book ahead")).toEqual([]);
		const dupes = texts.filter((t, i) => texts.indexOf(t) !== i);
		expect(dupes, `identical rows: ${[...new Set(dupes)].join(", ")}`).toEqual(
			[],
		);
		// A "Book ahead" on a visit: the place's to-do list, the visit's Lists tab.
		const ahead = items.filter({ hasText: /^Book ahead · / }).first();
		const pick = (await ahead.count()) ? ahead : items.first();
		await pick.click();
		await expect(page).toHaveURL(/tab=lists/);
		await expect(page).toHaveURL(/sel=/);
		const tabs = page.getByTestId("inspector-tabs");
		await expect(tabs.getByRole("tab", { name: /Lists/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(
			page.getByTestId("inspector").getByTestId("list-row").first(),
		).toBeVisible();
		// A leg's to-do: narrowed to its day(s), the leg's Lists tab.
		await openTrip(page, `/t/${TRIP}?sel=root`);
		await row.getByRole("button", { name: /still to book/ }).click();
		const leg = row
			.getByTestId("still-to-plan-item")
			.filter({ hasText: / · (?:Leg|Flight|Transit|Walk) · / })
			.first();
		if (await leg.count()) {
			await leg.click();
			await expect(page).toHaveURL(/sel=l\./);
			await expect(page).toHaveURL(/days=/);
			await expect(
				page.getByTestId("inspector-tabs").getByRole("tab", { name: /Lists/ }),
			).toHaveAttribute("aria-selected", "true");
		}
	});

	test("COLLAB-R2-05: the trip overview fits the inspector (no sideways scroll)", async ({
		page,
	}) => {
		await signIn(page);
		await openTrip(page, `/t/${TRIP}?sel=root`);
		const overview = page.getByTestId("trip-overview");
		await expect(overview).toBeVisible();
		const fit = await overview.evaluate((el) => {
			// A long Recent line ("… accepted Maya's suggestion: shifted the trip
			// +1 day (Sat 2 Oct → Sun 3 Oct)") must truncate, not widen the column.
			const line = el.querySelector('[data-testid="trip-recent"] button');
			if (line)
				line.textContent = `Dennis Tester accepted Maya's suggestion: shifted the trip +1 day (Sat 2 Oct → Sun 3 Oct) ${"and more ".repeat(12)}`;
			let scroller = el.parentElement;
			while (scroller && getComputedStyle(scroller).overflowY !== "auto")
				scroller = scroller.parentElement;
			return {
				overview: Math.round(el.getBoundingClientRect().width),
				room: scroller?.clientWidth ?? 0,
				scrollW: scroller?.scrollWidth ?? 0,
			};
		});
		expect(fit.scrollW, JSON.stringify(fit)).toBeLessThanOrEqual(fit.room + 1);
		expect(fit.overview).toBeLessThanOrEqual(fit.room);
	});

	test("VIS2-02: the inbox popover is a dialog named 'Inbox'", async ({
		page,
	}) => {
		await signIn(page);
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		await page.getByTestId("inbox-bell").first().click();
		await expect(page.getByRole("dialog", { name: "Inbox" })).toBeVisible();
		const unnamed = await page.evaluate(() =>
			[...document.querySelectorAll("[role=dialog]")]
				.filter(
					(d) =>
						!d.getAttribute("aria-label") && !d.getAttribute("aria-labelledby"),
				)
				.map((d) => d.textContent?.slice(0, 30)),
		);
		expect(unnamed).toEqual([]);
	});
});

test.describe("phone", () => {
	test.beforeEach(({}, info) => {
		test.skip(info.project.name !== "chromium", "runs its own phone viewport");
	});
	const { defaultBrowserType: _ignored, ...iphone } = devices["iPhone 13"];
	test.use({ ...iphone, viewport: { width: 390, height: 844 } });

	test("VIS2-13: deadline titles aren't squeezed by their chips", async ({
		page,
	}) => {
		await signIn(page);
		// The deadlines live on the Overview page (docs/OVERVIEW.md §7).
		await openTrip(page, `/t/${TRIP}?tab=overview`);
		const rows = page.getByTestId("trip-deadline-row");
		await rows.first().waitFor({ timeout: 15_000 }).catch(() => undefined);
		test.skip((await rows.count()) === 0, "no deadlines in the seed");
		const layout = await rows.evaluateAll((els) =>
			els.map((row) => {
				const chip = row.querySelector('[data-testid="trip-deadline-chip"]');
				const title = chip?.previousElementSibling as HTMLElement | null;
				const c = chip?.getBoundingClientRect();
				const t = title?.getBoundingClientRect();
				return {
					text: title?.textContent ?? "",
					below: !!c && !!t && c.top >= t.bottom - 1,
					cut: !!title && title.scrollWidth > title.clientWidth + 1,
					titleW: Math.round(t?.width ?? 0),
					rowW: Math.round(row.getBoundingClientRect().width),
				};
			}),
		);
		for (const r of layout) {
			expect(r.below, r.text).toBe(true);
			// A title that still truncates has the row's width, not what a chip leaves.
			if (r.cut) expect(r.titleW, r.text).toBeGreaterThan(r.rowW * 0.7);
		}
	});
});

test.describe("200% zoom", () => {
	test.beforeEach(({}, info) => {
		test.skip(info.project.name !== "chromium", "runs its own viewport");
	});
	test.use({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 2 });

	test("VIS2-08: the + button and the sheet leave every map control reachable", async ({
		page,
	}) => {
		await signIn(page);
		await openTrip(page, `/t/${TRIP}/japan/tokyo?days=2027-10-05&lens=place`);
		const covered = await page.evaluate(() =>
			["Fit to the scope", "Map layers and legend", "Filter"].flatMap(
				(label) => {
					const b = document.querySelector(`[aria-label^="${label}"]`);
					if (!b) return [`${label}: missing`];
					const r = b.getBoundingClientRect();
					const top = document.elementFromPoint(
						r.x + r.width / 2,
						r.y + r.height / 2,
					);
					if (top && b.contains(top)) return [];
					const by = top?.closest("button,[data-testid]");
					return [
						`${label}: under ${by?.getAttribute("aria-label") ?? by?.getAttribute("data-testid") ?? top?.tagName}`,
					];
				},
			),
		);
		expect(covered, covered.join("\n")).toEqual([]);
		// The + button itself stays on screen.
		const fab = await page.getByTestId("fab").boundingBox();
		expect(fab).not.toBeNull();
		if (fab) expect(fab.y + fab.height).toBeLessThanOrEqual(360);
	});
});
