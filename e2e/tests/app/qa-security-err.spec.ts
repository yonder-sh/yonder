/**
 * QA security verifier (I2 round 1): ERR-03 (a failed save rolls back, says
 * "Couldn't save" with Retry), ERR-06 (tiles fail), ERR-07 (the session is
 * deleted mid-edit), ERR-08 (bad input refused).
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { call, DAY1, EMAIL, MOD, memberPage, T } from "./qa-security-helpers";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const GG_URL = "/t/asia-2027/japan/tokyo/shinjuku/golden-gai";
const PSQL = process.env.QA_SEC_PSQL ?? "/nix/store/8zm2sma9jgvq101yy4x45za4y28yd164-postgresql-17.10/bin/psql";
const DB = process.env.DATABASE_URL ?? "postgres://trip:trip@localhost:5432/trip_a27";

test("ERR-03/06/07/08", async ({ browser }) => {
	test.setTimeout(300_000);
	const out: Record<string, unknown> = {};
	const audrey = await memberPage(browser, EMAIL.audrey);
	const page = audrey.page;

	// ---- ERR-03: the next server-function POST answers 500 -----------------
	await page.goto(GG_URL);
	await page.getByRole("tab", { name: /^Lists/ }).first().click();
	const row = page.locator(`[data-testid=list-row][data-status=open]`).first();
	await expect(row).toBeVisible({ timeout: 20_000 });
	const id = await row.getAttribute("data-id");
	let fail = true;
	await page.route("**/_serverFn/**", async (route) => {
		if (fail && route.request().method() === "POST") {
			fail = false;
			return route.fulfill({ status: 500, body: "boom" });
		}
		return route.continue();
	});
	await row.getByTestId("list-row-check").click();
	await page.waitForTimeout(2500);
	out.err03 = {
		statusAfter: await page.locator(`[data-testid=list-row][data-id="${id}"]`).first().getAttribute("data-status"),
		toasts: await page.locator("[data-sonner-toast]").allInnerTexts(),
		retryButton: await page.locator("[data-sonner-toast] button", { hasText: /retry/i }).count(),
	};
	await page.screenshot({ path: path.join(DIR, "err03.png") });
	await page.unroute("**/_serverFn/**");

	// ---- ERR-06: tiles blocked ---------------------------------------------
	await page.route(/tiles\.openfreemap\.org/, (r) => r.abort());
	await page.goto("/t/asia-2027/japan/tokyo");
	await page.waitForTimeout(6000);
	out.err06 = (await page.locator("body").innerText()).match(/[^\n]*(tiles|Map)[^\n]*(load|unavailable)[^\n]*/gi)?.slice(0, 3) ?? [];
	await page.screenshot({ path: path.join(DIR, "err06.png") });
	await page.unroute(/tiles\.openfreemap\.org/);

	// ---- ERR-08: bad input over the API ------------------------------------
	const bad = [
		await call(page, MOD.items, "createItem", { tripId: T, dayId: null, title: "x".repeat(300) }),
		await call(page, MOD.items, "createItem", { tripId: T, dayId: null, title: "bad time", pinnedStart: "25:00" }),
		await call(page, MOD.items, "createItem", { tripId: T, dayId: null, title: "bad duration", durationMin: -30 }),
	];
	out.err08 = bad.map((r) => (r.ok ? "ACCEPTED" : r.err.slice(0, 60)));
	void DAY1;

	// ---- ERR-07: the session row is deleted while Audrey types a todo -------
	await page.goto(GG_URL);
	await page.getByRole("tab", { name: /^Lists/ }).first().click();
	const add = page.getByTestId("list-add").first();
	await expect(add).toBeVisible({ timeout: 20_000 });
	await add.click();
	await page.keyboard.insertText("Buy Suica top-up (ERR-07)");
	execFileSync(PSQL, [DB, "-c", `delete from session where user_id = (select id from "user" where email = '${EMAIL.audrey}')`]);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(3000);
	out.err07 = {
		url: page.url(),
		text: (await page.locator("body").innerText()).slice(0, 300),
		toasts: await page.locator("[data-sonner-toast]").allInnerTexts(),
	};
	await page.screenshot({ path: path.join(DIR, "err07.png") });
	writeFileSync(path.join(DIR, "err.json"), JSON.stringify(out, null, 1));
	await audrey.ctx.close();
});
