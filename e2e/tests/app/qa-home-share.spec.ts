/**
 * I2 verifier "home" (round 1): SHARE-* (qa/SCENARIOS §7), the suggester role
 * in sharing (EXTENSIONS §1.4 WP-Home), and placeholders ↔ accounts
 * (ADDENDUM §8/§10). Isolated server (APP_URL), QA seed loaded.
 */
import { type APIRequestContext, type Browser, type Page, expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { hydrated } from "./_helpers/page";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
});


const SHOTS = process.env.QA_SHOTS ?? "shots";
const shot = (page: Page, name: string, fullPage = false) =>
	page.screenshot({ path: `${SHOTS}/share-${name}.png`, animations: "disabled", fullPage });
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OTP = process.env.DEV_FIXED_OTP || "000000";
const SHARING = "/src/features/home/sharing.functions.ts";

type Graph = {
	trip: { id: string; name: string; slug: string };
	days: { id: string; date: string | null }[];
	items: { id: string; title: string | null; dayId: string | null; assigneeIds: string[] }[];
	me: { role: string; memberId: string | null; isGuest: boolean };
	members: { id: string; name: string; role: string; status?: string; email?: string }[];
};

async function graphOf(page: Page): Promise<Graph> {
	await expect
		.poll(() => page.evaluate(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph), { timeout: 30_000 })
		.toBe(true);
	return page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __yonder: { graph: unknown } }).__yonder.graph)));
}

async function callFn(page: Page, mod: string, fn: string, data: unknown) {
	const resP = page.waitForResponse((r) => r.url().includes("/_serverFn/"), { timeout: 15_000 }).catch(() => null);
	const out = await page.evaluate(
		async ({ mod, fn, data }) => {
			try {
				const m = await import(/* @vite-ignore */ mod);
				const v = await m[fn]({ data });
				return { ok: true, value: JSON.parse(JSON.stringify(v ?? null)) };
			} catch (e) {
				const err = e as { message?: string; code?: string };
				return { ok: false, error: String(err?.message ?? e), code: err?.code ?? null };
			}
		},
		{ mod, fn, data },
	);
	const res = await resP;
	return { ...out, status: res?.status() ?? null } as { ok: boolean; value?: any; error?: string; code?: string | null; status: number | null };
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
	const page = await ctx.newPage();
	return { ctx, page, email };
}

async function openWorkspace(page: Page, slug: string) {
	await page.goto(`/t/${slug}?tab=plan`);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
}

async function openShare(page: Page) {
	await (await hydrated(page.getByTestId("share-button").first())).click();
	await expect(page.getByTestId("share-dialog")).toBeVisible();
	await expect(page.getByTestId("share-dialog").getByTestId("home-member-row").first()).toBeVisible();
}

