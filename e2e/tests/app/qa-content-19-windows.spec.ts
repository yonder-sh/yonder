/**
 * I2 "content" verifier: relative booking windows (ADDENDUM §10, QA DUE-09)
 * on a cloned fixture trip: days / months / day-of-month rules follow their
 * item when it moves and when the whole trip shifts; a gone anchor says
 * "Date TBD".
 */
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { TESTID } from "../../../src/lib/testids";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
test.use({ storageState: path.join(AUTH, "dennis.json") });

async function call<T>(page: Page, mod: string, fn: string, data: unknown): Promise<T> {
	return page.evaluate(
		async ({ mod, fn, data }) => {
			const m = await import(mod);
			try {
				return await m[fn]({ data });
			} catch (e) {
				return { __error: (e as Error).message };
			}
		},
		{ mod, fn, data },
	) as Promise<T>;
}
const LISTS = "/src/features/lists/lists.functions.ts";

test("relative windows follow item moves, trip shifts; gone anchor → Date TBD", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=lists`);
	await expectLive(page);
	const g = await page.evaluate(() => (window as unknown as { __yonder: { graph: { items: { id: string; dayId: string | null; title: string | null; nodeId: string | null }[]; days: { id: string; date: string }[]; nodes: { id: string; name: string }[]; trip: { version?: number } } } }).__yonder.graph);
	const itemName = (id: string) => {
		const it = g.items.find((i) => i.id === id);
		return it?.title ?? g.nodes.find((n) => n.id === it?.nodeId)?.name;
	};
	const kiyo = c.ids.items.kiyomizu;
	console.log("anchor", itemName(kiyo), g.items.find((i) => i.id === kiyo)?.dayId, JSON.stringify(g.days.map((d) => d.date)));
	const rules = [
		["QA 355 days @09:00 JST", { kind: "days", itemId: kiyo, days: 355, time: "09:00", tz: "Asia/Tokyo" }],
		["QA 1 month @10:00 JST", { kind: "months", itemId: kiyo, months: 1, time: "10:00", tz: "Asia/Tokyo" }],
		["QA 10th, 2 months before", { kind: "months", itemId: kiyo, months: 2, dayOfMonth: 10, time: "10:00", tz: "Asia/Tokyo" }],
	] as const;
	for (const [text, rule] of rules) {
		const r = await call(page, LISTS, "createListItem", { tripId: c.tripId, target: { kind: "trip" }, list: "todo", text, dueKind: "opens", dueRule: rule });
		console.log("create", text, JSON.stringify(r).slice(0, 100));
	}
	await page.reload();
	await expectLive(page);
	const tab = page.getByTestId(TESTID.listsTab);
	const chips = async () => {
		const out: Record<string, string> = {};
		for (const [text] of rules) out[text] = (await tab.getByTestId(L.row).filter({ hasText: text }).innerText()).replace(/\n/g, " | ");
		return out;
	};
	const c0 = await chips();
	console.log("BEFORE", JSON.stringify(c0, null, 1));
	await shot(page, "19-windows-before");
	// Shift the whole trip by +1 day.
	const version = await page.evaluate(() => (window as unknown as { __yonder: { graph: { trip: { version: number } } } }).__yonder.graph.trip.version);
	const s = await call(page, "/src/functions/trips.functions.ts", "shiftTripDates", { tripId: c.tripId, deltaDays: 1, expectedVersion: version });
	console.log("shift", JSON.stringify(s).slice(0, 200));
	await page.reload();
	await expectLive(page);
	const c1 = await chips();
	console.log("AFTER SHIFT +1", JSON.stringify(c1, null, 1));
	await shot(page, "19-windows-after-shift");
	// Move the anchor to another day.
	const g2 = await page.evaluate(() => (window as unknown as { __yonder: { graph: { days: { id: string; date: string }[]; items: { id: string; dayId: string | null }[] } } }).__yonder.graph);
	const cur = g2.items.find((i) => i.id === kiyo)?.dayId;
	const idx = g2.days.findIndex((d) => d.id === cur);
	const next = g2.days[idx + 1];
	await call(page, "/src/functions/items.functions.ts", "moveItem", { itemId: kiyo, dayId: next?.id });
	await page.reload();
	await expectLive(page);
	console.log("AFTER MOVE +1 day", JSON.stringify(await chips(), null, 1));
	// Delete the anchor: "Date TBD".
	const del = await call(page, "/src/functions/items.functions.ts", "deleteItem", { itemId: kiyo });
	console.log("deleteItem", JSON.stringify(del).slice(0, 120));
	await page.reload();
	await expectLive(page);
	console.log("AFTER DELETE", JSON.stringify(await chips(), null, 1));
	await shot(page, "19-windows-after-delete");
	// Unschedule instead (restore + move to Unscheduled).
	expect(c1).not.toEqual(c0);
});
