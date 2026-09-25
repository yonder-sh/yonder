/**
 * I2 "content" verifier, round 2: MED-06 refusals through the real UI, a
 * guest editor's own e-ticket on the flight, and a view-link guest opening a
 * general PDF (viewer, no lock control).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { makePdf } from "../../../src/features/media/__tests__/make-pdf";
import { MEDIA_TESTID as MT } from "../../../src/features/media/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";
import { ensureQaPdfs } from "./_helpers/qa-pdfs";
import { openLink } from "./_helpers/link";

test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
const state = (h: string) => path.join(AUTH, `${h}.json`);
type G = { trip: { id: string }; nodes: { id: string; name: string }[]; legs: { id: string; mode: string | null; fromItemId: string | null; toItemId: string | null }[]; items: { id: string; dayId: string | null }[]; days: { id: string; date: string }[] };
const graphOf = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
async function ctxFor(browser: Browser, h: string | null) {
	const ctx = await browser.newContext({ ...(h ? { storageState: state(h) } : {}), viewport: { width: 1440, height: 900 } });
	return { ctx, page: await ctx.newPage() };
}
async function guest(browser: Browser, role: "viewer" | "editor") {
	const c = await ctxFor(browser, null);
	await openLink(c.page, "asia-2027", role);
	await expect(c.page).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
	return c;
}
const toasts = (p: Page) => p.locator("[data-sonner-toast]").allInnerTexts();

// The general PDF the guest opens (qa-content-17 uploads the same ones).
test.beforeAll(async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	await ensureQaPdfs(d.page);
	await d.ctx.close();
});

test("MED-06 through the UI: .exe, HEIC, oversized PDF and bad links get specific messages", async ({ browser }, info) => {
	const a = await ctxFor(browser, "audrey");
	await a.page.goto("/t/asia-2027?tab=plan");
	await expectLive(a.page);
	const g = await graphOf(a.page);
	const gg = g.nodes.find((n) => n.name === "Golden Gai");
	await a.page.goto(`/t/asia-2027?sel=n.${gg?.id}`);
	await expectLive(a.page);
	await a.page.getByTestId(TESTID.inspector).getByRole("tab", { name: /Media/ }).click();
	const input = a.page.getByTestId(TESTID.inspector).getByTestId(MT.fileInput).first();
	const puts: string[] = [];
	a.page.on("request", (r) => {
		if (r.method() === "PUT") puts.push(r.url());
	});
	const before = await a.page.evaluate(async (tripId) => {
		const m = await import("/src/features/media/media.functions.ts");
		return (await m.listTripMedia({ data: { tripId } })).length;
	}, g.trip.id);
	await input.setInputFiles({ name: "malware.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ fake") });
	await a.page.waitForTimeout(1200);
	console.log("exe toasts:", JSON.stringify(await toasts(a.page)));
	await shot(a.page, "32-med06-exe");
	await input.setInputFiles({ name: "pagoda-portrait.heic", mimeType: "image/heic", buffer: Buffer.alloc(2048, 1) });
	await a.page.waitForTimeout(1500);
	console.log("heic toasts:", JSON.stringify(await toasts(a.page)));
	// PDFs go up to 50 MB now (PDF_MAX_BYTES, raised from 20 MB with chunked uploads). Over
	// 50 MB Playwright wants a path, not a buffer.
	const huge = info.outputPath("huge.pdf");
	writeFileSync(huge, Buffer.alloc(51 * 1024 * 1024, 32));
	await input.setInputFiles(huge);
	await a.page.waitForTimeout(1500);
	console.log("51MB pdf toasts:", JSON.stringify(await toasts(a.page)));
	await shot(a.page, "32-med06-files");
	// Links through the Add ▸ Link form.
	for (const bad of ["javascript:alert(1)", "not a url"]) {
		await a.page.getByTestId(TESTID.inspector).getByTestId(MT.addButton).first().click();
		const addLink = a.page.getByTestId(MT.addLink).first();
		if (await addLink.isVisible().catch(() => false)) await addLink.click();
		const li = a.page.getByTestId(MT.linkInput).first();
		await expect(li).toBeVisible();
		await li.fill(bad);
		const submit = a.page.getByTestId(MT.linkSubmit).first();
		const enabled = await submit.isEnabled();
		if (enabled) await submit.click();
		else await li.press("Enter");
		await a.page.waitForTimeout(800);
		const form = await li.locator("xpath=ancestor::*[self::form or @role='dialog'][1]").innerText().catch(() => "");
		console.log(`link "${bad}": submit enabled=${enabled}; form text: ${form.replace(/\n/g, " | ").slice(0, 200)}; toasts: ${JSON.stringify(await toasts(a.page))}`);
		await shot(a.page, `32-med06-link-${bad.replace(/[^a-z]/g, "")}`);
		await a.page.keyboard.press("Escape");
		await a.page.waitForTimeout(300);
	}
	const after = await a.page.evaluate(async (tripId) => {
		const m = await import("/src/features/media/media.functions.ts");
		return (await m.listTripMedia({ data: { tripId } })).length;
	}, g.trip.id);
	console.log("media rows before/after:", before, after, "PUTs:", puts.length);
	expect(after).toBe(before);
	expect(puts.length).toBe(0);
	await a.ctx.close();
});

test("A guest editor's e-ticket on the flight: what do they see after uploading?", async ({ browser }) => {
	const ge = await guest(browser, "editor");
	await expectLive(ge.page);
	const g = await graphOf(ge.page);
	const flight = g.legs.find((l) => l.mode === "flight");
	const from = g.items.find((i) => i.id === flight?.fromItemId);
	const day = g.days.find((d) => d.id === from?.dayId);
	await ge.page.goto(`/t/asia-2027?days=${day?.date}&sel=l.${flight?.fromItemId}.${flight?.toItemId}`);
	await expectLive(ge.page);
	await ge.page.waitForTimeout(1000);
	const tabs = await ge.page.getByTestId(TESTID.inspector).getByRole("tab").allInnerTexts();
	console.log("guest flight inspector tabs:", JSON.stringify(tabs));
	const media = ge.page.getByTestId(TESTID.inspector).getByRole("tab", { name: /Media/ });
	if (await media.count()) await media.first().click();
	const input = ge.page.getByTestId(TESTID.inspector).getByTestId(MT.fileInput).first();
	if (!(await input.count())) {
		console.log("no file input for the guest editor on the flight");
		await shot(ge.page, "32-guest-flight-no-input");
		await ge.ctx.close();
		return;
	}
	await input.setInputFiles({ name: "Guest boarding pass.pdf", mimeType: "application/pdf", buffer: makePdf(["Boarding pass"], { title: "Guest boarding pass" }) });
	await ge.page.waitForTimeout(4000);
	console.log("guest toasts:", JSON.stringify(await toasts(ge.page)));
	const tiles = await ge.page.getByTestId(TESTID.inspector).getByTestId(TESTID.galleryItem).evaluateAll((els) => els.map((e) => `${e.getAttribute("data-kind")}:${e.textContent?.slice(0, 40)}`));
	console.log("guest sees tiles on the flight:", JSON.stringify(tiles));
	await shot(ge.page, "32-guest-flight-after-upload");
	await ge.ctx.close();
});

test("A view-link guest opens a general PDF in the viewer with no lock control", async ({ browser }) => {
	const gv = await guest(browser, "viewer");
	await gv.page.goto("/t/asia-2027/japan/tokyo?tab=media&mf=documents");
	await expectLive(gv.page);
	const tile = gv.page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=pdf]`).first();
	await expect(tile).toBeVisible({ timeout: 15_000 });
	await tile.getByRole("button").first().click();
	const v = gv.page.getByTestId(MT.pdfViewer);
	await expect(v).toBeVisible();
	await expect(v.getByTestId(MT.pdfPage).first()).toBeVisible({ timeout: 15_000 });
	await gv.page.waitForTimeout(800);
	console.log("guest viewer lock controls:", await v.getByTestId(MT.visibility).count(), "download:", await v.getByTestId(MT.pdfDownload).count());
	await shot(gv.page, "32-guest-pdf-viewer");
	expect(await v.getByTestId(MT.visibility).count()).toBe(0);
	await gv.ctx.close();
});
