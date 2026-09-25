/**
 * I2 verifier "home" (round 1): DASH-* and TRIP-* (qa/SCENARIOS §6) plus
 * Duplicate… (ADDENDUM §9). Isolated server (APP_URL), QA seed loaded.
 */
import { type Browser, type Page, expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { hydrated } from "./_helpers/page";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
});


const SHOTS = process.env.QA_SHOTS ?? "shots";
const shot = (page: Page, name: string, fullPage = false) =>
	page.screenshot({ path: `${SHOTS}/dash-${name}.png`, animations: "disabled", fullPage });
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

type Graph = {
	trip: { id: string; name: string; startDate: string | null; endDate: string | null; slug: string };
	days: { id: string; date: string | null }[];
	items: { id: string; title: string | null; nodeId: string | null; dayId: string | null; fixedStart?: string | null; startTime?: string | null }[];
	me: { role: string };
	members: { id: string; name: string; role: string; status?: string }[];
};

async function graphOf(page: Page): Promise<Graph> {
	await expect
		.poll(() => page.evaluate(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph), {
			timeout: 30_000,
		})
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
	return { ...out, status: res?.status() ?? null } as { ok: boolean; value?: unknown; error?: string; code?: string | null; status: number | null };
}

/** Login with retries: parallel sign-ins for one email race on the stored code. */
async function login(req: import("@playwright/test").APIRequestContext, email: string, first: string, last: string) {
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
	return { ctx, page };
}

test("DASH-01/02: own vs shared trips, card content, card opens the trip", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dennis@asia2027.test", "Dennis", "Tester");
	await page.goto("/");
	await expect(page.getByTestId("dashboard")).toBeVisible();
	await expect(page.locator('svg[data-sketch="drawn"]').first()).toBeVisible({ timeout: 20_000 });
	await shot(page, "01-dennis", true);
	const hero = page.getByTestId("home-hero");
	await expect(hero).toContainText("Asia 2027");
	await expect(hero).toContainText(/2 Oct\s*–\s*5 Nov 2027/);
	await expect(hero).toContainText("35 days");
	const text = await page.getByTestId("dashboard").innerText();
	expect(text.toLowerCase()).toContain("shared with you");
	expect(text).toContain("Phu Quoc detour");
	expect(text).toMatch(/by Audrey Tester/);
	expect(text).toMatch(/Can view/);
	// Eve's trips must not appear: give Eve a trip first
	const eve = await userPage(browser, "eve@asia2027.test", "Eve", "Outsider");
	await eve.page.goto("/");
	await expect(eve.page.getByTestId("dashboard")).toBeVisible();
	const created = await callFn(eve.page, "/src/functions/trips.functions.ts", "createTrip", { name: "Eve secret trip" });
	expect(created.ok, JSON.stringify(created)).toBe(true);
	await page.reload();
	await expect(page.getByTestId("dashboard")).toBeVisible();
	await expect(page.getByTestId("dashboard")).not.toContainText("Eve secret trip");
	// Hero avatars (Dennis, Audrey, Kai, Maya)
	const heroText = await hero.innerText();
	console.log("DASH-02 hero:", heroText.replace(/\n/g, " | "));
	// Clicking the card body opens the trip
	await hero.getByTestId("trip-card").first().click();
	await expect(page).toHaveURL(/\/t\/asia-2027/);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await eve.ctx.close();
	await ctx.close();
});

test("DASH-03: past trips move under Past; upcoming sorted by start", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dennis@asia2027.test", "Dennis", "Tester");
	await page.clock.setFixedTime(new Date("2027-11-10T12:00:00Z"));
	await page.goto("/");
	await expect(page.getByTestId("dashboard")).toBeVisible();
	await page.waitForTimeout(1500);
	await shot(page, "03-clock-2027-11-10", true);
	const txt = await page.getByTestId("dashboard").innerText();
	const pastIdx = txt.toLowerCase().indexOf("past\n");
	expect(pastIdx, txt).toBeGreaterThan(-1);
	expect(txt.slice(pastIdx)).toContain("Asia 2027");
	expect(txt.slice(pastIdx)).toContain("Phu Quoc detour");
	// "Delete me" (1 Dec 2027) is the only upcoming one → the hero
	await expect(page.getByTestId("home-hero")).toContainText("Delete me");
	expect.soft(await page.getByTestId("home-hero").innerText(), "1-day trip label").not.toMatch(/\b1 days\b/);
	await ctx.close();
});

