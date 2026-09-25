/**
 * QA security verifier (I2 round 2): re-check of the reported SHR-07 bug
 * (Itoya's Maps link vs the Itoya already in Asia 2027) on the dev stack.
 */
import { test } from "@playwright/test";
import { call, EMAIL, memberPage, T } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

test("SHR-07 resolveSharedLink finds the existing Itoya", async ({ browser }) => {
	const { ctx, page } = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	for (const url of [
		"https://www.google.com/maps/place/Itoya/@35.6739,139.7676,17z",
		"https://www.google.com/maps/place/G.Itoya/@35.6739,139.7676,17z",
	]) {
		const r = await call(page, "/src/features/places/places.functions.ts", "resolveSharedLink", { tripId: T, url });
		console.log("SHR-07", url, JSON.stringify(r).slice(0, 700));
	}
	await ctx.close();
});
