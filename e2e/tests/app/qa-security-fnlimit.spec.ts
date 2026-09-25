/** SEC-06 / SECURITY §10: 300 server-function calls per minute per user (production build). */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const PROD = process.env.QA_SEC_PROD_URL ?? "http://localhost:5372";
test.use({ baseURL: PROD });

test("server functions are limited per user", async ({ browser }) => {
	test.setTimeout(300_000);
	const ctx = await browser.newContext({ baseURL: PROD });
	const email = `fnlimit-${Date.now().toString(36)}@example.com`;
	const h = { Origin: PROD, "Content-Type": "application/json", "X-Forwarded-For": "192.0.2.77" };
	await ctx.request.post("/api/auth/email-otp/send-verification-otp", { data: { email, type: "sign-in" }, headers: h });
	await ctx.request.post("/api/auth/sign-in/email-otp", { data: { email, otp: "000000" }, headers: h });
	await ctx.request.post("/api/auth/update-user", { data: { firstName: "Fn", lastName: "Limit" }, headers: h });
	const page = await ctx.newPage();
	let fnUrl = "";
	let fnHeaders: Record<string, string> = {};
	const seen: string[] = [];
	page.on("response", async (res) => {
		const r = res.request();
		if (r.url().includes("/_serverFn/")) seen.push(`${r.method()} ${res.status()} ${r.url().slice(0, 90)}`);
		if (!fnUrl && r.url().includes("/_serverFn/") && r.method() === "GET" && res.status() === 200) {
			fnUrl = r.url();
			fnHeaders = await r.allHeaders();
		}
	});
	await page.goto("/");
	await page.waitForTimeout(4000);
	const statuses: Record<string, number> = {};
	for (let i = 0; i < 320 && fnUrl; i++) {
		const res = await ctx.request.get(fnUrl, { headers: { ...Object.fromEntries(Object.entries(fnHeaders).filter(([k]) => !k.startsWith(":") && k !== "cookie")), Origin: PROD } });
		const s = res.status();
		if (i === 0) statuses[`first:${(await res.text()).slice(0, 60)}`] = s;
		statuses[s] = (statuses[s] ?? 0) + 1;
	}
	writeFileSync(path.join(process.env.QA_SEC_DIR ?? "/tmp", "fnlimit.json"), JSON.stringify({ fnUrl: fnUrl.replace(/\?.*/, "?…"), seen, statuses }, null, 1));
	await ctx.close();
});
