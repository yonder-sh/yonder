/**
 * QA security verifier (I2 round 2): variants of the fixed "old share-link
 * grant overrides the member role" bug (SHARE-04). A signed-in guest holding
 * the EDIT link becomes a member through an email invite as "Can view". The
 * role the owner picked should be the role they get. (Placeholder claim links
 * were removed with FB-14.)
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { type Browser, expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { call, MOD } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";

async function user(browser: Browser, email: string, first: string, last: string) {
	const ctx = await browser.newContext();
	await loginViaApi(ctx.request, email, { first, last });
	const page = await ctx.newPage();
	await page.goto("/login");
	return { ctx, page };
}

test("a member made from an edit-link guest gets the role the owner picked", async ({ browser }) => {
	test.setTimeout(300_000);
	const stamp = Date.now().toString(36);
	const out: Record<string, unknown> = {};
	const o = await user(browser, `qa-sec-r2-gr-o-${stamp}@example.com`, "Olga", "Owner");
	const c = await cloneFixtureTrip(o.page.request);
	const me = async (p: import("@playwright/test").Page) => {
		const g = await call(p, MOD.graph, "getTripGraph", { tripId: c.tripId });
		return g.ok ? (g.r as { me: { role: string; isGuest: boolean } }).me : g.err;
	};
	const edit = async (p: import("@playwright/test").Page, label: string) => {
		const r = await call(p, MOD.items, "createItem", { tripId: c.tripId, dayId: null, title: `${label} ${stamp}` });
		return r.ok ? "EDITED" : r.err.slice(0, 60);
	};

	// Email invite as "Can view" of an account that holds the edit link.
	const hEmail = `qa-sec-r2-gr-h-${stamp}@example.com`;
	const h = await user(browser, hEmail, "Hana", "Guest");
	await h.page.goto(`/join#t=${c.shareTokens.editor}`);
	await expect(h.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const inv = await call(o.page, MOD.sharing, "inviteMember", { tripId: c.tripId, email: hEmail, role: "viewer" });
	out.b_invite = inv.ok ? inv.r : inv.err;
	await h.page.goto("/dashboard");
	await h.page.waitForTimeout(3000);
	await h.page.goto(`/t/${c.slug}?tab=plan`);
	await h.page.waitForTimeout(3000);
	out.b_me = await me(h.page);
	out.b_write = await edit(h.page, "after invite");
	const sharingB = await call(o.page, MOD.sharing, "getSharing", { tripId: c.tripId });
	out.b_ownerSees = (sharingB as { r: { members: { name: string; role: string; status: string }[] } }).r.members.filter((m) => /Hana/.test(m.name)).map((m) => `${m.name}:${m.role}:${m.status}`);
	writeFileSync(path.join(DIR, "r2-grantrole.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	for (const x of [o, h]) await x.ctx.close();
});
