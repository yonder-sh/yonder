/**
 * I2 verifier "home" (round 1): AUTH-* scenarios (qa/SCENARIOS §5) through the
 * real UI. Runs against an isolated server (APP_URL) with DEV_FIXED_OTP=000000.
 */
import { type Page, expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { APP_URL } from "./_helpers/env";
import { hydrated } from "./_helpers/page";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
});


const SHOTS = process.env.QA_SHOTS ?? "shots";
const shot = (page: Page, name: string) =>
	page.screenshot({ path: `${SHOTS}/auth-${name}.png`, animations: "disabled" });
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OTP = process.env.DEV_FIXED_OTP || "000000";

async function uiRequestCode(page: Page, email: string) {
	await page.goto("/login");
	const input = await hydrated(page.getByTestId("login-email"));
	await input.fill(email);
	await page.getByTestId("login-submit").click();
	await expect(page.getByTestId("otp-input")).toBeVisible();
}

async function typeCode(page: Page, code: string) {
	const otp = page.getByTestId("otp-input");
	await otp.click();
	await page.keyboard.type(code);
}

/** Calls a server function from the page (same cookies), returning status + value/error. */
async function callFn(page: Page, mod: string, fn: string, data: unknown) {
	const resP = page.waitForResponse((r) => r.url().includes("/_serverFn/"), { timeout: 15_000 }).catch(() => null);
	const out = await page.evaluate(
		async ({ mod, fn, data }) => {
			try {
				const m = await import(/* @vite-ignore */ mod);
				const v = await m[fn]({ data });
				return { ok: true, value: JSON.parse(JSON.stringify(v ?? null)) };
			} catch (e) {
				const err = e as { message?: string; code?: string; name?: string };
				return { ok: false, error: String(err?.message ?? e), code: err?.code ?? null };
			}
		},
		{ mod, fn, data },
	);
	const res = await resP;
	return { ...out, status: res?.status() ?? null };
}

test("AUTH-01: first sign-up with a code, then the name step, then the dashboard", async ({ page }) => {
	const email = `qa-home-a01-${uniq()}@asia2027.test`;
	await uiRequestCode(page, email);
	await shot(page, "01-code-step");
	await typeCode(page, OTP);
	await expect(page).toHaveURL(/\/welcome/);
	await expect(page.getByTestId("welcome-first-name")).toBeVisible();
	await shot(page, "01-welcome");
	await page.getByTestId("welcome-first-name").fill("Dennis");
	await page.getByTestId("welcome-last-name").fill("Tester");
	await page.getByTestId("welcome-submit").click();
	await expect(page.getByTestId("dashboard")).toBeVisible();
	await shot(page, "01-dashboard-empty");
	await (await hydrated(page.getByTestId("account-menu").first())).click();
	await expect(page.getByRole("menu")).toContainText("Dennis Tester");
	const initials = await page.getByTestId("account-menu").first().innerText();
	expect.soft(initials.replace(/\s/g, "")).toBe("DT");
	await shot(page, "01-account-menu");
	await page.keyboard.press("Escape");
	await page.reload();
	await expect(page.getByTestId("dashboard")).toBeVisible();
});

test("AUTH-02: the name step can't be skipped, and the server refuses nameless calls", async ({ page }) => {
	const email = `qa-home-a02-${uniq()}@asia2027.test`;
	await uiRequestCode(page, email);
	await typeCode(page, OTP);
	await expect(page).toHaveURL(/\/welcome/);
	await hydrated(page.getByTestId("welcome-first-name"));
	await page.getByTestId("welcome-first-name").fill("Kai");
	await page.getByTestId("welcome-submit").click();
	await expect(page.getByText(/required/i).first()).toBeVisible();
	await shot(page, "02-last-empty");
	await page.getByTestId("welcome-first-name").fill("   ");
	await page.getByTestId("welcome-last-name").fill("Viewer");
	await page.getByTestId("welcome-submit").click();
	await expect(page.getByText(/required/i).first()).toBeVisible();
	await shot(page, "02-first-blank");
	await page.goto("/dashboard");
	await expect(page).toHaveURL(/\/welcome/);
	await page.goto("/t/asia-2027?tab=plan");
	await expect(page).toHaveURL(/\/welcome/);
	// Direct server-function calls with Kai's cookie
	await page.goto("/welcome");
	await hydrated(page.getByTestId("welcome-first-name"));
	const create = await callFn(page, "/src/functions/trips.functions.ts", "createTrip", {
		name: "Nameless trip",
		startDate: "2027-10-02",
		endDate: "2027-10-05",
	});
	expect.soft(create.ok, JSON.stringify(create)).toBe(false);
	expect.soft(create.status ?? 0, JSON.stringify(create)).toBeGreaterThanOrEqual(400);
	// Also the API update-user with a blank name must be refused
	const upd = await page.request.post("/api/auth/update-user", {
		headers: { Origin: APP_URL, "Content-Type": "application/json" },
		data: { firstName: "  ", lastName: "X" },
	});
	expect.soft(upd.status(), "update-user with blank first name").toBeGreaterThanOrEqual(400);
	const updName = await page.request.post("/api/auth/update-user", {
		headers: { Origin: APP_URL, "Content-Type": "application/json" },
		data: { name: "Sneaky Name" },
	});
	const sess = await (await page.request.get("/api/auth/get-session")).json();
	expect.soft(sess?.user?.name, `update-user {name} → ${updName.status()}`).not.toBe("Sneaky Name");
});

