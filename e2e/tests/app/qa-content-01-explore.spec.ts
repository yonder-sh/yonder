/**
 * I2 "content" verifier: exploration of the imported Asia 2027 trip (lists,
 * rollups) as Dennis. Screenshots → QA_SHOTS.
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

test("explore lists at root/tokyo/asakusa", async ({ page }) => {
	await page.goto(`/t/asia-2027?tab=lists`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.listsTab)).toBeVisible();
	await page.waitForTimeout(1500);
	await shot(page, "01-root-lists-todo");
	const info = await page.evaluate(() => {
		const y = (window as unknown as { __yonder?: { graph: { nodes: { id: string; name: string; slug?: string; parentId: string | null; type: string }[] } } }).__yonder;
		return y?.graph.nodes.filter((n) => /Tokyo|Asakusa|Shinjuku|Kappabashi|Japan|Mt\. Fuji|Golden Gai|Bar Benfiddich|Chureito|Hiroshima|Kawaguchiko/.test(n.name)).map((n) => `${n.name} ${n.type} ${n.id} ${n.slug ?? ""}`);
	});
	console.log(info?.join("\n"));
	const rows = await page.getByTestId(L.row).count();
	console.log("root todo rows", rows);
	await page.getByTestId(L.kindShopping).click();
	await page.waitForTimeout(800);
	console.log("root shopping rows", await page.getByTestId(L.row).count());
	await shot(page, "01-root-lists-shopping");
});
