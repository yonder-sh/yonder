/**
 * I2 "content" verifier, round 3: cheap re-checks of round-2 reports from
 * other areas that touch what this verifier looks at (guest link messages,
 * the phone dashboard's deadlines), plus a guest-vs-private-items probe.
 */
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";
import { openLink } from "./_helpers/link";

test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");
const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
const state = (h: string) => path.join(AUTH, `${h}.json`);
type G = { trip: { id: string; slug: string } };
const graphOf = (p: Page) => p.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);

test("LINK-07: a working guest link on another trip's URL says 'no access', not 'link no longer active'", async ({ browser }) => {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const p = await ctx.newPage();
	await openLink(p, "asia-2027", "editor");
	await expect(p.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await p.goto("/t/phu-quoc-detour?tab=plan");
	await p.waitForTimeout(2500);
	const t = (await p.locator("body").innerText()).replace(/\n/g, " | ");
	console.log("guest on phu-quoc-detour:", t.slice(0, 200));
	await shot(p, "41-link07-other-trip");
	await p.goto("/t/asia-2027?tab=plan");
	await expect(p.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	expect(t).not.toMatch(/no longer active/i);
	expect(t).not.toMatch(/Phu Quoc/);
	await ctx.close();
});

test("phone dashboard: deadlines from 'Asia 2027' and 'Asia 2027 backup' can be told apart", async ({ browser }) => {
	test.setTimeout(120_000);
	const ctx = await browser.newContext({ storageState: state("dennis"), viewport: { width: 1440, height: 900 } });
	const p = await ctx.newPage();
	await p.goto("/t/asia-2027?tab=plan");
	await expectLive(p);
	const g = await graphOf(p);
	const dup = await p.evaluate(async (tripId) => {
		const m = await import("/src/features/home/dashboard.functions.ts");
		return m.duplicateTrip({
			data: { tripId, name: "Asia 2027 backup", startDate: "2027-10-02", include: { notes: false, lists: true, media: false, budgets: false, placeholders: false } },
		});
	}, g.trip.id);
	console.log("dup", JSON.stringify(dup));
	const ph = await browser.newContext({ storageState: state("dennis"), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
	const pp = await ph.newPage();
	await pp.goto("/dashboard");
	const box = pp.getByTestId(HOME_TESTID.deadlines);
	await expect(box).toBeVisible({ timeout: 20_000 });
	await box.scrollIntoViewIfNeeded();
	await pp.waitForTimeout(800);
	const rows = box.getByTestId(HOME_TESTID.deadlineRow);
	const n = await rows.count();
	const info: { text: string; trip: string; tripClipped: boolean }[] = [];
	for (let i = 0; i < n; i++) {
		const r = rows.nth(i);
		const trip = r.getByTestId(HOME_TESTID.deadlineTrip);
		const t = (await trip.count()) ? trip.first() : null;
		info.push({
			text: (await r.innerText()).replace(/\n/g, " | "),
			trip: t ? await t.innerText() : "-",
			tripClipped: t ? await t.evaluate((e) => e.scrollWidth > e.clientWidth + 1) : false,
		});
	}
	console.log("phone deadlines", JSON.stringify(info, null, 1));
	await box.screenshot({ path: path.join(SHOTS, "41-phone-deadlines.png") });
	await shot(pp, "41-phone-dashboard");
	// Clean up the copy.
	const del = await p.evaluate(async (tripId) => {
		const m = await import("/src/functions/trips.functions.ts");
		return (m as unknown as { deleteTrip: (a: unknown) => Promise<unknown> }).deleteTrip({ data: { tripId } }).catch((e: Error) => e.message);
	}, (dup as { tripId: string }).tripId);
	console.log("delete copy", JSON.stringify(del).slice(0, 120));
	await ph.close();
	await ctx.close();
	// Two rows with the same to-do text must show distinguishable trip names.
	const byText = new Map<string, Set<string>>();
	for (const r of info) {
		const key = r.text.replace(r.trip, "").trim();
		byText.set(key, (byText.get(key) ?? new Set()).add(r.trip));
	}
	for (const r of info) expect(r.tripClipped, `trip name clipped in "${r.text}"`).toBe(false);
});

test("a link guest never gets another member's private to-do (list, counts, Lists tab)", async ({ browser }) => {
	const d = await browser.newContext({ storageState: state("dennis"), viewport: { width: 1440, height: 900 } });
	const dp = await d.newPage();
	await dp.goto("/t/asia-2027?tab=lists");
	await expectLive(dp);
	const g = await graphOf(dp);
	const text = `GIFT-R3 for guests ${Date.now() % 10000}`;
	const made = await dp.evaluate(
		async ({ tripId, text }) => {
			const m = await import("/src/features/lists/lists.functions.ts");
			return m.createListItem({ data: { tripId, target: { kind: "trip" }, list: "todo", text, isPrivate: true, dueDate: "2026-09-25" } });
		},
		{ tripId: g.trip.id, text },
	);
	const gc = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const gp = await gc.newPage();
	await openLink(gp, "asia-2027", "editor");
	await expect(gp.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await gp.goto("/t/asia-2027?tab=lists");
	await expectLive(gp);
	await gp.waitForTimeout(1500);
	const tab = await gp.getByTestId(TESTID.listsTab).innerText();
	const lists = await gp.evaluate(async (tripId) => {
		const m = await import("/src/features/lists/lists.functions.ts");
		return m.listTripListItems({ data: { tripId } }).catch((e: Error) => e.message);
	}, g.trip.id);
	const act = await gp.evaluate(async (tripId) => {
		const m = await import("/src/functions/graph.functions.ts");
		return m.listActivity({ data: { tripId } }).catch((e: Error) => e.message);
	}, g.trip.id);
	console.log("guest rows:", Array.isArray(lists) ? lists.length : lists, "| rows in UI:", await gp.getByTestId(TESTID.listsTab).getByTestId(L.row).count());
	await shot(gp, "41-guest-lists");
	await dp.evaluate(async (id) => {
		const m = await import("/src/features/lists/lists.functions.ts");
		return m.deleteListItem({ data: { id } });
	}, (made as { id: string }).id);
	expect(tab).not.toContain(text);
	expect(JSON.stringify(lists)).not.toContain(text);
	expect(JSON.stringify(act)).not.toContain("GIFT-R3");
	await gc.close();
	await d.close();
});

test("map: which edge layers are dashed (ADDENDUM §10: only proposals and estimates)", async ({ browser }) => {
	const ctx = await browser.newContext({ storageState: state("dennis"), viewport: { width: 1440, height: 900 } });
	const p = await ctx.newPage();
	await p.goto("/t/asia-2027?lens=country");
	await expectLive(p);
	await expect
		.poll(() => p.evaluate(() => !!(window as unknown as { __tripMap?: unknown }).__tripMap), { timeout: 20_000 })
		.toBe(true);
	await p.waitForTimeout(3000);
	const layers = await p.evaluate(() => {
		const m = (window as unknown as { __tripMap?: { map?: unknown } }).__tripMap;
		const map = (m?.map ?? m) as { getStyle(): { layers: { id: string; type: string; filter?: unknown; paint?: Record<string, unknown> }[] } };
		return map
			.getStyle()
			.layers.filter((l) => /edge|leg|route|arc/i.test(l.id) && l.type === "line")
			.map((l) => ({ id: l.id, dash: l.paint?.["line-dasharray"] ?? null, filter: JSON.stringify(l.filter ?? null).slice(0, 160) }));
	});
	console.log("edge layers", JSON.stringify(layers, null, 1));
	await shot(p, "41-map-root");
	const flight = layers.find((l) => l.id === "yonder-edges-flight");
	expect(flight?.dash ?? null).toBeNull();
	await ctx.close();
});
