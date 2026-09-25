/** I2 "content" verifier: LIST-03 rows show where they belong. */
import path from "node:path";
import { test } from "@playwright/test";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
test.use({ storageState: path.join(AUTH, "dennis.json") });
test("LIST-03 crumbs", async ({ page }) => {
	await page.goto("/t/asia-2027?tab=lists");
	await expectLive(page);
	const tab = page.getByTestId(TESTID.listsTab);
	for (const t of ["Select seats 8D/8G", "Charge phones", "Transfer Chase → Aeroplan before 30 Sep 2026", "Buy Fuji Excursion seats"]) {
		const r = tab.getByTestId(L.row).filter({ hasText: t }).first();
		console.log("ROW", t, "=>", (await r.innerText().catch(() => "MISSING")).replace(/\n/g, " | "));
	}
});
