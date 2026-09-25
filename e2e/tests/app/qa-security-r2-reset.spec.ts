/**
 * QA security verifier (I2 round 2): re-check of "a guest whose link is
 * turned off or reset lands on the sign-in page" with a RESET (new token) on
 * a clone, and that the old token is dead while the new one works.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { call, MOD } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";

test("reset link: open guest, old token, new token", async ({ browser }) => {
	test.setTimeout(200_000);
	const out: Record<string, unknown> = {};
	const octx = await browser.newContext();
	await loginViaApi(octx.request, `qa-sec-r2-rs-${Date.now().toString(36)}@example.com`, { first: "Olga", last: "Owner" });
	const op = await octx.newPage();
	const c = await cloneFixtureTrip(op.request);
	await op.goto("/login");
	const g = await browser.newContext();
	const gp = await g.newPage();
	await gp.goto(`/join#t=${c.shareTokens.editor}`);
	await expect(gp.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const r = await call(op, MOD.sharing, "resetShareLink", { tripId: c.tripId, role: "editor" });
	out.reset = r.ok ? "OK" : r.err;
	const newUrl = r.ok ? (r.r as { url: string }).url : "";
	await gp.waitForTimeout(5000);
	out.openGuestAfterReset = { url: gp.url(), text: (await gp.locator("body").innerText()).slice(0, 160).replace(/\s+/g, " ") };
	await gp.screenshot({ path: path.join(DIR, "r2-reset-open-guest.png") });
	await gp.reload();
	await gp.waitForTimeout(4000);
	out.afterReload = { url: gp.url(), text: (await gp.locator("body").innerText()).slice(0, 160).replace(/\s+/g, " ") };
	await gp.screenshot({ path: path.join(DIR, "r2-reset-reload.png") });
	const g2 = await browser.newContext();
	const p2 = await g2.newPage();
	await p2.goto(`/join#t=${c.shareTokens.editor}`);
	await p2.waitForTimeout(5000);
	out.oldToken = { url: p2.url(), text: (await p2.locator("body").innerText()).slice(0, 100).replace(/\s+/g, " ") };
	await p2.goto(newUrl.replace(/^https?:\/\/[^/]+/, ""));
	await p2.waitForTimeout(6000);
	out.newTokenSameTab = { url: p2.url().replace(/#t=.*/, "#t=<new>"), text: (await p2.locator("body").innerText()).slice(0, 100).replace(/\s+/g, " ") };
	await p2.screenshot({ path: path.join(DIR, "r2-reset-newtoken-same-tab.png") });
	const g3 = await browser.newContext();
	const p3 = await g3.newPage();
	await p3.goto(newUrl.replace(/^https?:\/\/[^/]+/, ""));
	await p3.waitForTimeout(6000);
	out.newTokenFreshTab = { url: p3.url() };
	await g3.close();
	writeFileSync(path.join(DIR, "r2-reset.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	for (const x of [octx, g, g2]) await x.close();
});
