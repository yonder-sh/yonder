/** ADDENDUM §7.2: Dennis's private note (Love Hotel Hill) never reaches anyone else. */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { call, EMAIL, guestPage, MOD, memberPage, T, TOKEN } from "./qa-security-helpers";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const NODE = "01a0cf13-e765-70f2-9b1e-c06c7ad9f535";
test("private notes stay private", async ({ browser }) => {
	test.setTimeout(240_000);
	const out: Record<string, unknown> = {};
	for (const [who, open] of [
		["dennis", () => memberPage(browser, EMAIL.dennis, "Dennis", "Tester")],
		["audrey", () => memberPage(browser, EMAIL.audrey)],
		["kai", () => memberPage(browser, EMAIL.kai)],
		["guestEditor", () => guestPage(browser, TOKEN.editor)],
	] as const) {
		const { ctx, page } = await open();
		const counts = await call(page, MOD.graph, "getTripCounts", { tripId: T });
		const notes = await call(page, MOD.notes, "listTripNotes", { tripId: T });
		const act = await call(page, MOD.graph, "listActivity", { tripId: T, limit: 100 });
		const digest = await call(page, MOD.activity, "getDigest", { tripId: T });
		const inbox = await call(page, MOD.inbox, "listInbox", { tripId: T });
		const graph = await call(page, MOD.graph, "getTripGraph", { tripId: T });
		const hit = (r: unknown) => JSON.stringify(r).includes("PRIVNOTE");
		out[who] = {
			hasNote: counts.ok ? (counts.r as { byNode: Record<string, { hasNote: boolean }> }).byNode[NODE]?.hasNote ?? false : counts.err,
			notes: hit(notes), activity: hit(act), digest: hit(digest), inbox: hit(inbox), graph: hit(graph),
		};
		await ctx.close();
	}
	writeFileSync(path.join(process.env.QA_SEC_DIR ?? "/tmp", "privnote.json"), JSON.stringify(out, null, 1));
});
