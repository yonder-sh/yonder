/**
 * I2 "content" verifier: probing for leaks of hidden ("Hide from guests")
 * attachments through side channels — suggestions (proposals) listed to a
 * link guest, the Rate view (the old Rate screen's link, now the Places tab)
 * and a place's drawer there, the node overview, the activity digest.
 */
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { expectLive } from "./_helpers/page";
import { ensureQaPdfs } from "./_helpers/qa-pdfs";
import { openLink } from "./_helpers/link";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
const state = (h: string) => path.join(AUTH, `${h}.json`);
async function ctxFor(browser: Browser, h: string | null) {
	const ctx = await browser.newContext({ ...(h ? { storageState: state(h) } : {}), viewport: { width: 1440, height: 900 } });
	return { ctx, page: await ctx.newPage() };
}
async function guest(browser: Browser, role: "viewer" | "editor" | "suggester") {
	const c = await ctxFor(browser, null);
	await openLink(c.page, "asia-2027", role);
	await expect(c.page).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
	return c;
}
async function call<T>(page: Page, mod: string, fn: string, data: unknown): Promise<T> {
	return page.evaluate(
		async ({ mod, fn, data }) => {
			const m = await import(mod);
			try {
				return await m[fn]({ data });
			} catch (e) {
				return { __error: (e as Error).message };
			}
		},
		{ mod, fn, data },
	) as Promise<T>;
}
const MEDIA = "/src/features/media/media.functions.ts";

test("a suggestion about a hidden PDF never reaches a link guest", async ({ browser }) => {
	test.setTimeout(180_000);
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	await ensureQaPdfs(d.page);
	const tripId = await d.page.evaluate(() => (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder.graph.trip.id);
	const media = await call<{ id: string; kind: string; visibility: string; target: { kind: string } }[]>(d.page, MEDIA, "listTripMedia", { tripId });
	const hidden = media.find((m) => m.kind === "pdf" && m.visibility === "members" && m.target.kind === "leg");
	if (!hidden) throw new Error("run qa-content-17 first (needs a hidden PDF)");
	// Dennis captions it with a booking ref (members may).
	console.log("dennis caption", JSON.stringify(await call(d.page, MEDIA, "updateAttachment", { id: hidden.id, caption: "PNR ZK4P7Q — Dennis 8D" })));
	// Maya (a suggester member) suggests a new caption.
	const m = await ctxFor(browser, "maya");
	await m.page.goto("/t/asia-2027?tab=plan");
	await expectLive(m.page);
	const prop = await call(m.page, MEDIA, "updateAttachment", { id: hidden.id, caption: "SECRETREF XJ4K2Q seat 8G" });
	console.log("maya proposes", JSON.stringify(prop).slice(0, 300));
	const del = await call(m.page, MEDIA, "deleteAttachment", { id: hidden.id });
	console.log("maya proposes delete", JSON.stringify(del).slice(0, 300));
	const leaks: string[] = [];
	// Link guests with review/propose rights list the suggestions.
	for (const role of ["editor", "suggester"] as const) {
		const gst = await guest(browser, role);
		await gst.page.goto("/t/asia-2027?tab=plan");
		await expectLive(gst.page);
		const props = await call<unknown[]>(gst.page, "/src/functions/proposals.functions.ts", "listProposals", { tripId });
		const txt = JSON.stringify(props);
		const about = (props as { entityId: string | null; op: string; summary: string; payload: unknown; before: unknown }[]).filter((p) => p.entityId === hidden.id);
		console.log(`guest-${role}: proposals=${(props as unknown[]).length}, about hidden PDF=${about.length}`, JSON.stringify(about).slice(0, 600));
		console.log(`guest-${role}: leaks SECRETREF=${/SECRETREF/.test(txt)} leaks ZK4P7Q=${/ZK4P7Q/.test(txt)}`);
		// The review drawer UI.
		await gst.page.goto("/t/asia-2027?review=1");
		await gst.page.waitForTimeout(1500);
		await shot(gst.page, `22-guest-${role}-review`);
		const body = await gst.page.locator("body").innerText();
		console.log(`guest-${role} page shows SECRETREF=${/SECRETREF/.test(body)} ZK4P7Q=${/ZK4P7Q/.test(body)}`);
		leaks.push(`${role}:${/SECRETREF|ZK4P7Q/.test(txt)}`);
		// Guest editor accepting it.
		if (role === "editor" && about[0]) {
			const acc = await call(gst.page, "/src/functions/proposals.functions.ts", "resolveProposal", { proposalId: (about[0] as unknown as { id: string }).id, decision: "accept" });
			console.log("guest-editor accept:", JSON.stringify(acc).slice(0, 200));
		}
		await gst.ctx.close();
	}
	console.log("LEAKS", leaks.join(" "));
	// Dennis checks the hidden PDF after the guest's accept attempt.
	const after = await call<{ id: string; caption: string | null; visibility: string }[]>(d.page, MEDIA, "listTripMedia", { tripId });
	console.log("hidden PDF after guest accept:", JSON.stringify(after.find((x) => x.id === hidden.id)));
	expect(leaks.join()).not.toMatch(/true/);
	await m.ctx.close();
	await d.ctx.close();
});

test("the Rate view, the Places drawer and node overview never show a hidden PDF to a guest", async ({ browser }) => {
	const gv = await guest(browser, "viewer");
	const r = await gv.page.goto("/t/asia-2027/rate");
	await gv.page.waitForTimeout(2500);
	console.log("guest rate screen", r?.status(), gv.page.url());
	await shot(gv.page, "22-guest-rate");
	const body = await gv.page.locator("body").innerText();
	console.log("guest rate body mentions QA lodging:", /QA lodging/.test(body));
	await gv.page.goto("/t/asia-2027?sel=n.01a0cea5-cdd4-705e-82b1-d10aac19c266");
	await gv.page.waitForTimeout(2500);
	const body2 = await gv.page.locator("body").innerText();
	console.log("guest ryokan overview mentions QA lodging:", /QA lodging/.test(body2));
	await shot(gv.page, "22-guest-ryokan-overview");
	// The Places tab's details for the same place (its media strip lists PDFs).
	await gv.page.goto("/t/asia-2027?tab=places&sel=n.01a0cea5-cdd4-705e-82b1-d10aac19c266");
	await gv.page.waitForTimeout(2500);
	const body3 = await gv.page.locator("body").innerText();
	console.log("guest ryokan Places details mention QA lodging:", /QA lodging/.test(body3));
	await shot(gv.page, "22-guest-ryokan-places");
	expect(body + body2 + body3).not.toMatch(/QA lodging/);
	await gv.ctx.close();
});
