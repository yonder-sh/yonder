/** I2 verifier "home": production-mode limits on the built app (non-member trip opens per IP). */
import { expect, test } from "@playwright/test";
import { openLink, setTestLink, settled } from "./_helpers/link";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
});

test.beforeEach(({}, info) => {
	test.skip(process.env.QA_PROD_LIMITS !== "1", "needs the built app with NODE_ENV=production (QA_PROD_LIMITS=1)");
});


test("LINK-09b: guessing trip addresses is rate-limited (the same 'no access' page)", async ({ browser, request }) => {
	// The real address works while its link is on…
	await setTestLink(request, "asia-2027", "viewer");
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	const seen: string[] = [];
	// …until one IP has opened 30 trips it isn't a member of in a minute.
	for (let i = 0; i < 31; i++) {
		await page.goto("about:blank");
		await page.goto(`/t/asia-2027-guess${i}`);
		await settled(page);
		seen.push(`${i}:${(await page.getByTestId("trip-no-access").count()) ? "no access" : "?"}`);
	}
	console.log("LINK-09b:", seen.join(" | "));
	expect(seen.every((s) => s.endsWith("no access"))).toBe(true);
	// A real link right after, from the same IP: the same page, nothing revealed.
	const p2 = await (await browser.newContext()).newPage();
	await p2.goto("/t/asia-2027");
	await settled(p2);
	await expect(p2.getByTestId("trip-no-access")).toBeVisible();
	await page.screenshot({ path: `${process.env.QA_SHOTS}/link-09b-limited.png` });
	await ctx.close();
});

test("R2 HOME-13: a group of 8 on one IP opens the real view link within a minute", async ({ browser }) => {
	const results: string[] = [];
	for (let i = 0; i < 8; i++) {
		const ctx = await browser.newContext();
		const p = await ctx.newPage();
		await openLink(p, "asia-2027", "viewer");
		const ok = await p.getByTestId("workspace").waitFor({ state: "visible", timeout: 30_000 }).then(() => "ok").catch(async () => `FAIL:${(await p.locator("body").innerText()).slice(0, 80).replace(/\n/g, " ")}`);
		results.push(`${i}:${ok}`);
		if (i === 7) await p.screenshot({ path: `${process.env.QA_SHOTS}/link-r2-group-8th.png` });
		await ctx.close();
	}
	console.log("R2 HOME-13 group:", results.join(" | "));
	expect(results.filter((r) => r.endsWith(":ok")).length).toBe(8);
});
