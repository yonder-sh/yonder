/**
 * MOB-07 at 390 px: the small controls of push, the digest, Activity, live
 * cursors and media take a 44×44 tap. A control's hit area is its box or its
 * `touch-hit` ::before, and the edges of that area must hit the control
 * (`elementFromPoint`), so a clipped or covered hit area fails too.
 * Shots (the hit areas outlined) in `e2e/shots/tap/<TAP_SHOTS or after>-*`.
 */
import { randomUUID } from "node:crypto";
import { type Browser, devices, expect, type Locator, type Page, test } from "@playwright/test";
import { makePdf } from "../../../src/features/media/__tests__/make-pdf";
import { MEDIA_TESTID as MT } from "../../../src/features/media/testids";
import { PUSH_TESTID as P } from "../../../src/features/push/testids";
import { SHELL_TESTID as S } from "../../../src/features/shell/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

const { defaultBrowserType: _d, ...pixel } = devices["Pixel 7"];
const PHONE = { ...pixel, viewport: { width: 390, height: 844 } };
test.use({ ...PHONE, storageState: storageStateOf("dev") });
test.beforeEach(({}, info) => {
	test.skip(info.project.name !== "mobile", "a phone check");
});

const SHOTS = process.env.TAP_SHOTS ?? "after";
const S3 = process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:8080";

type Hit = { label: string; w: number; h: number; edges: number };

/** The hit area of each match: its box or its ::before, and how many of its 4 edges hit it. */
async function hits(label: string, loc: Locator): Promise<Hit[]> {
	const out: Hit[] = [];
	for (const [i, el] of (await loc.all()).entries()) {
		if (!(await el.isVisible())) continue;
		await el.scrollIntoViewIfNeeded();
		const h = await el.evaluate((node) => {
			const r = node.getBoundingClientRect();
			const b = getComputedStyle(node, "::before");
			const pseudo = b.content !== "none" && b.position === "absolute";
			const w = Math.max(r.width, pseudo ? Number.parseFloat(b.width) : 0);
			const h = Math.max(r.height, pseudo ? Number.parseFloat(b.height) : 0);
			const cx = r.left + r.width / 2;
			const cy = r.top + r.height / 2;
			const pts = [
				[cx - w / 2 + 2, cy],
				[cx + w / 2 - 2, cy],
				[cx, cy - h / 2 + 2],
				[cx, cy + h / 2 - 2],
			];
			let edges = 0;
			for (const [x, y] of pts) {
				const at = document.elementFromPoint(x as number, y as number);
				if (at && (at === node || node.contains(at))) edges++;
			}
			// Outline it for the shots.
			const o = document.createElement("div");
			o.dataset.tapOutline = "";
			Object.assign(o.style, {
				position: "fixed",
				left: `${cx - w / 2}px`,
				top: `${cy - h / 2}px`,
				width: `${w}px`,
				height: `${h}px`,
				outline: `1.5px dashed ${w >= 44 && h >= 44 ? "#16a34a" : "#dc2626"}`,
				pointerEvents: "none",
				zIndex: "2147483647",
			});
			document.body.append(o);
			return { w: Math.round(w), h: Math.round(h), edges };
		});
		out.push({ label: `${label}#${i}`, ...h });
	}
	return out;
}

/** Every hit area is 44×44 at least and its edges reach the control. */
function expectTappable(all: Hit[], min = 1) {
	expect(all.length, "controls found").toBeGreaterThanOrEqual(min);
	const bad = all.filter((x) => x.w < 44 || x.h < 44 || x.edges < 4);
	expect.soft(bad, bad.map((b) => `${b.label} ${b.w}×${b.h} edges ${b.edges}/4`).join("\n")).toEqual([]);
}

async function shot(page: Page, name: string) {
	await page.waitForTimeout(250);
	await page.screenshot({ path: shotPath(`tap/${SHOTS}-${name}.png`), animations: "disabled" });
	await page.evaluate(() => {
		for (const o of document.querySelectorAll("[data-tap-outline]")) o.remove();
	});
}

