/** I2 verifier "home": production-mode limits on the built app (share-link redemption). */
import { expect, test } from "@playwright/test";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
});

test.beforeEach(({}, info) => {
	test.skip(process.env.QA_PROD_LIMITS !== "1", "needs the built app with NODE_ENV=production (QA_PROD_LIMITS=1)");
});


test("LINK-09b: guessing tokens is rate-limited ('Too many tries')", async ({ browser }) => {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const seen: string[] = [];
	for (let i = 0; i < 14; i++) {
		await page.goto("about:blank");
		await page.goto(`/join#t=guess${i}${"x".repeat(43 - `guess${i}`.length)}`);
		const h = page.locator("h1, h2").first();
		await expect(h).not.toHaveText(/Opening the trip/, { timeout: 15_000 });
		seen.push(`${i}:${(await h.innerText()).trim()}`);
	}
	console.log("LINK-09b:", seen.join(" | "));
	expect(seen.join(" ")).toMatch(/Too many tries/);
	await page.screenshot({ path: `${process.env.QA_SHOTS}/link-09b-too-many.png` });
	// a real link right after, from the same IP
	const p2 = await (await browser.newContext()).newPage();
	await p2.goto("/join#t=qa-share-token-viewer-asia-2027");
	await p2.waitForTimeout(4000);
	console.log("LINK-09b real link after limit:", p2.url(), (await p2.locator("body").innerText()).slice(0, 120).replace(/\n/g, " | "));
	await ctx.close();
});

test("R2 HOME-13: a group of 8 on one IP opens the real view link within a minute", async ({ browser }) => {
	const results: string[] = [];
	for (let i = 0; i < 8; i++) {
		const ctx = await browser.newContext();
		const p = await ctx.newPage();
		await p.goto("/join#t=qa-share-token-viewer-asia-2027");
		const ok = await p.getByTestId("workspace").waitFor({ state: "visible", timeout: 30_000 }).then(() => "ok").catch(async () => `FAIL:${(await p.locator("body").innerText()).slice(0, 80).replace(/\n/g, " ")}`);
		results.push(`${i}:${ok}`);
		if (i === 7) await p.screenshot({ path: `${process.env.QA_SHOTS}/link-r2-group-8th.png` });
		await ctx.close();
	}
	console.log("R2 HOME-13 group:", results.join(" | "));
	expect(results.filter((r) => r.endsWith(":ok")).length).toBe(8);
});
