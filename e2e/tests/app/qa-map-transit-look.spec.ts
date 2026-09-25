/** I2 map-transit: open a URL, screenshot, dump the center panel + inspector text. */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { asUser, OUT, onlyHere, shot } from "./qa-map-transit-helpers";

onlyHere();

test("look", async ({ browser }) => {
	const w = Number(process.env.QA_W ?? 1440);
	const h = Number(process.env.QA_H ?? 900);
	const { page, errors } = await asUser(browser, process.env.QA_USER ?? "dennis@asia2027.test", { viewport: { width: w, height: h } });
	const urls = (process.env.QA_URLS ?? "/t/asia-2027").split(" ");
	let k = 0;
	for (const u of urls) {
		k++;
		const tag = `${process.env.QA_TAG ?? "look"}-${k}`;
		await page.goto(u);
		await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 45_000 });
		await page.waitForTimeout(Number(process.env.QA_WAIT ?? 3000));
		if (process.env.QA_SCROLL) {
			const el = page.getByText(process.env.QA_SCROLL, { exact: false }).first();
			await el.scrollIntoViewIfNeeded().catch(() => {});
			await page.waitForTimeout(800);
		}
		await page.screenshot({ path: shot(tag), fullPage: false });
		const txt = async (id: string) => {
			const l = page.getByTestId(id);
			return (await l.count()) ? await l.first().innerText({ timeout: 5000 }).catch(() => "") : "";
		};
		const center = await txt("center-panel");
		const insp = await txt("inspector");
		writeFileSync(path.join(OUT, `${tag}.txt`), `URL ${u}\n--- center\n${center}\n--- inspector\n${insp}\n--- errors\n${errors.join("\n")}`);
	}
});
