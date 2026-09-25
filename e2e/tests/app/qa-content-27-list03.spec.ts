/** I2 "content" verifier: LIST-03 rows show where they belong. */
import path from "node:path";
import { expect, test } from "@playwright/test";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
test.use({ storageState: path.join(AUTH, "dennis.json") });

type G = {
	trip: { id: string };
	nodes: { id: string; name: string }[];
	items: { id: string; nodeId: string | null; title: string | null }[];
	days: { id: string; date: string }[];
	legs: { id: string; mode: string | null; toItemId: string | null; details: Record<string, unknown> | null }[];
};

test("LIST-03 crumbs", async ({ page }) => {
	await page.goto("/t/asia-2027?tab=lists");
	await expectLive(page);
	// The to-dos of qa-content-12's LIST-02/03, on the NH 9 flight, the Fuji Excursion leg, Sat 2 Oct and the trip.
	const g = await page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
	const name = (id: string | null) => {
		const it = g.items.find((i) => i.id === id);
		return it?.title ?? g.nodes.find((n) => n.id === it?.nodeId)?.name;
	};
	const fuji = g.legs.find((l) => /Fuji Excursion/.test(JSON.stringify(l.details ?? {})) || name(l.toItemId) === "Drop bags at ryokan");
	const nh9 = g.legs.find((l) => l.mode === "flight" && /NH ?9\b/.test(JSON.stringify(l.details ?? {})));
	const sat = g.days.find((d) => d.date === "2027-10-02");
	if (!fuji || !nh9 || !sat) throw new Error(`fixture: fuji=${!!fuji} nh9=${!!nh9} sat=${!!sat}`);
	const todos = [
		{ text: "Select seats 8D/8G", target: { kind: "leg", legId: nh9.id }, crumb: "Flight · NH 9 JFK → HND" },
		{ text: "Charge phones", target: { kind: "day", dayId: sat.id }, crumb: "Day 1 · Sat 2 Oct" },
		{ text: "Transfer Chase → Aeroplan before 30 Sep 2026", target: { kind: "trip" }, crumb: null },
		{ text: "Buy Fuji Excursion seats", target: { kind: "leg", legId: fuji.id }, crumb: "Leg · Fuji Excursion 7" },
	];
	await page.evaluate(
		async ({ tripId, todos }) => {
			const l = await import("/src/features/lists/lists.functions.ts");
			for (const t of todos) await l.createListItem({ data: { tripId, target: t.target, list: "todo", text: t.text } });
		},
		{ tripId: g.trip.id, todos },
	);
	await page.reload();
	await expectLive(page);
	const tab = page.getByTestId(TESTID.listsTab);
	for (const t of todos) {
		const r = tab.getByTestId(L.row).filter({ hasText: t.text }).first();
		await expect(r).toBeVisible();
		console.log("ROW", t.text, "=>", (await r.innerText()).replace(/\n/g, " | "));
		if (t.crumb) await expect(r).toContainText(t.crumb);
	}
});