test("SHARE-01 + suggester role: invite an existing user as editor / suggester via the dialog", async ({ browser }) => {
	const o = await userPage(browser, `qa-home-s1o-${uniq()}@asia2027.test`, "Dennis", "Owner");
	const a = await userPage(browser, `qa-home-s1a-${uniq()}@asia2027.test`, "Audrey", "Tester");
	const s = await userPage(browser, `qa-home-s1s-${uniq()}@asia2027.test`, "Sug", "Gester");
	const c = await cloneFixtureTrip(o.page.request);
	await openWorkspace(o.page, c.slug);
	await openShare(o.page);
	const dlg = o.page.getByTestId("share-dialog");
	// invite role select offers Can view / Can suggest / Can edit
	await dlg.getByTestId("home-invite-role").click();
	const opts = await o.page.getByRole("option").allInnerTexts();
	console.log("SHARE invite role options:", opts);
	expect(opts.join("|")).toMatch(/Can view/);
	expect(opts.join("|")).toMatch(/Can suggest/);
	expect(opts.join("|")).toMatch(/Can edit/);
	await o.page.getByRole("option", { name: /Can edit/ }).click();
	await dlg.getByTestId("home-invite-email").fill(a.email);
	await dlg.getByTestId("home-invite-submit").click();
	const aRow = dlg.getByTestId("home-member-row").filter({ hasText: "Audrey Tester" });
	await expect(aRow).toBeVisible();
	await expect(aRow).toContainText(/Can edit/);
	// suggester
	await dlg.getByTestId("home-invite-role").click();
	await o.page.getByRole("option", { name: /Can suggest/ }).click();
	await dlg.getByTestId("home-invite-email").fill(s.email);
	await dlg.getByTestId("home-invite-submit").click();
	const sRow = dlg.getByTestId("home-member-row").filter({ hasText: "Sug Gester" });
	await expect(sRow).toBeVisible();
	await expect(sRow).toContainText(/Can suggest/);
	await shot(o.page, "01-owner-dialog");
	// Audrey: shared with you + Can edit; can add an item
	await a.page.goto("/dashboard");
	await expect(a.page.getByTestId("dashboard")).toContainText("Demo");
	await expect(a.page.getByTestId("dashboard")).toContainText(/Can edit/);
	await shot(a.page, "01-audrey-dashboard");
	await openWorkspace(a.page, c.slug);
	const g = await graphOf(a.page);
	expect(g.me.role).toBe("editor");
	const add = await callFn(a.page, "/src/functions/items.functions.ts", "createItem", { tripId: c.tripId, dayId: g.days[2]!.id, title: "Audrey's item" });
	expect(add.ok, JSON.stringify(add)).toBe(true);
	// Suggester: dashboard badge "Can suggest"; a direct edit becomes a suggestion or is refused
	await s.page.goto("/dashboard");
	await expect(s.page.getByTestId("dashboard")).toContainText(/Can suggest/);
	await openWorkspace(s.page, c.slug);
	const gs = await graphOf(s.page);
	expect(gs.me.role).toBe("suggester");
	const sAdd = await callFn(s.page, "/src/functions/items.functions.ts", "createItem", { tripId: c.tripId, dayId: gs.days[2]!.id, title: "Suggested item" });
	console.log("SUGGESTER direct createItem:", JSON.stringify(sAdd));
	expect.soft(sAdd.ok && !(sAdd.value && (sAdd.value as { proposed?: unknown }).proposed), "suggester's direct write must not apply").toBe(false);
	await shot(s.page, "01-suggester-workspace");
	// Suggester cannot manage sharing
	const sInv = await callFn(s.page, SHARING, "inviteMember", { tripId: c.tripId, email: `x-${uniq()}@asia2027.test`, role: "editor" });
	expect(sInv.ok).toBe(false);
	await o.ctx.close();
	await a.ctx.close();
	await s.ctx.close();
});

