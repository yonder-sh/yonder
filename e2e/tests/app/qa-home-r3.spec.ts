/**
 * I2 verifier "home" (round 3): re-checks of round-2 findings on the isolated
 * dev server with the QA seed (Asia 2027 as dennis@asia2027.test).
 */
import { type APIRequestContext, type Browser, type Page, expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
});

const SHOTS = process.env.QA_SHOTS ?? "shots";
const shot = (page: Page, name: string, fullPage = false) =>
	page.screenshot({ path: `${SHOTS}/r3-${name}.png`, animations: "disabled", fullPage });
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function graphOf(page: Page): Promise<any> {
	await expect
		.poll(() => page.evaluate(() => !!(window as any).__yonder?.graph), { timeout: 30_000 })
		.toBe(true);
	return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__yonder.graph)));
}

async function callFn(page: Page, mod: string, fn: string, data: unknown) {
	return page.evaluate(
		async ({ mod, fn, data }) => {
			try {
				const m = await import(/* @vite-ignore */ mod);
				const v = await m[fn]({ data });
				return { ok: true, value: JSON.parse(JSON.stringify(v ?? null)) };
			} catch (e) {
				return { ok: false, error: String((e as Error)?.message ?? e) };
			}
		},
		{ mod, fn, data },
	) as Promise<{ ok: boolean; value?: any; error?: string }>;
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

async function userPage(browser: Browser, email: string, first = "QA", last = "Tester", viewport = { width: 1440, height: 900 }) {
	const ctx = await browser.newContext({ viewport });
	await login(ctx.request, email, first, last);
	return { ctx, page: await ctx.newPage() };
}

const DASH_FNS = "/src/features/home/dashboard.functions.ts";
const LIST_FNS = "/src/features/lists/lists.functions.ts";

test("R3 phone dashboard: deadlines show the full trip name ('Asia 2027' vs 'Asia 2027 backup')", async ({ browser }) => {
	const d = await userPage(browser, "dennis@asia2027.test", "Dennis", "Tester");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expect(d.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const g = await graphOf(d.page);
	const mine = await callFn(d.page, "/src/features/home/dashboard.functions.ts", "listMyTrips", {});
	const names: string[] = (mine.value ?? []).map?.((t: any) => t.name) ?? [];
	if (!names.includes("Asia 2027 backup")) {
		const dup = await callFn(d.page, DASH_FNS, "duplicateTrip", {
			tripId: g.trip.id,
			name: "Asia 2027 backup",
			startDate: g.trip.startDate,
			include: { notes: true, lists: true, media: false, budgets: true, placeholders: true },
		});
		console.log("R3 dup:", dup.ok, dup.error ?? dup.value?.slug);
	}
	await d.ctx.close();
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
	await login(ctx.request, "dennis@asia2027.test", "Dennis", "Tester");
	const page = await ctx.newPage();
	await page.goto("/dashboard");
	await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 });
	const rows = page.getByTestId("home-deadline-row");
	await expect(rows.first()).toBeVisible({ timeout: 20_000 });
	await page.waitForTimeout(1200);
	const info = await page.evaluate(() =>
		[...document.querySelectorAll('[data-testid="home-deadline-row"]')].map((r) => {
			const t = r.querySelector('[data-testid="home-deadline-trip"]') as HTMLElement | null;
			return {
				text: (r as HTMLElement).innerText.replace(/\n/g, " | "),
				trip: t?.innerText,
				tripTruncated: t ? t.scrollWidth > t.clientWidth + 1 : null,
				tripWidth: t?.clientWidth,
			};
		}),
	);
	console.log("R3 phone deadline rows:", JSON.stringify(info, null, 1));
	console.log("R3 phone overflow:", await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth));
	await page.getByTestId("home-deadlines").scrollIntoViewIfNeeded();
	await shot(page, "phone-deadlines");
	await shot(page, "phone-dashboard", true);
	for (const r of info) expect.soft(r.tripTruncated, `trip name cut: ${r.text}`).toBe(false);
	await ctx.close();
});

