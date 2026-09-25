/** Second pass of the matrix: edit-only, direct and people functions per role. */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { call, EMAIL, GG, guestPage, IDS, MOD, memberPage, T, TOKEN } from "./qa-security-helpers";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const DM: string = IDS.DM ?? "01a0cf13-fed4-74e3-a8e8-b7dc9254f72d"; // "Delete me": Dennis owns, Audrey edits
const LINK_ATT: string = IDS.LINK_ATT ?? "01a0cf13-e76e-706f-ac56-3982857012df";
const PAIR = { kind: "pair", fromItemId: IDS.PAIR_FROM ?? "01a0cf13-e770-7057-a38f-3eb150fa3a66", toItemId: IDS.PAIR_TO ?? "01a0cf13-e770-7057-a38f-40bc39e6cd97" };
const probes: [string, string, string, unknown][] = [
	["searchPlaces", MOD.places, "searchPlaces", { tripId: T, q: "Golden Gai", sessionToken: "qa" }],
	["refreshLinkMeta", MOD.media, "refreshLinkMeta", { id: LINK_ATT }],
	["estimateWalk", MOD.transit, "estimateWalk", { target: PAIR }],
	["fetchOpeningHours", MOD.insights, "fetchOpeningHours", { tripId: T, nodeIds: [GG] }],
	["extendShareLink", MOD.sharing, "extendShareLink", { tripId: T }],
	["deleteTrip(DM)", MOD.trips, "deleteTrip", { tripId: DM }],
	["leaveTrip(T)", MOD.sharing, "leaveTrip", { tripId: T, dryRunProbe: undefined }],
	["getClimate", MOD.insights, "getClimate", { tripId: T, nodeIds: [IDS.TOKYO ?? "01a0cf13-e763-7519-9ffa-a1ac2e9cc1d3"] }],
];
test("authz matrix, second pass", async ({ browser }) => {
	test.setTimeout(400_000);
	const out: Record<string, Record<string, string>> = {};
	for (const [who, open] of [
		["maya", () => memberPage(browser, EMAIL.maya)],
		["kai", () => memberPage(browser, EMAIL.kai)],
		["audrey", () => memberPage(browser, EMAIL.audrey)],
		["guestSuggester", () => guestPage(browser, TOKEN.suggester)],
		["guestViewer", () => guestPage(browser, TOKEN.viewer)],
		["guestEditor", () => guestPage(browser, TOKEN.editor)],
	] as const) {
		const { ctx, page } = await open();
		const row: Record<string, string> = {};
		for (const [name, mod, fn, data] of probes) {
			if (name.startsWith("leaveTrip")) continue; // destructive for members; checked for guests below
			const r = await call(page, mod, fn, data);
			row[name] = r.ok ? `OK ${JSON.stringify(r.r).slice(0, 60)}` : r.err.slice(0, 70);
		}
		if (who.startsWith("guest")) {
			const r = await call(page, MOD.sharing, "leaveTrip", { tripId: T });
			row.leaveTrip = r.ok ? "OK" : r.err.slice(0, 70);
		}
		out[who] = row;
		await ctx.close();
	}
	writeFileSync(path.join(process.env.QA_SEC_DIR ?? "/tmp", "authz2.json"), JSON.stringify(out, null, 1));
});