async function as(browser: Browser, who: string, url: string, phone = true): Promise<Page> {
	const ctx = await browser.newContext({ ...(phone ? PHONE : {}), storageState: storageStateOf(who) });
	const page = await ctx.newPage();
	await page.goto(url);
	return page;
}

async function jpeg(page: Page): Promise<Buffer> {
	const b64 = await page.evaluate(async () => {
		const c = document.createElement("canvas");
		c.width = 320;
		c.height = 240;
		const g = c.getContext("2d") as CanvasRenderingContext2D;
		g.fillStyle = "hsl(200 60% 55%)";
		g.fillRect(0, 0, 320, 240);
		const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), "image/jpeg", 0.8));
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let s = "";
		for (const x of bytes) s += String.fromCharCode(x);
		return btoa(s);
	});
	return Buffer.from(b64, "base64");
}

test("Notifications: whole rows toggle, Unmute and the close take a 44 px tap", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expectLive(page);
	await page.evaluate(async (tripId) => {
		const m = await import("/src/functions/push.functions.ts");
		await m.setTripMuted({ data: { tripId, muted: true } });
	}, c.tripId);
	// The settings were read with the page: read them again.
	await page.reload();
	await expectLive(page);
	await page.locator(`[data-testid="${TESTID.mobilePills}"] [aria-label="More"]`).tap();
	await page.getByTestId(P.accountItem).tap();
	const dialog = page.getByTestId(P.dialog);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId(P.mutedTrip)).toHaveCount(1);
	await page.waitForTimeout(300);
	const all = [
		...(await hits("close", dialog.locator('[data-slot="dialog-close"]'))),
		...(await hits("row", dialog.locator(`label:has([data-testid="${P.type}"])`))),
		...(await hits("unmute", dialog.getByRole("button", { name: "Unmute" }))),
	];
	await shot(page, "notifications");
	expectTappable(all, 5);
	// A tap on a row's words flips its switch.
	const sw = dialog.getByTestId(P.type).first();
	const was = await sw.getAttribute("aria-checked");
	await dialog.locator(`label:has([data-testid="${P.type}"])`).first().locator("span").first().tap();
	await expect(sw).not.toHaveAttribute("aria-checked", was ?? "");
});

test("digest banner and Activity lines take a 44 px tap", async ({ page, browser }) => {
	const c = await cloneFixtureTrip(page.request);
	test.skip(!c.members.maya, "maya@example.com is not seeded");
	await page.goto(`/t/${c.slug}?tab=plan&lens=place`);
	await expectLive(page);
	const maya = await as(browser, "maya", `/t/${c.slug}?tab=plan&lens=place`, false);
	await expectLive(maya);
	await maya.evaluate(
		async ({ tripId, parentId, id }) => {
			const m = await import("/src/functions/nodes.functions.ts");
			return m.createNode({
				data: { tripId, parentId, id, type: "place", category: "food_drink", name: "Nishiki Market" },
			});
		},
		{ tripId: c.tripId, parentId: c.ids.nodes.kyoto, id: randomUUID() },
	);
	await page.reload();
	await expectLive(page);
	const banner = page.getByTestId(S.digestBanner);
	await expect(banner).toBeVisible();
	const all = [
		...(await hits("digest link", banner.getByRole("button", { name: /since you last looked/ }))),
		...(await hits("got it", page.getByTestId(S.digestGotIt))),
	];
	await shot(page, "digest");
	expectTappable(all, 2);
	await banner.getByRole("button", { name: /since you last looked/ }).tap();
	const dialog = page.getByTestId(S.activityDialog);
	await expect(dialog).toContainText("added Nishiki Market");
	await page.waitForTimeout(300);
	const lines = [
		...(await hits("activity line", dialog.locator("li button:enabled"))),
		...(await hits("close", dialog.locator('[data-slot="dialog-close"]'))),
	];
	await shot(page, "activity");
	expectTappable(lines, 2);
	await maya.context().close();
});

