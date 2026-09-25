/**
 * I2 "content" verifier: QA ROLL-01/02/03/06/12 counts on the imported Asia
 * 2027 trip (read-only checks; run before the mutating specs).
 */
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
test.use({ storageState: path.join(AUTH, "dennis.json") });

async function rowsText(page: Page): Promise<string[]> {
	await page.waitForTimeout(600);
	return (await page.getByTestId(L.rowText).allInnerTexts()).map((t) => t.trim());
}

async function openList(page: Page, url: string, kind: "todo" | "shopping") {
	await page.goto(url);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.listsTab)).toBeVisible();
	await page.getByTestId(kind === "todo" ? L.kindTodo : L.kindShopping).click();
	await page.waitForTimeout(800);
}

test("ROLL-01/02 shopping rollups by scope", async ({ page }) => {
	await openList(page, "/t/asia-2027/japan/tokyo?tab=lists", "shopping");
	const tokyo = await rowsText(page);
	console.log("TOKYO", tokyo.length, JSON.stringify(tokyo));
	console.log("TOKYO kind chip", await page.getByTestId(L.kindShopping).innerText());
	await shot(page, "11-roll-tokyo-shopping");
	await openList(page, "/t/asia-2027/japan/tokyo/asakusa?tab=lists", "shopping");
	const asakusa = await rowsText(page);
	console.log("ASAKUSA", asakusa.length, JSON.stringify(asakusa));
	await shot(page, "11-roll-asakusa-shopping");
	await openList(page, "/t/asia-2027/japan/tokyo/shinjuku?tab=lists", "shopping");
	const shinjuku = await rowsText(page);
	console.log("SHINJUKU", shinjuku.length, JSON.stringify(shinjuku));
	await openList(page, "/t/asia-2027/japan?tab=lists", "shopping");
	const japan = await rowsText(page);
	console.log("JAPAN", japan.length, JSON.stringify(japan));
	await openList(page, "/t/asia-2027?tab=lists", "shopping");
	const root = await rowsText(page);
	console.log("ROOT", root.length, JSON.stringify(root));
	// ROLL-06: For: Audrey
	await page.getByTestId(L.who).click();
	await page.waitForTimeout(300);
	await shot(page, "11-roll-who-open");
	const opts = await page.getByRole("option").allInnerTexts();
	console.log("WHO OPTIONS", JSON.stringify(opts));
	await page.getByRole("option", { name: /Audrey/ }).first().click();
	const audrey = await rowsText(page);
	console.log("FOR AUDREY", audrey.length, JSON.stringify(audrey));
	console.log("URL", page.url());
	await shot(page, "11-roll-root-for-audrey");
});

test("ROLL-03 todo rollup at Mt. Fuji, Shinjuku, root", async ({ page }) => {
	await openList(page, "/t/asia-2027/japan/mt-fuji?tab=lists", "todo");
	const fuji = await rowsText(page);
	console.log("FUJI", fuji.length, JSON.stringify(fuji));
	const fujiSrc = await page.getByTestId(L.row).allInnerTexts();
	console.log("FUJI ROWS", JSON.stringify(fujiSrc));
	await shot(page, "11-roll-fuji-todo");
	await openList(page, "/t/asia-2027/japan/tokyo/shinjuku?tab=lists", "todo");
	const shin = await page.getByTestId(L.row).allInnerTexts();
	console.log("SHINJUKU ROWS", JSON.stringify(shin));
	await shot(page, "11-roll-shinjuku-todo");
	await openList(page, "/t/asia-2027?tab=lists", "todo");
	const root = await rowsText(page);
	const dup = root.filter((t, i) => root.indexOf(t) !== i);
	console.log("ROOT TODOS", root.length, "dups", JSON.stringify(dup));
});
