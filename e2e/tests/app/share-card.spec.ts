/**
 * docs/OVERVIEW.md §Sharing: `GET /t/<slug>/share-card.png?size=story|square`.
 * A member gets the PNG in both sizes (private, cached a minute, with an
 * ETag that answers 304); someone without access and a signed-out visitor
 * get 404; a view-link guest gets a card drawn from their redacted graph.
 * Needs the QA seed (`pnpm db:seed:qa`) and QA_AUTH_DIR (run
 * qa-content-00-auth first).
 */
import path from "node:path";
import { type APIResponse, expect, test } from "@playwright/test";

test.skip(!process.env.QA_AUTH_DIR, "share-card spec: set QA_AUTH_DIR (QA seed + qa-content-00-auth)");
test.beforeEach(({}, info) => {
	test.skip(info.project.name !== "chromium", "one browser is enough");
});

const AUTH = process.env.QA_AUTH_DIR ?? "";
const state = (h: string) => path.join(AUTH, `${h}.json`);
const URL_OF = (size: string) => `/t/asia-2027/share-card.png?size=${size}`;

async function pngSize(res: APIResponse) {
	const body = await res.body();
	expect(body.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
	return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

test("a member gets the story and square cards as PNGs", async ({ browser }) => {
	test.setTimeout(90_000);
	const ctx = await browser.newContext({ storageState: state("dennis") });
	for (const [size, dims] of [
		["story", { width: 1080, height: 1920 }],
		["square", { width: 1080, height: 1080 }],
	] as const) {
		const res = await ctx.request.get(URL_OF(size));
		expect(res.status(), size).toBe(200);
		expect(res.headers()["content-type"]).toBe("image/png");
		expect(res.headers()["cache-control"]).toBe("private, max-age=60");
		expect(await pngSize(res)).toEqual(dims);
		const etag = res.headers().etag;
		expect(etag).toMatch(/^"sc\d+-/);
		const again = await ctx.request.get(URL_OF(size), { headers: { "If-None-Match": etag ?? "" } });
		expect(again.status()).toBe(304);
	}
	expect((await ctx.request.get(URL_OF("poster"))).status()).toBe(400);
	await ctx.close();
});

test("no access, signed out or no such trip: 404", async ({ browser, playwright }) => {
	const eve = await browser.newContext({ storageState: state("eve") });
	expect((await eve.request.get(URL_OF("story"))).status()).toBe(404);
	await eve.close();
	const anon = await playwright.request.newContext({ baseURL: process.env.APP_URL });
	expect((await anon.get(URL_OF("story"))).status()).toBe(404);
	await anon.dispose();
	const dennis = await browser.newContext({ storageState: state("dennis") });
	expect((await dennis.request.get("/t/no-such-trip-here/share-card.png")).status()).toBe(404);
	await dennis.close();
});

test("a view-link guest gets a card", async ({ browser }) => {
	test.setTimeout(90_000);
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto("/join#t=qa-share-token-viewer-asia-2027");
	await expect(page).toHaveURL(/\/t\/asia-2027/, { timeout: 30_000 });
	const res = await ctx.request.get(URL_OF("story"));
	expect(res.status()).toBe(200);
	expect(await pngSize(res)).toEqual({ width: 1080, height: 1920 });
	await ctx.close();
});
