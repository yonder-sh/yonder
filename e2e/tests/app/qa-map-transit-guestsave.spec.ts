/** I2 map-transit: a guest editor saves NH 9 (masked ref/seats) — the stored ref and seats must survive; TK 25 + TK 11 layover. */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { APP, asUser, graph, itemLabel, OUT, onlyHere, shot } from "./qa-map-transit-helpers";
import { openLink } from "./_helpers/link";

onlyHere();
const LOG = path.join(OUT, "guestsave-results.txt");
const log = (s: string) => appendFileSync(LOG, `${s}\n`);

test("guest editor saves NH 9; Fuji Excursion booking too", async ({ browser }) => {
	writeFileSync(LOG, "");
	const d = await asUser(browser, "dennis@asia2027.test");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expect(d.page.getByTestId("workspace")).toBeVisible({ timeout: 45_000 });
	const g = await graph(d.page);
	const nh9 = g.legs.find((l) => itemLabel(g, l.fromItemId) === "Check in (JFK T7)");
	const before = JSON.stringify((nh9?.details as { flight?: unknown }).flight);
	log(`before: ${before}`);
	const gc = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const guest = await gc.newPage();
	await openLink(guest, "asia-2027", "editor");
	await expect(guest).toHaveURL(/\/t\/asia-2027/, { timeout: 30_000 });
	await guest.goto(`/t/asia-2027?sel=l.${nh9?.fromItemId}.${nh9?.toItemId}`);
	const ov = guest.getByTestId(TESTID.legOverview);
	await expect(ov).toBeVisible({ timeout: 30_000 });
	await ov.getByRole("button", { name: "Edit flight" }).click();
	const form = ov.getByTestId(T.flightForm);
	await guest.screenshot({ path: shot("guest-flight-form") });
	const refVal = (await form.getByTestId(T.flightRef).count()) ? await form.getByTestId(T.flightRef).evaluate((e) => `${e.tagName}:${(e as HTMLInputElement).value ?? ""}:${e.textContent}`) : "(no ref field)";
	const seatVals = await form.getByTestId(T.flightSeat).evaluateAll((els) => els.map((e) => `${e.tagName}:${(e as HTMLInputElement).value ?? ""}:${e.textContent}`));
	await guest.waitForTimeout(3000);
	await guest.screenshot({ path: shot("guest-map-after-wait") });
	const mapState = await guest.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		const m = (window as any).__tripMap;
		return m ? { loaded: m.loaded(), tiles: m.areTilesLoaded(), pins: m.__yonder?.pins?.length } : "no map";
	});
	log(`guest map: ${JSON.stringify(mapState)}`);
	log(`guest form ref="${refVal}" seats=${JSON.stringify(seatVals)}`);
	await form.getByTestId(T.flightAircraft).fill("Boeing 777-300ER (guest edit)");
	await form.getByTestId(T.flightSave).click();
	await guest.waitForTimeout(2500);
	const errs = (await form.count()) ? await form.getByTestId(T.flightError).allInnerTexts().catch(() => []) : [];
	log(`guest save errors: ${JSON.stringify(errs)}`);
	await d.page.reload();
	await expect(d.page.getByTestId("workspace")).toBeVisible({ timeout: 45_000 });
	await d.page.waitForTimeout(1500);
	const g2 = await graph(d.page);
	const after = g2.legs.find((l) => l.id === nh9?.id);
	log(`after: ${JSON.stringify((after?.details as { flight?: unknown }).flight)}`);
	// Revert aircraft as Dennis.
	await d.page.goto(`/t/asia-2027?sel=l.${nh9?.fromItemId}.${nh9?.toItemId}`);
	const dov = d.page.getByTestId(TESTID.legOverview);
	await expect(dov).toBeVisible({ timeout: 30_000 });
	await dov.getByRole("button", { name: "Edit flight" }).click();
	await dov.getByTestId(T.flightForm).getByTestId(T.flightAircraft).fill("Boeing 777-300ER");
	await dov.getByTestId(T.flightForm).getByTestId(T.flightSave).click();
	await d.page.waitForTimeout(1500);
	// TK 25 + TK 11: layover, no false late.
	await d.page.goto("/t/asia-2027?days=2027-11-04..2027-11-05");
	await expect(d.page.getByTestId("workspace")).toBeVisible({ timeout: 45_000 });
	await d.page.waitForTimeout(2500);
	const c = await d.page.getByTestId("center-panel").innerText();
	writeFileSync(path.join(OUT, "tk-center.txt"), c);
	log(`TK layover: conflict=${/conflict/i.test(c)} layover=${/Layover/.test(c)} misses=${/Misses/.test(c)}`);
	await d.page.screenshot({ path: shot("tk-layover") });
	await gc.close();
});
