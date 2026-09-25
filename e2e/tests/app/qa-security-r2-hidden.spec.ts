/**
 * QA security verifier (I2 round 2): "Hide from guests" (ADDENDUM §9) seen
 * through counts, covers and the leg/node payloads, member vs link guest.
 * Needs the members-only photo on Tokyo and the members-only PDF on the
 * JFK→HND leg (qa-security-privacy.spec.ts sets both up).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { call, EMAIL, FLIGHT_LEG, guestPage, IDS, MOD, memberPage, T, TOKEN } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const TOKYO: string = IDS.TOKYO ?? "01a0cf13-e763-7519-9ffa-a1ac2e9cc1d3";
const HIDDEN_PHOTO: string = IDS.HIDDEN_PHOTO ?? "01a0cf13-e76d-7683-9c36-ec028a4e8144";

test("members-only media leave no trace for guests", async ({ browser }) => {
	test.setTimeout(200_000);
	const out: Record<string, unknown> = {};
	for (const [who, open] of [
		["dennis", () => memberPage(browser, EMAIL.dennis, "Dennis", "Tester")],
		["kai", () => memberPage(browser, EMAIL.kai)],
		["guestViewer", () => guestPage(browser, TOKEN.viewer)],
		["guestEditor", () => guestPage(browser, TOKEN.editor)],
	] as const) {
		const { ctx, page } = await open();
		const counts = await call(page, MOD.graph, "getTripCounts", { tripId: T });
		const graph = await call(page, MOD.graph, "getTripGraph", { tripId: T });
		const media = await call(page, MOD.media, "listTripMedia", { tripId: T });
		const c = counts.ok ? (counts.r as { byNode: Record<string, unknown>; byLeg?: Record<string, unknown> }) : null;
		const g = graph.ok ? (graph.r as { nodes: { id: string; cover?: unknown; coverId?: unknown }[]; legs: { id: string; hasContent?: boolean }[] }) : null;
		const tokyo = g?.nodes.find((n) => n.id === TOKYO);
		out[who] = {
			tokyoCounts: c?.byNode[TOKYO],
			flightLegCounts: c?.byLeg?.[FLIGHT_LEG] ?? "(no byLeg)",
			countsKeys: c ? Object.keys(c) : null,
			tokyoCover: tokyo ? JSON.stringify({ cover: tokyo.cover, coverId: tokyo.coverId }).slice(0, 200) : null,
			graphHasHiddenId: JSON.stringify(graph).includes(HIDDEN_PHOTO),
			mediaHasHiddenId: JSON.stringify(media).includes(HIDDEN_PHOTO),
			flightLegHasContent: g?.legs.find((l) => l.id === FLIGHT_LEG)?.hasContent,
			mediaCount: media.ok ? (media.r as unknown[]).length : media.err,
		};
		// A guest editor tries to un-hide or delete a members-only row it can't see.
		if (who === "guestEditor") {
			for (const [fn, data] of [
				["setAttachmentVisibility", { id: HIDDEN_PHOTO, visibility: "everyone" }],
				["updateAttachment", { id: HIDDEN_PHOTO, caption: "guest touched it" }],
				["deleteAttachment", { id: HIDDEN_PHOTO }],
			] as const) {
				const r = await call(page, MOD.media, fn, data);
				(out[who] as Record<string, unknown>)[`try:${fn}`] = r.ok ? `OK ${JSON.stringify(r.r).slice(0, 80)}` : r.err.slice(0, 80);
			}
		}
		await ctx.close();
	}
	writeFileSync(path.join(DIR, "r2-hidden.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
});