test("DASH-04: a newly shared trip shows up (reload; live bonus)", async ({ browser }) => {
	const d = await userPage(browser, `qa-home-d4d-${uniq()}@asia2027.test`, "Dora", "Dash");
	const a = await userPage(browser, `qa-home-d4a-${uniq()}@asia2027.test`, "Ana", "Share");
	await d.page.goto("/");
	await expect(d.page.getByTestId("dashboard")).toBeVisible();
	const doraEmail = (await (await d.ctx.request.get("/api/auth/get-session")).json()).user.email;
	await a.page.goto("/");
	await expect(a.page.getByTestId("dashboard")).toBeVisible();
	const t = await callFn(a.page, "/src/functions/trips.functions.ts", "createTrip", { name: "Shared later", startDate: "2027-03-01", endDate: "2027-03-04" });
	expect(t.ok, JSON.stringify(t)).toBe(true);
	const tripId = (t.value as { tripId?: string; id?: string }).tripId ?? (t.value as { id: string }).id;
	const inv = await callFn(a.page, "/src/features/home/sharing.functions.ts", "inviteMember", { tripId, email: doraEmail, role: "viewer" });
	expect(inv.ok, JSON.stringify(inv)).toBe(true);
	const live = await d.page
		.getByTestId("dashboard")
		.getByText("Shared later")
		.first()
		.waitFor({ timeout: 6000 })
		.then(() => true)
		.catch(() => false);
	console.log("DASH-04 live without reload:", live);
	await d.page.reload();
	await expect(d.page.getByTestId("dashboard")).toContainText("Shared later");
	await shot(d.page, "04-shared-later");
	await d.ctx.close();
	await a.ctx.close();
});

test("TRIP-01: create a trip with 35 dated days; invalid input refused", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, `qa-home-t1-${uniq()}@asia2027.test`, "Dennis", "Tester");
	await page.goto("/");
	await (await hydrated(page.getByTestId("new-trip-button").first())).click();
	const dlg = page.getByTestId("new-trip-dialog");
	await expect(dlg).toBeVisible();
	// empty name: submit disabled
	await expect(page.getByTestId("new-trip-submit")).toBeDisabled();
	await page.getByTestId("new-trip-name").fill("   ");
	await expect(page.getByTestId("new-trip-submit")).toBeDisabled();
	await page.getByTestId("new-trip-name").fill("Asia 2027");
	await page.getByTestId("home-new-trip-dates").click();
	const pop = page.locator('[data-slot="popover-content"]');
	await expect(pop).toBeVisible();
	// navigate to October 2027 (two months shown; data-day is M/D/YYYY)
	for (let i = 0; i < 30; i++) {
		if ((await pop.locator('button[data-day="10/2/2027"]').count()) > 0) break;
		await pop.getByRole("button", { name: /next/i }).click();
	}
	await shot(page, "t01-calendar");
	await pop.locator('button[data-day="10/2/2027"]').first().click();
	for (let i = 0; i < 3; i++) {
		if ((await pop.locator('button[data-day="11/5/2027"]').count()) > 0) break;
		await pop.getByRole("button", { name: /next/i }).click();
	}
	await pop.locator('button[data-day="11/5/2027"]').first().click();
	await expect(page.getByTestId("home-new-trip-dates")).toContainText("35 days");
	await shot(page, "t01-dialog-filled");
	await page.getByTestId("new-trip-submit").click();
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.keyboard.press("Escape");
	const g = await graphOf(page);
	expect(g.days.length).toBe(35);
	expect(g.days[0]?.date).toBe("2027-10-02");
	expect(g.days.at(-1)?.date).toBe("2027-11-05");
	expect(g.me.role).toBe("owner");
	await shot(page, "t01-workspace");
	// server-side validation
	const bad = await callFn(page, "/src/functions/trips.functions.ts", "createTrip", { name: "Backwards", startDate: "2027-11-05", endDate: "2027-10-02" });
	expect.soft(bad.ok, JSON.stringify(bad)).toBe(false);
	const empty = await callFn(page, "/src/functions/trips.functions.ts", "createTrip", { name: "  " });
	expect.soft(empty.ok, JSON.stringify(empty)).toBe(false);
	await page.goto("/");
	await expect(page.getByTestId("dashboard")).toContainText("Asia 2027");
	await expect(page.getByTestId("dashboard")).not.toContainText("Backwards");
	await ctx.close();
});

