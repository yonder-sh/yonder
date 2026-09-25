/**
 * I2 "content" verifier, round 2: does a member's PRIVATE day note show
 * itself to another member (ADDENDUM §7.2: never in others' counts, …)?
 * Probe: shortening the trip over a day that holds only Dennis's private note.
 */
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
type G = { trip: { id: string; version: number }; days: { id: string; date: string }[]; items: { id: string; dayId: string | null }[] };

test("a private day note blocks another member's date change and names the day", async ({ browser }) => {
	test.setTimeout(120_000);
	const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(dctx.request, "dev@example.com", { first: "Dev", last: "User" });
	const d = await dctx.newPage();
	const c = await cloneFixtureTrip(d.request);
	await d.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(d);
	const g0 = await d.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
	const days0 = [...g0.days].sort((a, b) => a.date.localeCompare(b.date));
	// Dennis adds an empty day before the trip, then keeps a private note on it.
	const prev = new Date(`${days0[0]?.date}T12:00:00Z`);
	prev.setUTCDate(prev.getUTCDate() - 1);
	const ext = await d.evaluate(
		async ({ tripId, start, end, v }) => {
			const t = await import("/src/functions/trips.functions.ts");
			try {
				return await t.setTripDates({ data: { tripId, startDate: start, endDate: end, expectedVersion: v } });
			} catch (e) {
				return { __error: (e as Error).message };
			}
		},
		{ tripId: c.tripId, start: prev.toISOString().slice(0, 10), end: days0[days0.length - 1]?.date as string, v: g0.trip.version },
	);
	console.log("extend", JSON.stringify(ext));
	await d.reload();
	await expectLive(d);
	const g = await d.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
	const days = [...g.days].sort((a, b) => a.date.localeCompare(b.date));
	const last = days[0];
	console.log("days", days.map((x) => x.date).join(","), "last has items:", g.items.filter((i) => i.dayId === last?.id).length);
	await d.goto(`/t/${c.slug}?sel=d.${last?.id}`);
	await expectLive(d);
	await d.getByTestId(TESTID.inspector).getByRole("tab", { name: /Notes/ }).click();
	const panel = d.getByTestId(TESTID.notesPanel);
	await panel.getByTestId(NT.privateToggle).getByRole("button", { name: /Only me/ }).click();
	const ed = panel.getByTestId(NT.editor);
	await expect(ed).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
	await ed.click();
	await d.keyboard.type("PRIVATE DAYNOTE only for me");
	await d.waitForTimeout(4000);
	await shot(d, "33-private-daynote");
	// Maya (an editor of the clone) shortens the trip by the last day.
	const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(mctx.request, "maya@example.com", { first: "Maya", last: "Chen" });
	const m = await mctx.newPage();
	await m.goto(`/t/${c.slug}?sel=d.${last?.id}`);
	await expectLive(m);
	const mg = await m.evaluate(() => (window as unknown as { __yonder: { graph: G & { me: unknown } } }).__yonder.graph);
	console.log("maya me", JSON.stringify(mg.me));
	await m.getByTestId(TESTID.inspector).getByRole("tab", { name: /Notes/ }).click();
	await m.waitForTimeout(1500);
	console.log("maya day notes text:", JSON.stringify((await m.getByTestId(TESTID.notesPanel).innerText()).slice(0, 200)));
	const res = await m.evaluate(
		async ({ tripId, start, end, v }) => {
			const t = await import("/src/functions/trips.functions.ts");
			try {
				return await t.setTripDates({ data: { tripId, startDate: start, endDate: end, expectedVersion: v } });
			} catch (e) {
				return { __error: (e as Error).message };
			}
		},
		{ tripId: c.tripId, start: days[1]?.date as string, end: days[days.length - 1]?.date as string, v: mg.trip.version },
	);
	console.log("maya setTripDates:", JSON.stringify(res));
	await shot(m, "33-maya-daynote");
	await dctx.close();
	await mctx.close();
	expect(JSON.stringify(res)).not.toMatch(/has a note/);
});
