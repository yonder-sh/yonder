/** A guest editor (never sees money) changes the trip's HOME currency through the API. */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { call, EMAIL, guestPage, MOD, memberPage, T, TOKEN } from "./qa-security-helpers";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

test("guest editor vs home currency", async ({ browser }) => {
	test.setTimeout(240_000);
	const out: Record<string, unknown> = {};
	const dennis = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	const before = await call(dennis.page, MOD.money, "listMoney", { tripId: T });
	out.homeBefore = before.ok ? (before.r as { homeCurrency: string }).homeCurrency : before.err;
	const g = await guestPage(browser, TOKEN.editor);
	out.guestSeesMoney = (await call(g.page, MOD.money, "listMoney", { tripId: T })).ok;
	const r = await call(g.page, MOD.trips, "updateTrip", { tripId: T, settings: { currency: "VND" } });
	out.guestChange = r.ok ? r.r : r.err;
	await dennis.page.waitForTimeout(8000);
	const after = await call(dennis.page, MOD.money, "listMoney", { tripId: T });
	out.homeAfter = after.ok ? (after.r as { homeCurrency: string }).homeCurrency : after.err;
	await dennis.page.goto("/t/asia-2027?tab=money");
	await dennis.page.getByRole("tab", { name: /^Money/ }).first().click().catch(() => undefined);
	await dennis.page.waitForTimeout(3000);
	await dennis.page.screenshot({ path: path.join(process.env.QA_SEC_DIR ?? "/tmp", "guest-currency.png") });
	// Restore.
	const back = await call(dennis.page, MOD.trips, "updateTrip", { tripId: T, settings: { currency: String(out.homeBefore) } });
	out.restore = back.ok ? "OK" : back.err;
	writeFileSync(path.join(process.env.QA_SEC_DIR ?? "/tmp", "guestcurrency.json"), JSON.stringify(out, null, 1));
	await g.ctx.close();
	await dennis.ctx.close();
});
