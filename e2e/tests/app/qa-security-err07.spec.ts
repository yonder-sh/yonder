/**
 * ERR-07 with the session really gone (Postgres row AND its Redis copy): what
 * does Audrey see when she submits the todo she was typing?
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { EMAIL, memberPage } from "./qa-security-helpers";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const PSQL = "/nix/store/8zm2sma9jgvq101yy4x45za4y28yd164-postgresql-17.10/bin/psql";
const REDIS = "/nix/store/zkd0ckjz5v4izrbb719rhw6y7bb6z4sp-redis-8.8.0/bin/redis-cli";
const DB = process.env.DATABASE_URL ?? "postgres://trip:trip@localhost:5432/trip_a27";
const PREFIX = process.env.REDIS_PREFIX ?? "yonder-a27";

test("ERR-07: the session is revoked while typing a todo", async ({ browser }) => {
	test.setTimeout(180_000);
	const out: Record<string, unknown> = {};
	const audrey = await memberPage(browser, EMAIL.audrey);
	const page = audrey.page;
	await page.goto("/t/asia-2027/japan/tokyo/shinjuku/golden-gai?tab=lists");
	const add = page.getByTestId("list-add").first();
	await expect(add).toBeVisible({ timeout: 20_000 });
	await add.click();
	const text = `Top up Suica ERR07 ${Date.now().toString(36)}`;
	await page.keyboard.insertText(text);
	const uid = execFileSync(PSQL, [DB, "-At", "-c", `select id from "user" where email='${EMAIL.audrey}'`]).toString().trim();
	const tokens = execFileSync(PSQL, [DB, "-At", "-c", `delete from session where user_id='${uid}' returning token`]).toString().trim().split("\n").filter(Boolean);
	for (const t of tokens) execFileSync(REDIS, ["del", `${PREFIX}:ba:${t}`]);
	execFileSync(REDIS, ["eval", "local n=0 for _,k in ipairs(redis.call('keys', ARGV[1])) do local v=redis.call('get', k) if v and string.find(v, ARGV[2], 1, true) then redis.call('del', k) n=n+1 end end return n", "0", `${PREFIX}:ba:*`, uid]);
	out.revokedTokens = tokens.length;
	await page.keyboard.press("Enter");
	await page.waitForTimeout(4000);
	out.url = page.url();
	out.toasts = await page.locator("[data-sonner-toast]").allInnerTexts();
	out.dialog = (await page.getByRole("dialog").count()) ? (await page.getByRole("dialog").first().innerText()).slice(0, 300) : "(none)";
	out.saved = execFileSync(PSQL, [DB, "-At", "-c", `select count(*) from list_items where text = '${text}'`]).toString().trim();
	out.textStillInInput = (await page.locator("body").innerText()).includes(text);
	await page.screenshot({ path: path.join(DIR, "err07-revoked.png") });
	writeFileSync(path.join(DIR, "err07.json"), JSON.stringify(out, null, 1));
	await audrey.ctx.close();
});