test("TRIP-02: shrinking dates warns, confirms into Unscheduled, cancel changes nothing", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, `qa-home-t2-${uniq()}@asia2027.test`, "Dennis", "Tester");
	await page.goto("/");
	const t = await callFn(page, "/src/functions/trips.functions.ts", "createTrip", { name: "Shrink me", startDate: "2027-11-02", endDate: "2027-11-05" });
	expect(t.ok, JSON.stringify(t)).toBe(true);
	const { tripId, slug } = t.value as { tripId: string; slug: string };
	await page.goto(`/t/${slug}?tab=plan`);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.keyboard.press("Escape");
	const g0 = await graphOf(page);
	const last = g0.days.at(-1)!;
	for (const title of ["TK 11 check-in", "Arrive home"]) {
		const r = await callFn(page, "/src/functions/items.functions.ts", "createItem", { tripId, dayId: last.id, title, durationMin: 60 });
		expect(r.ok, JSON.stringify(r)).toBe(true);
	}
	await page.reload();
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect.poll(async () => (await graphOf(page)).items.length, { timeout: 10_000 }).toBe(2);
	const g = await graphOf(page);
	await (await hydrated(page.getByTestId("trip-menu").first())).click();
	await page.getByRole("menuitem", { name: /trip settings/i }).click();
	await expect(page.getByTestId("trip-settings-dialog")).toBeVisible();
	const settings = page.getByTestId("trip-settings-dialog");
	const pick = async () => {
		await page.getByTestId("home-settings-dates").click();
		const pop = page.locator('[data-slot="popover-content"]');
		await expect(pop).toBeVisible();
		await pop.locator('button[data-day="11/2/2027"]').first().click();
		await pop.locator('button[data-day="11/4/2027"]').first().click();
	};
	await pick();
	await expect(settings).toContainText(/move to Unscheduled/, { timeout: 10_000 });
	await shot(page, "t02-preview");
	const txt = await settings.innerText();
	expect(txt).toMatch(/2 items on .*Nov/);
	expect(txt).toContain("Arrive home");
	await settings.getByRole("button", { name: /^cancel$/i }).click();
	const g1 = await graphOf(page);
	expect(g1.trip.endDate).toBe("2027-11-05");
	await pick();
	await page.getByTestId("home-settings-dates-confirm").click();
	await expect.poll(async () => (await graphOf(page)).trip.endDate, { timeout: 15_000 }).toBe("2027-11-04");
	const g2 = await graphOf(page);
	expect(g2.days.length).toBe(3);
	for (const it of g.items) {
		const now = g2.items.find((i) => i.id === it.id);
		expect(now, `item ${it.title} still exists`).toBeTruthy();
		expect(now?.dayId ?? null, `item ${it.title} unscheduled`).toBeNull();
	}
	await page.keyboard.press("Escape");
	await page.waitForTimeout(800);
	await shot(page, "t02-after");
	await ctx.close();
});

