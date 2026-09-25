/**
 * I2 "content" verifier: list/note marks on the Plan and the map edge panel
 * (QA LIST-02 badge, NOTE-07 preview) on the imported Asia 2027 trip.
 */
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
test.use({ storageState: path.join(AUTH, "dennis.json") });

type G = {
	trip: { id: string };
	nodes: { id: string; name: string }[];
	items: { id: string; nodeId: string | null; dayId: string | null; title: string | null }[];
	days: { id: string; date: string }[];
	legs: { id: string; kind: string; fromItemId: string | null; toItemId: string | null; mode: string | null }[];
};
const graphOf = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);

test("LIST-02 badge on the Fuji Excursion leg row and the map edge; NOTE-07 preview", async ({ page }) => {
	await page.goto("/t/asia-2027?tab=plan");
	await expectLive(page);
	const g = await graphOf(page);
	const name = (id: string | null) => {
		const it = g.items.find((i) => i.id === id);
		return it?.title ?? g.nodes.find((n) => n.id === it?.nodeId)?.name ?? "?";
	};
	const fuji = g.legs.find((l) => name(l.toItemId) === "Drop bags at ryokan");
	if (!fuji) throw new Error("no fuji leg");
	const day7 = g.days.find((d) => d.date === "2027-10-07");
	const day5 = g.days.find((d) => d.date === "2027-10-05");
	if (!day7 || !day5) throw new Error("days");
	await page.goto(`/t/asia-2027?tab=plan&sel=d.${day7.id}`);
	await expectLive(page);
	await page.waitForTimeout(1500);
	const drop = page.getByTestId(TESTID.timelineItem).filter({ hasText: "Drop bags at ryokan" }).first();
	await drop.scrollIntoViewIfNeeded();
	await page.waitForTimeout(500);
	await shot(page, "13-plan-day7-fuji-leg");
	// The leg row just before "Drop bags at ryokan".
	const legs = page.getByTestId(TESTID.leg);
	const n = await legs.count();
	for (let i = 0; i < n; i++) {
		const t = (await legs.nth(i).innerText().catch(() => "")).replace(/\n/g, " | ");
		if (/Fuji Excursion|Kawaguchiko/.test(t)) console.log("LEG ROW", i, t);
	}
	// NOTE-07: Bar Benfiddich's card on Tue 5 Oct.
	await page.goto(`/t/asia-2027?tab=plan&sel=d.${day5.id}`);
	await expectLive(page);
	await page.waitForTimeout(1500);
	const benf = page.getByTestId(TESTID.timelineItem).filter({ hasText: "Bar Benfiddich" }).first();
	await benf.scrollIntoViewIfNeeded();
	await page.waitForTimeout(400);
	console.log("BENF CARD", (await benf.innerText()).replace(/\n/g, " | "));
	await shot(page, "13-plan-day5-benfiddich");
	// The map edge panel between Tokyo and Mt. Fuji.
	const tokyo = g.nodes.find((x) => x.name === "Tokyo");
	const mtfuji = g.nodes.find((x) => x.name === "Mt. Fuji");
	await page.goto(`/t/asia-2027/japan?sel=e.${tokyo?.id}.${mtfuji?.id}`);
	await expectLive(page);
	await page.waitForTimeout(1500);
	const edge = page.getByTestId(TESTID.edgeOverview);
	console.log("EDGE", (await edge.innerText().catch(() => "none")).replace(/\n/g, " | "));
	await shot(page, "13-map-edge-tokyo-fuji");
});
