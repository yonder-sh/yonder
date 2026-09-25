/** I2 "content" verifier: shopping ↔ plan "Closed Day N" (ADDENDUM §10, E1 hours). */
import path from "node:path";
import { expect, test } from "@playwright/test";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";

test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");
const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
test.use({ storageState: path.join(AUTH, "dennis.json") });
test("Closed Day N on a shopping row", async ({ page }) => {
	await page.goto("/t/asia-2027?tab=lists&list=shopping");
	await expectLive(page);
	const id = await page.evaluate(() => (window as unknown as { __yonder: { graph: { nodes: { id: string; name: string }[] } } }).__yonder.graph.nodes.find((n) => n.name === "Kappabashi Street")?.id);
	const set = (hours: unknown) =>
		page.evaluate(
			async ({ nodeId, hours }) => {
				const m = await import("/src/features/insights/insights.functions.ts");
				try {
					return JSON.stringify(await m.setOpeningHours({ data: { nodeId, hours } }));
				} catch (e) {
					return (e as Error).message;
				}
			},
			{ nodeId: id, hours },
		);
	const periods = [2, 3, 4, 5, 6].map((day) => ({ day, open: "09:00", close: "17:00" }));
	console.log("set hours", await set({ source: "manual", periods, closedDays: [0, 1], updatedAt: new Date().toISOString() }));
	await page.reload();
	await expectLive(page);
	const det = await page.evaluate((nid) => JSON.stringify((window as unknown as { __yonder: { graph: { nodes: { id: string; details: unknown }[] } } }).__yonder.graph.nodes.find((n) => n.id === nid)?.details).slice(0, 400), id);
	console.log("node details", det);
	const row = page.getByTestId(TESTID.listsTab).getByTestId(L.row).filter({ hasText: "Knife sharpener" });
	await page.waitForTimeout(1500);
	console.log("shop plan:", await row.getByTestId(L.shopPlan).innerText());
	await page.screenshot({ path: path.join(SHOTS, "28-closed-day.png") });
	await page.goto("/t/asia-2027?tab=plan&days=2027-10-04");
	await expectLive(page);
	await page.waitForTimeout(1500);
	const card = page.getByTestId(TESTID.timelineItem).filter({ hasText: "Kappabashi" }).first();
	await card.scrollIntoViewIfNeeded();
	console.log("plan card:", (await card.innerText()).replace(/\n/g, " | "), "hours chips:", await card.getByTestId(TESTID.hoursChip).count());
	await page.screenshot({ path: path.join(SHOTS, "28-closed-plan.png") });
	console.log("reset", await set(null));
});