test("cursors: the reaction palette fits and takes 44 px taps; edge arrows never catch a tap", async ({ page }) => {
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?tab=plan&lens=place`);
	await expectLive(page);
	const card = page.locator(`[data-cursor-anchor="item:${c.ids.items.meiji}"]`);
	await card.evaluate((el) => el.scrollIntoView({ block: "center" }));
	await page.waitForTimeout(400);
	const box = await card.boundingBox();
	if (!box) throw new Error("no card");
	const cdp = await page.context().newCDPSession(page);
	const at = { x: Math.round(box.x + box.width * 0.35), y: Math.round(box.y + box.height / 2) };
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
	await page.waitForTimeout(650);
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	const palette = page.getByTestId(S.reactionPalette);
	await expect(palette).toBeVisible();
	await page.waitForTimeout(400);
	const pb = await palette.boundingBox();
	expect(pb).not.toBeNull();
	if (pb) {
		expect(pb.x).toBeGreaterThanOrEqual(0);
		expect(pb.x + pb.width).toBeLessThanOrEqual(390);
	}
	const all = await hits("reaction", palette.getByRole("button"));
	await shot(page, "palette");
	expectTappable(all, 8);
	await page.keyboard.press("Escape");
	// An edge arrow (made here: no one else is on the trip) only points under a finger.
	const edge = await page.getByTestId(S.cursorLayer).evaluate((layer) => {
		const b = document.createElement("button");
		b.className = "yc-edge";
		b.dataset.state = "on";
		layer.append(b);
		const pe = getComputedStyle(b).pointerEvents;
		b.remove();
		return pe;
	});
	expect(edge).toBe("none");
});

test("media: tile menu, chips, Add, Cancel and Retry take a 44 px tap", async ({ page }) => {
	test.setTimeout(120_000);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=media`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.mediaTab)).toBeVisible();
	const input = page.getByTestId(MT.fileInput).first();
	await input.setInputFiles({ name: "tap-photo.jpg", mimeType: "image/jpeg", buffer: await jpeg(page) });
	await input.setInputFiles({
		name: "Tap map.pdf",
		mimeType: "application/pdf",
		buffer: makePdf(["Tap map"], { title: "Tap" }),
	});
	const photo = page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=photo]`);
	await expect(photo).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
	await expect(page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=pdf]`)).toHaveAttribute(
		"data-status",
		"ready",
		{ timeout: 30_000 },
	);
	await page.waitForTimeout(500);
	const all = [
		...(await hits("tile menu", page.getByTestId(MT.tileMenu))),
		...(await hits("chip", page.getByTestId(MT.filterChip))),
		...(await hits("add", page.getByTestId(MT.addButton).first())),
	];
	await shot(page, "media");
	expectTappable(all, 5);

	// An upload held mid-flight: its Cancel.
	let release: () => void = () => {};
	const held = new Promise<void>((r) => {
		release = r;
	});
	await page.route(
		(u) => u.href.startsWith(S3),
		async (route) => {
			if (route.request().method() !== "PUT") return route.continue();
			await held;
			return route.abort();
		},
	);
	await input.setInputFiles({ name: "held.jpg", mimeType: "image/jpeg", buffer: await jpeg(page) });
	const cancel = page.getByTestId(MT.uploadCancel);
	await expect(cancel).toBeVisible({ timeout: 15_000 });
	const up = await hits("cancel", cancel);
	await shot(page, "upload-cancel");
	expectTappable(up, 1);
	await cancel.tap();
	await expect(page.getByTestId(MT.uploadTile)).toHaveCount(0);
	release();

	// A refused upload: its Retry and Dismiss.
	await page.unroute((u) => u.href.startsWith(S3));
	await page.route(
		(u) => u.href.startsWith(S3),
		(route) =>
			route.request().method() === "PUT" ? route.fulfill({ status: 403, body: "no" }) : route.continue(),
	);
	await input.setInputFiles({ name: "refused.jpg", mimeType: "image/jpeg", buffer: await jpeg(page) });
	const failed = page.locator(`[data-testid="${MT.uploadTile}"][data-phase="failed"]`);
	await expect(failed).toBeVisible({ timeout: 60_000 });
	await page.waitForTimeout(300);
	const retry = await hits("retry/dismiss", failed.getByRole("button"));
	await shot(page, "upload-failed");
	expectTappable(retry, 2);
});
