/** LINK-03 / SHARE-08: what the share UI and getSharing show a link guest and a viewer. */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { call, EMAIL, guestPage, MOD, memberPage, T, TOKEN } from "./qa-security-helpers";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const DIR = process.env.QA_SEC_DIR ?? "/tmp";
test("share settings as a guest editor and a viewer", async ({ browser }) => {
	test.setTimeout(180_000);
	const out: Record<string, unknown> = {};
	for (const [who, open] of [
		["guestEditor", () => guestPage(browser, TOKEN.editor)],
		["kai", () => memberPage(browser, EMAIL.kai)],
	] as const) {
		const { ctx, page } = await open();
		const s = await call(page, MOD.sharing, "getSharing", { tripId: T });
		out[`${who}:getSharing`] = s.ok ? s.r : s.err;
		await page.goto("/t/asia-2027?tab=plan");
		await page.waitForTimeout(3000);
		const share = page.getByRole("button", { name: /^Share$/ }).first();
		if (await share.isVisible().catch(() => false)) {
			await share.click();
			await page.waitForTimeout(1500);
			out[`${who}:dialog`] = (await page.getByRole("dialog").first().innerText().catch(() => "(no dialog)")).slice(0, 800);
			await page.screenshot({ path: path.join(DIR, `share-${who}.png`) });
		} else out[`${who}:dialog`] = "(no Share button)";
		await ctx.close();
	}
	writeFileSync(path.join(DIR, "guestshare.json"), JSON.stringify(out, null, 1));
});
