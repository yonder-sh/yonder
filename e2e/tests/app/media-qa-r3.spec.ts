/**
 * WP-Media fixes from QA round 3 and owner feedback round 1, each on its own
 * cloned demo trip (SPEC §18.5):
 *
 * - COLLAB-R3-05: accepting a suggested link turns its ghost into the real
 *   tile with no duplicate React keys, and the tile is never shown twice or
 *   dropped, whichever of the `proposals` / `media` refetches lands first
 *   (each order is forced by holding the other response back).
 * - COLLAB-R3-04: a suggested link made right after the same person's
 *   accepted one still reads "added a link to Tokyo" (summary, toast).
 * - FB-02: gallery tiles, their controls and the lightbox's controls show the
 *   pointer cursor.
 *
 * Self-contained logins (no shared storageState), so it can run against any
 * agent's server: `APP_URL=http://localhost:<port> N pnpm e2e -- tests/app/media-qa-r3.spec.ts`.
 */
import { type Browser, expect, type Page, type Route, test } from "@playwright/test";
import { MEDIA_TESTID } from "../../../src/features/media/testids";
import { SUGGEST_TESTID } from "../../../src/features/suggest/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath } from "./_helpers/env";
import { cloneFixtureTrip, type FixtureClone } from "./_helpers/fixture";
import { collectConsole, expectLive } from "./_helpers/page";
import { clearToasts } from "./media-helpers";

test.skip(({ isMobile }) => isMobile, "desktop: hover controls and the lightbox toolbar");

const MEF = "/src/features/media/media.functions.ts";

async function person(browser: Browser, email: string, first: string, last: string) {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await loginViaApi(ctx.request, email, { first, last });
	return { ctx, page: await ctx.newPage() };
}

async function openMedia(page: Page, slug: string) {
	await page.goto(`/t/${slug}/japan/tokyo?tab=media`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.mediaTab)).toBeVisible();
}

/** The server function a dev-mode `/_serverFn/<base64url {file, export}>` request calls. */
function serverFnOf(url: string): string | null {
	const id = /\/_serverFn\/([^/?]+)/.exec(url)?.[1];
	if (!id) return null;
	try {
		const { export: name } = JSON.parse(Buffer.from(id, "base64url").toString("utf8")) as { export?: string };
		return name?.replace(/_createServerFn_handler$/, "") ?? null;
	} catch {
		return null;
	}
}

/** Holds every response of server function `fn` back by `ms` (a slow network for that one query). */
async function slow(page: Page, fn: string, ms: number): Promise<() => Promise<void>> {
	const handler = async (route: Route) => {
		if (serverFnOf(route.request().url()) !== fn) return route.fallback();
		await new Promise((r) => setTimeout(r, ms));
		await route.fallback();
	};
	await page.route("**/_serverFn/**", handler);
	return () => page.unroute("**/_serverFn/**", handler);
}

async function suggestLink(page: Page, c: FixtureClone, url: string) {
	return page.evaluate(
		async ({ file, data }) => {
			const mod = (await import(/* @vite-ignore */ file)) as Record<
				string,
				(o: { data: unknown }) => Promise<{ proposed?: { id: string; summary: string } }>
			>;
			return mod.addLink?.({ data });
		},
		{ file: MEF, data: { tripId: c.tripId, target: { kind: "node", nodeId: c.ids.nodes.tokyo }, url } },
	);
}

/** Samples how many tiles carry `id` every 50 ms for `ms` (the tile must never vanish or double). */
async function tileCounts(page: Page, id: string, ms: number): Promise<number[]> {
	return page.evaluate(
		async ({ id, ms, testid }) => {
			const out: number[] = [];
			const t0 = performance.now();
			while (performance.now() - t0 < ms) {
				out.push(document.querySelectorAll(`[data-testid="${testid}"][data-id="${id}"]`).length);
				await new Promise((r) => setTimeout(r, 50));
			}
			return out;
		},
		{ id, ms, testid: TESTID.galleryItem },
	);
}

test("accepting a suggested link: one tile, never doubled or dropped, and one link reads as one link (COLLAB-R3-04/05)", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const dev = await person(browser, "dev@example.com", "Dev", "User");
	const maya = await person(browser, "maya@example.com", "Maya", "Chen");
	const c = await cloneFixtureTrip(dev.ctx.request, { mayaRole: "suggester" });
	const logs = collectConsole(dev.page);
	const mayaLogs = collectConsole(maya.page);
	await openMedia(dev.page, c.slug);
	await openMedia(maya.page, c.slug);

	const cases = [
		// The media list lands while the proposal still reads open (the old duplicate key).
		{ hold: "listProposals", url: "https://www.japan-guide.com/e/e3007.html" },
		// The proposal closes while the media list is still on its way (the old blink).
		{ hold: "listTripMedia", url: "https://www.japan-guide.com/e/e3002.html" },
	];
	for (const [i, k] of cases.entries()) {
		const r = await suggestLink(maya.page, c, k.url);
		expect(r?.proposed?.summary, `suggestion ${i + 1} is one link`).toBe("added a link to Tokyo");
		const ghost = dev.page.locator(`[data-testid="${TESTID.proposalGhost}"][data-proposal-id="${r?.proposed?.id}"]`);
		await expect(ghost).toBeVisible({ timeout: 10_000 });
		const id = await ghost.getByTestId(TESTID.galleryItem).getAttribute("data-id");
		expect(id).toBeTruthy();
		if (i === 0) await dev.page.screenshot({ path: shotPath("media/r3-ghost-before-accept.png") });

		const release = await slow(dev.page, k.hold, 1_500);
		await ghost.hover();
		const sampling = tileCounts(dev.page, id as string, 3_000);
		await ghost.getByTestId(SUGGEST_TESTID.ghostAccept).click();
		const counts = await sampling;
		await release();
		expect(counts.filter((n) => n !== 1), `${k.hold} held back: ${counts.join("")}`).toEqual([]);
		await expect(dev.page.getByText(/^Accepted — /).last()).toContainText("a link");
		// Settled: the real tile, with its menu, no ghost.
		await expect(ghost).toHaveCount(0, { timeout: 10_000 });
		await expect(dev.page.locator(`[data-testid="${TESTID.galleryItem}"][data-id="${id}"]`)).toHaveCount(1);
		await expect(maya.page.locator(`[data-testid="${TESTID.galleryItem}"][data-id="${id}"]`)).toHaveCount(1, {
			timeout: 10_000,
		});
		if (i === 1) {
			await dev.page.mouse.move(5, 5);
			await dev.page.screenshot({ path: shotPath("media/r3-after-accept.png") });
		}
		await clearToasts(dev.page);
	}
	const dup = /two children with the same key/;
	expect(logs.messages.filter((m) => dup.test(m))).toEqual([]);
	expect(mayaLogs.messages.filter((m) => dup.test(m))).toEqual([]);
	await maya.ctx.close();
	await dev.ctx.close();
});