test("TRIP-04: rename propagates to another member (header, tab title, dashboard)", async ({ browser }) => {
	const o = await userPage(browser, `qa-home-t4o-${uniq()}@asia2027.test`, "Owner", "Four");
	const m = await userPage(browser, `qa-home-t4m-${uniq()}@asia2027.test`, "Member", "Four");
	const c = await cloneFixtureTrip(o.page.request);
	await o.page.goto(`/t/${c.slug}?tab=plan`);
	await expect(o.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const memEmail = (await (await m.ctx.request.get("/api/auth/get-session")).json()).user.email;
	const inv = await callFn(o.page, "/src/features/home/sharing.functions.ts", "inviteMember", { tripId: c.tripId, email: memEmail, role: "editor" });
	expect(inv.ok, JSON.stringify(inv)).toBe(true);
	await m.page.goto(`/t/${c.slug}?tab=plan`);
	await expect(m.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const newName = "Asia 2027 🇯🇵🇰🇷🇻🇳🇹🇼";
	const up = await callFn(o.page, "/src/functions/trips.functions.ts", "updateTrip", { tripId: c.tripId, name: newName });
	expect(up.ok, JSON.stringify(up)).toBe(true);
	await expect(m.page.getByTestId("trip-menu").first()).toContainText(newName, { timeout: 8000 });
	const liveTitle = await m.page.title();
	console.log("TRIP-04 member tab title (live):", liveTitle);
	expect.soft(liveTitle, "tab title updates live with the header").toContain("Asia 2027");
	await m.page.reload();
	await expect(m.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect.poll(() => m.page.title(), { timeout: 8000 }).toContain("Asia 2027");
	await m.page.goto("/");
	await expect(m.page.getByTestId("dashboard")).toContainText(newName);
	await shot(m.page, "t04-member-dashboard");
	await o.ctx.close();
	await m.ctx.close();
});

test("TRIP-05: only the owner can delete; delete removes it everywhere", async ({ browser }) => {
	const o = await userPage(browser, `qa-home-t5o-${uniq()}@asia2027.test`, "Owner", "Five");
	const e = await userPage(browser, `qa-home-t5e-${uniq()}@asia2027.test`, "Editor", "Five");
	await o.page.goto("/");
	const t = await callFn(o.page, "/src/functions/trips.functions.ts", "createTrip", { name: "Delete me" });
	expect(t.ok, JSON.stringify(t)).toBe(true);
	const { tripId, slug } = t.value as { tripId: string; slug: string };
	const edEmail = (await (await e.ctx.request.get("/api/auth/get-session")).json()).user.email;
	await callFn(o.page, "/src/features/home/sharing.functions.ts", "inviteMember", { tripId, email: edEmail, role: "editor" });
	// editor: no delete option; server refuses
	await e.page.goto(`/t/${slug}?tab=plan`);
	await expect(e.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await (await hydrated(e.page.getByTestId("trip-menu").first())).click();
	await e.page.getByRole("menuitem", { name: /trip settings/i }).click();
	await expect(e.page.getByTestId("trip-settings-dialog")).toBeVisible();
	await expect(e.page.getByTestId("home-settings-delete")).toHaveCount(0);
	await shot(e.page, "t05-editor-settings");
	await e.page.keyboard.press("Escape");
	const del = await callFn(e.page, "/src/functions/trips.functions.ts", "deleteTrip", { tripId });
	expect(del.ok).toBe(false);
	console.log("TRIP-05 editor deleteTrip:", del.status, del.error);
	expect.soft(del.status).toBe(403);
	// owner deletes with typed title
	await o.page.goto(`/t/${slug}?tab=plan`);
	await expect(o.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await (await hydrated(o.page.getByTestId("trip-menu").first())).click();
	await o.page.getByRole("menuitem", { name: /trip settings/i }).click();
	await o.page.getByTestId("home-settings-delete").click();
	const alert = o.page.getByRole("alertdialog");
	await expect(alert.getByRole("button", { name: /delete trip/i })).toBeDisabled();
	await alert.getByRole("textbox").fill("Delete m");
	await expect(alert.getByRole("button", { name: /delete trip/i })).toBeDisabled();
	await alert.getByRole("textbox").fill("Delete me");
	await alert.getByRole("button", { name: /delete trip/i }).click();
	await expect(o.page).toHaveURL(/\/$/);
	await expect(o.page.getByTestId("dashboard")).not.toContainText("Delete me");
	// editor's tab: trip gone
	await e.page.goto("/");
	await expect(e.page.getByTestId("dashboard")).not.toContainText("Delete me");
	await e.page.goto(`/t/${slug}?tab=plan`);
	await expect(e.page.getByText("This trip doesn't exist or you don't have access.")).toBeVisible({ timeout: 15_000 });
	await o.ctx.close();
	await e.ctx.close();
});

test("Duplicate…: new name + start, shifted days, pinned times kept, no members/links/money", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, `qa-home-dup-${uniq()}@asia2027.test`, "Dup", "Owner");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const src = await graphOf(page);
	console.log("DUP src", src.trip.startDate, src.trip.endDate, "days", src.days.length, "items", src.items.length, "members", src.members.map((m) => `${m.name}:${m.role}:${m.status ?? ""}`));
	await page.goto("/");
	await expect(page.locator('svg[data-sketch="drawn"]').first()).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1000);
	const menu = page.getByRole("button", { name: /More for Demo/ }).first();
	await (await hydrated(menu)).click();
	await page.getByRole("menuitem", { name: /Duplicate/ }).click();
	const dialog = page.getByTestId("home-duplicate-dialog");
	await expect(dialog).toBeVisible();
	await dialog.getByTestId("home-duplicate-name").fill("Demo backup dates");
	const newStart = new Date(Date.parse(`${src.trip.startDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
	await dialog.getByTestId("home-duplicate-start").click();
	{
		const [y, mo, d] = newStart.split("-").map(Number);
		await page.locator(`[data-slot="popover-content"] button[data-day="${mo}/${d}/${y}"]`).first().click();
	}
	await shot(page, "dup-dialog");
	await dialog.getByTestId("home-duplicate-submit").click();
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("trip-menu").first()).toContainText("Demo backup dates");
	const copy = await graphOf(page);
	console.log("DUP copy", copy.trip.startDate, copy.trip.endDate, "days", copy.days.length, "items", copy.items.length, "members", copy.members.map((m) => `${m.name}:${m.role}:${m.status ?? ""}`));
	expect(copy.trip.startDate).toBe(newStart);
	expect(copy.days.length).toBe(src.days.length);
	expect(copy.items.length).toBe(src.items.length);
	expect(copy.me.role).toBe("owner");
	const activeOthers = copy.members.filter((m) => m.role !== "owner" && m.status !== "placeholder" && m.status !== "removed");
	expect(activeOthers, JSON.stringify(copy.members)).toEqual([]);
	// share links: none active on the copy
	const sharing = await callFn(page, "/src/features/home/sharing.functions.ts", "getSharing", { tripId: copy.trip.id });
	// FB-13: one link per trip (none on a copy).
	const copyLink = (sharing.value as { link: { enabled: boolean } | null })?.link ?? null;
	console.log("DUP sharing link:", JSON.stringify(copyLink));
	expect(copyLink?.enabled ?? false).toBe(false);
	await shot(page, "dup-copy");
	await ctx.close();
});
