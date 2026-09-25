/**
 * QA security verifier (I2 round 1): LINK-04/05/06. Guests on the editor and
 * viewer links have Golden Gai's notes open; the owner turns the links off.
 * Their next call fails, the page says so, a reload shows no trip data, and
 * the owner's later note edits no longer reach their sockets. The links are
 * turned back on at the end (same tokens; `setLinkEnabled`).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { call, EMAIL, GG, guestPage, MOD, memberPage, T, TOKEN } from "./qa-security-helpers";
import { setTestLink } from "./_helpers/link";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const GG_URL = "/t/asia-2027/japan/tokyo/shinjuku/golden-gai";
const DOC = `trip/${T}/node/${GG}`;

async function openNotes(page: Page) {
	await page.goto(GG_URL);
	const tab = page.getByRole("tab", { name: /^Notes/ }).first();
	await tab.click();
	await expect(page.locator(`[data-testid=note-editor][data-doc="${DOC}"]`).first()).toBeVisible({ timeout: 20_000 });
}

function frames(page: Page): string[] {
	const got: string[] = [];
	page.on("websocket", (ws) => {
		ws.on("framereceived", (f) => {
			const p = typeof f.payload === "string" ? f.payload : Buffer.from(f.payload).toString("latin1");
			got.push(p);
		});
	});
	return got;
}

test("turning links off cuts open tabs and sockets", async ({ browser }) => {
	test.setTimeout(300_000);
	const out: Record<string, unknown> = {};
	const stamp = Date.now().toString(36);
	const ge = await guestPage(browser, TOKEN.editor);
	const gv = await guestPage(browser, TOKEN.viewer);
	const geFrames = frames(ge.page);
	const gvFrames = frames(gv.page);
	await openNotes(ge.page);
	await openNotes(gv.page);
	const dennis = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	await openNotes(dennis.page);
	const editor = dennis.page.locator(`[data-testid=note-editor][data-doc="${DOC}"]`).first();

	// Control: before the change, Dennis's typing reaches both guests.
	await editor.click();
	await dennis.page.keyboard.press("End");
	await dennis.page.keyboard.insertText(` BEFORE${stamp}`);
	await dennis.page.waitForTimeout(2500);
	out.beforeReachesEditor = geFrames.some((f) => f.includes(`BEFORE${stamp}`));
	out.beforeReachesViewer = gvFrames.some((f) => f.includes(`BEFORE${stamp}`));

	for (const role of ["editor", "viewer"] as const) {
		const r = await call(dennis.page, MOD.sharing, "setShareLink", { tripId: T, role, enabled: false });
		out[`off:${role}`] = r.ok ? "OK" : r.err;
	}
	const cut = Date.now();
	await ge.page.waitForTimeout(3000);
	await editor.click();
	await dennis.page.keyboard.press("End");
	await dennis.page.keyboard.insertText(` AFTER${stamp}`);
	await dennis.page.waitForTimeout(3000);
	out.afterReachesEditor = geFrames.some((f) => f.includes(`AFTER${stamp}`));
	out.afterReachesViewer = gvFrames.some((f) => f.includes(`AFTER${stamp}`));
	const edit = await call(ge.page, MOD.lists, "createListItem", { tripId: T, target: { kind: "node", nodeId: GG }, list: "todo", text: `after-revoke ${stamp}` });
	out.guestEditAfter = edit.ok ? "OK (still writes!)" : edit.err;
	out.guestEditorPage = (await ge.page.locator("body").innerText()).slice(0, 300);
	out.guestViewerPage = (await gv.page.locator("body").innerText()).slice(0, 300);
	out.msSinceCut = Date.now() - cut;
	await ge.page.screenshot({ path: path.join(DIR, "revoke-guest-editor.png") });
	await gv.page.screenshot({ path: path.join(DIR, "revoke-guest-viewer.png") });
	// Reload: no trip data in the HTML or the page.
	const res = await gv.page.goto("/t/asia-2027?tab=plan");
	await gv.page.waitForTimeout(3000);
	const html = (await res?.text()) ?? "";
	out.reloadStatus = res?.status();
	out.reloadHtmlHasTrip = /Golden Gai|Asia 2027|Shinjuku/.test(html);
	out.reloadPage = (await gv.page.locator("body").innerText()).slice(0, 200);
	await gv.page.screenshot({ path: path.join(DIR, "revoke-guest-viewer-reload.png") });
	// Re-opening the address while the link is off.
	await gv.page.goto("/t/asia-2027");
	await gv.page.waitForTimeout(4000);
	out.rejoinPage = (await gv.page.locator("body").innerText()).slice(0, 200);

	// On again through the test route (the app would give the seeded address a tail).
	for (const role of ["editor", "viewer"] as const) {
		await setTestLink(dennis.page.request, "asia-2027", role);
		out[`on:${role}`] = "OK";
	}
	writeFileSync(path.join(DIR, "revoke.json"), JSON.stringify(out, null, 1));
	await ge.ctx.close();
	await gv.ctx.close();
	await dennis.ctx.close();
});
