/**
 * The QA trip's PDFs from qa-content-17 — a general one at Tokyo ("Tokyo
 * subway map", everyone) and a hidden one on the NH 9 flight (members only).
 * Specs that look at PDFs make sure these exist instead of relying on
 * qa-content-17 having run before them in the same database (the fast full
 * run gives every spec file its own fresh copy of the QA seed).
 */
import { expect, type Page } from "@playwright/test";
import { makePdf } from "../../../../src/features/media/__tests__/make-pdf";

type Media = { id: string; kind: string; status: string; visibility: string; target: Record<string, string> };
type Want = { target: Record<string, string>; name: string; pages: string[] };

const MEDIA = "/src/features/media/media.functions.ts";

const listMedia = (page: Page, tripId: string): Promise<Media[]> =>
	page.evaluate(
		async ({ mod, tripId }) => {
			const m = await import(mod);
			return m.listTripMedia({ data: { tripId } });
		},
		{ mod: MEDIA, tripId },
	);

/** `page`: an editor of `asia-2027` (Dennis) on its workspace (`window.__yonder` loaded). */
export async function ensureQaPdfs(page: Page): Promise<void> {
	const g = await page.evaluate(() => {
		const graph = (
			window as unknown as {
				__yonder: {
					graph: {
						trip: { id: string };
						nodes: { id: string; name: string }[];
						legs: { id: string; mode: string | null }[];
					};
				};
			}
		).__yonder.graph;
		return {
			tripId: graph.trip.id,
			tokyo: graph.nodes.find((n) => n.name === "Tokyo")?.id,
			flight: graph.legs.find((l) => l.mode === "flight")?.id,
		};
	});
	if (!g.tokyo || !g.flight) throw new Error("the QA trip has no Tokyo or no flight leg");
	const media = await listMedia(page, g.tripId);
	const pdfs = media.filter((m) => m.kind === "pdf");
	const want: Want[] = [];
	if (!pdfs.some((m) => m.visibility === "everyone" && m.target.nodeId === g.tokyo))
		want.push({ target: { kind: "node", nodeId: g.tokyo }, name: "Tokyo subway map.pdf", pages: ["Tokyo subway map", "Lines", "Fares"] });
	if (!pdfs.some((m) => m.visibility === "members" && m.target.kind === "leg"))
		want.push({ target: { kind: "leg", legId: g.flight }, name: "QA flight NH 9.pdf", pages: ["QA flight NH 9"] });
	for (const w of want) {
		const r = await page.evaluate(
			async ({ mod, tripId, target, name, b64 }) => {
				const m = await import(mod);
				const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
				const up = await m.createUpload({ data: { tripId, target, type: "application/pdf", size: bytes.length, name } });
				const put = await fetch(up.url, { method: "PUT", body: bytes, headers: { "content-type": "application/pdf" } });
				if (!put.ok) return `PUT ${put.status}`;
				await m.completeUpload({ data: { id: up.id, hasPoster: false } });
				return "ok";
			},
			{ mod: MEDIA, tripId: g.tripId, target: w.target, name: w.name, b64: makePdf(w.pages, { title: w.name }).toString("base64") },
		);
		if (r !== "ok") throw new Error(`uploading ${w.name}: ${r}`);
	}
	if (want.length)
		await expect
			.poll(async () => (await listMedia(page, g.tripId)).filter((m) => m.kind === "pdf" && m.status !== "ready").length, {
				timeout: 60_000,
			})
			.toBe(0);
}
