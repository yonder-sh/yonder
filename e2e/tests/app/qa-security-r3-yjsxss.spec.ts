/**
 * QA security verifier (I2 round 3): SEC-04 for note content written straight
 * into Yjs by an editor (link marks with javascript:/data:/vbscript: hrefs,
 * a mention with hostile attrs, an unknown `image` node, raw HTML text) —
 * see scratchpad qa-security-yjs-marks.mts, stamp in QA_SEC_STAMP. Dennis
 * and a guest viewer open Golden Gai's notes; nothing may run and no hostile
 * href may reach the DOM, even after clicking every injected link.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { expectLive } from "./_helpers/page";
import { EMAIL, guestPage, IDS, memberPage, TOKEN } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR || !process.env.QA_SEC_STAMP, "QA security verifier probes: set QA_SEC_DIR and QA_SEC_STAMP");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const STAMP = process.env.QA_SEC_STAMP ?? "";

async function scan(page: Page) {
	return page.evaluate((stamp) => {
		const bad = /^\s*(javascript|data|vbscript|file):/i;
		const anchors = [...document.querySelectorAll("a")].filter((a) => a.textContent?.includes(stamp) || bad.test((a.getAttribute("href") ?? "").replace(/[\t\n\r]/g, "")));
		const onAttrs = [...document.querySelectorAll("*")].filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).map((el) => el.outerHTML.slice(0, 120));
		return {
			xss: (window as unknown as { __xss?: number }).__xss ?? 0,
			anchors: anchors.map((a) => `${a.textContent?.slice(0, 20)} -> ${a.getAttribute("href")}`),
			badHrefs: anchors.filter((a) => bad.test((a.getAttribute("href") ?? "").replace(/[\t\n\r]/g, ""))).length,
			onAttrs: onAttrs.slice(0, 5),
			mentionText: [...document.querySelectorAll("[data-mention]")].map((m) => `${m.getAttribute("data-mention")}|${m.textContent}`).filter((t) => t.includes(stamp) || t.includes("onmouseover")),
			imgs: [...document.querySelectorAll("img")].filter((i) => /^\s*javascript/i.test(i.getAttribute("src") ?? "")).length,
			htmlText: document.body.innerText.includes(`YJSHTML-${stamp}`),
		};
	}, STAMP);
}

async function clickLinks(page: Page, where: string, out: Record<string, unknown>) {
	const popups: string[] = [];
	page.context().on("page", (p) => popups.push(p.url()));
	const dialogs: string[] = [];
	page.on("dialog", async (d) => {
		dialogs.push(d.message());
		await d.dismiss();
	});
	const links = page.locator(`a:has-text("YJSLINK")`);
	const n = await links.count();
	for (let i = 0; i < n; i++) {
		await links.nth(i).click({ modifiers: [], timeout: 3000 }).catch(() => undefined);
		await page.waitForTimeout(400);
		// Ctrl/Cmd-click too (TipTap opens links on modified clicks while editing).
		await links.nth(i).click({ modifiers: ["ControlOrMeta"], timeout: 3000 }).catch(() => undefined);
		await page.waitForTimeout(400);
	}
	out[`${where}:clicked`] = n;
	out[`${where}:popups`] = popups;
	out[`${where}:dialogs`] = dialogs;
	out[`${where}:xssAfterClicks`] = await page.evaluate(() => (window as unknown as { __xss?: number }).__xss ?? 0);
	out[`${where}:url`] = page.url();
}

test("hostile Yjs marks in a shared note never run", async ({ browser }) => {
	test.setTimeout(240_000);
	const out: Record<string, unknown> = {};
	const url = "/t/asia-2027/japan/tokyo/shinjuku/golden-gai?tab=notes";
	const d = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	await d.page.goto(url);
	await expectLive(d.page);
	await d.page.waitForTimeout(3000);
	out.dennisNotes = await scan(d.page);
	await d.page.screenshot({ path: path.join(DIR, "r3-yjsxss-dennis.png"), fullPage: false });
	await clickLinks(d.page, "dennisNotes", out);
	// The inspector's note preview for the node.
	await d.page.goto(`/t/asia-2027?sel=n.${IDS.GG}`);
	await expectLive(d.page);
	await d.page.waitForTimeout(2500);
	out.dennisOverview = await scan(d.page);
	await clickLinks(d.page, "dennisOverview", out);
	const g = await guestPage(browser, TOKEN.viewer);
	await g.page.goto(url);
	await expectLive(g.page);
	await g.page.waitForTimeout(3000);
	out.guestNotes = await scan(g.page);
	await g.page.screenshot({ path: path.join(DIR, "r3-yjsxss-guest.png"), fullPage: false });
	await clickLinks(g.page, "guestNotes", out);
	writeFileSync(path.join(DIR, "r3-yjsxss.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await d.ctx.close();
	await g.ctx.close();
	for (const k of ["dennisNotes", "dennisOverview", "guestNotes"]) {
		expect((out[k] as { xss: number }).xss, k).toBe(0);
		expect((out[k] as { badHrefs: number }).badHrefs, k).toBe(0);
		expect(out[`${k}:xssAfterClicks`], k).toBe(0);
	}
});