test("R3 overdue: a to-do 1 hour overdue reads the same on the dashboard and in Lists", async ({ browser }) => {
	const d = await userPage(browser, "dennis@asia2027.test", "Dennis", "Tester");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expect(d.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const g = await graphOf(d.page);
	const tz = "America/New_York";
	const { date, time } = await d.page.evaluate((tz) => {
		const t = new Date(Date.now() - 65 * 60_000);
		const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(t);
		const get = (k: string) => parts.find((p) => p.type === k)!.value;
		return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
	}, tz);
	const text = `R3 overdue check ${uniq()}`;
	const me = g.me.memberId ?? g.members.find((m: any) => m.isMe || m.userId === g.me.userId)?.id;
	const r = await callFn(d.page, LIST_FNS, "createListItem", {
		tripId: g.trip.id,
		target: { kind: "trip" },
		list: "todo",
		text,
		dueDate: date,
		dueTime: time,
		dueTz: tz,
		dueKind: "due",
		...(me ? { assigneeIds: [me] } : {}),
	});
	console.log("R3 overdue create:", r.ok, r.error, date, time, "assignee", me);
	expect(r.ok).toBe(true);
	await d.page.goto("/dashboard");
	await expect(d.page.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 });
	let row = d.page.getByTestId("home-deadline-row").filter({ hasText: text });
	if (!(await row.count())) {
		await d.page.getByTestId("home-deadlines-everyone").click();
		row = d.page.getByTestId("home-deadline-row").filter({ hasText: text });
	}
	await expect(row).toBeVisible({ timeout: 15_000 });
	const dashText = (await row.innerText()).replace(/\n/g, " | ");
	console.log("R3 overdue dashboard row:", dashText);
	await row.scrollIntoViewIfNeeded();
	await shot(d.page, "overdue-dashboard");
	await d.page.goto("/t/asia-2027?tab=lists");
	await expect(d.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const lrow = d.page.getByText(text).first();
	await expect(lrow).toBeVisible({ timeout: 20_000 });
	const listText = await lrow.evaluate((el) => {
		let n: HTMLElement | null = el as HTMLElement;
		for (let i = 0; i < 6 && n; i++) {
			if (/Overdue|Due /.test(n.innerText) && n.innerText.length < 400) return n.innerText.replace(/\n/g, " | ");
			n = n.parentElement;
		}
		return (el as HTMLElement).parentElement?.innerText.replace(/\n/g, " | ");
	});
	console.log("R3 overdue lists row:", listText);
	await lrow.scrollIntoViewIfNeeded();
	await shot(d.page, "overdue-lists");
	expect.soft(dashText).toMatch(/Overdue 1h/);
	expect.soft(listText).toMatch(/Overdue 1h/);
	await d.ctx.close();
});

test("R3 LINK-07: an editor-link guest on another trip's URL gets the plain no-access page; the link stays", async ({ browser }) => {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await page.goto("/join#t=qa-share-token-editor-asia-2027");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const before = await page.evaluate(() => ({ grants: localStorage.getItem("yonder:grants"), gone: localStorage.getItem("yonder:grants-gone") }));
	console.log("R3 LINK-07 before:", JSON.stringify(before));
	await page.goto("/t/phu-quoc-detour?tab=plan");
	await page.waitForTimeout(3000);
	const body = (await page.locator("body").innerText()).replace(/\n/g, " | ");
	console.log("R3 LINK-07 on phu-quoc:", page.url(), body.slice(0, 200));
	await shot(page, "link07-phuquoc");
	const after = await page.evaluate(() => ({ grants: localStorage.getItem("yonder:grants"), gone: localStorage.getItem("yonder:grants-gone") }));
	console.log("R3 LINK-07 after:", JSON.stringify(after));
	expect.soft(body).not.toMatch(/no longer active/i);
	expect.soft(body).toMatch(/doesn't exist or you don't have access/);
	expect(body).not.toMatch(/Phu Quoc/i);
	// a slug that doesn't exist at all
	await page.goto("/t/no-such-trip-r3?tab=plan");
	await page.waitForTimeout(2500);
	const body2 = (await page.locator("body").innerText()).replace(/\n/g, " | ");
	console.log("R3 LINK-07 on no-such-trip:", body2.slice(0, 200));
	expect.soft(body2).not.toMatch(/no longer active/i);
	await page.goto("/t/asia-2027?tab=plan");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const g = await graphOf(page);
	console.log("R3 LINK-07 asia still opens as", g.me.role, "guest", g.me.isGuest);
	// A fresh session with only the remembered grant (session cookie dropped) can re-redeem
	await ctx.clearCookies();
	await page.goto("/t/asia-2027?tab=plan");
	await page.waitForTimeout(4000);
	const body3 = (await page.locator("body").innerText()).replace(/\n/g, " | ");
	console.log("R3 LINK-07 after cookie loss:", page.url(), (await page.getByTestId("workspace").count()) > 0 ? "workspace" : body3.slice(0, 160));
	await shot(page, "link07-reredeem");
	await ctx.close();
});

test("R3 duration editor: click the chip, type a duration, press Enter", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dennis@asia2027.test", "Dennis", "Tester");
	await page.goto("/t/asia-2027?days=2027-10-05");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const card = page.getByTestId("timeline-item").filter({ hasText: "Nakano Broadway" }).first();
	await expect(card).toBeVisible({ timeout: 20_000 });
	const chip = card.getByTestId("plan-item-duration").getByRole("button");
	const before = await chip.innerText();
	await chip.click();
	await page.waitForTimeout(500);
	const focus = await page.evaluate(() => {
		const a = document.activeElement as HTMLElement | null;
		return { tag: a?.tagName, text: a?.innerText ?? (a as HTMLInputElement)?.value, type: (a as HTMLInputElement)?.type };
	});
	console.log("R3 duration popover focus:", before, JSON.stringify(focus));
	await shot(page, "duration-open");
	await page.keyboard.type("3h");
	await page.keyboard.press("Enter");
	await page.waitForTimeout(1500);
	const after = await chip.innerText();
	console.log("R3 duration after typing 3h + Enter:", before, "->", after);
	await shot(page, "duration-after");
	// restore through the text field
	await chip.click();
	const input = page.getByLabel("Duration", { exact: true });
	await input.fill(before);
	await input.press("Enter");
	await page.waitForTimeout(1000);
	console.log("R3 duration restored:", await chip.innerText());
	expect.soft(after, "typing 3h then Enter should set 3h").toBe("3h");
	await ctx.close();
});