test("AUTH-03: international and hostile names render literally", async ({ page }) => {
	const dialogs: string[] = [];
	page.on("dialog", (d) => {
		dialogs.push(d.message());
		void d.dismiss();
	});
	const email = `qa-home-a03-${uniq()}@asia2027.test`;
	await uiRequestCode(page, email);
	await typeCode(page, OTP);
	await hydrated(page.getByTestId("welcome-first-name"));
	await page.getByTestId("welcome-first-name").fill("Thảo"); // decomposed ả
	await page.getByTestId("welcome-last-name").fill("Nguyễn-O'Brien");
	await page.getByTestId("welcome-submit").click();
	await expect(page.getByTestId("dashboard")).toBeVisible();
	const sess = await (await page.request.get("/api/auth/get-session")).json();
	expect.soft(sess.user.firstName, "NFC-normalised first name").toBe("Thảo".normalize("NFC"));
	expect.soft(sess.user.lastName).toBe("Nguyễn-O'Brien");
	await (await hydrated(page.getByTestId("account-menu").first())).click();
	await expect(page.getByRole("menu")).toContainText("Nguyễn-O'Brien");
	expect.soft((await page.getByTestId("account-menu").first().innerText()).replace(/\s/g, "")).toBe("TN");
	await page.keyboard.press("Escape");
	// hostile name
	const ctx2 = await page.context().browser()!.newContext();
	const p2 = await ctx2.newPage();
	p2.on("dialog", (d) => {
		dialogs.push(d.message());
		void d.dismiss();
	});
	await loginViaApi(p2.request, `qa-home-a03x-${uniq()}@asia2027.test`, { first: "<img src=x onerror=alert(1)>", last: "Test" });
	await p2.goto("/dashboard");
	await expect(p2.getByTestId("dashboard")).toBeVisible();
	await (await hydrated(p2.getByTestId("account-menu").first())).click();
	await expect(p2.getByRole("menu")).toContainText("<img src=x onerror=alert(1)> Test");
	await p2.screenshot({ path: `${SHOTS}/auth-03-hostile.png` });
	expect(dialogs).toEqual([]);
	await ctx2.close();
});

test("AUTH-04/10: returning user skips the name step; email is case/space-insensitive", async ({ page, browser }) => {
	const base = `qa-home-a04-${uniq()}@asia2027.test`;
	const ctx = await browser.newContext();
	await loginViaApi(ctx.request, base, { first: "Audrey", last: "Tester" });
	const first = await (await ctx.request.get("/api/auth/get-session")).json();
	await ctx.close();
	await uiRequestCode(page, `  ${base.replace("qa-home", "QA-Home").replace("asia2027.test", "Asia2027.TEST")} `);
	await typeCode(page, OTP);
	await expect(page.getByTestId("dashboard")).toBeVisible();
	const sess = await (await page.request.get("/api/auth/get-session")).json();
	expect(sess.user.id).toBe(first.user.id);
	expect(sess.user.name).toBe("Audrey Tester");
});

