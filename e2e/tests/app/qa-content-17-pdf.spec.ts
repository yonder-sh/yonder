/**
 * I2 "content" verifier: PDFs (ADDENDUM §9): viewer, thumbnails, the
 * Documents filter, "Hide from guests" defaults and toggles, and the guest
 * visibility rules end to end (lists, routes, counts, activity, live).
 */
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { makePdf } from "../../../src/features/media/__tests__/make-pdf";
import { MEDIA_TESTID as MT } from "../../../src/features/media/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
const state = (h: string) => path.join(AUTH, `${h}.json`);

type N = { id: string; name: string; slug: string; parentId: string | null };
type G = {
	trip: { id: string };
	nodes: N[];
	items: { id: string; nodeId: string | null; dayId: string | null; title: string | null }[];
	days: { id: string; date: string }[];
	legs: { id: string; kind: string; fromItemId: string | null; toItemId: string | null; mode: string | null; details: Record<string, unknown> | null }[];
};
type M = { id: string; kind: string; status: string; visibility: string; target: Record<string, string>; hasThumb: boolean; pages: number; pageCount: number | null; title: string | null };
const graphOf = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
async function ctxFor(browser: Browser, h: string | null) {
	const ctx = await browser.newContext({ ...(h ? { storageState: state(h) } : {}), viewport: { width: 1440, height: 900 }, acceptDownloads: true });
	return { ctx, page: await ctx.newPage() };
}
async function guest(browser: Browser, role: "viewer" | "editor") {
	const c = await ctxFor(browser, null);
	await c.page.goto(`/join#t=qa-share-token-${role}-asia-2027`);
	await expect(c.page).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
	return c;
}
function scopePath(g: G, name: string): string {
	const byId = new Map(g.nodes.map((n) => [n.id, n]));
	let n = g.nodes.find((x) => x.name === name);
	const parts: string[] = [];
	while (n) {
		parts.unshift(n.slug);
		n = n.parentId ? byId.get(n.parentId) : undefined;
	}
	return `/t/asia-2027/${parts.join("/")}`;
}
const listMedia = (page: Page): Promise<M[]> =>
	page.evaluate(async () => {
		const m = await import("/src/features/media/media.functions.ts");
		const y = (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder;
		return (await m.listTripMedia({ data: { tripId: y.graph.trip.id } })) as M[];
	});
async function uploadPdf(page: Page, target: Record<string, string>, name: string, pages: string[]) {
	const pdf = makePdf(pages, { title: name }).toString("base64");
	return page.evaluate(
		async ({ target, name, b64 }) => {
			const m = await import("/src/features/media/media.functions.ts");
			const y = (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder;
			const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			try {
				const up = await m.createUpload({ data: { tripId: y.graph.trip.id, target, type: "application/pdf", size: bytes.length, name } });
				const put = await fetch(up.url, { method: "PUT", body: bytes, headers: { "content-type": "application/pdf" } });
				if (!put.ok) return { error: `PUT ${put.status}` };
				const dto = await m.completeUpload({ data: { id: up.id, hasPoster: false } });
				return { id: up.id, visibility: dto.visibility };
			} catch (e) {
				return { error: (e as Error).message };
			}
		},
		{ target, name, b64: pdf },
	);
}

// The hide test uses the PDFs the first test uploads.
test.describe.configure({ mode: "serial" });

let g: G;
const ids: Record<string, string> = {};
test.beforeAll(async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	g = await graphOf(d.page);
	await d.ctx.close();
});

test("PDF defaults, viewer, thumbnail, Documents filter", async ({ browser }) => {
	test.setTimeout(240_000);
	const d = await ctxFor(browser, "dennis");
	const tokyoUrl = `${scopePath(g, "Tokyo")}?tab=media`;
	await d.page.goto(tokyoUrl);
	await expectLive(d.page);
	// A general PDF through the real UI.
	await d.page.getByTestId(MT.fileInput).first().setInputFiles({
		name: "Tokyo subway map.pdf",
		mimeType: "application/pdf",
		buffer: makePdf(["Tokyo subway map", "Lines", "Fares"], { title: "Tokyo subway map" }),
	});
	const pdfTile = d.page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=pdf]`).first();
	await expect(pdfTile).toHaveAttribute("data-status", "ready", { timeout: 40_000 });
	await expect(pdfTile).toHaveAttribute("data-visibility", "everyone");
	ids.general = (await pdfTile.getAttribute("data-id")) as string;
	await expect
		.poll(() => pdfTile.locator("img").first().evaluate((i: HTMLImageElement) => (i.complete ? i.naturalWidth : 0)).catch(() => 0), { timeout: 20_000 })
		.toBeGreaterThan(50);
	const thumb = await d.page.request.get(`/media/${ids.general}/thumb`);
	console.log("PDF thumb", thumb.status(), thumb.headers()["content-type"]);
	await shot(d.page, "17-pdf-tile-tokyo");
	// Viewer: pages, zoom, download.
	await pdfTile.getByRole("button").first().click();
	const viewer = d.page.getByTestId(MT.pdfViewer);
	await expect(viewer).toBeVisible();
	await expect(viewer.getByTestId(MT.pdfPage)).toHaveCount(3, { timeout: 20_000 });
	await expect.poll(() => viewer.getByRole("img", { name: /Page 1 of/ }).evaluate((i: HTMLImageElement) => (i.complete ? i.naturalWidth : 0)).catch(() => 0), { timeout: 20_000 }).toBeGreaterThan(100);
	await shot(d.page, "17-pdf-viewer");
	await viewer.getByTestId(MT.pdfZoomIn).click();
	await d.page.waitForTimeout(300);
	await shot(d.page, "17-pdf-viewer-zoom");
	const dl = d.page.waitForEvent("download", { timeout: 10_000 }).catch(() => null);
	await viewer.getByTestId(MT.pdfDownload).click();
	const got = await dl;
	console.log("PDF download:", got ? got.suggestedFilename() : "NO download event");
	const orig = await d.page.request.get(`/media/${ids.general}/original?download=1`, { maxRedirects: 0 });
	console.log("original redirect", orig.status(), (orig.headers().location ?? "").slice(0, 80));
	await d.page.keyboard.press("Escape");
	// Documents filter.
	await d.page.goto(`${tokyoUrl}&mf=documents`);
	await expectLive(d.page);
	await d.page.waitForTimeout(1000);
	const kinds = await d.page.getByTestId(TESTID.galleryItem).evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
	console.log("Documents filter kinds", JSON.stringify(kinds));
	expect(kinds.length).toBeGreaterThan(0);
	expect(kinds.every((k) => k === "pdf")).toBe(true);
	const chips = await d.page.getByTestId(MT.filterChip).allInnerTexts();
	console.log("chips", JSON.stringify(chips));
	await shot(d.page, "17-pdf-documents-filter");

	// Defaults per target.
	const name = (id: string | null) => {
		const it = g.items.find((i) => i.id === id);
		return it?.title ?? g.nodes.find((n) => n.id === it?.nodeId)?.name;
	};
	const flight = g.legs.find((l) => l.mode === "flight");
	const fuji = g.legs.find((l) => name(l.toItemId) === "Drop bags at ryokan");
	const walk = g.legs.find((l) => l.mode === "walk");
	const ryokan = g.nodes.find((n) => n.name === "Kawaguchiko Ryokan");
	const ryokanItem = g.items.find((i) => i.nodeId === ryokan?.id);
	const day = g.days.find((x) => x.date === "2027-10-07");
	const cases: [string, Record<string, string>, string][] = [
		["flight NH 9", { kind: "leg", legId: flight?.id as string }, "members"],
		["reserved Fuji Excursion", { kind: "leg", legId: fuji?.id as string }, "members"],
		["walk leg", { kind: "leg", legId: walk?.id as string }, "everyone"],
		["lodging node", { kind: "node", nodeId: ryokan?.id as string }, "members"],
		["lodging item", { kind: "item", itemId: ryokanItem?.id as string }, "members"],
		["day", { kind: "day", dayId: day?.id as string }, "everyone"],
		["trip", { kind: "trip" }, "everyone"],
	];
	for (const [label, target, want] of cases) {
		const r = await uploadPdf(d.page, target, `QA ${label}.pdf`, [`QA ${label}`]);
		console.log(`DEFAULT ${label}: ${JSON.stringify(r)} (want ${want})`);
		if ("id" in r && r.id) ids[label] = r.id;
		expect(r).toMatchObject({ visibility: want });
	}
	await d.ctx.close();
});

test("Hide from guests: guests never reach hidden PDFs; toggles are live; who may flip", async ({ browser }) => {
	test.setTimeout(240_000);
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	const all = await listMedia(d.page);
	const pdfs = all.filter((m) => m.kind === "pdf");
	console.log("member sees PDFs", pdfs.length, JSON.stringify(pdfs.map((p) => `${p.visibility}:${p.target.kind}`)));
	const hidden = pdfs.filter((p) => p.visibility === "members");
	const general = pdfs.find((p) => p.visibility === "everyone" && p.target.kind === "node");
	expect(hidden.length).toBeGreaterThan(0);
	if (!general) throw new Error("no general pdf");

	const gv = await guest(browser, "viewer");
	const tokyoUrl = `${scopePath(g, "Tokyo")}?tab=media&mf=documents`;
	await gv.page.goto(tokyoUrl);
	await expectLive(gv.page);
	const bodies: string[] = [];
	gv.page.on("response", async (r) => {
		if (r.url().includes("/_serverFn/")) bodies.push(await r.text().catch(() => ""));
	});
	const gm = await listMedia(gv.page);
	const leaked = gm.filter((m) => hidden.some((h) => h.id === m.id));
	console.log("guest-v sees PDFs", gm.filter((m) => m.kind === "pdf").length, "leaked hidden:", leaked.length);
	expect(leaked).toEqual([]);
	for (const h of hidden.slice(0, 3)) {
		const st = await gv.page.evaluate(async (id) => {
			const out: Record<string, number> = {};
			for (const v of ["thumb", "page-1", "original", "display"]) out[v] = (await fetch(`/media/${id}/${v}`, { redirect: "manual" })).status;
			return out;
		}, h.id);
		console.log("guest-v fetch hidden", h.id, JSON.stringify(st));
		expect(Object.values(st).every((s) => s === 404)).toBe(true);
	}
	// Counts: the guest's "docs" never include hidden ones.
	const counts = await gv.page.evaluate(async () => {
		const m = await import("/src/functions/graph.functions.ts");
		const y = (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder;
		return m.getTripCounts({ data: { tripId: y.graph.trip.id } });
	});
	const memberCounts = await d.page.evaluate(async () => {
		const m = await import("/src/functions/graph.functions.ts");
		const y = (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder;
		return m.getTripCounts({ data: { tripId: y.graph.trip.id } });
	});
	const sumDocs = (c: unknown) => {
		let n = 0;
		JSON.stringify(c, (k, v) => {
			if (k === "docs" && typeof v === "number") n += v;
			return v;
		});
		return n;
	};
	console.log("docs counts guest vs member:", sumDocs(counts), sumDocs(memberCounts));
	expect(sumDocs(counts)).toBeLessThan(sumDocs(memberCounts));
	// Guest's activity feed never names a hidden PDF.
	const act = await gv.page.evaluate(async () => {
		const m = await import("/src/functions/graph.functions.ts");
		const y = (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder;
		return m.listActivity({ data: { tripId: y.graph.trip.id } });
	});
	const actText = JSON.stringify(act);
	console.log("guest activity mentions QA PDFs:", /QA (flight|reserved|lodging)/.test(actText), "PDF lines:", (actText.match(/a PDF|PDFs/g) ?? []).length);
	await shot(gv.page, "17-guest-documents");
	const gtile = gv.page.locator(`[data-testid=${TESTID.galleryItem}][data-id="${general.id}"]`);
	await expect(gtile).toBeVisible();
	await expect(gv.page.getByTestId(MT.visibility)).toHaveCount(0);

	// Dennis hides the general PDF from the tile's lock: the guest loses it live.
	await d.page.goto(tokyoUrl);
	await expectLive(d.page);
	const dtile = d.page.locator(`[data-testid=${TESTID.galleryItem}][data-id="${general.id}"]`);
	// Touch screens have no hover lock: the tile's ⋯ menu carries it (media-tile.tsx).
	if (await d.page.evaluate(() => matchMedia("(hover: none)").matches)) {
		await dtile.getByTestId(MT.tileMenu).click();
		await d.page.getByRole("menuitem", { name: "Hide from guests" }).click();
	} else {
		await dtile.hover();
		await dtile.getByTestId(MT.visibility).click();
	}
	await expect(dtile).toHaveAttribute("data-visibility", "members");
	await expect(dtile.getByTestId(MT.hiddenChip)).toBeVisible();
	const t0 = Date.now();
	await expect(gtile).toHaveCount(0, { timeout: 5_000 });
	console.log("hide → guest live ms", Date.now() - t0);
	await shot(d.page, "17-tile-hidden");
	// Ask the server, not the guest's HTTP cache: a thumbnail they already saw stays
	// in their own cache (private, 1 day) and offline cache by design (PWA-10).
	const st = await gv.page.evaluate(async (id) => (await fetch(`/media/${id}/thumb`, { cache: "no-store" })).status, general.id);
	console.log("guest thumb after hide", st);
	expect(st).toBe(404);
	// Lightbox toggle back to visible.
	await dtile.getByRole("button").first().click();
	const v = d.page.getByTestId(MT.pdfViewer);
	await expect(v).toBeVisible();
	const lock = v.getByTestId(MT.visibility).first();
	await expect(lock).toContainText("Hidden from guests");
	await lock.click();
	await expect(lock).toContainText("Hide from guests");
	await d.page.keyboard.press("Escape");
	const t1 = Date.now();
	await expect(gtile).toBeVisible({ timeout: 5_000 });
	console.log("show → guest live ms", Date.now() - t1);

	// Kai (a viewer member) may flip; Guest-E may not.
	const k = await ctxFor(browser, "kai");
	await k.page.goto(tokyoUrl);
	await expectLive(k.page);
	const kr = await k.page.evaluate(async (id) => {
		const m = await import("/src/features/media/media.functions.ts");
		try {
			await m.setAttachmentVisibility({ data: { id, visibility: "members" } });
			await m.setAttachmentVisibility({ data: { id, visibility: "everyone" } });
			return "ok";
		} catch (e) {
			return `refused: ${(e as Error).message}`;
		}
	}, general.id);
	console.log("kai flips:", kr);
	const ge = await guest(browser, "editor");
	await ge.page.goto(tokyoUrl);
	await expectLive(ge.page);
	const gr = await ge.page.evaluate(async (ids) => {
		const m = await import("/src/features/media/media.functions.ts");
		const out: string[] = [];
		for (const [id, vis] of ids) {
			try {
				await m.setAttachmentVisibility({ data: { id, visibility: vis } });
				out.push(`ACCEPTED ${vis}`);
			} catch (e) {
				out.push(`refused: ${(e as Error).message}`);
			}
		}
		return out;
	}, [[general.id, "members"], [hidden[0]?.id as string, "everyone"]] as [string, string][]);
	console.log("guest-e flips:", JSON.stringify(gr));
	expect(gr.join()).not.toMatch(/ACCEPTED/);
	// A guest editor uploads an e-ticket onto the flight: it starts hidden, even from them.
	const flight = g.legs.find((l) => l.mode === "flight");
	const gu = await uploadPdf(ge.page, { kind: "leg", legId: flight?.id as string }, "Guest e-ticket.pdf", ["Guest e-ticket"]);
	console.log("guest-e uploads flight PDF:", JSON.stringify(gu));
	// Guest-E: does anything hidden reach their list or the leg?
	const gel = await listMedia(ge.page);
	console.log("guest-e sees hidden:", gel.filter((m) => m.visibility !== "everyone").length);
	// Deleting / editing hidden rows as the guest editor.
	const gd = await ge.page.evaluate(async (id) => {
		const m = await import("/src/features/media/media.functions.ts");
		const out: string[] = [];
		try {
			await m.updateAttachment({ data: { id, caption: "guest was here" } });
			out.push("update ACCEPTED");
		} catch (e) {
			out.push(`update refused: ${(e as Error).message}`);
		}
		try {
			await m.deleteAttachment({ data: { id } });
			out.push("delete ACCEPTED");
		} catch (e) {
			out.push(`delete refused: ${(e as Error).message}`);
		}
		return out;
	}, hidden[0]?.id as string);
	console.log("guest-e edits a hidden PDF:", JSON.stringify(gd));
	expect(gd.join()).not.toMatch(/ACCEPTED/);
	expect(bodies.join("\n")).not.toMatch(/QA flight NH 9|QA lodging|QA reserved/);
	for (const c of [d, gv, k, ge]) await c.ctx.close();
});
