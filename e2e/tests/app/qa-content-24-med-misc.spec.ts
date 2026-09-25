/**
 * I2 "content" verifier: QA MED-02 (video on the Fuji Excursion leg: poster,
 * inline playback with Range) and MED-06 (server-side refusals) on Asia 2027.
 */
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { MEDIA_TESTID as MT } from "../../../src/features/media/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
test.use({ storageState: path.join(AUTH, "audrey.json") });

async function webmFromPage(page: Page): Promise<Buffer> {
	const b64 = await page.evaluate(async () => {
		const c = document.createElement("canvas");
		c.width = 480;
		c.height = 270;
		const g = c.getContext("2d") as CanvasRenderingContext2D;
		const rec = new MediaRecorder(c.captureStream(24), { mimeType: "video/webm" });
		const parts: Blob[] = [];
		rec.ondataavailable = (e) => parts.push(e.data);
		let t = 0;
		const timer = setInterval(() => {
			g.fillStyle = `hsl(${(t * 3) % 360} 60% 50%)`;
			g.fillRect(0, 0, 480, 270);
			t += 1;
		}, 40);
		rec.start(200);
		await new Promise((r) => setTimeout(r, 2000));
		rec.stop();
		await new Promise((r) => (rec.onstop = r));
		clearInterval(timer);
		const bytes = new Uint8Array(await new Blob(parts, { type: "video/webm" }).arrayBuffer());
		let s = "";
		for (const x of bytes) s += String.fromCharCode(x);
		return btoa(s);
	});
	return Buffer.from(b64, "base64");
}

test("MED-02 video on the Fuji Excursion leg; MED-06 refusals", async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto("/t/asia-2027?tab=plan");
	await expectLive(page);
	const g = await page.evaluate(() => (window as unknown as { __yonder: { graph: { trip: { id: string }; items: { id: string; title: string | null; nodeId: string | null }[]; nodes: { id: string; name: string }[]; legs: { id: string; fromItemId: string | null; toItemId: string | null }[] } } }).__yonder.graph);
	const name = (id: string | null) => {
		const it = g.items.find((i) => i.id === id);
		return it?.title ?? g.nodes.find((n) => n.id === it?.nodeId)?.name;
	};
	const fuji = g.legs.find((l) => name(l.toItemId) === "Drop bags at ryokan");
	await page.goto(`/t/asia-2027?sel=l.${fuji?.fromItemId}.${fuji?.toItemId}`);
	await expectLive(page);
	const insp = page.getByTestId(TESTID.inspector);
	await insp.getByRole("tab", { name: /Media/ }).click();
	await insp.getByTestId(MT.fileInput).setInputFiles({ name: "fuji-excursion-window.webm", mimeType: "video/webm", buffer: await webmFromPage(page) });
	const tile = insp.locator(`[data-testid=${TESTID.galleryItem}][data-kind=video]`).first();
	await expect(tile).toHaveAttribute("data-status", "ready", { timeout: 40_000 });
	await expect.poll(() => tile.locator("img").first().evaluate((i: HTMLImageElement) => i.naturalWidth).catch(() => 0), { timeout: 15_000 }).toBeGreaterThan(0);
	const id = await tile.getAttribute("data-id");
	const orig = await page.request.get(`/media/${id}/original`, { maxRedirects: 0 });
	const loc = orig.headers().location;
	const range = await page.request.get(loc, { headers: { Range: "bytes=0-99" } });
	console.log("MED-02 Range request:", range.status(), range.headers()["content-range"], range.headers()["content-type"]);
	await tile.getByRole("button").first().click();
	const player = page.locator(".yonder-lightbox video");
	await expect(player).toBeVisible();
	await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
	await page.screenshot({ path: path.join(SHOTS, "24-med02-video.png") });
	await page.keyboard.press("Escape");
	// MED-06 server refusals (the API, not just the UI).
	const res = await page.evaluate(
		async ({ tripId, nodeId }) => {
			const m = await import("/src/features/media/media.functions.ts");
			const out: Record<string, string> = {};
			const t = async (k: string, f: () => Promise<unknown>) => {
				try {
					await f();
					out[k] = "ACCEPTED";
				} catch (e) {
					out[k] = (e as Error).message.slice(0, 120);
				}
			};
			const target = { kind: "node", nodeId };
			await t("exe", () => m.createUpload({ data: { tripId, target, type: "application/x-msdownload", size: 100, name: "malware.exe" } }));
			await t("heic", () => m.createUpload({ data: { tripId, target, type: "image/heic", size: 100, name: "p.heic" } }));
			// PDFs go up to 50 MB now (PDF_MAX_BYTES, raised from 20 MB with chunked uploads).
			await t("pdf 51MB", () => m.createUpload({ data: { tripId, target, type: "application/pdf", size: 51 * 1024 * 1024, name: "big.pdf" } }));
			await t("jpeg 60MB", () => m.createUpload({ data: { tripId, target, type: "image/jpeg", size: 60 * 1024 * 1024, name: "big.jpg" } }));
			await t("svg", () => m.createUpload({ data: { tripId, target, type: "image/svg+xml", size: 100, name: "x.svg" } }));
			await t("javascript:", () => m.addLink({ data: { tripId, target, url: "javascript:alert(1)" } }));
			await t("not a url", () => m.addLink({ data: { tripId, target, url: "not a url" } }));
			await t("data:", () => m.addLink({ data: { tripId, target, url: "data:text/html,<script>alert(1)</script>" } }));
			return out;
		},
		{ tripId: g.trip.id, nodeId: g.nodes.find((n) => n.name === "Golden Gai")?.id },
	);
	console.log("MED-06", JSON.stringify(res, null, 1));
	expect(JSON.stringify(res)).not.toMatch(/ACCEPTED/);
	// A PUT with a different content-type than signed is refused by S3.
	const lie = await page.evaluate(
		async ({ tripId, nodeId }) => {
			const m = await import("/src/features/media/media.functions.ts");
			const up = await m.createUpload({ data: { tripId, target: { kind: "node", nodeId }, type: "image/png", size: 10, name: "x.png" } });
			const r1 = await fetch(up.url, { method: "PUT", body: "<script>1</script>", headers: { "content-type": "text/html" } });
			const r2 = await fetch(up.url, { method: "PUT", body: "0123456789abcdef", headers: { "content-type": "image/png" } });
			let done = "";
			try {
				await m.completeUpload({ data: { id: up.id, hasPoster: false } });
				done = "completed";
			} catch (e) {
				done = (e as Error).message.slice(0, 100);
			}
			return { html: r1.status, wrongLen: r2.status, complete: done };
		},
		{ tripId: g.trip.id, nodeId: g.nodes.find((n) => n.name === "Golden Gai")?.id },
	);
	console.log("MED-06 presign tamper", JSON.stringify(lie));
});