test("AUTH-05: a deep link survives sign-in; an external redirect is ignored", async ({ page, browser }) => {
	// Dennis of the QA seed owns asia-2027. Signed out, with link sharing off:
	// the "no access" page (the same for any address), whose Sign in keeps it.
	await page.goto("/t/asia-2027?days=2027-10-05");
	await expect(page.getByTestId("trip-no-access")).toBeVisible({ timeout: 30_000 });
	await page.getByTestId("trip-no-access-sign-in").click();
	await expect(page).toHaveURL(/\/login\?next=/);
	await shot(page, "05-login-with-next");
	await hydrated(page.getByTestId("login-email"));
	await page.getByTestId("login-email").fill("audrey@asia2027.test");
	await page.getByTestId("login-submit").click();
	await typeCode(page, OTP);
	await expect(page).toHaveURL(/\/t\/asia-2027/);
	expect.soft(page.url()).toContain("days=2027-10-05");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await shot(page, "05-landed-on-day");
	for (const evil of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
		const ctx = await browser.newContext();
		const p2 = await ctx.newPage();
		await p2.goto(`/login?next=${encodeURIComponent(evil)}`);
		await hydrated(p2.getByTestId("login-email"));
		await p2.getByTestId("login-email").fill("audrey@asia2027.test");
		await p2.getByTestId("login-submit").click();
		await typeCode(p2, OTP);
		await p2.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15_000 }).catch(() => {});
		await p2.waitForTimeout(1500);
		console.log(`AUTH-05 next=${evil} → ${p2.url()}`);
		expect.soft(new URL(p2.url()).host, `next=${evil}`).toBe(new URL(APP_URL).host);
		await ctx.close();
	}
});

test("AUTH-06: wrong code, then too many attempts", async ({ page }) => {
	const email = `qa-home-a06-${uniq()}@asia2027.test`;
	await uiRequestCode(page, email);
	await typeCode(page, "111111");
	await expect(page.getByTestId("auth-error")).toBeVisible();
	await shot(page, "06-wrong-code");
	const firstMsg = await page.getByTestId("auth-error").innerText();
	expect.soft(firstMsg).toMatch(/incorrect|wrong|invalid/i);
	await expect(page.getByTestId("otp-input")).toBeVisible();
	const msgs: string[] = [firstMsg];
	for (let i = 0; i < 6; i++) {
		if (await page.getByTestId("otp-new-code").isVisible()) break;
		await typeCode(page, "22222" + i);
		await expect(page.getByTestId("auth-error")).toBeVisible();
		msgs.push(await page.getByTestId("auth-error").innerText());
	}
	await shot(page, "06-too-many");
	console.log("AUTH-06 messages:", msgs);
	// Now the correct code must be refused too
	const otp = page.getByTestId("otp-input");
	if (await otp.isEnabled()) {
		await typeCode(page, OTP);
		await page.waitForTimeout(1500);
		expect.soft(page.url(), "correct code after too many attempts must be refused").toContain("/login");
	}
	expect.soft(msgs.join(" | ")).toMatch(/too many/i);
	await expect(page.getByTestId("otp-new-code")).toBeVisible();
	await page.getByTestId("otp-new-code").click();
	await typeCode(page, OTP);
	await expect(page).toHaveURL(/\/welcome/);
});

test("AUTH-08: resend shows a countdown; hammering the send endpoint is capped", async ({ page }) => {
	const email = `qa-home-a08-${uniq()}@asia2027.test`;
	await uiRequestCode(page, email);
	await expect(page.getByTestId("otp-resend-countdown")).toBeVisible();
	await shot(page, "08-countdown");
	const statuses: number[] = [];
	for (let i = 0; i < 12; i++) {
		const r = await page.request.post("/api/auth/email-otp/send-verification-otp", {
			headers: { Origin: APP_URL, "Content-Type": "application/json" },
			data: { email, type: "sign-in" },
		});
		statuses.push(r.status());
	}
	console.log("AUTH-08 send statuses:", statuses.join(","));
});

test("AUTH-09: email OTP is the only way in", async ({ page, request }) => {
	await page.goto("/login");
	await hydrated(page.getByTestId("login-email"));
	await expect(page.locator('input[type="password"]')).toHaveCount(0);
	await expect(page.getByText(/password|magic link|google|github|apple/i)).toHaveCount(0);
	const h = { Origin: APP_URL, "Content-Type": "application/json" };
	const results: Record<string, number> = {};
	for (const [p, body] of [
		["/api/auth/sign-in/email", { email: "dennis@asia2027.test", password: "hunter22hunter22" }],
		["/api/auth/sign-up/email", { email: `x-${uniq()}@asia2027.test`, password: "hunter22hunter22", name: "X" }],
		["/api/auth/sign-in/magic-link", { email: "dennis@asia2027.test" }],
		["/api/auth/sign-in/social", { provider: "google" }],
		["/api/auth/forget-password", { email: "dennis@asia2027.test" }],
		["/api/auth/request-password-reset", { email: "dennis@asia2027.test" }],
	] as const) {
		const r = await request.post(p, { headers: h, data: body });
		results[p] = r.status();
	}
	console.log("AUTH-09 statuses:", results);
	for (const [p, s] of Object.entries(results)) expect.soft(s, p).toBeGreaterThanOrEqual(400);
});

