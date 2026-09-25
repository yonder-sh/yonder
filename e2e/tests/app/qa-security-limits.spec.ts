/**
 * QA security verifier (I2 round 1): SEC-06 (brute force and rate limits) and
 * SEC-08 (cookies) against a PRODUCTION build (`NODE_ENV=production`; the
 * limiters are off in dev). Run with QA_SEC_PROD_URL=http://localhost:<port>.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { request, test } from "@playwright/test";
import { REPO_ROOT } from "./_helpers/env";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const PROD = process.env.QA_SEC_PROD_URL ?? "http://localhost:5372";
const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const OUTBOX = path.resolve(REPO_ROOT, process.env.EMAIL_OUTBOX_DIR ?? ".data/outbox");
test.use({ baseURL: PROD });

const stamp = Date.now().toString(36);
const ip = (n: number) => `203.0.113.${n % 250}`;
const mailsTo = (email: string) =>
	readdirSync(OUTBOX).filter((f) => f.endsWith(".json")).filter((f) => {
		try {
			return (JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8")) as { to?: string }).to === email;
		} catch {
			return false;
		}
	}).length;

test("OTP send/verify caps, anonymous sign-in and link redemption limits", async ({ browser }) => {
	test.setTimeout(300_000);
	const out: Record<string, unknown> = {};
	const api = await request.newContext({ baseURL: PROD });
	const post = (p: string, body: unknown, xff: string) =>
		api.post(`/api/auth${p}`, { data: body, headers: { Origin: PROD, "Content-Type": "application/json", "X-Forwarded-For": xff } });

	if (!process.env.QA_SEC_ONLY_GUESS) {
	// A. Per-email send cap (5/h), each request from its own IP.
	const e1 = `rl-send-${stamp}@example.com`;
	const sends: number[] = [];
	for (let i = 0; i < 7; i++) sends.push((await post("/email-otp/send-verification-otp", { email: e1, type: "sign-in" }, ip(10 + i))).status());
	await new Promise((r) => setTimeout(r, 1500));
	out.perEmailSendStatuses = sends;
	out.perEmailMailsSent = mailsTo(e1);

	// B. Per-IP send limit (5/min) with different emails.
	const b: number[] = [];
	for (let i = 0; i < 7; i++) b.push((await post("/email-otp/send-verification-otp", { email: `rl-ip-${stamp}-${i}@example.com`, type: "sign-in" }, "198.51.100.7")).status());
	out.perIpSendStatuses = b;

	// C. Verify lockout: 11 wrong codes (3 per issued code), then the right one.
	const e2 = `rl-verify-${stamp}@example.com`;
	const verify: number[] = [];
	let n = 0;
	for (let round = 0; round < 4; round++) {
		await post("/email-otp/send-verification-otp", { email: e2, type: "sign-in" }, ip(100 + round));
		for (let k = 0; k < 3 && n < 11; k++, n++)
			verify.push((await post("/sign-in/email-otp", { email: e2, otp: "123456" }, ip(120 + n))).status());
	}
	out.wrongCodeStatuses = verify;
	await post("/email-otp/send-verification-otp", { email: e2, type: "sign-in" }, ip(200));
	const right = await post("/sign-in/email-otp", { email: e2, otp: "000000" }, ip(201));
	out.rightCodeAfterLock = { status: right.status(), body: (await right.text()).slice(0, 160) };

	// D. Anonymous sign-ins per IP (3/min).
	const anon: number[] = [];
	for (let i = 0; i < 5; i++) anon.push((await post("/sign-in/anonymous", {}, "198.51.100.9")).status());
	out.anonymousStatuses = anon;

	}
	// E. Share-token guessing from one browser (10/min per IP), through /join.
	const ctx = await browser.newContext({ baseURL: PROD });
	const page = await ctx.newPage();
	const states: string[] = [];
	for (let i = 0; i < 13; i++) {
		const tok = `guess${stamp}${i}${"x".repeat(24)}`;
		await page.goto("about:blank");
		await page.goto(`/join#t=${tok}`);
		await page.waitForFunction(() => /no longer works|Too many|try again|wait/i.test(document.body.innerText), undefined, { timeout: 15_000 }).catch(() => undefined);
		const t = await page.locator("body").innerText();
		states.push(/no longer works/i.test(t) ? "dead" : /too many|wait|try again/i.test(t) ? "LIMITED" : t.slice(0, 40).replace(/\s+/g, " "));
	}
	out.guessStates = states;
	await page.screenshot({ path: path.join(DIR, "limits-guess.png") });

	if (!process.env.QA_SEC_ONLY_GUESS) {
	// F. Cookies (SEC-08): sign in and read Set-Cookie.
	const e3 = `rl-cookie-${stamp}@example.com`;
	await post("/email-otp/send-verification-otp", { email: e3, type: "sign-in" }, ip(230));
	const s = await post("/sign-in/email-otp", { email: e3, otp: "000000" }, ip(231));
	out.signInStatus = s.status();
	out.setCookie = s.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value.replace(/=[^;]+;/, "=<redacted>;"));
	}
	writeFileSync(path.join(DIR, process.env.QA_SEC_ONLY_GUESS ? "limits-guess.json" : "limits.json"), JSON.stringify(out, null, 1));
	await ctx.close();
	await api.dispose();
});