test("SHARE-02: invite someone without an account; they sign up and see the trip", async ({ browser, page }) => {
	const o = await userPage(browser, `qa-home-s2o-${uniq()}@asia2027.test`, "Dennis", "Owner");
	const c = await cloneFixtureTrip(o.page.request);
	await openWorkspace(o.page, c.slug);
	await openShare(o.page);
	const kai = `qa-home-s2k-${uniq()}@asia2027.test`;
	const dlg = o.page.getByTestId("share-dialog");
	await dlg.getByTestId("home-invite-role").click();
	await o.page.getByRole("option", { name: /Can view/ }).click();
	await dlg.getByTestId("home-invite-email").fill(kai);
	await dlg.getByTestId("home-invite-submit").click();
	const row = dlg.getByTestId("home-member-row").filter({ hasText: /Pending/ });
	await expect(row).toBeVisible();
	await shot(o.page, "02-pending");
	// invite email in outbox
	// Kai signs up through the UI
	await page.goto("/login");
	await (await hydrated(page.getByTestId("login-email"))).fill(kai);
	await page.getByTestId("login-submit").click();
	await page.getByTestId("otp-input").click();
	await page.keyboard.type(OTP);
	await expect(page).toHaveURL(/\/welcome/);
	await page.getByTestId("welcome-first-name").fill("Kai");
	await page.getByTestId("welcome-last-name").fill("Viewer");
	await page.getByTestId("welcome-submit").click();
	await expect(page.getByTestId("dashboard")).toBeVisible();
	await expect(page.getByTestId("dashboard")).toContainText("Demo", { timeout: 10_000 });
	await expect(page.getByTestId("dashboard")).toContainText(/Can view/);
	await shot(page, "02-kai-dashboard");
	await o.page.reload();
	await expect(o.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await openShare(o.page);
	await expect(o.page.getByTestId("share-dialog").getByTestId("home-member-row").filter({ hasText: "Kai Viewer" })).toContainText(/Can view/);
	await o.ctx.close();
});

test("SHARE-03: a viewer sees no editing controls (Kai on Asia 2027)", async ({ browser }) => {
	const k = await userPage(browser, "kai@asia2027.test", "Kai", "Viewer");
	await k.page.goto("/t/asia-2027?days=2027-10-05");
	await expect(k.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await k.page.waitForTimeout(2000);
	await shot(k.page, "03-kai-day");
	const g = await graphOf(k.page);
	expect(g.me.role).toBe("viewer");
	const ws = k.page.getByTestId("workspace");
	const txt = await ws.innerText();
	expect.soft(txt, "no 'Add to this day'").not.toMatch(/Add to this day/);
	expect.soft(await k.page.getByTestId("fab").count(), "no FAB").toBe(0);
	// no drag handles
	expect.soft(await k.page.locator('[data-dnd-handle], [aria-roledescription="sortable"]').count(), "no sortable/drag handles").toBe(0);
	// share dialog: no invite row, no link rows
	await openShare(k.page);
	const dlg = k.page.getByTestId("share-dialog");
	expect(await dlg.getByTestId("home-invite-email").count()).toBe(0);
	expect(await dlg.getByTestId("share-link-row").count()).toBe(0);
	const dtxt = await dlg.innerText();
	expect.soft(dtxt, "viewer sees no member emails").not.toMatch(/@asia2027\.test/);
	await shot(k.page, "03-kai-share");
	await k.page.keyboard.press("Escape");
	// notes editor not editable
	await k.page.getByRole("tab", { name: /notes/i }).first().click().catch(() => {});
	await k.page.waitForTimeout(1500);
	const editable = await k.page.locator('[contenteditable="true"]').count();
	expect.soft(editable, "no editable contenteditable for a viewer").toBe(0);
	await shot(k.page, "03-kai-notes");
	// lists: no toggleable checkboxes
	await k.page.getByRole("tab", { name: /lists/i }).first().click().catch(() => {});
	await k.page.waitForTimeout(1500);
	const enabledChecks = await k.page.locator('[role="checkbox"]:not([disabled]):not([aria-disabled="true"])').count();
	console.log("SHARE-03 enabled checkboxes in lists:", enabledChecks);
	await shot(k.page, "03-kai-lists");
	await k.ctx.close();
});

test("SHARE-04/05: role change without re-sign-in; removal cuts access fast", async ({ browser }) => {
	const o = await userPage(browser, `qa-home-s4o-${uniq()}@asia2027.test`, "Dennis", "Owner");
	const k = await userPage(browser, `qa-home-s4k-${uniq()}@asia2027.test`, "Kai", "Viewer");
	const c = await cloneFixtureTrip(o.page.request);
	await openWorkspace(o.page, c.slug);
	const inv = await callFn(o.page, SHARING, "inviteMember", { tripId: c.tripId, email: k.email, role: "viewer" });
	expect(inv.ok, JSON.stringify(inv)).toBe(true);
	const memberId = inv.value.memberId as string;
	await openWorkspace(k.page, c.slug);
	expect((await graphOf(k.page)).me.role).toBe("viewer");
	// promote via the dialog role select
	await openShare(o.page);
	const row = o.page.getByTestId("share-dialog").getByTestId("home-member-row").filter({ hasText: "Kai Viewer" });
	await row.getByTestId("home-member-role").click();
	await o.page.getByRole("option", { name: /Can edit/ }).click();
	await expect(row).toContainText(/Can edit/);
	const live = await expect
		.poll(async () => (await graphOf(k.page)).me.role, { timeout: 6000 })
		.toBe("editor")
		.then(() => true)
		.catch(() => false);
	console.log("SHARE-04 promotion live:", live);
	if (!live) {
		await k.page.reload();
		await expect(k.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
		expect((await graphOf(k.page)).me.role).toBe("editor");
	}
	await shot(k.page, "04-kai-editor");
	// demote back
	await row.getByTestId("home-member-role").click();
	await o.page.getByRole("option", { name: /Can view/ }).click();
	const liveDown = await expect
		.poll(async () => (await graphOf(k.page)).me.role, { timeout: 6000 })
		.toBe("viewer")
		.then(() => true)
		.catch(() => false);
	console.log("SHARE-04 demotion live:", liveDown);
	// SHARE-05: remove
	await k.page.goto(`/t/${c.slug}?tab=notes`);
	await expect(k.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await k.page.waitForTimeout(1500);
	const t0 = Date.now();
	await row.getByTestId("home-member-menu").click();
	await o.page.getByRole("menuitem", { name: /remove from trip/i }).click();
	await expect(k.page.getByText(/no longer have access|doesn't exist or you don't have access/i).first()).toBeVisible({ timeout: 5000 });
	console.log("SHARE-05 kicked after ms:", Date.now() - t0);
	await shot(k.page, "05-kai-removed");
	const after = await callFn(k.page, "/src/functions/graph.functions.ts", "getTripGraph", { tripId: c.tripId });
	expect(after.ok).toBe(false);
	expect([403, 404]).toContain(after.status);
	await k.page.goto("/dashboard");
	await expect(k.page.getByTestId("dashboard")).toBeVisible();
	await expect(k.page.getByTestId("dashboard")).not.toContainText("Demo");
	void memberId;
	await o.ctx.close();
	await k.ctx.close();
});

test("SHARE-06: editors see members read-only and can't manage; nobody can remove/demote the owner", async ({ browser }) => {
	const a = await userPage(browser, "audrey@asia2027.test", "Audrey", "Tester");
	await openWorkspace(a.page, "asia-2027");
	const g = await graphOf(a.page);
	expect(g.me.role).toBe("editor");
	await openShare(a.page);
	const dlg = a.page.getByTestId("share-dialog");
	expect(await dlg.getByTestId("home-invite-email").count()).toBe(0);
	expect(await dlg.getByTestId("share-link-row").count()).toBe(0);
	expect(await dlg.getByTestId("home-member-role").count()).toBe(0);
	await shot(a.page, "06-audrey-share");
	const tripId = g.trip.id;
	const owner = g.members.find((m) => m.role === "owner")!;
	const kai = g.members.find((m) => m.name.startsWith("Kai"))!;
	const results: Record<string, unknown> = {};
	results.invite = await callFn(a.page, SHARING, "inviteMember", { tripId, email: `x-${uniq()}@asia2027.test`, role: "viewer" });
	results.role = await callFn(a.page, SHARING, "updateMemberRole", { memberId: kai.id, role: "editor" });
	results.remove = await callFn(a.page, SHARING, "removeMember", { memberId: kai.id });
	results.link = await callFn(a.page, SHARING, "setShareLink", { tripId, role: "viewer", enabled: false });
	results.reset = await callFn(a.page, SHARING, "resetShareLink", { tripId, role: "viewer" });
	results.demoteOwner = await callFn(a.page, SHARING, "updateMemberRole", { memberId: owner.id, role: "viewer" });
	results.removeOwner = await callFn(a.page, SHARING, "removeMember", { memberId: owner.id });
	const sharing = await callFn(a.page, SHARING, "getSharing", { tripId });
	for (const [k, v] of Object.entries(results)) {
		const r = v as { ok: boolean; status: number | null; error?: string };
		console.log(`SHARE-06 ${k}: ${r.status} ${r.error ?? ""}`);
		expect.soft(r.ok, k).toBe(false);
		expect.soft(r.status, k).toBe(403);
	}
	// SHARE-08 (editor): no emails, no link URLs
	const js = JSON.stringify(sharing.value);
	expect.soft(js, "editor getSharing leaks emails").not.toMatch(/@asia2027\.test/);
	expect.soft(js, "editor getSharing leaks link tokens").not.toMatch(/qa-share-token/);
	// owner self-demotion / removal
	const d = await userPage(browser, "dennis@asia2027.test", "Dennis", "Tester");
	await openWorkspace(d.page, "asia-2027");
	const dg = await graphOf(d.page);
	const selfDemote = await callFn(d.page, SHARING, "updateMemberRole", { memberId: dg.me.memberId, role: "viewer" });
	const selfRemove = await callFn(d.page, SHARING, "removeMember", { memberId: dg.me.memberId });
	console.log("SHARE-06 owner self-demote:", selfDemote.status, selfDemote.error, "self-remove:", selfRemove.status, selfRemove.error);
	expect(selfDemote.ok).toBe(false);
	expect(selfRemove.ok).toBe(false);
	await a.ctx.close();
	await d.ctx.close();
});

test("SHARE-07: invite validation (invalid, already a member, own address)", async ({ browser }) => {
	const d = await userPage(browser, "dennis@asia2027.test", "Dennis", "Tester");
	await openWorkspace(d.page, "asia-2027");
	await openShare(d.page);
	const dlg = d.page.getByTestId("share-dialog");
	const before = await dlg.getByTestId("home-member-row").count();
	const tryInvite = async (email: string) => {
		await dlg.getByTestId("home-invite-email").fill(email);
		await dlg.getByTestId("home-invite-submit").click();
		const err = dlg.getByRole("alert");
		await expect(err).toBeVisible({ timeout: 5000 });
		return err.innerText();
	};
	await dlg.getByTestId("home-invite-email").fill("audrey@");
	await dlg.getByTestId("home-invite-submit").click();
	const nativeInvalid = await dlg.getByTestId("home-invite-email").evaluate((el) => (el as HTMLInputElement).validationMessage);
	const alertCount = await dlg.getByRole("alert").count();
	const m1 = alertCount ? await dlg.getByRole("alert").innerText() : `native: ${nativeInvalid}`;
	const m2 = await tryInvite("audrey@asia2027.test");
	const m3 = await tryInvite("Audrey@Asia2027.test");
	const m4 = await tryInvite("dennis@asia2027.test");
	console.log("SHARE-07 messages:", { m1, m2, m3, m4 });
	await shot(d.page, "07-own-address");
	expect(m1).toMatch(/email|@/i);
	expect(m2).toMatch(/already/i);
	expect(m3).toMatch(/already/i);
	expect(m4).toMatch(/you|yourself|already/i);
	await d.page.reload();
	await expect(d.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await openShare(d.page);
	expect(await d.page.getByTestId("share-dialog").getByTestId("home-member-row").count()).toBe(before);
	await d.ctx.close();
});

test("SHARE-08: member list is informative; viewers and guests never receive member emails", async ({ browser }) => {
	const d = await userPage(browser, "dennis@asia2027.test", "Dennis", "Tester");
	await openWorkspace(d.page, "asia-2027");
	await openShare(d.page);
	const dlg = d.page.getByTestId("share-dialog");
	const t = await dlg.innerText();
	expect(t).toContain("audrey@asia2027.test");
	expect(t).toContain("kai@asia2027.test");
	const links = await dlg.getByTestId("share-link-row").allInnerTexts();
	console.log("SHARE-08 link rows:", links.map((l) => l.replace(/\n/g, " | ")));
	await d.ctx.close();
	// Kai (viewer): capture every server response
	const k = await userPage(browser, "kai@asia2027.test", "Kai", "Viewer");
	const bodies: string[] = [];
	k.page.on("response", async (r) => {
		if (r.url().includes("/_serverFn/") || r.url().includes("/api/")) bodies.push(await r.text().catch(() => ""));
	});
	await openWorkspace(k.page, "asia-2027");
	await openShare(k.page);
	await k.page.waitForTimeout(2000);
	const leaked = bodies.filter((b) => /(audrey|dennis|maya)@asia2027\.test/.test(b));
	expect(leaked.map((b) => b.slice(0, 200)), "viewer received other members' emails").toEqual([]);
	await k.ctx.close();
	// Guest-V
	const gctx = await browser.newContext();
	const gp = await gctx.newPage();
	const gb: string[] = [];
	gp.on("response", async (r) => {
		if (r.url().includes("/_serverFn/") || r.url().includes("/api/")) gb.push(await r.text().catch(() => ""));
	});
	await gp.goto("/join#t=qa-share-token-viewer-asia-2027");
	await expect(gp.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await gp.waitForTimeout(2500);
	const gl = gb.filter((b) => /@asia2027\.test/.test(b));
	expect(gl.map((b) => b.slice(0, 200)), "guest received member emails").toEqual([]);
	await gctx.close();
});

test("Placeholders: link to an email (auto-claim at sign-up) and 'Same person as…' (merge)", async ({ browser }) => {
	const o = await userPage(browser, `qa-home-p2o-${uniq()}@asia2027.test`, "Dennis", "Owner");
	const c = await cloneFixtureTrip(o.page.request);
	await openWorkspace(o.page, c.slug);
	const add = await callFn(o.page, SHARING, "addPlaceholder", { tripId: c.tripId, displayName: "Mika" });
	expect(add.ok, JSON.stringify(add)).toBe(true);
	const mika = add.value.memberId as string;
	const add2 = await callFn(o.page, SHARING, "addPlaceholder", { tripId: c.tripId, displayName: "Maya C" });
	const mayaPh = add2.value.memberId as string;
	await o.page.reload();
	await expect(o.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const g = await graphOf(o.page);
	const item = g.items.find((i) => i.dayId)!;
	await callFn(o.page, "/src/functions/items.functions.ts", "setItemAssignees", { itemId: item.id, memberIds: [mika, mayaPh] });
	// Link Mika to an email through the dialog
	await openShare(o.page);
	const row = o.page.getByTestId("share-dialog").getByTestId("home-member-row").filter({ hasText: "Mika" });
	await row.getByTestId("home-member-menu").click();
	await o.page.getByTestId("home-placeholder-link-email").click();
	const mikaEmail = `qa-home-mika-${uniq()}@asia2027.test`;
	await row.getByRole("textbox").fill(mikaEmail);
	await row.getByRole("button", { name: /link|save|invite/i }).first().click();
	await expect(row).toContainText(/Pending/, { timeout: 8000 });
	await shot(o.page, "ph-linked-email");
	// Mika signs up
	const m = await userPage(browser, mikaEmail, "Mika", "Tanaka");
	await openWorkspace(m.page, c.slug);
	const mg = await graphOf(m.page);
	console.log("PH Mika me:", mg.me);
	expect(mg.me.memberId).toBe(mika);
	expect(mg.items.find((i) => i.id === item.id)!.assigneeIds).toContain(mika);
	// Same person as… : merge "Maya C" into Maya Chen (the fixture's editor)
	const mayaMember = g.members.find((x) => x.name.startsWith("Maya Chen"));
	expect(mayaMember, JSON.stringify(g.members)).toBeTruthy();
	const merge = await callFn(o.page, SHARING, "linkPlaceholder", { memberId: mayaPh, toMemberId: mayaMember!.id });
	expect(merge.ok, JSON.stringify(merge)).toBe(true);
	await o.page.reload();
	await expect(o.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const g3 = await graphOf(o.page);
	const it3 = g3.items.find((i) => i.id === item.id)!;
	console.log("PH after merge assignees:", it3.assigneeIds, "maya", mayaMember!.id);
	expect(it3.assigneeIds).toContain(mayaMember!.id);
	await o.ctx.close();
	await m.ctx.close();
});