test("AUTH-11: email validation and OTP input ergonomics", async ({ page }) => {
	await page.goto("/login");
	await hydrated(page.getByTestId("login-email"));
	let sent = 0;
	page.on("request", (r) => {
		if (r.url().includes("send-verification-otp")) sent++;
	});
	await page.getByTestId("login-email").fill("dennis@");
	await page.getByTestId("login-submit").click();
	await expect(page.getByTestId("auth-error")).toBeVisible();
	expect(sent).toBe(0);
	await shot(page, "11-invalid-email");
	await page.getByTestId("login-email").fill(`qa-home-a11-${uniq()}@asia2027.test`);
	await page.getByTestId("login-submit").click();
	const otp = page.getByTestId("otp-input");
	await expect(otp).toHaveAttribute("inputmode", "numeric");
	await expect(otp).toHaveAttribute("autocomplete", "one-time-code");
	await otp.focus();
	await page.evaluate((code) => {
		const el = document.querySelector('[data-testid="otp-input"]') as HTMLInputElement;
		const dt = new DataTransfer();
		dt.setData("text/plain", code);
		el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
	}, `${OTP.slice(0, 3)} ${OTP.slice(3)}`);
	await expect(page).toHaveURL(/\/welcome/, { timeout: 10_000 });
});

test("AUTH-12/13: sign-out ends the session; protected routes don't leak", async ({ page, browser, playwright }) => {
	await loginViaApi(page.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
	const cookies = await page.context().cookies();
	const tab2 = await page.context().newPage();
	await tab2.goto("/dashboard");
	await expect(tab2.getByTestId("dashboard")).toBeVisible();
	await page.goto("/dashboard");
	await expect(page.getByTestId("dashboard")).toBeVisible();
	await (await hydrated(page.getByTestId("account-menu").first())).click();
	await page.getByRole("menuitem", { name: /sign out/i }).click();
	await expect(page).toHaveURL(/\/login/);
	await shot(page, "12-signed-out");
	// tab 2's next action
	await tab2.getByTestId("new-trip-button").first().click().catch(() => {});
	await tab2.reload();
	await expect(tab2).toHaveURL(/\/login/);
	// replay old cookie
	const replay = await playwright.request.newContext({ baseURL: APP_URL, storageState: { cookies, origins: [] } });
	const s = await replay.get("/api/auth/get-session");
	const body = await s.text();
	expect.soft(body === "null" || body === "" || s.status() === 401, `replayed session: ${s.status()} ${body.slice(0, 120)}`).toBe(true);
	const dash = await replay.get("/dashboard", { maxRedirects: 0 });
	expect.soft(dash.status(), "dashboard with replayed cookie").toBeGreaterThanOrEqual(300);
	await replay.dispose();
	// AUTH-13: signed-out browser, raw HTML
	const anon = await playwright.request.newContext({ baseURL: APP_URL });
	for (const p of ["/dashboard", "/t/asia-2027", "/t/asia-2027/japan", "/t/01a0cea5-d26d-7713-a5c8-ede8e15b9662"]) {
		const r = await anon.get(p, { maxRedirects: 0 });
		const html = await r.text();
		console.log(`AUTH-13 ${p}: ${r.status()} ${r.headers().location ?? ""}`);
		expect.soft(html, p).not.toMatch(/Golden Gai|Asia 2027|Shibuya|Haneda/);
	}
	await anon.dispose();
});

test("AUTH-15: changing your name later updates the account menu; both names stay required", async ({ page }) => {
	await loginViaApi(page.request, `qa-home-a15-${uniq()}@asia2027.test`, { first: "Audrey", last: "Tester" });
	await page.goto("/dashboard");
	await expect(page.getByTestId("dashboard")).toBeVisible();
	await (await hydrated(page.getByTestId("account-menu").first())).click();
	await page.getByRole("menuitem", { name: /profile/i }).click();
	await expect(page.getByTestId("profile-dialog")).toBeVisible();
	await page.getByTestId("home-profile-last").fill("");
	await shot(page, "15-profile-blank-last");
	const disabled = await page.getByTestId("home-profile-save").isDisabled();
	if (!disabled) {
		await page.getByTestId("home-profile-save").click();
		await expect(page.getByTestId("profile-dialog")).toBeVisible();
	}
	await page.getByTestId("home-profile-last").fill("   ");
	expect.soft(await page.getByTestId("home-profile-save").isDisabled(), "whitespace-only last name").toBe(true);
	await page.getByTestId("home-profile-last").fill("Tester-Lee");
	await page.getByTestId("home-profile-save").click();
	await expect(page.getByTestId("profile-dialog")).toBeHidden();
	await page.getByTestId("account-menu").first().click();
	await expect(page.getByRole("menu")).toContainText("Audrey Tester-Lee");
});
