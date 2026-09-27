/**
 * Chunked uploads through the app: a 40 MB video (a real MP4 made here with
 * ffmpeg, padded with an ISO-BMFF `free` box) goes straight to S3 as a
 * multipart upload in 16 MB parts, several at a time; one part that fails
 * is retried on its own; progress moves; the server completes it and the
 * worker makes the poster. Needs the worker (`pnpm dev` runs it) and ffmpeg
 * (FFMPEG_PATH or on PATH) for the test file.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { MEDIA_TESTID } from "../../../src/features/media/testids";
import { TESTID } from "../../../src/lib/testids";
import { storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

const MiB = 1024 * 1024;

/** A real 3 s MP4 (ffmpeg's test pattern) padded to exactly `size` bytes with a trailing `free` box. */
function paddedMp4(size: number): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "yonder-mp4-"));
	const clip = path.join(dir, "clip.mp4");
	execFileSync(process.env.FFMPEG_PATH || "ffmpeg", [
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc=size=320x240:rate=15",
		"-t",
		"3",
		"-c:v",
		"mpeg4",
		"-y",
		clip,
	]);
	const head = readFileSync(clip);
	const pad = size - head.length;
	const free = Buffer.alloc(pad);
	free.writeUInt32BE(pad, 0);
	free.write("free", 4, "latin1");
	const out = path.join(dir, "fuji-timelapse.mp4");
	writeFileSync(out, Buffer.concat([head, free]));
	return out;
}

test("a 40 MB video goes up in 16 MB parts, a failed part is retried alone, and the worker processes it", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "one desktop run");
	test.setTimeout(180_000);
	const file = paddedMp4(40 * MiB);
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}/japan/tokyo?tab=media`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.mediaTab)).toBeVisible();

	// Every PUT of the original, and the first try of part 2 dropped once.
	const puts: URL[] = [];
	page.on("request", (r) => {
		if (r.method() === "PUT" && r.url().includes("/original.upload")) puts.push(new URL(r.url()));
	});
	let dropped = 0;
	await page.route(
		(u) => u.pathname.endsWith("/original.upload") && u.searchParams.get("partNumber") === "2",
		async (route) => {
			if (dropped++ === 0) return route.abort("connectionreset");
			return route.continue();
		},
	);
	// Slow uploads down enough to watch the progress ring move.
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Network.enable");
	await cdp.send("Network.emulateNetworkConditions", {
		offline: false,
		latency: 0,
		downloadThroughput: -1,
		uploadThroughput: 24 * MiB,
	});
	await page.evaluate(() => {
		const seen: number[] = [];
		(window as unknown as { __progress: number[] }).__progress = seen;
		new MutationObserver(() => {
			for (const el of document.querySelectorAll("[data-testid=media-upload-tile] [role=progressbar]"))
				seen.push(Number(el.getAttribute("aria-valuenow")));
		}).observe(document.body, { subtree: true, attributes: true, childList: true });
	});

	await page.getByTestId(MEDIA_TESTID.fileInput).setInputFiles(file);
	const tile = page.locator(`[data-testid=${TESTID.galleryItem}][data-kind=video]`);
	await expect(tile).toHaveCount(1, { timeout: 60_000 });
	const id = await tile.getAttribute("data-id");
	await expect(tile).toHaveAttribute("data-status", "ready", { timeout: 90_000 });

	// Multipart only: three parts, part 2 twice (dropped, then retried), nothing else.
	expect(puts.length).toBeGreaterThanOrEqual(4);
	expect(puts.every((u) => u.searchParams.has("partNumber") && u.searchParams.has("uploadId"))).toBe(true);
	const counts = new Map<string, number>();
	for (const u of puts) counts.set(u.searchParams.get("partNumber") ?? "", (counts.get(u.searchParams.get("partNumber") ?? "") ?? 0) + 1);
	expect([...counts.keys()].sort()).toEqual(["1", "2", "3"]);
	expect(counts.get("1")).toBe(1);
	expect(counts.get("3")).toBe(1);
	expect(counts.get("2")).toBe(2);
	for (const u of puts) expect(u.searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
	// The ring moved through the upload.
	const progress = await page.evaluate(() => (window as unknown as { __progress: number[] }).__progress);
	expect(progress.some((v) => v > 0 && v < 100)).toBe(true);

	// The stored original is the whole file, served through the app's redirect.
	const res = await page.request.get(`/media/${id}/original`, { maxRedirects: 0 });
	expect(res.status()).toBe(302);
	const location = res.headers().location ?? "";
	expect(new URL(location).searchParams.get("response-content-type")).toBe("video/mp4");
	// (A presigned GET signs the method: read one byte and the total size.)
	const first = await page.request.get(location, { headers: { Range: "bytes=0-0" } });
	expect(first.status()).toBe(206);
	expect(first.headers()["content-range"]).toBe(`bytes 0-0/${40 * MiB}`);
});
