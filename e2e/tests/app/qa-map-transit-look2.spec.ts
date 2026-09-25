/** I2 map-transit round 2: screenshot helper (QA_URL, QA_TAG). */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { asUser, OUT, onlyHere, shot } from "./qa-map-transit-helpers";

onlyHere();

test("look2", async ({ browser }) => {
	const { page, errors } = await asUser(browser, process.env.QA_USER ?? "dennis@asia2027.test");
	await page.goto(process.env.QA_URL ?? "/t/asia-2027");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 45_000 });
	await page.waitForTimeout(Number(process.env.QA_WAIT ?? 3500));
	const tag = process.env.QA_TAG ?? "look2";
	await page.screenshot({ path: shot(tag) });
	writeFileSync(path.join(OUT, `${tag}.txt`), `${await page.getByTestId("center-panel").innerText().catch(() => "")}\n---inspector---\n${await page.getByTestId("inspector").innerText().catch(() => "")}\n---errors---\n${JSON.stringify(errors)}`);
});
