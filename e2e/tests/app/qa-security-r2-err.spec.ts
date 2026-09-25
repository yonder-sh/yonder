/**
 * QA security verifier (I2 round 2): ERR-01, ERR-04 and ERR-05 against
 * isolated PRODUCTION instances (never the shared services): one with a
 * DATABASE_URL on a closed port (QA_SEC_DBDOWN_URL), one whose S3 endpoint is
 * a closed port (QA_SEC_S3DOWN_URL). ERR-01 runs on QA_SEC_PROD_URL.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";

test.skip(!process.env.QA_SEC_DIR || !process.env.QA_SEC_PROD_URL, "QA security verifier probes");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const PROD = process.env.QA_SEC_PROD_URL ?? "";
const DBDOWN = process.env.QA_SEC_DBDOWN_URL ?? "";
const S3DOWN = process.env.QA_SEC_S3DOWN_URL ?? "";
const JPEG = Buffer.from(
	"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
	"base64",
);

test("ERR-01: an unknown trip id", async ({ browser }) => {
	test.skip(!!process.env.QA_SEC_SKIP_ERR01, "done");
	const ctx = await browser.newContext({ baseURL: PROD });
	await loginViaApi(ctx.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
	const page = await ctx.newPage();
	const out: Record<string, unknown> = {};
	for (const u of ["/trips/00000000-0000-0000-0000-000000000000", "/t/00000000-0000-0000-0000-000000000000"]) {
		const res = await page.goto(u);
		await page.waitForTimeout(2500);
		const html = (await res?.text()) ?? "";
		out[u] = { status: res?.status(), url: page.url(), text: (await page.locator("body").innerText()).slice(0, 200), stack: /at [\w.]+ \(|node_modules|Error:/.test(html) };
		await page.screenshot({ path: path.join(DIR, `r2-err01-${u.split("/")[1]}.png`) });
	}
	writeFileSync(path.join(DIR, "r2-err01.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
});

test("ERR-04: the database is down", async ({ browser }) => {
	test.skip(!DBDOWN, "QA_SEC_DBDOWN_URL");
	// Signed in (cookies for localhost cover every port; the session is in Redis too).
	const ctx = await browser.newContext({ baseURL: PROD });
	await loginViaApi(ctx.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" });
	const page = await ctx.newPage();
	const out: Record<string, unknown> = {};
	for (const u of ["/", "/t/asia-2027", "/login"]) {
		const res = await page.goto(DBDOWN + u);
		await page.waitForTimeout(3000);
		const html = (await res?.text()) ?? "";
		out[u] = {
			status: res?.status(),
			url: page.url(),
			text: (await page.locator("body").innerText()).slice(0, 200),
			leaks: (html.match(/ECONNREFUSED|postgres|select |stack|at [\w.]+ \(|node_modules|5999/gi) ?? []).slice(0, 5),
		};
		await page.screenshot({ path: path.join(DIR, `r2-err04-${u.replace(/\W+/g, "_") || "root"}.png`) });
	}
	// What "Show Error" reveals on the dashboard.
	await page.goto(DBDOWN + "/");
	await page.waitForTimeout(3000);
	const show = page.getByRole("button", { name: /show error/i });
	if (await show.isVisible().catch(() => false)) {
		await show.click();
		await page.waitForTimeout(500);
		out.showError = (await page.locator("body").innerText()).slice(0, 600);
		await page.screenshot({ path: path.join(DIR, "r2-err04-show-error.png") });
	}
	out.dashboardHtmlSql = ((await (await ctx.request.get(DBDOWN + "/")).text()).match(/Failed query|select [^<]{0,80}|ECONNREFUSED|session/gi) ?? []).slice(0, 6);
	// The sign-in API itself.
	const send = await ctx.request.post(DBDOWN + "/api/auth/email-otp/send-verification-otp", {
		data: { email: "dennis@asia2027.test", type: "sign-in" },
		headers: { Origin: DBDOWN, "Content-Type": "application/json" },
	});
	out.sendOtp = { status: send.status(), body: (await send.text()).slice(0, 200) };
	writeFileSync(path.join(DIR, "r2-err04.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
});

test("ERR-05: storage is down during an upload", async ({ browser }) => {
	test.skip(!S3DOWN, "QA_SEC_S3DOWN_URL");
	const ctx = await browser.newContext({ baseURL: PROD, viewport: { width: 1440, height: 900 } });
	await loginViaApi(ctx.request, "audrey@asia2027.test", { first: "Audrey", last: "Tester" });
	const page = await ctx.newPage();
	await page.goto(S3DOWN + "/t/asia-2027/japan/tokyo/shinjuku/golden-gai?tab=media");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.getByRole("tab", { name: /^Media/ }).first().click();
	await page.waitForTimeout(1500);
	const before = await page.getByTestId("media-upload-tile").count();
	const input = page.getByTestId("media-file-input").first();
	await input.setInputFiles({ name: `err05-${Date.now()}.jpg`, mimeType: "image/jpeg", buffer: JPEG });
	await page.waitForTimeout(8000);
	const out = {
		tilesBefore: before,
		uploadTiles: await page.getByTestId("media-upload-tile").allInnerTexts(),
		retryButtons: await page.getByTestId("media-upload-retry").count(),
		toasts: await page.locator("[data-sonner-toast]").allInnerTexts(),
	};
	await page.screenshot({ path: path.join(DIR, "r2-err05.png") });
	writeFileSync(path.join(DIR, "r2-err05.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
});
