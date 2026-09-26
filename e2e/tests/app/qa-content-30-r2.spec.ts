/**
 * I2 "content" verifier, round 2: re-checks of earlier reports that touch
 * content (PDF viewer on a place's details — the old Rate card's, now the
 * Places tab's drawer —, "still to book" opening a filtered view, zone labels
 * on deadline chips, the Rate comment @mention popup in the Rate feed).
 */
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { makePdf } from "../../../src/features/media/__tests__/make-pdf";
import { MEDIA_TESTID as MT } from "../../../src/features/media/testids";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { PLACES_TAB_TESTID as PT } from "../../../src/features/places/tab/testids";
import { SHELL_TESTID as S } from "../../../src/features/shell/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";

test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
const state = (h: string) => path.join(AUTH, `${h}.json`);
type G = { trip: { id: string }; nodes: { id: string; name: string }[] };
const graphOf = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
async function ctxFor(browser: Browser, h: string | null) {
	const ctx = await browser.newContext({ ...(h ? { storageState: state(h) } : {}), viewport: { width: 1440, height: 900 } });
	return { ctx, page: await ctx.newPage() };
}
async function uploadPdf(page: Page, target: Record<string, string>, name: string) {
	const pdf = makePdf([name, "page 2"], { title: name }).toString("base64");
	return page.evaluate(
		async ({ target, name, b64 }) => {
			const m = await import("/src/features/media/media.functions.ts");
			const y = (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder;
			const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			const up = await m.createUpload({ data: { tripId: y.graph.trip.id, target, type: "application/pdf", size: bytes.length, name } });
			const put = await fetch(up.url, { method: "PUT", body: bytes, headers: { "content-type": "application/pdf" } });
			if (!put.ok) return { error: `PUT ${put.status}` };
			const dto = await m.completeUpload({ data: { id: up.id, hasPoster: false } });
			return { id: up.id, visibility: dto.visibility };
		},
		{ target, name, b64: pdf },
	);
}

test("Places panel: a PDF in its Media tab opens the in-app viewer, not a new tab", async ({ browser }) => {
	test.setTimeout(180_000);
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	const g = await graphOf(d.page);
	const sky = g.nodes.find((n) => n.name === "Shibuya Sky");
	if (!sky) throw new Error("no Shibuya Sky");
	const up = await uploadPdf(d.page, { kind: "node", nodeId: sky.id }, "Shibuya Sky tickets.pdf");
	console.log("upload", JSON.stringify(up));
	// The place's panel, the same on every tab: its PDFs are in the Media tab.
	await d.page.goto(`/t/asia-2027?tab=places&sel=n.${sky.id}&itab=media`);
	const card = d.page.getByTestId(PT.drawer);
	await expect(card).toHaveAttribute("data-place", sky.id, { timeout: 30_000 });
	const pdf = card.locator(`[data-testid=${TESTID.galleryItem}][data-kind=pdf]`).filter({ hasText: "Shibuya Sky tickets" }).getByRole("button").first();
	await expect(pdf).toBeVisible({ timeout: 30_000 });
	await shot(d.page, "30-rate-card-pdf");
	const popup = d.ctx.waitForEvent("page", { timeout: 3_000 }).catch(() => null);
	await pdf.click();
	const viewer = d.page.getByTestId(MT.pdfViewer);
	const opened = await popup;
	console.log("new tab opened:", !!opened, opened?.url());
	await expect(viewer).toBeVisible();
	await expect(viewer.getByTestId(MT.pdfPage).first()).toBeVisible({ timeout: 20_000 });
	await d.page.waitForTimeout(800);
	await shot(d.page, "30-rate-card-pdf-viewer");
	expect(opened).toBeNull();
	await d.ctx.close();
});

test("Trip overview: 'still to book' rows open a filtered view; deadline chips carry zones", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?sel=root");
	await expectLive(d.page);
	const ov = d.page.getByTestId(S.tripOverview);
	await expect(ov).toBeVisible({ timeout: 20_000 });
	const chips = await d.page.getByTestId(S.deadlineChip).allInnerTexts();
	console.log("DEADLINE CHIPS", JSON.stringify(chips));
	const book = d.page.locator(`[data-testid=${S.stillToPlanRow}][data-row=book]`);
	await expect(book).toBeVisible();
	console.log("BOOK ROW", await book.locator("button").first().innerText());
	await book.locator("button").first().click();
	const items = book.getByTestId(S.stillToPlanItem);
	await expect(items.first()).toBeVisible();
	const texts = await items.allInnerTexts();
	console.log("TO BOOK", texts.length, JSON.stringify(texts.slice(0, 6)));
	await shot(d.page, "30-still-to-book-open");
	await items.first().click();
	await d.page.waitForTimeout(1200);
	const url = new URL(d.page.url());
	console.log("after click URL", url.pathname + url.search);
	const panel = d.page.getByTestId(TESTID.listsPanel).first();
	const rows = await panel.getByTestId("list-row").allInnerTexts().catch(() => []);
	console.log("lists rows after click", rows.length, JSON.stringify(rows.slice(0, 5)));
	await shot(d.page, "30-still-to-book-filtered");
	expect(url.searchParams.get("sel")).not.toBeNull();
	await d.ctx.close();
});

test("Rate comment: the @mention popup can be clicked with a mouse", async ({ browser }) => {
	const a = await ctxFor(browser, "audrey");
	await a.page.goto("/t/asia-2027?tab=plan");
	await expectLive(a.page);
	const g = await graphOf(a.page);
	const sky = g.nodes.find((n) => n.name === "Shibuya Sky");
	// The old Rate screen's link: the Places tab's Rate feed, on Shibuya Sky.
	await a.page.goto(`/t/asia-2027/rate?n=${sky?.id}`);
	const card = a.page.locator(`[data-testid=${PT.feedCard}][data-active]`);
	await expect(card).toHaveAttribute("data-place", sky?.id as string, { timeout: 30_000 });
	await a.page.waitForTimeout(800);
	if (!(await card.getAttribute("data-rated"))) {
		console.log("Audrey had no rating on Shibuya Sky: rating it 2");
		await a.page.keyboard.press("2");
		await expect(card).toHaveAttribute("data-rated", /.+/);
	}
	// A comment goes with a rating: "Add a comment" (or the comment already there).
	await card.locator("button:has(svg.lucide-message-square)").first().click();
	const input = card.getByTestId(TESTID.mentionInput).first();
	await expect(input).toBeVisible();
	await input.click();
	await a.page.keyboard.type("ask @Kenji");
	const opt = a.page.getByTestId(NT.mentionPopup).locator(`[data-testid=${NT.mentionAdd}], [data-testid=${NT.mentionOption}]`).filter({ hasText: /Kenji/ }).first();
	await expect(opt).toBeVisible();
	await shot(a.page, "30-rate-mention-popup");
	const box = await opt.boundingBox();
	const hit = box
		? await a.page.evaluate(({ x, y }) => {
				const el = document.elementFromPoint(x, y);
				const t = el?.closest("[data-testid]");
				return el ? `${el.tagName} in ${t?.getAttribute("data-testid")} "${el.textContent?.slice(0, 40)}"` : "none";
			}, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
		: "no box";
	console.log("element at option centre:", hit);
	await a.page.mouse.click((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2);
	await a.page.waitForTimeout(500);
	console.log("comment text after click:", await input.innerText(), "| popup still open:", await a.page.getByTestId(NT.mentionPopup).isVisible());
	await shot(a.page, "30-rate-mention-picked");
	expect(hit).toMatch(/mention-(add|option)/);
	await a.ctx.close();
});
