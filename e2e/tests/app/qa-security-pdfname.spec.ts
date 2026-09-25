/** SEC-04 for PDF names, SEC-05 for the PDF download: a hostile file name. */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { call, EMAIL, GG, MOD, memberPage, T } from "./qa-security-helpers";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
const NAME = `"><img src=x onerror="window.__xss=1;alert('pdf')">\r\nX-Evil: 1.pdf`;

test("a hostile PDF name", async ({ browser }) => {
	test.setTimeout(240_000);
	const out: Record<string, unknown> = {};
	const audrey = await memberPage(browser, EMAIL.audrey);
	const up = await call(audrey.page, MOD.media, "createUpload", { tripId: T, target: { kind: "node", nodeId: GG }, type: "application/pdf", size: Buffer.byteLength(PDF), name: NAME });
	expect(up.ok, JSON.stringify(up)).toBe(true);
	const { id, url } = up.r as { id: string; url: string };
	expect((await audrey.page.request.put(url, { data: Buffer.from(PDF), headers: { "Content-Type": "application/pdf" } })).status()).toBe(200);
	const done = await call(audrey.page, MOD.media, "completeUpload", { id, hasPoster: false });
	out.complete = done.ok ? (done.r as { title?: string }).title : done.err;
	const dl = await audrey.page.request.get(`/media/${id}/original`, { maxRedirects: 0 });
	const loc = new URL(dl.headers().location ?? "http://x/");
	out.download = {
		status: dl.status(),
		contentType: loc.searchParams.get("response-content-type"),
		disposition: loc.searchParams.get("response-content-disposition"),
	};
	await audrey.ctx.close();
	const dennis = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	const dialogs: string[] = [];
	dennis.page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
	await dennis.page.goto("/t/asia-2027/japan/tokyo/shinjuku/golden-gai?tab=media");
	await dennis.page.waitForTimeout(4000);
	const tile = dennis.page.locator(`[data-id="${id}"], [data-media-id="${id}"]`).first();
	if (await tile.count()) await tile.click().catch(() => undefined);
	else await dennis.page.getByText(/img src=x/).first().click().catch(() => undefined);
	await dennis.page.waitForTimeout(2500);
	out.state = await dennis.page.evaluate(() => ({ xss: (window as unknown as { __xss?: number }).__xss ?? 0, live: document.querySelectorAll("img[onerror]").length }));
	out.dialogs = dialogs;
	await dennis.page.screenshot({ path: path.join(DIR, "pdfname.png") });
	writeFileSync(path.join(DIR, "pdfname.json"), JSON.stringify(out, null, 1));
	await dennis.ctx.close();
});
