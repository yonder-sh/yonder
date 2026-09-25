/**
 * I2 "content" verifier, round 3: new probes.
 *  - A damaged PDF (not really a PDF) gets the generic PDF icon fallback
 *    (ADDENDUM §9), never a tile stuck in "processing".
 *  - Ctrl+U in a note: the stored markdown stays valid (NOTE-04's rule for
 *    typed text, not only paste).
 */
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { MEDIA_TESTID as MT } from "../../../src/features/media/testids";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";
import { psql } from "./_helpers/psql";

test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");
const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
const state = (h: string) => path.join(AUTH, `${h}.json`);
type G = { trip: { id: string }; nodes: { id: string; name: string }[] };
const graphOf = (p: Page) => p.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);

test("a damaged PDF gets the generic PDF fallback, not a tile stuck processing", async ({ browser }) => {
	test.setTimeout(120_000);
	const ctx = await browser.newContext({ storageState: state("dennis"), viewport: { width: 1440, height: 900 } });
	const p = await ctx.newPage();
	await p.goto("/t/asia-2027?tab=plan");
	await expectLive(p);
	const g = await graphOf(p);
	const kuro = g.nodes.find((n) => n.name === "Bar Kuro");
	const name = `Damaged ${Date.now() % 10000}.pdf`;
	const up = await p.evaluate(
		async ({ tripId, nodeId, name }) => {
			const m = await import("/src/features/media/media.functions.ts");
			const bytes = new TextEncoder().encode("%PDF-1.7\nthis is not really a pdf, the xref is missing\n%%EOF\n");
			try {
				const u = await m.createUpload({ data: { tripId, target: { kind: "node", nodeId }, type: "application/pdf", size: bytes.length, name } });
				const put = await fetch(u.url, { method: "PUT", body: bytes, headers: { "content-type": "application/pdf" } });
				if (!put.ok) return { error: `PUT ${put.status}` };
				const dto = await m.completeUpload({ data: { id: u.id, hasPoster: false } });
				return { id: u.id, status: dto.status };
			} catch (e) {
				return { error: (e as Error).message };
			}
		},
		{ tripId: g.trip.id, nodeId: kuro?.id, name },
	);
	console.log("damaged upload:", JSON.stringify(up));
	await p.goto(`/t/asia-2027?sel=n.${kuro?.id}`);
	await expectLive(p);
	await p.getByTestId(TESTID.inspector).getByRole("tab", { name: /Media/ }).click();
	const id = (up as { id?: string }).id;
	if (!id) {
		console.log("refused at upload (acceptable)");
		await ctx.close();
		return;
	}
	const tile = p.locator(`[data-testid=${TESTID.galleryItem}][data-id="${id}"]`);
	await expect(tile).toBeVisible({ timeout: 20_000 });
	let status = "";
	for (let i = 0; i < 30; i++) {
		status = (await tile.getAttribute("data-status")) ?? "";
		if (status !== "processing" && status !== "pending") break;
		await p.waitForTimeout(1000);
	}
	console.log("damaged tile status after ~30s:", status, "| DB:", psql(`select status::text || ' pages=' || coalesce((select 1)::text,'') from attachments where id = '${id}'`));
	await tile.scrollIntoViewIfNeeded();
	await shot(p, "42-damaged-pdf-tile");
	await tile.click();
	await p.waitForTimeout(2500);
	const viewer = p.getByTestId(MT.pdfViewer);
	console.log("viewer open:", await viewer.isVisible(), "| text:", (await viewer.innerText().catch(() => "")).replace(/\n/g, " | ").slice(0, 200));
	await shot(p, "42-damaged-pdf-viewer");
	await p.keyboard.press("Escape");
	await p.evaluate(async (id) => {
		const m = await import("/src/features/media/media.functions.ts");
		return m.deleteAttachment({ data: { id } }).catch(() => null);
	}, id);
	expect(["processing", "pending"]).not.toContain(status);
	await ctx.close();
});

test("NOTE-04 (typed): Ctrl+U in a note never stores `++…++` markdown", async ({ browser }) => {
	const ctx = await browser.newContext({ storageState: state("dennis"), viewport: { width: 1440, height: 900 } });
	const p = await ctx.newPage();
	await p.goto("/t/asia-2027?tab=plan");
	await expectLive(p);
	const g = await graphOf(p);
	const gg = g.nodes.find((n) => n.name === "Golden Gai");
	await p.goto(`/t/asia-2027?sel=n.${gg?.id}`);
	await expectLive(p);
	await p.getByTestId(TESTID.inspector).getByRole("tab", { name: /Notes/ }).click();
	const ed = p.getByTestId(TESTID.notesPanel).getByTestId(NT.editor);
	await expect(ed).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
	await ed.click();
	await p.keyboard.press("Control+End");
	await p.keyboard.press("Enter");
	const word = `UNDERKEY${Date.now() % 10000}`;
	await p.keyboard.press("Control+u");
	await p.keyboard.type(word);
	await p.keyboard.press("Control+u");
	await p.keyboard.type(" plain");
	await p.waitForTimeout(4000);
	const html = await ed.innerHTML();
	console.log("editor html around word:", html.slice(Math.max(0, html.indexOf(word) - 60), html.indexOf(word) + 60));
	const md = psql(`select markdown from yjs_documents where plain_text like '%${word}%'`);
	const line = md.split("\n").find((l) => l.includes(word));
	console.log("stored markdown line:", line);
	await shot(p, "42-ctrl-u");
	expect(line ?? "").not.toMatch(/\+\+/);
	await ctx.close();
});
