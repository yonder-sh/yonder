/**
 * Owner feedback round 1, foundation items:
 *  - FB-01: no TanStack devtools UI (or source injection) anywhere.
 *  - FB-02: everything clickable shows the pointer.
 *  - FB-16: profile pictures: the upload contract, the private route (self +
 *    people who share a trip, 404 for anyone else), a client can't set
 *    `user.image`, and every avatar renders the picture as a circle.
 */
import { randomBytes } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { APP_URL, shotPath } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive, hydrated } from "./_helpers/page";

test.describe.configure({ mode: "serial" });

const rand = () => randomBytes(4).toString("hex");

async function userId(request: APIRequestContext): Promise<string> {
	const s = (await (await request.get("/api/auth/get-session")).json()) as {
		user: { id: string };
	};
	return s.user.id;
}

/** Draws a `w`×`h` PNG in the page and runs create → PUT → commit. */
async function uploadAvatar(
	page: Page,
	opts: { w: number; h: number; color: string; type?: string; bogus?: boolean },
): Promise<{ image: string | null; error?: string }> {
	return page.evaluate(async ({ w, h, color, type, bogus }) => {
		const m = await import("/src/functions/avatar.functions.ts");
		let blob: Blob;
		if (bogus) blob = new Blob(["not a picture at all"], { type: "image/png" });
		else {
			const c = document.createElement("canvas");
			c.width = w;
			c.height = h;
			const g = c.getContext("2d") as CanvasRenderingContext2D;
			g.fillStyle = color;
			g.fillRect(0, 0, w, h);
			g.fillStyle = "#ffffff";
			g.beginPath();
			g.arc(w / 2, h / 2, Math.min(w, h) / 4, 0, Math.PI * 2);
			g.fill();
			blob = await new Promise<Blob>((r) =>
				c.toBlob((b) => r(b as Blob), type ?? "image/png", 0.9),
			);
		}
		try {
			const up = await m.createAvatarUpload({
				data: { contentType: blob.type as "image/png", size: blob.size },
			});
			const put = await fetch(up.url, { method: "PUT", headers: up.headers, body: blob });
			if (!put.ok) return { image: null, error: `PUT ${put.status}` };
			return await m.commitAvatar({ data: { key: up.key } });
		} catch (e) {
			return { image: null, error: String((e as Error).message) };
		}
	}, opts);
}

async function fetchAvatar(page: Page, url: string) {
	return page.evaluate(async (u) => {
		// Past the browser cache: the access rule is what's under test.
		const r = await fetch(u, { cache: "no-store" });
		if (!r.ok) return { status: r.status, type: null, w: 0, h: 0, cache: null };
		const b = await r.blob();
		const bmp = await createImageBitmap(b);
		return {
			status: r.status,
			type: r.headers.get("content-type"),
			w: bmp.width,
			h: bmp.height,
			cache: r.headers.get("cache-control"),
		};
	}, url);
}

test("FB-01: no TanStack devtools in the page", async ({ page }) => {
	await loginViaApi(page.request, `fb1-${rand()}@example.com`, { first: "Dev", last: "Tools" });
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	const found = await page.evaluate(() => ({
		source: document.querySelectorAll("[data-tsd-source]").length,
		shell: document.querySelectorAll(
			'[id*="tanstack" i], [class*="tsqd" i], [class*="tanstack-devtools" i], [data-testid*="devtools" i]',
		).length,
	}));
	expect(found).toEqual({ source: 0, shell: 0 });
});

