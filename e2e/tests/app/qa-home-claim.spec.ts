/**
 * I2 verifier "home" (round 1): placeholder claim by a signed-in guest
 * (ADDENDUM §10) and what it unlocks; signed-in guests promoted with the
 * suggester role (EXTENSIONS §1.4 WP-Home).
 */
import { type APIRequestContext, type Browser, type Page, expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { hydrated } from "./_helpers/page";
import { openLink } from "./_helpers/link";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
});


const SHOTS = process.env.QA_SHOTS ?? "shots";
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/claim-${name}.png`, animations: "disabled" });
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function graphOf(page: Page): Promise<any> {
	await expect
		.poll(() => page.evaluate(() => !!(window as any).__yonder?.graph), { timeout: 30_000 })
		.toBe(true);
	return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__yonder.graph)));
}

async function login(req: APIRequestContext, email: string, first: string, last: string) {
	for (let i = 0; ; i++) {
		try {
			return await loginViaApi(req, email, { first, last });
		} catch (e) {
			if (i >= 4) throw e;
			await new Promise((r) => setTimeout(r, 500 + Math.random() * 1500));
		}
	}
}

async function userPage(browser: Browser, email: string, first: string, last: string) {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await login(ctx.request, email, first, last);
	return { ctx, page: await ctx.newPage(), email };
}

test("A signed-in VIEW-link guest claims a placeholder: what does it unlock?", async ({ browser }) => {
	const o = await userPage(browser, `qa-home-c1o-${uniq()}@asia2027.test`, "Olga", "Owner");
	const c = await cloneFixtureTrip(o.page.request);
	// A stranger who got the public view link and signs in with any name
	const s = await userPage(browser, `qa-home-c1s-${uniq()}@asia2027.test`, "Mallory", "Stranger");
	const bodies: string[] = [];
	s.page.on("response", async (r) => {
		if (r.url().includes("/_serverFn/")) bodies.push(await r.text().catch(() => ""));
	});
	await openLink(s.page, c.slug, "viewer");
	await expect(s.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const before = await graphOf(s.page);
	const flightBefore = JSON.stringify(before.legs.filter((l: any) => l.details?.kind === "flight").map((l: any) => l.details));
	console.log("CLAIM before: me", before.me, "| flight details:", flightBefore.slice(0, 300));
	const beforeTabs = await s.page.getByTestId("center-tabs").innerText();
	// Share dialog → Audrey (placeholder) → This is me
	await (await hydrated(s.page.getByTestId("share-button").first())).click();
	const dlg = s.page.getByTestId("share-dialog");
	await expect(dlg).toBeVisible();
	await shot(s.page, "01-stranger-share-dialog");
	await expect(dlg.getByTestId("home-member-row").filter({ hasText: "Audrey" })).toBeVisible({ timeout: 15_000 });
	const menus = dlg.getByTestId("home-member-row").filter({ hasText: "Audrey" }).getByTestId("home-member-menu");
	const menuState = (await menus.count()) === 0 ? "absent" : (await menus.first().isDisabled()) ? "disabled" : "ENABLED";
	console.log("CLAIM UI menu for a view-link guest:", menuState);
	await s.page.keyboard.press("Escape");
	const claim = await s.page.evaluate(async ({ tripId, memberId }) => {
		const m = await import("/src/features/home/sharing.functions.ts");
		try { return await m.claimPlaceholder({ data: { tripId, memberId } }); } catch (e) { return { err: String(e) }; }
	}, { tripId: c.tripId, memberId: c.members.audrey });
	console.log("CLAIM server fn as view-link guest:", JSON.stringify(claim));
	await s.page.waitForTimeout(1500);
	await s.page.keyboard.press("Escape");
	await s.page.reload();
	await expect(s.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const after = await graphOf(s.page);
	const flightAfter = JSON.stringify(after.legs.filter((l: any) => l.details?.kind === "flight").map((l: any) => l.details));
	const afterTabs = await s.page.getByTestId("center-tabs").innerText();
	console.log("CLAIM after: me", after.me, "| flight details:", flightAfter.slice(0, 300));
	console.log("CLAIM tabs before:", beforeTabs.replace(/\n/g, " "), "| after:", afterTabs.replace(/\n/g, " "));
	await shot(s.page, "02-stranger-after-claim");
	const refFields = (j: string) => (j.match(/"(bookingRef|ref|seat)":"[^"]+"/g) ?? []).slice(0, 5);
	console.log("CLAIM booking fields before:", refFields(flightBefore), "after:", refFields(flightAfter));
	// The owner's view
	await o.page.goto(`/t/${c.slug}?tab=plan`);
	await expect(o.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const og = await graphOf(o.page);
	console.log("CLAIM owner sees members:", og.members.map((m: any) => `${m.name}:${m.role}:${m.status}`));
	expect.soft(after.me.isGuest, "a view-link guest became a full member without the owner").toBe(true);
	await o.ctx.close();
	await s.ctx.close();
});

test("Signed-in guests: owner promotes one as 'Can suggest'", async ({ browser }) => {
	const o = await userPage(browser, `qa-home-c2o-${uniq()}@asia2027.test`, "Olga", "Owner");
	const c = await cloneFixtureTrip(o.page.request);
	const g = await userPage(browser, `qa-home-c2g-${uniq()}@asia2027.test`, "Gina", "Guest");
	await openLink(g.page, c.slug, "editor");
	await expect(g.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await o.page.goto(`/t/${c.slug}?tab=plan`);
	await expect(o.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await (await hydrated(o.page.getByTestId("share-button").first())).click();
	const dlg = o.page.getByTestId("share-dialog");
	const grow = dlg.getByTestId("home-guest-row").filter({ hasText: "Gina" });
	await expect(grow).toBeVisible({ timeout: 10_000 });
	await shot(o.page, "03-guests-section");
	console.log("GUEST row:", (await grow.innerText()).replace(/\n/g, " | "));
	await grow.getByTestId("home-guest-promote").click();
	await o.page.waitForTimeout(500);
	await shot(o.page, "04-promote-menu");
	const opts = await o.page.getByRole("menuitem").allInnerTexts().catch(() => []);
	const opts2 = await o.page.getByRole("option").allInnerTexts().catch(() => []);
	console.log("PROMOTE options:", opts, opts2);
	const suggest = o.page.getByRole("menuitem", { name: /suggest/i }).or(o.page.getByRole("option", { name: /suggest/i })).first();
	await suggest.click();
	await expect(dlg.getByTestId("home-member-row").filter({ hasText: "Gina Guest" })).toContainText(/Can suggest/, { timeout: 10_000 });
	await g.page.reload();
	await expect(g.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const gg = await graphOf(g.page);
	console.log("PROMOTED me:", gg.me);
	expect(gg.me.isGuest).toBe(false);
	// she held an EDIT link grant: does it still give her editing? (max of membership and grant)
	console.log("PROMOTED effective role (member suggester + edit-link grant):", gg.me.role);
	expect.soft(gg.me.role, "promoted as Can suggest, but the old edit-link grant keeps her an editor").toBe("suggester");
	// Owner now demotes her to viewer via the member row
	const mrow = dlg.getByTestId("home-member-row").filter({ hasText: "Gina Guest" });
	await mrow.getByTestId("home-member-role").click();
	await o.page.getByRole("option", { name: /Can view/ }).click();
	await expect(mrow).toContainText(/Can view/);
	await g.page.reload();
	await expect(g.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const g2 = await graphOf(g.page);
	console.log("DEMOTED to viewer, effective role:", g2.me.role);
	expect.soft(g2.me.role, "owner set Can view, member still edits through the old link grant").toBe("viewer");
	const edit = await g.page.evaluate(async ({ tripId }) => {
		const m = await import("/src/functions/items.functions.ts");
		try { return await m.createItem({ data: { tripId, dayId: null, title: "edit after demotion" } }); } catch (e) { return { err: String(e) }; }
	}, { tripId: c.tripId });
	console.log("DEMOTED createItem:", JSON.stringify(edit).slice(0, 200));
	await shot(o.page, "05-owner-sees-can-view");
	await o.ctx.close();
	await g.ctx.close();
});
