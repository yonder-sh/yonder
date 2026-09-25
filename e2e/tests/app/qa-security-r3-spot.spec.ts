/**
 * QA security verifier (I2 round 3): quick spot checks of three round-2 bugs
 * from other areas (map dashes, still-to-book rows). Evidence only.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { expectLive } from "./_helpers/page";
import { EMAIL, memberPage } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";

test("spot checks", async ({ browser }) => {
	test.setTimeout(180_000);
	const out: Record<string, unknown> = {};
	const d = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	await d.page.goto("/t/asia-2027?sel=root");
	await expectLive(d.page);
	await d.page.waitForFunction(() => !!(window as unknown as { __tripMap?: unknown }).__tripMap, undefined, { timeout: 30_000 }).catch(() => undefined);
	await d.page.waitForTimeout(3000);
	out.dash = await d.page.evaluate(() => {
		const m = (window as unknown as { __tripMap?: { getStyle: () => { layers: { id: string; paint?: Record<string, unknown> }[] } } }).__tripMap;
		if (!m) return "no map";
		return m.getStyle().layers.filter((l) => l.id.startsWith("yonder-edges")).map((l) => `${l.id}:${JSON.stringify(l.paint?.["line-dasharray"] ?? null)}`);
	});
	const toBook = d.page.getByTestId("still-to-plan-row").filter({ hasText: /still to book/i }).first();
	if (await toBook.count()) {
		await toBook.click();
		await d.page.waitForTimeout(800);
		out.stillToBook = (await d.page.getByTestId("still-to-plan-item").allInnerTexts()).slice(0, 14);
		await d.page.screenshot({ path: path.join(DIR, "r3-spot-still-to-book.png") });
		const first = d.page.getByTestId("still-to-plan-item").first();
		await first.click();
		await d.page.waitForTimeout(2000);
		out.afterClickUrl = d.page.url().replace(/^https?:\/\/[^/]+/, "");
	}
	writeFileSync(path.join(DIR, "r3-spot.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await d.ctx.close();
});
