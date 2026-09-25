/**
 * I2 verifier "visual" (round 2): new MOB/A11Y/UX/PERF findings on the QA
 * seed (`pnpm db:seed:qa`, trip `asia-2027`), plus guards for fixes that were
 * re-verified this round. Tests titled "DEFECT" encode the expected behaviour
 * of an open bug and fail until it is fixed; the others are passing guards.
 *
 * Mostly read-only on the seeded trip. The PDF guard (the old Rate card's,
 * now the Places tab's drawer) uploads one small PDF to Shibuya Sky; the
 * delete-focus test works on a fixture clone.
 *
 *   APP_URL=http://localhost:<port> DEV_FIXED_OTP=000000 \
 *     N pnpm e2e tests/app/qa-visual-r2.spec.ts --project chromium
 */
import { expect, type Page, test } from "@playwright/test";
import { makePdf } from "../../../src/features/media/__tests__/make-pdf";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";

const TRIP = "asia-2027";

test.beforeEach(({}, info) => {
	test.skip(info.project.name !== "chromium", "runs its own viewports on the desktop project");
});

async function signInDennis(page: Page): Promise<void> {
	// Parallel workers sign the same account in; a concurrent sign-in can consume the code.
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

const focusInDialog = (page: Page) =>
	page.evaluate(() => !!document.activeElement?.closest("[role=dialog],[role=alertdialog]"));

test.describe("desktop 1440", () => {
	test.use({ viewport: { width: 1440, height: 900 } });

	test("DEFECT A11Y-02 (WP-Home): Share and Trip settings opened from the keyboard keep Tab inside the dialog", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		const found: string[] = [];
		// Share: focus the top-bar button, Enter, then Tab.
		await page.getByTestId("share-button").focus();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("share-dialog")).toBeVisible();
		await page.keyboard.press("Tab");
		if (!(await focusInDialog(page))) found.push("share: Tab lands behind the modal");
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("share-dialog")).toHaveCount(0);
		// Trip settings: title menu → first entry, then Tab.
		await page.getByRole("button", { name: /^Asia 2027/ }).first().focus();
		await page.keyboard.press("Enter");
		await page.getByRole("menuitem", { name: /Trip settings/ }).focus();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("trip-settings-dialog")).toBeVisible();
		await page.keyboard.press("Tab");
		if (!(await focusInDialog(page))) found.push("settings: Tab lands behind the modal");
		// Today: focus sits on the top bar's "Editing" button under the overlay, and the first Esc only closes its tooltip.
		expect(found, found.join("\n")).toEqual([]);
	});

	test("DEFECT A11Y-01 (WP-Shell, WP-Map): the inbox and map-layers popovers have an accessible name", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		const unnamed = () =>
			page.evaluate(() =>
				[...document.querySelectorAll("[role=dialog]")]
					.filter((d) => !d.getAttribute("aria-label") && !d.getAttribute("aria-labelledby"))
					.map((d) => d.getAttribute("data-testid") ?? d.textContent?.slice(0, 30) ?? "?"),
			);
		const found: string[] = [];
		await page.getByTestId("inbox-bell").first().click();
		await page.waitForTimeout(600);
		found.push(...(await unnamed()).map((x) => `inbox: ${x}`));
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: /Map layers/ }).first().click();
		await page.waitForTimeout(600);
		found.push(...(await unnamed()).map((x) => `map layers: ${x}`));
		expect(found, found.join("\n")).toEqual([]);
	});

	test("DEFECT (WP-Shell): the 'still to book' rows say what is to be booked", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?sel=root`);
		const stp = page.getByTestId("still-to-plan");
		await stp.getByText(/still to book/).first().click();
		const rows = stp.getByTestId("still-to-plan-item");
		await expect(rows.first()).toBeVisible();
		const texts = (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
		const dupes = texts.filter((t, i) => texts.indexOf(t) !== i);
		// Today: 11 rows read just "Book ahead", with no place or item name.
		expect(dupes, `identical rows: ${[...new Set(dupes)].join(", ")}`).toEqual([]);
	});

	test("DEFECT (WP-Map): known flights draw solid arcs on the map (ADDENDUM §10: dashed = proposals and estimates)", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		const dash = await page.evaluate(() => {
			const m = (window as unknown as { __tripMap?: { getLayer: (id: string) => unknown; getPaintProperty: (id: string, p: string) => unknown } }).__tripMap;
			if (!m?.getLayer("yonder-edges-flight")) return "no layer";
			return m.getPaintProperty("yonder-edges-flight", "line-dasharray") ?? null;
		});
		expect(dash).toBeNull();
	});

	test("DEFECT (WP-Plan): a travel day's summary doesn't say it ends before its flight leaves", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?days=2027-10-02&lens=place`);
		const header = page.getByTestId("plan-day-header").first();
		await expect(header).toContainText("Sat 2 Oct");
		// NH 9 leaves JFK 02:00 EDT and lands 05:00+1 JST; the summary reads "Travel 16h · ends 00:00".
		await expect(header).not.toContainText(/ends 00:00/);
	});

	test("DEFECT A11Y-02 (WP-Plan): deleting a card from its ⋯ menu doesn't drop the focus to <body>", async ({ page }) => {
		await signInDennis(page);
		const c = await cloneFixtureTrip(page.request);
		await openTrip(page, `/t/${c.slug}?lens=place`);
		const card = page.getByTestId("timeline-item").first();
		const menu = card.locator('button[aria-haspopup="menu"]').first();
		await menu.focus();
		await page.keyboard.press("Enter");
		await page.getByRole("menuitem", { name: "Delete" }).focus();
		await page.keyboard.press("Enter");
		await page.waitForTimeout(800);
		const onBody = await page.evaluate(() => document.activeElement === document.body);
		expect(onBody, "focus fell to <body> after Delete").toBe(false);
	});

	test("Rate guard: a PDF in a place's drawer (the old Rate card) opens in the in-app viewer", async ({ page, context }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}?tab=plan`);
		const nodeId = await page.evaluate(
			() =>
				(window as unknown as { __yonder: { graph: { nodes: { id: string; name: string }[] } } }).__yonder.graph.nodes.find(
					(n) => n.name === "Shibuya Sky",
				)?.id,
		);
		expect(nodeId).toBeTruthy();
		const b64 = makePdf(["Shibuya Sky tickets"], { title: "Shibuya Sky tickets" }).toString("base64");
		const up = await page.evaluate(
			async ({ nodeId, b64 }) => {
				const m = await import("/src/features/media/media.functions.ts");
				const y = (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder;
				const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
				const u = await m.createUpload({
					data: { tripId: y.graph.trip.id, target: { kind: "node", nodeId }, type: "application/pdf", size: bytes.length, name: "Shibuya Sky tickets.pdf" },
				});
				const put = await fetch(u.url, { method: "PUT", body: bytes, headers: { "content-type": "application/pdf" } });
				if (!put.ok) return { error: `PUT ${put.status}` };
				await m.completeUpload({ data: { id: u.id, hasPoster: false } });
				return { id: u.id };
			},
			{ nodeId: nodeId as string, b64 },
		);
		expect(up).not.toHaveProperty("error");
		await page.goto(`/t/${TRIP}?tab=places&sel=n.${nodeId}`);
		const drawer = page.getByTestId("places-drawer");
		await expect(drawer).toHaveAttribute("data-place", nodeId as string, { timeout: 30_000 });
		const pdf = drawer.getByTestId("rate-pdf").filter({ hasText: "Shibuya Sky tickets" }).first();
		await expect(pdf).toBeVisible({ timeout: 15_000 });
		const pages = context.pages().length;
		await pdf.click();
		await expect(page.getByTestId("media-pdf-viewer")).toBeVisible();
		expect(context.pages().length).toBe(pages);
		await page.keyboard.press("Escape");
		// Clean up: remove the PDF again.
		await page.evaluate(async (id) => {
			const m = await import("/src/features/media/media.functions.ts");
			await (m as unknown as { deleteAttachment: (a: { data: { id: string } }) => Promise<unknown> }).deleteAttachment({ data: { id } }).catch(() => {});
		}, (up as { id: string }).id);
	});
});

test.describe("200% zoom (1280×720 → 640×360)", () => {
	test.use({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 2 });

	test("DEFECT A11Y-04 (WP-Shell/WP-Map): the map controls aren't covered by the + button or the sheet", async ({ page }) => {
		await signInDennis(page);
		await openTrip(page, `/t/${TRIP}/japan/tokyo?days=2027-10-05&lens=place`);
		const covered = await page.evaluate(() =>
			["Fit to the scope", "Map layers and legend", "Filter"].flatMap((label) => {
				const b = document.querySelector(`[aria-label^="${label}"]`);
				if (!b) return [`${label}: missing`];
				const r = b.getBoundingClientRect();
				const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
				if (top && b.contains(top)) return [];
				const by = top?.closest("button,[data-testid]");
				return [`${label}: under ${by?.getAttribute("aria-label") ?? by?.getAttribute("data-testid") ?? top?.tagName}`];
			}),
		);
		// Today: "Map layers and legend: under Add" and "Filter: under mobile-sheet" (also an iPhone SE in landscape).
		expect(covered, covered.join("\n")).toEqual([]);
	});
});