test("R3 restore: Golden Gai and Nakano Broadway back to 2h30", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, "dennis@asia2027.test", "Dennis", "Tester");
	await page.goto("/t/asia-2027?days=2027-10-05");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	for (const name of ["Golden Gai", "Nakano Broadway"]) {
		const chip = page.getByTestId("timeline-item").filter({ hasText: name }).first().getByTestId("plan-item-duration").getByRole("button");
		await expect(chip).toBeVisible({ timeout: 20_000 });
		if ((await chip.innerText()) === "2h30") continue;
		await chip.click();
		const input = page.getByLabel("Duration", { exact: true });
		await input.fill("2h30");
		await input.press("Enter");
		await page.waitForTimeout(1000);
		console.log("R3 restored", name, await chip.innerText());
	}
	await ctx.close();
});

test("R3 dashboard first paint: a trip that already ended vs the real next trip", async ({ browser }) => {
	const { ctx, page } = await userPage(browser, `qa-home-r3past-${uniq()}@asia2027.test`, "Pat", "Past");
	await page.goto("/dashboard");
	await expect(page.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 });
	const a = await callFn(page, "/src/functions/trips.functions.ts", "createTrip", { name: "Spring 2026 (ended)", startDate: "2026-04-01", endDate: "2026-04-05" });
	const b = await callFn(page, "/src/functions/trips.functions.ts", "createTrip", { name: "Winter 2026 (upcoming)", startDate: "2026-12-01", endDate: "2026-12-05" });
	console.log("R3 past trips:", a.ok, a.error, b.ok, b.error);
	const html = await (await ctx.request.get("/dashboard")).text();
	const heroIdx = html.indexOf('data-testid="home-hero"');
	const around = heroIdx >= 0 ? html.slice(heroIdx, heroIdx + 3000).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200) : "(no hero in SSR)";
	console.log("R3 SSR hero:", around);
	const pastIdx = html.search(/>Past</i);
	console.log("R3 SSR has a Past section:", pastIdx >= 0);
	// what the browser shows before and after hydration
	const p2 = await ctx.newPage();
	await p2.route("**/*.js", async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
	await p2.goto("/dashboard", { waitUntil: "commit" });
	await p2.waitForSelector('[data-testid="home-hero"]', { timeout: 20_000 }).catch(() => null);
	const early = (await p2.getByTestId("home-hero").innerText().catch(() => "(none)")).replace(/\n/g, " | ");
	await shot(p2, "dash-first-paint");
	await p2.unrouteAll({ behavior: "ignoreErrors" });
	await p2.waitForTimeout(6000);
	const late = (await p2.getByTestId("home-hero").innerText().catch(() => "(none)")).replace(/\n/g, " | ");
	console.log("R3 hero first paint:", early);
	console.log("R3 hero after hydration:", late);
	await shot(p2, "dash-hydrated");
	expect.soft(early).not.toMatch(/ended/);
	await ctx.close();
});
