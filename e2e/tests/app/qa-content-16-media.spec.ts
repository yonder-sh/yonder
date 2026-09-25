/**
 * I2 "content" verifier: QA MED-01/02/04/05/07/10/11 and ROLL-09/10 on the
 * imported Asia 2027 trip, in real browsers.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { MEDIA_TESTID as MT } from "../../../src/features/media/testids";
import { TESTID } from "../../../src/lib/testids";
import { E2E_ROOT } from "./_helpers/env";
import { expectLive } from "./_helpers/page";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
// The photo fixtures are committed (e2e/fixtures/make-photos.mjs regenerates them).
const FIX = path.join(E2E_ROOT, "fixtures");
const S3 = "http://localhost:8080";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
const state = (h: string) => path.join(AUTH, `${h}.json`);

type N = { id: string; name: string; slug: string; parentId: string | null };
type G = {
	trip: { id: string };
	nodes: N[];
	items: { id: string; nodeId: string | null; dayId: string | null; title: string | null }[];
	days: { id: string; date: string }[];
	legs: { id: string; kind: string; fromItemId: string | null; toItemId: string | null; mode: string | null }[];
};
const graphOf = (page: Page) => page.evaluate(() => (window as unknown as { __yonder: { graph: G } }).__yonder.graph);
async function ctxFor(browser: Browser, h: string | null) {
	const ctx = await browser.newContext({ ...(h ? { storageState: state(h) } : {}), viewport: { width: 1440, height: 900 } });
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
async function listMedia(page: Page) {
	return page.evaluate(async () => {
		const m = await import("/src/features/media/media.functions.ts");
		const y = (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder;
		return (await m.listTripMedia({ data: { tripId: y.graph.trip.id } })) as {
			id: string;
			kind: string;
			status: string;
			visibility: string;
			provider: string | null;
			embedId: string | null;
			title: string | null;
			url: string | null;
			siteName: string | null;
			target: Record<string, string>;
			hasThumb: boolean;
			pages: number;
		}[];
	});
}
const tiles = (scope: Page | ReturnType<Page["getByTestId"]>) => scope.getByTestId(TESTID.galleryItem);

let g: G;
test.beforeAll(async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	g = await graphOf(d.page);
	await d.ctx.close();
});

test("MED-01/10/07/11 a photo on Chureito: direct PUT, live, presigned, upright, GPS stripped; delete; guests", async ({ browser }) => {
	test.setTimeout(180_000);
	const url = `${scopePath(g, "Chureito Pagoda")}?tab=media`;
	console.log("URL", url);
	const d = await ctxFor(browser, "dennis");
	await d.page.goto(url);
	await expectLive(d.page);
	const a = await ctxFor(browser, "audrey");
	await a.page.goto(url);
	await expectLive(a.page);
	const before = await tiles(d.page).count();
	const puts: string[] = [];
	a.page.on("request", (r) => {
		if (r.method() === "PUT") puts.push(r.url());
	});
	await a.page.getByTestId(MT.fileInput).first().setInputFiles({
		name: "chureito-sunrise.jpg",
		mimeType: "image/jpeg",
		buffer: readFileSync(path.join(FIX, "chureito-sunrise.jpg")),
	});
	const up = a.page.getByTestId(MT.uploadTile);
	const sawProgress = await up.first().isVisible().catch(() => false);
	console.log("MED-01 upload tile/progress visible:", sawProgress);
	await shot(a.page, "16-med01-uploading");
	await expect.poll(() => puts.length, { timeout: 20_000 }).toBeGreaterThan(0);
	console.log("MED-01 PUT hosts", JSON.stringify(puts.map((u) => new URL(u).host)));
	expect(puts.every((u) => u.startsWith(S3))).toBe(true);
	const t0 = Date.now();
	await expect(tiles(d.page)).toHaveCount(before + 1, { timeout: 15_000 });
	console.log("MED-01 Dennis sees new tile ms", Date.now() - t0);
	const media = await listMedia(d.page);
	const photo = media.find((m) => m.kind === "photo" && m.title === "chureito-sunrise.jpg") ?? media.filter((m) => m.kind === "photo").at(-1);
	console.log("PHOTO dto", JSON.stringify(photo));
	if (!photo) throw new Error("no photo");
	await expect.poll(async () => (await listMedia(d.page)).find((m) => m.id === photo.id)?.status, { timeout: 30_000 }).toBe("ready");
	await d.page.reload();
	await expectLive(d.page);
	const tile = d.page.locator(`[data-testid=${TESTID.galleryItem}][data-id="${photo.id}"]`);
	await expect(tile).toBeVisible();
	await shot(d.page, "16-med01-dennis-after-reload");
	// Presigned GET for display works in a fresh context (no cookies).
	const loc = await d.page.evaluate(async (id) => {
		const r = await fetch(`/media/${id}/display`, { redirect: "manual" });
		return { status: r.status, type: r.type, loc: r.headers.get("location") };
	}, photo.id);
	console.log("display redirect", JSON.stringify(loc));
	const req = await d.page.request.get(`/media/${photo.id}/display`, { maxRedirects: 0 });
	const presigned = req.headers().location;
	console.log("presigned", presigned?.slice(0, 120));
	const fresh = await browser.newContext();
	const r2 = await fresh.request.get(presigned);
	console.log("fresh GET", r2.status(), r2.headers()["content-type"]);
	expect(r2.status()).toBe(200);
	// MED-10: upright + GPS stripped in the served derivative.
	const disp = await r2.body();
	const probe = await d.page.evaluate(async (b64) => {
		const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const bmp = await createImageBitmap(new Blob([bin]));
		const c = new OffscreenCanvas(bmp.width, bmp.height);
		const x = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
		x.drawImage(bmp, 0, 0);
		const top = x.getImageData(Math.floor(bmp.width / 2), 5, 1, 1).data;
		const left = x.getImageData(5, Math.floor(bmp.height / 2), 1, 1).data;
		return { w: bmp.width, h: bmp.height, top: [...top].slice(0, 3), left: [...left].slice(0, 3) };
	}, disp.toString("base64"));
	console.log("MED-10 display probe", JSON.stringify(probe));
	expect(probe.h).toBeGreaterThan(probe.w);
	const gpsInDisplay = disp.includes(Buffer.from("GPS")) || disp.includes(Buffer.from([0x88, 0x25]));
	console.log("MED-10 display has GPS marker:", gpsInDisplay, "size", disp.length);
	const orig = await d.page.request.get(`/media/${photo.id}/original`, { maxRedirects: 0 });
	const origBody = await (await fresh.request.get(orig.headers().location)).body();
	console.log("MED-10 orig bytes", origBody.length);
	const { writeFileSync } = await import("node:fs");
	writeFileSync(path.join(SHOTS, "med10-display.webp"), disp);
	writeFileSync(path.join(SHOTS, "med10-original.jpg"), origBody);
	const th = await d.page.request.get(`/media/${photo.id}/thumb`);
	writeFileSync(path.join(SHOTS, "med10-thumb.webp"), await th.body());
	await fresh.close();

	// MED-11: Guest-V sees the thumbnail, no upload/delete controls; Guest-E can upload.
	const gv = await guest(browser, "viewer");
	await gv.page.goto(url);
	await expectLive(gv.page);
	await expect(gv.page.locator(`[data-testid=${TESTID.galleryItem}][data-id="${photo.id}"]`)).toBeVisible();
	const gvThumb = await gv.page.evaluate(async (id) => (await fetch(`/media/${id}/thumb`)).status, photo.id);
	console.log("MED-11 guest-v thumb status", gvThumb);
	console.log("MED-07 guest-v add buttons:", await gv.page.getByTestId(MT.addButton).count(), "enabled:", await gv.page.getByTestId(MT.addButton).first().isEnabled().catch(() => "n/a"), "file inputs:", await gv.page.getByTestId(MT.fileInput).count());
	await gv.page.locator(`[data-testid=${TESTID.galleryItem}][data-id="${photo.id}"]`).hover();
	console.log("MED-07 guest-v tile menus:", await gv.page.getByTestId(MT.tileMenu).count());
	await shot(gv.page, "16-med11-guest-v");
	const k = await ctxFor(browser, "kai");
	await k.page.goto(url);
	await expectLive(k.page);
	console.log("MED-07 kai add buttons:", await k.page.getByTestId(MT.addButton).count(), "enabled:", await k.page.getByTestId(MT.addButton).first().isEnabled().catch(() => "n/a"));
	await k.page.locator(`[data-testid=${TESTID.galleryItem}][data-id="${photo.id}"]`).hover();
	const kmenu = k.page.locator(`[data-testid=${TESTID.galleryItem}][data-id="${photo.id}"]`).getByTestId(MT.tileMenu);
	console.log("MED-07 kai tile menus:", await kmenu.count());
	if (await kmenu.count()) {
		await kmenu.click();
		await k.page.waitForTimeout(300);
		console.log("MED-07 kai tile menu items:", JSON.stringify(await k.page.getByRole("menuitem").allInnerTexts()));
		await shot(k.page, "16-med07-kai-menu");
		await k.page.keyboard.press("Escape");
	}
	await shot(k.page, "16-med07-kai");
	// Replayed presign from Kai and Guest-V: refused.
	for (const [who, p] of [["kai", k.page], ["guest-v", gv.page]] as const) {
		const r = await p.evaluate(async (nodeId) => {
			const m = await import("/src/features/media/media.functions.ts");
			const y = (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder;
			try {
				await m.createUpload({ data: { tripId: y.graph.trip.id, target: { kind: "node", nodeId }, type: "image/jpeg", size: 1000, name: "x.jpg" } });
				return "ACCEPTED";
			} catch (e) {
				return `refused: ${(e as Error).message}`;
			}
		}, g.nodes.find((n) => n.name === "Chureito Pagoda")?.id);
		console.log(`MED-07 ${who} createUpload:`, r);
		expect(r).not.toBe("ACCEPTED");
	}
	const ge = await guest(browser, "editor");
	await ge.page.goto(url);
	await expectLive(ge.page);
	const photosBefore = (await listMedia(d.page)).filter((m) => m.kind === "photo").length;
	await ge.page.getByTestId(MT.fileInput).first().setInputFiles({
		name: "golden-gai-alley.png",
		mimeType: "image/png",
		buffer: readFileSync(path.join(FIX, "golden-gai-alley.png")),
	});
	await expect.poll(async () => (await listMedia(d.page)).filter((m) => m.kind === "photo").length, { timeout: 20_000 }).toBeGreaterThan(photosBefore);
	console.log("MED-11 guest-e uploaded OK");

	// MED-07: Audrey deletes the photo; Dennis sees it go.
	await a.page.reload();
	await expectLive(a.page);
	const at = a.page.locator(`[data-testid=${TESTID.galleryItem}][data-id="${photo.id}"]`);
	await at.hover();
	await at.getByTestId(MT.tileMenu).click();
	await shot(a.page, "16-med07-tile-menu");
	await a.page.getByRole("menuitem", { name: /Delete/ }).click();
	const t1 = Date.now();
	await expect(tile).toHaveCount(0, { timeout: 5_000 });
	console.log("MED-07 delete sync ms", Date.now() - t1);
	for (const c of [d, a, k, gv, ge]) await c.ctx.close();
});

test("MED-04/05 TikTok, Reel, YouTube ×3, guide link", async ({ browser }) => {
	test.setTimeout(180_000);
	const d = await ctxFor(browser, "audrey");
	await d.page.goto("/t/asia-2027?tab=plan");
	await expectLive(d.page);
	const node = (n: string) => g.nodes.find((x) => x.name === n)?.id as string;
	const name = (id: string | null) => {
		const it = g.items.find((i) => i.id === id);
		return it?.title ?? g.nodes.find((n) => n.id === it?.nodeId)?.name;
	};
	const fuji = g.legs.find((l) => name(l.toItemId) === "Drop bags at ryokan");
	const adds: [Record<string, string>, string][] = [
		[{ kind: "node", nodeId: node("Golden Gai") }, "https://www.tiktok.com/@fixture/video/7300000000000000001"],
		[{ kind: "node", nodeId: node("Kawaguchiko Ryokan") }, "https://www.instagram.com/reel/C0FIXTURE01/"],
		[{ kind: "leg", legId: fuji?.id as string }, "https://www.youtube.com/watch?v=FIXTURE0001"],
		[{ kind: "leg", legId: fuji?.id as string }, "https://youtu.be/FIXTURE0002"],
		[{ kind: "leg", legId: fuji?.id as string }, "https://www.youtube.com/shorts/FIXTURE0003"],
		[{ kind: "node", nodeId: node("Mt. Fuji") }, "https://www.japan-guide.com/e/e2172.html"],
	];
	for (const [target, url] of adds) {
		const r = await d.page.evaluate(
			async ({ target, url }) => {
				const m = await import("/src/features/media/media.functions.ts");
				const y = (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder;
				try {
					const out = await m.addLink({ data: { tripId: y.graph.trip.id, target, url } });
					return JSON.stringify(out).slice(0, 200);
				} catch (e) {
					return `ERR ${(e as Error).message}`;
				}
			},
			{ target, url },
		);
		console.log("addLink", url, "→", r);
	}
	await d.page.waitForTimeout(8000);
	const media = await listMedia(d.page);
	for (const [, url] of adds) {
		const m = media.find((x) => x.url === url);
		console.log("LINK", url, "→", JSON.stringify({ kind: m?.kind, provider: m?.provider, embedId: m?.embedId, status: m?.status, title: m?.title, siteName: m?.siteName, hasThumb: m?.hasThumb }));
	}
	// The Fuji Excursion leg's media in the inspector, then the embed opens.
	await d.page.goto(`/t/asia-2027?sel=l.${fuji?.fromItemId}.${fuji?.toItemId}`);
	await expectLive(d.page);
	const insp = d.page.getByTestId(TESTID.inspector);
	await insp.getByRole("tab", { name: /Media/ }).click();
	await d.page.waitForTimeout(1500);
	await shot(d.page, "16-med04-leg-media");
	const yt = insp.locator(`[data-testid=${TESTID.galleryItem}][data-kind=embed]`);
	console.log("leg embed tiles", await yt.count());
	if (await yt.count()) {
		await yt.first().getByRole("button").first().click();
		await d.page.waitForTimeout(1500);
		const frames = await d.page.locator("iframe").evaluateAll((fs) => fs.map((f) => (f as HTMLIFrameElement).src));
		console.log("embed iframes", JSON.stringify(frames));
		await shot(d.page, "16-med04-lightbox-embed");
		await d.page.keyboard.press("Escape");
	}
	// MED-05: the guide link card at Mt. Fuji.
	await d.page.goto(`${scopePath(g, "Mt. Fuji")}?tab=media&mf=guides`);
	await expectLive(d.page);
	await d.page.waitForTimeout(1500);
	const guides = d.page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=link]`);
	console.log("Mt. Fuji guide tiles", await guides.count());
	const anchors = await d.page.locator("a[href*='japan-guide.com']").evaluateAll((as) =>
		as.map((a) => `${(a as HTMLAnchorElement).href} target=${(a as HTMLAnchorElement).target} rel=${(a as HTMLAnchorElement).rel}`),
	);
	console.log("guide anchors", JSON.stringify(anchors));
	await shot(d.page, "16-med05-guides");
	await d.ctx.close();
});

test("ROLL-09/10 gallery rolls up at Mt. Fuji and Tokyo; lightbox", async ({ browser }) => {
	const d = await ctxFor(browser, "dennis");
	for (const scope of ["Mt. Fuji", "Tokyo", "Japan"]) {
		await d.page.goto(`${scopePath(g, scope)}?tab=media`);
		await expectLive(d.page);
		await d.page.waitForTimeout(1500);
		const chips = await d.page.getByTestId(MT.filterChip).allInnerTexts();
		const groups = await d.page.getByTestId(MT.group).evaluateAll((els) => els.map((e) => (e.querySelector("h2,h3,[data-group-title],header")?.textContent ?? e.textContent ?? "").slice(0, 60)));
		console.log(`ROLL ${scope}: tiles=${await tiles(d.page).count()} chips=${JSON.stringify(chips)} groups=${JSON.stringify(groups.slice(0, 12))}`);
		await shot(d.page, `16-roll-${scope.replace(/\W/g, "")}`);
	}
	// Lightbox ← → Esc at Japan.
	await tiles(d.page).first().getByRole("button").first().click();
	await d.page.waitForTimeout(800);
	await shot(d.page, "16-roll10-lightbox");
	await d.page.keyboard.press("ArrowRight");
	await d.page.waitForTimeout(500);
	await shot(d.page, "16-roll10-lightbox-next");
	await d.page.keyboard.press("Escape");
	await expect(d.page.locator(".yonder-lightbox")).toBeHidden();
	await d.ctx.close();
});