/** A small real JPEG drawn in the page (no fixture file). */
async function jpegFromPage(page: Page, hue: number): Promise<Buffer> {
	const b64 = await page.evaluate(async (h) => {
		const c = document.createElement("canvas");
		c.width = 600;
		c.height = 400;
		const g = c.getContext("2d") as CanvasRenderingContext2D;
		g.fillStyle = `hsl(${h} 45% 55%)`;
		g.fillRect(0, 0, 600, 400);
		const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), "image/jpeg", 0.85));
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let s = "";
		for (const x of bytes) s += String.fromCharCode(x);
		return btoa(s);
	}, hue);
	return Buffer.from(b64, "base64");
}

const cursorOf = (l: ReturnType<Page["locator"]>) => l.evaluate((el) => getComputedStyle(el).cursor);

test("tiles, tile controls and lightbox controls show the pointer cursor (FB-02)", async ({ browser }) => {
	test.setTimeout(120_000);
	const dev = await person(browser, "dev@example.com", "Dev", "User");
	const page = dev.page;
	const c = await cloneFixtureTrip(dev.ctx.request);
	await openMedia(page, c.slug);
	for (const [i, hue] of [200, 20].entries()) {
		await page.getByTestId(MEDIA_TESTID.fileInput).setInputFiles({
			name: `tokyo-${i}.jpg`,
			mimeType: "image/jpeg",
			buffer: await jpegFromPage(page, hue),
		});
		await expect(page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=photo][data-status=ready]`)).toHaveCount(
			i + 1,
			{ timeout: 30_000 },
		);
	}
	await clearToasts(page);
	const photo = page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=photo]`).first();
	await photo.hover();
	expect(await cursorOf(photo.getByRole("button", { name: /^Open / }))).toBe("pointer");
	expect(await cursorOf(photo.getByTestId(MEDIA_TESTID.tileMenu))).toBe("pointer");
	expect(await cursorOf(photo.getByTestId(MEDIA_TESTID.visibility))).toBe("pointer");
	expect(await cursorOf(page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=link] a`).first())).toBe("pointer");
	expect(await cursorOf(page.getByTestId(MEDIA_TESTID.filterChip).first())).toBe("pointer");
	expect(await cursorOf(page.getByTestId(MEDIA_TESTID.addButton).first())).toBe("pointer");
	await page.screenshot({ path: shotPath("media/fb02-tile-hover.png") });

	await photo.getByRole("button", { name: /^Open / }).click();
	await expect(page.getByTestId(MEDIA_TESTID.lightbox)).toBeAttached();
	// yarl portals the lightbox to <body>.
	const lb = page.getByRole("dialog", { name: "Lightbox" });
	await expect(lb.locator(".yarl__slide_image").first()).toBeVisible();
	for (const name of ["Previous", "Next", "Close", "Zoom in", "Hide thumbnails"])
		expect(await cursorOf(lb.getByRole("button", { name, exact: true })), name).toBe("pointer");
	expect(await cursorOf(lb.getByRole("link", { name: "Download", exact: true })), "Download").toBe("pointer");
	expect(await cursorOf(lb.getByTestId(MEDIA_TESTID.visibility)), "Hide from guests").toBe("pointer");
	expect(await cursorOf(lb.locator(".yarl__thumbnails_thumbnail").first()), "thumbnail").toBe("pointer");
	await lb.getByRole("button", { name: "Next", exact: true }).hover();
	// Past the open fade, so the shot shows the 92 % backdrop.
	await expect
		.poll(() => page.locator(".yarl__portal").evaluate((el) => getComputedStyle(el).opacity))
		.toBe("1");
	await page.screenshot({ path: shotPath("media/fb02-lightbox.png") });
	await page.keyboard.press("Escape");
	await expect(lb).toHaveCount(0);

	// The inspector's cover strip opens the same lightbox.
	await page.goto(`/t/${c.slug}/japan/tokyo?sel=n.${c.ids.nodes.tokyo}`);
	await expectLive(page);
	const cover = page.getByTestId(TESTID.coverStrip).getByRole("button").first();
	await expect(cover).toBeVisible();
	expect(await cursorOf(cover), "cover strip").toBe("pointer");
	await dev.ctx.close();
});
