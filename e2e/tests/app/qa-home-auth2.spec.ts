/** I2 verifier "home": AUTH-07 (expired code via DB time travel, QA TI-8). */
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { hydrated } from "./_helpers/page";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
});

test.beforeEach(({}, info) => {
	test.skip(!process.env.QA_DB, "needs QA_DB (the server's database name) for the DB time travel");
});


const SHOTS = process.env.QA_SHOTS ?? "shots";
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
function psql(sql: string): string {
	const pg = execFileSync("sh", ["-c", "docker ps --format '{{.Names}}' | grep -i postgres | head -1"], { encoding: "utf8" }).trim();
	return execFileSync("docker", ["exec", pg, "psql", "-U", "trip", "-d", process.env.QA_DB as string, "-tAc", sql], { encoding: "utf8" });
}

test("AUTH-07: an expired code is rejected with a one-click new code; no session", async ({ page }) => {
	const email = `qa-home-a07-${uniq()}@asia2027.test`;
	await page.goto("/login");
	await (await hydrated(page.getByTestId("login-email"))).fill(email);
	await page.getByTestId("login-submit").click();
	await expect(page.getByTestId("otp-input")).toBeVisible();
	await page.waitForTimeout(500);
	console.log("AUTH-07 rows:", psql(`select identifier, expires_at from verification where identifier like '%${email}%'`));
	const upd = psql(`update verification set expires_at = (now() at time zone 'utc') - interval '1 minute' where identifier like '%${email}%' returning id`);
	console.log("AUTH-07 time-travelled:", upd.trim());
	await page.getByTestId("otp-input").click();
	await page.keyboard.type(process.env.DEV_FIXED_OTP || "000000");
	await expect(page.getByTestId("auth-error")).toBeVisible();
	const msg = await page.getByTestId("auth-error").innerText();
	console.log("AUTH-07 message:", msg);
	await page.screenshot({ path: `${SHOTS}/auth-07-expired.png` });
	expect(msg).toMatch(/expired/i);
	await expect(page.getByTestId("otp-new-code")).toBeVisible();
	const sess = await (await page.request.get("/api/auth/get-session")).text();
	expect(sess === "null" || sess === "").toBe(true);
	await page.getByTestId("otp-new-code").click();
	await page.getByTestId("otp-input").click();
	await page.keyboard.type(process.env.DEV_FIXED_OTP || "000000");
	await expect(page).toHaveURL(/\/welcome/);
});

test("AUTH-08b: resend countdown actually counts down", async ({ page }) => {
	await page.goto("/login");
	await (await hydrated(page.getByTestId("login-email"))).fill(`qa-home-a08b-${uniq()}@asia2027.test`);
	await page.getByTestId("login-submit").click();
	const cd = page.getByTestId("otp-resend-countdown");
	await expect(cd).toBeVisible();
	const t1 = await cd.innerText();
	await page.waitForTimeout(3200);
	const t2 = await cd.innerText();
	console.log("AUTH-08b countdown:", t1, "→", t2);
	expect(t2).not.toBe(t1);
});