test("FB-02: clickable things show the pointer", async ({ page }, info) => {
	test.skip(info.project.name === "mobile", "hover cursors are a desktop concern");
	await loginViaApi(page.request, `fb2-${rand()}@example.com`, { first: "Point", last: "Er" });
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const cursor = (sel: string) =>
		page.locator(sel).first().evaluate((el) => getComputedStyle(el).cursor);
	// A plain button, a tab, an outline row (treeitem), a link and a plan card.
	await hydrated(page.getByTestId("trip-menu"));
	expect(await cursor('[data-testid="trip-menu"]')).toBe("pointer");
	expect(await cursor('[role="tab"]')).toBe("pointer");
	expect(await cursor('[data-testid="outline-row"]')).toBe("pointer");
	expect(await cursor("a[href]")).toBe("pointer");
	await expect(page.getByTestId("timeline-item").first()).toBeVisible({ timeout: 20_000 });
	expect(await cursor('[data-testid="timeline-item"] .group\\/card')).toBe("pointer");
	// Menu items (Radix dropdown) — their shadcn class said cursor-default.
	await page.getByTestId("trip-menu").click();
	const item = page.getByRole("menuitem").first();
	await expect(item).toBeVisible();
	expect(await item.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
	await page.keyboard.press("Escape");
	// Disabled buttons don't pretend to be clickable.
	const disabled = await page.evaluate(() => {
		const b = document.createElement("button");
		b.disabled = true;
		document.body.append(b);
		const c = getComputedStyle(b).cursor;
		b.remove();
		return c;
	});
	expect(disabled).toBe("default");
});

test("FB-16: avatar upload, private route, and circles everywhere", async ({ browser }, info) => {
	test.skip(info.project.name === "mobile", "one run covers the server contract");
	const owner = await browser.newContext({ baseURL: APP_URL, viewport: { width: 1440, height: 900 } });
	const maya = await browser.newContext({ baseURL: APP_URL, viewport: { width: 1440, height: 900 } });
	const stranger = await browser.newContext({ baseURL: APP_URL });
	const op = await owner.newPage();
	const mp = await maya.newPage();
	const sp = await stranger.newPage();
	await loginViaApi(op.request, `fb16-${rand()}@example.com`, { first: "Ava", last: "Tar" });
	await loginViaApi(mp.request, "maya@example.com", { first: "Maya", last: "Chen" });
	await loginViaApi(sp.request, `fb16s-${rand()}@example.com`, { first: "Stran", last: "Ger" });
	const c = await cloneFixtureTrip(op.request);
	const ownerId = await userId(op.request);

	await op.goto("/");
	await hydrated(op.getByTestId("account-menu"));
	// A non-square picture (300×200) comes back as square WebPs.
	const up = await uploadAvatar(op, { w: 300, h: 200, color: "#2f7f86" });
	expect(up.error).toBeUndefined();
	expect(up.image).toMatch(new RegExp(`^/api/avatar/${ownerId}\\?v=[a-z0-9]+$`));
	const image = up.image as string;
	for (const s of [64, 128, 256]) {
		const r = await fetchAvatar(op, `${image}&s=${s}`);
		expect(r).toMatchObject({ status: 200, type: "image/webp", w: s, h: s });
		// Private (never a shared cache), but reusable for a day (versioned URL).
		expect(r.cache).toBe("private, max-age=86400");
	}
	// Maya shares the trip: allowed. A stranger: 404, same as a missing picture.
	await mp.goto("/");
	expect((await fetchAvatar(mp, `${image}&s=64`)).status).toBe(200);
	await sp.goto("/");
	expect((await fetchAvatar(sp, `${image}&s=64`)).status).toBe(404);
	const nobody = await browser.newContext({ baseURL: APP_URL });
	expect((await nobody.request.get(image)).status()).toBe(404);
	await nobody.close();

	// Not a picture (a PNG header lie) and a client-set image are refused.
	const bad = await uploadAvatar(op, { w: 1, h: 1, color: "#000", bogus: true });
	expect(bad.error ?? "").toMatch(/picture/i);
	const forged = await op.request.post("/api/auth/update-user", {
		data: { image: "https://example.com/track.png" },
		headers: { Origin: APP_URL, "Content-Type": "application/json" },
	});
	expect(forged.ok()).toBe(false);
	expect((await (await op.request.get("/api/auth/get-session")).json()).user.image).toBe(image);

	// Maya gets a picture too (JPEG).
	await uploadAvatar(mp, { w: 400, h: 400, color: "#b4539a", type: "image/jpeg" });

	// In the trip: the owner's own account avatar, the People list and Maya's
	// presence avatar show pictures, clipped to circles.
	await op.goto(`/t/${c.slug}?sel=root`);
	await expectLive(op);
	await mp.goto(`/t/${c.slug}?sel=root`);
	await expectLive(mp);
	const pictures = op.locator('[data-avatar-image] img[data-slot="avatar-image"]');
	await expect(pictures.first()).toBeVisible({ timeout: 15_000 });
	await expect(op.getByTestId("presence-avatar").locator("img")).toBeVisible({ timeout: 20_000 });
	// The account, People and presence pictures load independently: wait for all three.
	await expect.poll(() => pictures.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
	const shapes = await pictures.evaluateAll((els) =>
		els.map((el) => {
			const img = el as HTMLImageElement;
			const root = img.closest('[data-slot="avatar"]') as HTMLElement;
			const r = root.getBoundingClientRect();
			return {
				loaded: img.complete && img.naturalWidth > 0,
				square: Math.abs(r.width - r.height) < 0.5,
				round: getComputedStyle(root).borderRadius,
				clip: getComputedStyle(root).overflow,
			};
		}),
	);
	expect(shapes.length).toBeGreaterThanOrEqual(3);
	for (const s of shapes) {
		expect(s.loaded).toBe(true);
		expect(s.square).toBe(true);
		expect(s.clip).toBe("hidden");
		expect(Number.parseFloat(s.round)).toBeGreaterThan(8);
	}
	await op.screenshot({ path: shotPath("foundation/fb16-avatars-owner.png") });
	await mp.screenshot({ path: shotPath("foundation/fb16-avatars-maya.png") });

	// Remove: back to initials; the route answers 404.
	const removed = await op.evaluate(async () => {
		const m = await import("/src/functions/avatar.functions.ts");
		return m.removeAvatar();
	});
	expect(removed.image).toBeNull();
	expect((await fetchAvatar(op, `${image}&s=64`)).status).toBe(404);
	await owner.close();
	await maya.close();
	await stranger.close();
});

test("QA TL-02 (R3): the duration chip opens with the field focused; '3h' + Enter sets 3h", async ({ page }, info) => {
	test.skip(info.project.name === "mobile", "desktop card chip");
	await loginViaApi(page.request, `tl02-${rand()}@example.com`, { first: "Dur", last: "Ation" });
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	const chip = page.getByTestId("plan-item-duration").first().getByRole("button");
	await hydrated(chip);
	const before = (await chip.textContent())?.trim();
	await chip.click();
	const field = page.getByLabel("Duration", { exact: true });
	await expect(field).toBeVisible();
	await expect(field).toBeFocused();
	await page.keyboard.type("3h");
	await page.keyboard.press("Enter");
	await expect(chip).toHaveText("3h");
	expect(before).not.toBe("3h");
});
