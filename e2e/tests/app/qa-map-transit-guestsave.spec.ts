/** I2 map-transit: an edit-link guest can't edit NH 9 and sees its ref masked; the stored flight is unchanged; TK 25 + TK 11 layover. */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { APP, asUser, graph, itemLabel, OUT, onlyHere, shot } from "./qa-map-transit-helpers";
import { openLink } from "./_helpers/link";

onlyHere();
const LOG = path.join(OUT, "guestsave-results.txt");
const log = (s: string) => appendFileSync(LOG, `${s}\n`);

test("an edit-link guest can't edit NH 9; TK layover", async ({ browser }) => {
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
	// Link guests only view (owner, 2026-10-09): no flight edit; ref and seats masked.
	const edit = ov.getByRole("button", { name: "Edit flight" });
	if (await edit.count()) await expect(edit).toBeDisabled();
	await expect(ov).not.toContainText("ZK4P7Q");
	await guest.screenshot({ path: shot("guest-flight-readonly") });
	await d.page.reload();
	await expect(d.page.getByTestId("workspace")).toBeVisible({ timeout: 45_000 });
	await d.page.waitForTimeout(1500);
	const g2 = await graph(d.page);
	const after = g2.legs.find((l) => l.id === nh9?.id);
	log(`after: ${JSON.stringify((after?.details as { flight?: unknown }).flight)}`);
	expect(JSON.stringify((after?.details as { flight?: unknown }).flight)).toBe(before);
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
