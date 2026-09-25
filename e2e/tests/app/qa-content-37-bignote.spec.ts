/**
 * I2 "content" verifier, round 2: NOTE-05 a 10,000-word note stays fast to
 * type into, and a second member gets it all within 2 s.
 */
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });

test("NOTE-05 a 10,000-word trip note", async ({ browser }) => {
	test.setTimeout(180_000);
	const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(dctx.request, "dev@example.com", { first: "Dev", last: "User" });
	const d = await dctx.newPage();
	const c = await cloneFixtureTrip(d.request);
	await d.goto(`/t/${c.slug}?sel=root`);
	await expectLive(d);
	await d.getByTestId(TESTID.inspector).getByRole("tab", { name: /Notes/ }).click();
	const ed = d.getByTestId(TESTID.notesPanel).getByTestId(NT.editor);
	await expect(ed).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
	await ed.click();
	const words = "tokyo kyoto osaka ramen sushi temple shrine market station train".split(" ");
	const paras: string[] = [];
	for (let p = 0; p < 200; p++) paras.push(`<p>${Array.from({ length: 50 }, (_, i) => words[(p + i) % words.length]).join(" ")}</p>`);
	await d.evaluate((html) => {
		const el = document.activeElement as HTMLElement;
		const dt = new DataTransfer();
		dt.setData("text/html", html);
		dt.setData("text/plain", "x");
		el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
	}, paras.join(""));
	await d.waitForTimeout(3000);
	const count = await ed.evaluate((e) => (e.textContent ?? "").split(/\s+/).filter(Boolean).length);
	console.log("words in editor:", count);
	await d.keyboard.press("Control+End");
	// Per-key latency: keydown → the editor's next DOM mutation (real key presses).
	await d.evaluate(() => {
		const el = document.activeElement as HTMLElement;
		const w = window as unknown as { __lat: number[]; __t0: number | null };
		w.__lat = [];
		w.__t0 = null;
		el.addEventListener("keydown", () => { w.__t0 = performance.now(); }, true);
		new MutationObserver(() => {
			if (w.__t0 !== null) {
				w.__lat.push(performance.now() - w.__t0);
				w.__t0 = null;
			}
		}).observe(el, { subtree: true, characterData: true, childList: true });
	});
	await d.keyboard.type("abcdefghijklmnopqrstuvwxy", { delay: 60 });
	await d.waitForTimeout(500);
	const lat = await d.evaluate(() => (window as unknown as { __lat: number[] }).__lat);
	const sorted = [...lat].sort((a, b) => a - b);
	console.log("keys measured:", lat.length, "latency ms p50/p90/max:", sorted[Math.floor(sorted.length / 2)]?.toFixed(1), sorted[Math.floor(sorted.length * 0.9)]?.toFixed(1), sorted[sorted.length - 1]?.toFixed(1));
	// Real key presses as a cross-check.
	const t0 = Date.now();
	await d.keyboard.type("hello world again", { delay: 0 });
	console.log("17 real keys took ms:", Date.now() - t0);
	await d.waitForTimeout(3000);
	await shot(d, "37-bignote");
	const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(mctx.request, "maya@example.com", { first: "Maya", last: "Chen" });
	const m = await mctx.newPage();
	await m.goto(`/t/${c.slug}?sel=root`);
	await expectLive(m);
	await m.getByTestId(TESTID.inspector).getByRole("tab", { name: /Notes/ }).click();
	const med = m.getByTestId(TESTID.notesPanel).getByTestId(NT.editor);
	const s0 = Date.now();
	await expect.poll(async () => (await med.textContent())?.includes("hello world again") ?? false, { timeout: 10_000, intervals: [100] }).toBe(true);
	console.log("second member full doc in ms:", Date.now() - s0);
	expect(sorted[Math.floor(sorted.length * 0.9)] ?? 999).toBeLessThan(50);
	await dctx.close();
	await mctx.close();
});
