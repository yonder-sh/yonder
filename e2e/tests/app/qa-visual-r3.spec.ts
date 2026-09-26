/**
 * I2 verifier "visual" (round 3): guards for the round-2 bugs that are now
 * fixed, and the defects found this round, on the QA seed (`pnpm db:seed:qa`,
 * trip `asia-2027`). Tests titled "DEFECT" encode the expected behaviour of an
 * open bug and fail until it is fixed; the others are passing guards.
 *
 * READ-ONLY on the seeded trip (dialogs are opened and cancelled; "Show
 * suggestions" is toggled and restored; it is a per-user view setting).
 * The palette test needs Photon (photon.komoot.io) to answer.
 * The PERF test only runs with QA_PERF=1 against the PRODUCTION build
 * (dev-mode timings are meaningless).
 *
 *   APP_URL=http://localhost:<port> DEV_FIXED_OTP=000000 \
 *     N pnpm e2e -- tests/app/qa-visual-r3.spec.ts --project chromium
 */
import { expect, type Page, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";

const TRIP = "asia-2027";

test.beforeEach(({}, info) => {
	test.skip(info.project.name !== "chromium", "runs its own viewports on the desktop project");
});

async function signInDennis(page: Page): Promise<void> {
	for (let i = 0; ; i++) {
		try {
			return await loginViaApi(page.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
		} catch (e) {
			if (i >= 4) throw e;
			await new Promise((r) => setTimeout(r, 400 + Math.random() * 1200));
		}
	}
}

async function openTrip(page: Page, url: string): Promise<void> {
	await page.goto(url);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(() => page.evaluate(() => !!(window as unknown as { __yonder?: unknown }).__yonder))
		.toBe(true);
	await page.waitForTimeout(1500);
}

type G = {
	nodes: { id: string; name: string }[];
	items: { id: string; title: string | null; nodeId: string | null }[];
	legs: { mode: string | null; fromItemId: string; toItemId: string; details?: unknown }[];
};
const graph = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);

// ---------------------------------------------------------------------------
// Guards: round-2 bugs verified fixed in round 3
// ---------------------------------------------------------------------------
test.describe("guards 1440", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("still-to-book rows name their item and open a scoped view", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?sel=root`);
		const stp = page.getByTestId("still-to-plan");
		await stp.getByRole("button", { name: /still to book/ }).click();
		const rows = (await stp.getByTestId("still-to-plan-item").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
		expect(rows.filter((r) => r === "Book ahead")).toEqual([]);
		await stp.getByTestId("still-to-plan-item").first().click();
		await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("lists");
		expect(new URL(page.url()).searchParams.get("sel")).not.toBeNull();
	});

	test("map: known flights and 'other' legs are solid; only estimates and proposals are dashed", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?lens=country`);
		const dash = await page.evaluate(() => {
			const m = (window as unknown as { __tripMap?: { map?: unknown } }).__tripMap;
			const map = (m?.map ?? m) as { getStyle(): { layers: { id: string; type: string; paint?: Record<string, unknown> }[] } };
			return Object.fromEntries(
				map.getStyle().layers.filter((l) => l.id.startsWith("yonder-edges") && l.type === "line").map((l) => [l.id, l.paint?.["line-dasharray"] ?? null]),
			);
		});
		expect(dash["yonder-edges-flight"]).toBeNull();
		expect(dash["yonder-edges-other"]).toBeNull();
		expect(dash["yonder-edges-transit"]).toBeNull();
		expect(dash["yonder-edges-flight-est"]).not.toBeNull();
		expect(dash["yonder-edges-proposed"]).not.toBeNull();
	});

	test("night-train day: header ends at departure; carry-over row quotes the ticket", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?days=2027-10-26&lens=place`);
		const tab = page.getByTestId("plan-tab");
		await expect(tab.getByTestId("plan-day-header").first()).toContainText("ends 21:35");
		await expect(tab.getByText(/to Lào Cai Station/)).toBeVisible();
		await expect(tab.getByText(/SP3\s*7h55/)).toBeVisible();
	});

	test("Outline › Show › Cities says '1 place' (singular)", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		await page.getByTestId("outline").getByRole("button", { name: "Outline options" }).click();
		await page.getByRole("menuitemradio", { name: /Cities/ }).or(page.getByRole("menuitem", { name: /^Cities/ })).first().click();
		const text = (await page.getByTestId("outline").innerText()).replace(/\s+/g, " ");
		expect(text).toContain("Uji · 1 place ");
		expect(text).not.toMatch(/\b1 places\b/);
		await page.getByTestId("outline").getByRole("button", { name: "Outline options" }).click();
		await page.getByRole("menuitemradio", { name: /Everything/ }).or(page.getByRole("menuitem", { name: /^Everything/ })).first().click();
	});

	test("Set location: pasted coordinates are the chosen option and keep the place's own name", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		const kuro = (await graph(page)).nodes.find((n) => n.name === "Bar Kuro")?.id;
		await openTrip(page, `/t/${TRIP}?sel=n.${kuro}`);
		const row = page.getByRole("treeitem", { name: /^Bar Kuro/ }).first();
		await row.scrollIntoViewIfNeeded();
		await row.hover();
		await row.getByTestId("outline-row-menu").click();
		await page.getByRole("menuitem", { name: /location/ }).click();
		const dlg = page.getByRole("dialog").filter({ hasText: /location for Bar Kuro/ });
		await page.waitForTimeout(3000);
		await dlg.getByRole("combobox").first().fill("35.6941, 139.7045");
		await page.waitForTimeout(1500);
		const selected = await dlg.locator('[role=option][aria-selected="true"]').first().innerText();
		expect(selected).toMatch(/Use this location/);
		await page.keyboard.press("Enter");
		await expect(dlg).toContainText("Nearest address on the map");
		await expect(dlg).not.toContainText("Blue Dragon");
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
	});
});

// ---------------------------------------------------------------------------
// DEFECTS
// ---------------------------------------------------------------------------
test.describe("desktop 1440", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("DEFECT (WP-Places): after Photon answers, Enter in the palette opens the first result, not 'Drop a pin…'", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}/japan/tokyo`);
		await page.keyboard.press("Control+k");
		const dlg = page.getByRole("dialog");
		await page.keyboard.type("Tokyo Tower", { delay: 60 });
		// Wait for the OpenStreetMap results.
		await expect.poll(() => dlg.getByRole("option").count(), { timeout: 15_000 }).toBeGreaterThan(4);
		await page.waitForTimeout(500);
		const selected = (await dlg.locator('[role=option][aria-selected="true"]').first().innerText()).trim();
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
		// Today: "Drop a pin…" (it was the first option before the results arrived and keeps the
		// highlight when they are inserted above it), so Enter opens the pin dropper.
		expect(selected).not.toMatch(/Drop a pin/);
	});

	test("DEFECT (WP-Shell): the overview's 'unrated places' counts match the Places tab (no suggestion ghosts)", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?sel=root`);
		const stp = page.getByTestId("still-to-plan");
		await stp.getByRole("button", { name: /unrated/ }).click();
		const overview = (await stp.innerText()).replace(/\s+/g, " ");
		const total = /Audrey Tester (\d+) of (\d+)/.exec(overview);
		expect(total, overview).not.toBeNull();
		const audrey = await page.evaluate(
			() =>
				(
					window as unknown as { __yonder: { graph: { members: { id: string; name?: string }[] } } }
				).__yonder.graph.members.find((m) => /Audrey/.test(m.name ?? ""))?.id,
		);
		// The old Rate screen's link: the Places tab, whose header has each member's progress.
		await page.goto(`/t/${TRIP}/rate`);
		const progress = page.getByTestId("places-progress").locator(`[data-member="${audrey}"][data-counted]`);
		await expect(progress).toBeVisible({ timeout: 30_000 });
		const header = (await progress.innerText()).replace(/\s+/g, " ");
		const rate = /(\d+)\/(\d+)/.exec(header);
		expect(rate, header).not.toBeNull();
		// Today: "Audrey Tester 79 of 126" (Maya's unaccepted Tōfuku-ji counts) vs "Audrey Tester 47/125".
		expect(Number(total?.[2])).toBe(Number(rate?.[2]));
		expect(Number(total?.[1]) + Number(rate?.[1])).toBe(Number(rate?.[2]));
	});

	test("DEFECT (F leg-summary / WP-Transit): the flight inspector's header doesn't give the plan total as the flight's time", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		const g = await graph(page);
		const nh9 = g.legs.find((l) => l.mode === "flight" && /NH ?9\b/.test(JSON.stringify(l.details ?? {})));
		expect(nh9).toBeTruthy();
		await openTrip(page, `/t/${TRIP}?days=2027-10-02&lens=place&sel=l.${nh9?.fromItemId}.${nh9?.toItemId}`);
		const summary = (await page.getByTestId("leg-overview").getByTestId("leg").first().innerText()).replace(/\s+/g, " ");
		// Today: "NH 9 JFK→HND 16h" directly above a ticket that says 14h (VN 576 reads "5h 35m" for a 2h 35m flight).
		expect(summary).not.toMatch(/NH ?9 JFK→HND 16h/);
	});

	test("DEFECT (WP-Places): the ratings list's names aren't cut (the old Rate card's 'Others', now the drawer)", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		const sky = await page.evaluate(
			() =>
				(
					window as unknown as { __yonder: { graph: { nodes: { id: string; name: string }[] } } }
				).__yonder.graph.nodes.find((n) => n.name === "Shibuya Sky")?.id,
		);
		await page.goto(`/t/${TRIP}?tab=places&sel=n.${sky}`);
		const card = page.getByTestId("places-drawer");
		await expect(card).toHaveAttribute("data-place", sky as string, { timeout: 30_000 });
		await expect(card.getByTestId("places-rating-row").first()).toBeVisible();
		const cut = await card.evaluate((el) =>
			[...el.querySelectorAll('li[data-testid="places-rating-row"] span.truncate')]
				.filter((s) => (s as HTMLElement).scrollWidth > (s as HTMLElement).clientWidth + 1)
				.map((s) => s.textContent),
		);
		// Today: "Audrey Test…" and "Maya Sugge…" in a 480px column.
		expect(cut).toEqual([]);
	});

	test("DEFECT (PERF, F1e/WP-Map): a lens change at the trip root has no long task over 50 ms (production build only)", async ({ page }) => {
		test.skip(process.env.QA_PERF !== "1", "set QA_PERF=1 and point APP_URL at the production build");
		await signInDennis(page);
		await page.goto(`/t/${TRIP}?tab=plan`);
		await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(5000);
		const worst: string[] = [];
		for (const lens of ["Region", "City", "Country", "Area", "Country"]) {
			const lt = await page.evaluate(
				(lens) =>
					new Promise<number[]>((resolve) => {
						const out: number[] = [];
						const po = new PerformanceObserver((l) => out.push(...l.getEntries().map((e) => Math.round(e.duration))));
						po.observe({ type: "longtask" });
						const btn = [...document.querySelectorAll('[data-testid="lens-control"] button')].find((b) => b.textContent?.trim() === lens) as HTMLElement;
						btn.click();
						setTimeout(() => {
							po.disconnect();
							resolve(out);
						}, 1500);
					}),
				lens,
			);
			if (lt.some((d) => d > 50)) worst.push(`${lens}: ${lt.join(", ")} ms`);
		}
		// Today (prod build, Asia 2027): Region 137+140 ms, Country 66+189 ms, Area 80 ms (SPEC §19: < 50 ms).
		expect(worst, worst.join("\n")).toEqual([]);
	});
});

test.describe("1100 (lg)", () => {
	test.use({ viewport: { width: 1100, height: 900 } });

	test("DEFECT (WP-Plan): a three-line transit row fits its lane: no wrapped or clipped line chips, one 'est.'", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?days=2027-10-03&lens=place`);
		const leg = page.getByTestId("plan-tab").getByTestId("leg").filter({ hasText: "Odakyu" }).first();
		await leg.scrollIntoViewIfNeeded();
		const r = await leg.evaluate((el) => {
			const chips = [...el.querySelectorAll("span,div")].filter((e) => /^(Tokyo Monorail|Odakyu Odawara)$/.test(e.textContent?.trim() ?? ""));
			const wrapped = chips
				.filter((c) => {
					const cs = getComputedStyle(c);
					return c.getBoundingClientRect().height > parseFloat(cs.fontSize) * 1.9 || c.scrollHeight > c.clientHeight + 1;
				})
				.map((c) => c.textContent?.trim());
			const ests = (el.textContent?.match(/est\./g) ?? []).length;
			return { wrapped: [...new Set(wrapped)], ests };
		});
		// Today: "Tokyo Monorail" and "Odakyu Odawara" wrap inside their pills (the second is clipped),
		// "1h 14m est." wraps, and a second "est." sits at the right edge.
		expect(r.wrapped).toEqual([]);
		expect(r.ests).toBe(1);
	});
});

test.describe("phone 390", () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

	test("DEFECT (WP-Shell): a link with ?tab=lists opens the sheet far enough to show the Lists tab", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}/japan/tokyo?tab=lists`);
		const top = await page.getByTestId("mobile-sheet").evaluate((s) => Math.round(s.getBoundingClientRect().top));
		const listsVisible = await page.evaluate(() => {
			const p = document.querySelector('[data-testid="lists-panel"]');
			if (!p) return false;
			const r = p.getBoundingClientRect();
			return r.top < innerHeight - 80 && r.height > 0;
		});
		// Today: the sheet stays at the 120px peek (top 724 of 844); only the map and the day chips show.
		expect(listsVisible, `sheet top ${top}`).toBe(true);
	});
});
