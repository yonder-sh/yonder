/**
 * SECURITY §2 "a guest can't pose as 'Dennis (owner)'": a guest editor names
 * themselves "Dennis Tester" and edits; how do the owner's activity views
 * attribute it?
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { call, EMAIL, GG, guestPage, MOD, memberPage, T, TOKEN } from "./qa-security-helpers";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const DIR = process.env.QA_SEC_DIR ?? "/tmp";
test("a guest editor named like the owner in the activity feed", async ({ browser }) => {
	test.setTimeout(180_000);
	const out: Record<string, unknown> = {};
	const stamp = Date.now().toString(36);
	const g = await guestPage(browser, TOKEN.editor);
	out.rename = await call(g.page, MOD.share, "renameGuest", { name: "Dennis Tester" });
	const del = await call(g.page, MOD.lists, "createListItem", { tripId: T, target: { kind: "node", nodeId: GG }, list: "todo", text: `Cancel all bookings ${stamp}` });
	out.write = del.ok ? "OK" : del.err;
	const dennis = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	const act = await call(dennis.page, MOD.graph, "listActivity", { tripId: T, limit: 5 });
	out.activity = act.ok ? (act.r as { actorName: string; summary: string }[]).slice(0, 3) : act.err;
	await dennis.page.goto("/t/asia-2027?tab=plan");
	await dennis.page.waitForTimeout(4000);
	await dennis.page.screenshot({ path: path.join(DIR, "spoof-overview.png") });
	await dennis.page.getByText(/changes? since you last looked/).first().click().catch(() => undefined);
	await dennis.page.waitForTimeout(2000);
	await dennis.page.screenshot({ path: path.join(DIR, "spoof-activity.png") });
	out.dialogText = (await dennis.page.getByRole("dialog").first().innerText().catch(() => "")).slice(0, 600);
	const recent = dennis.page.getByText(`Cancel all bookings ${stamp}`).first();
	out.visibleInOverview = await recent.isVisible().catch(() => false);
	writeFileSync(path.join(DIR, "spoof.json"), JSON.stringify(out, null, 1));
	await g.ctx.close();
	await dennis.ctx.close();
});
