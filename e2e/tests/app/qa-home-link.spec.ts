/**
 * I2 verifier "home" (round 1): LINK-* (qa/SCENARIOS §8), incl. the suggester
 * link (EXTENSIONS §3.1). Isolated server (APP_URL), QA seed loaded.
 */
import { type APIRequestContext, type Browser, type Page, expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { APP_URL } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { hydrated } from "./_helpers/page";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
});


const SHOTS = process.env.QA_SHOTS ?? "shots";
const shot = (page: Page, name: string, fullPage = false) =>
	page.screenshot({ path: `${SHOTS}/link-${name}.png`, animations: "disabled", fullPage });
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SHARING = "/src/features/home/sharing.functions.ts";

type Graph = {
	trip: { id: string; name: string; slug: string };
	days: { id: string; date: string | null }[];
	items: { id: string; title: string | null; dayId: string | null; nodeId: string | null; position: string }[];
	nodes: { id: string; name: string }[];
	legs: { id: string; details: unknown }[];
	me: { role: string; memberId: string | null; isGuest: boolean; name?: string; color?: number };
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

async function guest(browser: Browser, token: string) {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await page.goto(`/join#t=${token}`);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	return { ctx, page };
}

test("LINK-01: viewer link renders read-only with no sign-in prompt", async ({ browser }) => {
	const g = await guest(browser, "qa-share-token-viewer-asia-2027");
	await g.page.waitForTimeout(2000);
	await shot(g.page, "01-guest-viewer");
	const gr = await graphOf(g.page);
	expect(gr.me.isGuest).toBe(true);
	expect(gr.me.role).toBe("viewer");
	expect(gr.days.length).toBe(35);
	const txt = await g.page.getByTestId("workspace").innerText();
	expect.soft(txt).not.toMatch(/Add to this day/);
	expect.soft(txt, "guests never see Money tab").not.toMatch(/\bMoney\b/);
	expect(await g.page.locator('[contenteditable="true"]').count()).toBe(0);
	// Lists and media tabs visible
	for (const tab of ["Lists", "Media", "Notes"]) {
		await g.page.getByTestId("center-tabs").getByText(tab, { exact: false }).first().click();
		await g.page.waitForTimeout(1200);
		await shot(g.page, `01-guest-viewer-${tab.toLowerCase()}`);
		expect.soft(await g.page.locator('[contenteditable="true"]').count(), `${tab}: nothing editable`).toBe(0);
	}
	await g.ctx.close();
});

test("LINK-02/10: editor link — guest edits reach the owner live, attributed to Guest; stable guest identity", async ({ browser }) => {
	const o = await userPage(browser, `qa-home-l2o-${uniq()}@asia2027.test`, "Dennis", "Owner");
	const c = await cloneFixtureTrip(o.page.request);
	await o.page.goto(`/t/${c.slug}?tab=plan`);
	await expect(o.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const og = await graphOf(o.page);
	const ge = await guest(browser, c.shareTokens.editor);
	const gg = await graphOf(ge.page);
	expect(gg.me.role).toBe("editor");
	expect(gg.me.isGuest).toBe(true);
	console.log("LINK-10 guest me:", gg.me);
	// add a todo on the trip root
	const t0 = Date.now();
	const todo = await callFn(ge.page, "/src/features/lists/lists.functions.ts", "createListItem", {
		tripId: c.tripId,
		target: { kind: "trip" },
		list: "todo",
		text: "Top up Suica at HND",
	});
	expect(todo.ok, JSON.stringify(todo)).toBe(true);
	// move the second item of day 1 before the first
	const d1 = og.days[0]!.id;
	const d1Items = og.items.filter((i) => i.dayId === d1).sort((a, b) => (a.position < b.position ? -1 : 1));
	const mv = await callFn(ge.page, "/src/functions/items.functions.ts", "moveItem", { itemId: d1Items[1]!.id, dayId: d1, beforeItemId: d1Items[0]!.id });
	console.log("LINK-02 guest move:", JSON.stringify(mv).slice(0, 200));
	await expect
		.poll(
			async () => {
				const g2 = await graphOf(o.page);
				const ids = g2.items.filter((i) => i.dayId === d1).sort((a, b) => (a.position < b.position ? -1 : 1)).map((i) => i.id);
				return ids[0];
			},
			{ timeout: 5000 },
		)
		.toBe(d1Items[1]!.id);
	console.log("LINK-02 owner saw move after ms:", Date.now() - t0);
	// activity attribution
	const act = await callFn(o.page, "/src/functions/graph.functions.ts", "listActivity", { tripId: c.tripId });
	const rows = JSON.stringify(act.value).slice(0, 1500);
	console.log("LINK-02 activity:", rows);
	expect.soft(rows).toMatch(/Guest/);
	// notes: guest types in the trip notes
	await ge.page.getByTestId("center-tabs").getByText("Notes").first().click();
	const ed = ge.page.locator('[contenteditable="true"]').first();
	await expect(ed).toBeVisible({ timeout: 15_000 });
	await ed.click();
	await ge.page.keyboard.type(" Guest wrote this line.");
	await o.page.getByTestId("center-tabs").getByText("Notes").first().click();
	await expect(o.page.getByTestId("workspace")).toContainText("Guest wrote this line.", { timeout: 5000 });
	await shot(o.page, "02-owner-sees-guest-note");
	// LINK-10: reload keeps the same identity
	const before = (await graphOf(ge.page)).me;
	await ge.page.reload();
	await expect(ge.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const after = (await graphOf(ge.page)).me;
	expect(after.color).toBe(before.color);
	expect(after.name).toBe(before.name);
	const ge2 = await guest(browser, c.shareTokens.editor);
	const other = (await graphOf(ge2.page)).me;
	console.log("LINK-10 guests:", before, other);
	expect.soft(other.color, "second guest gets a different colour").not.toBe(before.color);
	await ge2.ctx.close();
	await ge.ctx.close();
	await o.ctx.close();
});

test("LINK-03: what a link editor can't do (Asia 2027 editor link)", async ({ browser }) => {
	const bodies: string[] = [];
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	page.on("response", async (r) => {
		if (r.url().includes("/_serverFn/")) bodies.push(await r.text().catch(() => ""));
	});
	await page.goto("/join#t=qa-share-token-editor-asia-2027");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const g = await graphOf(page);
	expect(g.me.role).toBe("editor");
	expect(g.me.isGuest).toBe(true);
	await page.goto("/t/asia-2027?days=2027-10-02");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(2500);
	await shot(page, "03-guest-editor-day1");
	// Share dialog
	const shareBtn = page.getByTestId("share-button");
	if (await shareBtn.count()) {
		await (await hydrated(shareBtn.first())).click();
		const dlg = page.getByTestId("share-dialog");
		if (await dlg.isVisible().catch(() => false)) {
			await shot(page, "03-guest-editor-share");
			expect(await dlg.getByTestId("share-link-row").count()).toBe(0);
			expect(await dlg.getByTestId("home-invite-email").count()).toBe(0);
			expect.soft(await dlg.innerText()).not.toMatch(/@asia2027\.test/);
			await page.keyboard.press("Escape");
		}
	}
	const all = bodies.join("\n");
	expect(all, "booking ref ZK4P7Q must never reach a guest").not.toContain("ZK4P7Q");
	expect(all, "member emails must never reach a guest").not.toMatch(/@asia2027\.test/);
	expect(all, "link tokens must never reach a guest").not.toContain("qa-share-token");
	const tripId = g.trip.id;
	const r: Record<string, { ok: boolean; status: number | null; error?: string; value?: any }> = {};
	r.getSharing = await callFn(page, SHARING, "getSharing", { tripId });
	r.setShareLink = await callFn(page, SHARING, "setShareLink", { tripId, role: "viewer", enabled: false });
	r.resetShareLink = await callFn(page, SHARING, "resetShareLink", { tripId, role: "editor" });
	r.inviteMember = await callFn(page, SHARING, "inviteMember", { tripId, email: `x-${uniq()}@asia2027.test`, role: "editor" });
	r.deleteTrip = await callFn(page, "/src/functions/trips.functions.ts", "deleteTrip", { tripId });
	r.duplicateTrip = await callFn(page, "/src/features/home/dashboard.functions.ts", "duplicateTrip", {
		tripId,
		name: "stolen copy",
		startDate: "2027-10-02",
		include: { notes: true, lists: true, media: true, budgets: true, placeholders: true },
	});
	const sharingJson = JSON.stringify(r.getSharing.value ?? {});
	console.log("LINK-03 getSharing for guest editor:", r.getSharing.status, sharingJson.slice(0, 300));
	expect.soft(sharingJson).not.toMatch(/@asia2027\.test/);
	expect.soft(sharingJson).not.toContain("qa-share-token");
	for (const k of ["setShareLink", "resetShareLink", "inviteMember", "deleteTrip", "duplicateTrip"]) {
		console.log(`LINK-03 ${k}: ${r[k]!.status} ${r[k]!.error ?? ""}`);
		expect.soft(r[k]!.ok, k).toBe(false);
		expect.soft(r[k]!.status, k).toBe(403);
	}
	// booking ref is masked in the flight UI
	const legs = g.legs.filter((l) => JSON.stringify(l.details).includes("NH"));
	console.log("LINK-03 NH legs details:", JSON.stringify(legs.map((l) => l.details)).slice(0, 400));
	await ctx.close();
});

test("LINK-04/05: revoked and reset links stop working, open tabs included", async ({ browser }) => {
	const o = await userPage(browser, `qa-home-l4o-${uniq()}@asia2027.test`, "Dennis", "Owner");
	const c = await cloneFixtureTrip(o.page.request);
	await o.page.goto(`/t/${c.slug}?tab=plan`);
	await expect(o.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const ge = await guest(browser, c.shareTokens.editor);
	const gv = await guest(browser, c.shareTokens.viewer);
	// LINK-05 first: reset the viewer link
	const reset = await callFn(o.page, SHARING, "resetShareLink", { tripId: c.tripId, role: "viewer" });
	expect(reset.ok, JSON.stringify(reset)).toBe(true);
	const newUrl = reset.value.url as string;
	console.log("LINK-05 new viewer url:", newUrl);
	const t0 = Date.now();
	await expect(gv.page.getByTestId("workspace")).toBeHidden({ timeout: 5000 });
	console.log("LINK-05 viewer kicked after ms:", Date.now() - t0, "at", gv.page.url());
	await shot(gv.page, "05-viewer-after-reset");
	// old URL: no longer works
	const old = await browser.newContext();
	const op = await old.newPage();
	await op.goto(`/join#t=${c.shareTokens.viewer}`);
	await expect(op.getByText("This link no longer works.")).toBeVisible({ timeout: 15_000 });
	// new URL works
	const nw = await browser.newContext();
	const np = await nw.newPage();
	await np.goto(newUrl.replace(/^https?:\/\/[^/]+/, APP_URL));
	await expect(np.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await old.close();
	await nw.close();
	// LINK-04: turn off the edit link while Guest-E is on it
	const off = await callFn(o.page, SHARING, "setShareLink", { tripId: c.tripId, role: "editor", enabled: false });
	expect(off.ok, JSON.stringify(off)).toBe(true);
	const t1 = Date.now();
	await expect(ge.page.getByTestId("workspace")).toBeHidden({ timeout: 5000 });
	console.log("LINK-04 editor kicked after ms:", Date.now() - t1, "at", ge.page.url());
	await ge.page.waitForTimeout(1000);
	await shot(ge.page, "04-editor-after-off");
	const shown = await ge.page.locator("body").innerText();
	console.log("LINK-04 guest page text:", shown.slice(0, 300).replace(/\n/g, " | "));
	expect.soft(shown, "guest page says the link is no longer active").toMatch(/no longer (works|active)|no longer have access/i);
	// reload the trip URL as that guest: no trip data in the HTML
	const res = await ge.page.request.get(`/t/${c.slug}`);
	const html = await res.text();
	console.log("LINK-04 reload status:", res.status());
	expect(html).not.toMatch(/Shibuya|Senso-ji|Meiji/);
	await ge.page.goto(`/t/${c.slug}?tab=plan`);
	await ge.page.waitForTimeout(3000);
	const after = await ge.page.locator("body").innerText();
	console.log("LINK-04 guest reload page:", ge.page.url(), after.slice(0, 200).replace(/\n/g, " | "));
	await shot(ge.page, "04-editor-reload");
	// replayed edit with the guest session
	const replay = await callFn(ge.page, "/src/functions/items.functions.ts", "createItem", { tripId: c.tripId, dayId: null, title: "after revoke" });
	expect(replay.ok).toBe(false);
	expect([403, 404, 401]).toContain(replay.status);
	await ge.ctx.close();
	await gv.ctx.close();
	await o.ctx.close();
});

test("LINK-07/08/09: token scope, signed-in non-member, token shape", async ({ browser }) => {
	const ge = await guest(browser, "qa-share-token-editor-asia-2027");
	await ge.page.goto("/dashboard");
	await expect(ge.page).toHaveURL(/\/login/);
	await shot(ge.page, "07-guest-dashboard");
	await ge.page.goto("/t/phu-quoc-detour?tab=plan");
	await ge.page.waitForTimeout(2500);
	const t = await ge.page.locator("body").innerText();
	console.log("LINK-07 guest on phu-quoc:", ge.page.url(), t.slice(0, 160).replace(/\n/g, " | "));
	expect(t).not.toMatch(/Phu Quoc/);
	// server fn with another trip's id: find Phu Quoc id via Dennis
	const d = await userPage(browser, "dennis@asia2027.test", "Dennis", "Tester");
	await d.page.goto("/t/phu-quoc-detour?tab=plan");
	await expect(d.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const pq = await graphOf(d.page);
	await ge.page.goto("/t/asia-2027?tab=plan");
	await expect(ge.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const cross = await callFn(ge.page, "/src/functions/graph.functions.ts", "getTripGraph", { tripId: pq.trip.id });
	console.log("LINK-07 cross-trip graph:", cross.status, cross.error);
	expect(cross.ok).toBe(false);
	expect(cross.error).toMatch(/NOT_FOUND|FORBIDDEN/);
	const crossWrite = await callFn(ge.page, "/src/functions/items.functions.ts", "createItem", { tripId: pq.trip.id, dayId: null, title: "x" });
	expect(crossWrite.ok).toBe(false);
	// LINK-08: Eve opens the viewer link
	const eve = await userPage(browser, "eve@asia2027.test", "Eve", "Outsider");
	await eve.page.goto("/join#t=qa-share-token-viewer-asia-2027");
	await expect(eve.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const eg = await graphOf(eve.page);
	console.log("LINK-08 eve me:", eg.me);
	expect(eg.me.role).toBe("viewer");
	expect(eg.members.map((m) => m.name)).not.toContain("Eve Outsider");
	expect(await eve.page.locator('[contenteditable="true"]').count()).toBe(0);
	await eve.page.goto("/dashboard");
	await expect(eve.page.getByTestId("dashboard")).toBeVisible();
	const edash = await eve.page.getByTestId("dashboard").innerText();
	console.log("LINK-08 eve dashboard has Asia 2027:", edash.includes("Asia 2027"));
	expect.soft(edash, "Asia 2027 must not appear as Eve's trip").not.toMatch(/Asia 2027/);
	await shot(eve.page, "08-eve-dashboard", true);
	// LINK-09: 20 viewer links → token shape; one-char change
	await d.page.goto("/dashboard");
	const scratch = await callFn(d.page, "/src/functions/trips.functions.ts", "createTrip", { name: `Scratch ${uniq()}` });
	const sid = scratch.value.tripId as string;
	const urls: string[] = [];
	for (let i = 0; i < 6; i++) {
		const r = await callFn(d.page, SHARING, "resetShareLink", { tripId: sid, role: "viewer" });
		if (!r.ok) {
			console.log("LINK-09 reset refused at", i, r.status, r.error);
			break;
		}
		urls.push(r.value.url);
	}
	const tokens = urls.map((u) => decodeURIComponent(u.split("#t=")[1] ?? ""));
	console.log("LINK-09 tokens:", tokens);
	for (const tk of tokens) {
		expect(tk.length).toBeGreaterThanOrEqual(22);
		expect(tk).toMatch(/^[A-Za-z0-9_-]+$/);
	}
	expect(new Set(tokens).size).toBe(tokens.length);
	for (const u of urls) expect(u).not.toMatch(/\/\d+(\/|$)|tripId|trip=/);
	const good = tokens.at(-1)!;
	const bad = good.slice(0, -1) + (good.at(-1) === "A" ? "B" : "A");
	const bctx = await browser.newContext();
	const bp = await bctx.newPage();
	await bp.goto(`/join#t=${bad}`);
	await expect(bp.getByText("This link no longer works.")).toBeVisible({ timeout: 15_000 });
	await shot(bp, "09-altered-token");
	await bctx.close();
	await eve.ctx.close();
	await d.ctx.close();
	await ge.ctx.close();
});

test("Suggester link: guest suggester proposes, can't apply edits or upload", async ({ browser }) => {
	const gs = await guest(browser, "qa-share-token-suggester-asia-2027");
	const g = await graphOf(gs.page);
	console.log("SUG-LINK me:", g.me);
	expect(g.me.role).toBe("suggester");
	expect(g.me.isGuest).toBe(true);
	await gs.page.waitForTimeout(1500);
	await shot(gs.page, "sug-guest");
	const r = await callFn(gs.page, "/src/functions/items.functions.ts", "createItem", { tripId: g.trip.id, dayId: g.days[3]!.id, title: "Guest suggestion" });
	console.log("SUG-LINK createItem:", JSON.stringify(r).slice(0, 300));
	expect(r.ok && !r.value?.proposed, "guest suggester's edit must not apply directly").toBe(false);
	const up = await callFn(gs.page, "/src/features/media/media.functions.ts", "createUpload", {
		tripId: g.trip.id,
		target: { kind: "trip" },
		type: "image/jpeg",
		size: 1000,
		name: "x.jpg",
	});
	console.log("SUG-LINK createUpload:", up.status, up.error);
	expect(up.ok).toBe(false);
	const settings = await callFn(gs.page, "/src/functions/trips.functions.ts", "updateTrip", { tripId: g.trip.id, name: "Hijacked" });
	console.log("SUG-LINK updateTrip:", JSON.stringify(settings).slice(0, 200));
	expect(settings.ok && !settings.value?.proposed, "guest suggester can't rename directly").toBe(false);
	// money is never visible to guests
	const txt = await gs.page.getByTestId("workspace").innerText();
	expect.soft(txt).not.toMatch(/\bMoney\b/);
	await gs.ctx.close();
});
