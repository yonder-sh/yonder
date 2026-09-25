/**
 * The upload queue's last step (ADDENDUM §9): a link guest's PDF on a flight
 * starts hidden from guests — the guest included — so it never joins their
 * gallery and the toast says where it went; a member's upload joins the
 * cache as before.
 */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tripKeys } from "@/lib/query/keys";
import type { MediaDto } from "../types";

const fns = vi.hoisted(() => ({
	createUpload: vi.fn(),
	completeUpload: vi.fn(),
	createPosterUpload: vi.fn(),
	deleteAttachment: vi.fn(),
	updateAttachment: vi.fn(),
	signUploadParts: vi.fn(),
	abortUpload: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../media.functions", () => fns);

const prep = vi.hoisted(() => ({
	prepareFile: vi.fn(),
	PrepareError: class PrepareError extends Error {},
}));
vi.mock("../upload/prepare", () => prep);

const toasts = vi.hoisted(() => {
	const t = Object.assign(vi.fn(), {
		loading: vi.fn(() => "t1"),
		success: vi.fn(),
		error: vi.fn(),
		dismiss: vi.fn(),
	});
	return t;
});
vi.mock("sonner", () => ({ toast: toasts }));

import {
	addedMessage,
	cancelUpload,
	PART_CONCURRENCY,
	retryDelay,
	startUploads,
	useUploads,
} from "../upload/uploader";

/** Every PUT the uploader made: its URL, body size and headers. */
const puts: { url: string; size: number; headers: Record<string, string> }[] =
	[];
/** How a PUT to a URL answers: `ok`, `fail` (a network error) or `hold` (never ends). */
let answer: (url: string, attempt: number) => "ok" | "fail" | "hold" = () =>
	"ok";
let inFlight = 0;
let maxInFlight = 0;

class FakeXhr {
	upload: { onprogress?: (e: unknown) => void } = {};
	status = 200;
	onload?: () => void;
	onerror?: () => void;
	onabort?: () => void;
	private url = "";
	private headers: Record<string, string> = {};
	private done = false;
	open(_method: string, url: string) {
		this.url = url;
	}
	setRequestHeader(k: string, v: string) {
		this.headers[k.toLowerCase()] = v;
	}
	send(body: Blob) {
		// Earlier PUTs of the same object part (a retry has a fresh URL).
		const path = this.url.split("?")[0];
		const attempt = puts.filter((p) => p.url.split("?")[0] === path).length;
		puts.push({ url: this.url, size: body.size, headers: this.headers });
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		const how = answer(this.url, attempt);
		if (how === "hold") return;
		setTimeout(() => {
			if (this.done) return;
			this.done = true;
			inFlight -= 1;
			this.upload.onprogress?.({
				lengthComputable: true,
				loaded: body.size,
				total: body.size,
			});
			if (how === "ok") this.onload?.();
			else this.onerror?.();
		}, 1);
	}
	abort() {
		if (this.done) return;
		this.done = true;
		inFlight -= 1;
		this.onabort?.();
	}
}

const TRIP = "00000000-0000-7000-8000-00000000f001";
const ID = "00000000-0000-7000-8000-00000000a0a1";
const FLIGHT = {
	kind: "leg",
	legId: "00000000-0000-7000-8000-00000000b001",
} as const;

function dto(visibility: "everyone" | "members"): MediaDto {
	return {
		id: ID,
		target: FLIGHT,
		kind: "pdf",
		status: "processing",
		visibility,
		mime: "application/pdf",
		width: null,
		height: null,
		durationSec: null,
		thumbhash: null,
		takenAt: null,
		url: null,
		provider: null,
		embedId: null,
		title: "Guest boarding pass.pdf",
		siteName: null,
		caption: null,
		position: "a0",
		createdAt: "2026-09-23T00:00:00.000Z",
		updatedAt: "2026-09-23T00:00:00.000Z",
		description: null,
		author: null,
		sizeBytes: 1234,
		hasThumb: false,
		hasImage: false,
		hasFavicon: false,
		aspect: null,
		pages: 0,
		pageCount: null,
		igType: null,
		license: null,
		licenseUrl: null,
		sourceUrl: null,
		fetch: null,
		mine: true,
	};
}

async function upload(guest: boolean, visibility: "everyone" | "members") {
	const qc = new QueryClient();
	qc.setQueryData(tripKeys.media(TRIP), []);
	const blob = new Blob(["%PDF-1.4"], { type: "application/pdf" });
	prep.prepareFile.mockResolvedValue({
		blob,
		type: "application/pdf",
		name: "Guest boarding pass.pdf",
		kind: "pdf",
		previewUrl: null,
	});
	fns.createUpload.mockResolvedValue({ id: ID, url: "http://s3/put" });
	fns.completeUpload.mockResolvedValue(dto(visibility));
	startUploads(
		[
			new File([blob], "Guest boarding pass.pdf", {
				type: "application/pdf",
			}),
		],
		{
			tripId: TRIP,
			target: FLIGHT,
			queryClient: qc,
			label: "JFK Terminal 7 → HND Terminal 3",
			guest,
		},
	);
	await vi.waitFor(() => expect(toasts.success).toHaveBeenCalled());
	return qc;
}

beforeEach(() => {
	vi.stubGlobal("XMLHttpRequest", FakeXhr);
	useUploads.setState({ items: [], previews: {} });
	puts.length = 0;
	answer = () => "ok";
	inFlight = 0;
	maxInFlight = 0;
	retryDelay.ms = () => 1;
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("addedMessage (ADDENDUM §9)", () => {
	const pdf = (visibility: "everyone" | "members") => ({
		kind: "pdf" as const,
		visibility,
	});
	it("says a guest's hidden upload went to trip members", () => {
		expect(addedMessage([pdf("members")], "NH 9", true)).toBe(
			"1 PDF added to NH 9 — hidden from guests; only trip members can see it",
		);
		expect(addedMessage([pdf("members"), pdf("everyone")], "NH 9", true)).toBe(
			"2 PDFs added to NH 9 — 1 PDF hidden from guests; only trip members can see it",
		);
	});
	it("stays plain for members and for uploads guests can see", () => {
		expect(addedMessage([pdf("members")], "NH 9", false)).toBe(
			"1 PDF added to NH 9",
		);
		expect(addedMessage([pdf("everyone")], "NH 9", true)).toBe(
			"1 PDF added to NH 9",
		);
	});
});

describe("startUploads: who sees the finished upload", () => {
	it("a guest's e-ticket on a flight: no tile, and the toast says why", async () => {
		const qc = await upload(true, "members");
		expect(toasts.success).toHaveBeenCalledWith(
			"1 PDF added to JFK Terminal 7 → HND Terminal 3 — hidden from guests; only trip members can see it",
			expect.objectContaining({ id: "t1", duration: 10_000 }),
		);
		expect(qc.getQueryData(tripKeys.media(TRIP))).toEqual([]);
		expect(useUploads.getState().items).toEqual([]);
	});

	it("a member's e-ticket joins their gallery (with the lock chip)", async () => {
		const qc = await upload(false, "members");
		expect(toasts.success).toHaveBeenCalledWith(
			"1 PDF added to JFK Terminal 7 → HND Terminal 3",
			{ id: "t1" },
		);
		expect(
			(qc.getQueryData(tripKeys.media(TRIP)) as MediaDto[]).map((m) => [
				m.id,
				m.visibility,
			]),
		).toEqual([[ID, "members"]]);
		expect(useUploads.getState().items).toEqual([]);
	});

	it("a guest's general PDF stays in their gallery", async () => {
		const qc = await upload(true, "everyone");
		expect(toasts.success).toHaveBeenCalledWith(
			"1 PDF added to JFK Terminal 7 → HND Terminal 3",
			{ id: "t1" },
		);
		expect(qc.getQueryData(tripKeys.media(TRIP))).toHaveLength(1);
	});
});

describe("multipart uploads (files over 16 MB)", () => {
	// The server names the part size, so tiny "MiB" keep the blobs small here.
	const MiB = 1024;
	const VIDEO_ID = "00000000-0000-7000-8000-00000000a0b2";

	function video(size: number) {
		const blob = new Blob([new Uint8Array(size)], { type: "video/mp4" });
		prep.prepareFile.mockResolvedValue({
			blob,
			type: "video/mp4",
			name: "fuji.mp4",
			kind: "video",
			previewUrl: null,
		});
		fns.createUpload.mockResolvedValue({
			id: VIDEO_ID,
			multipart: { partSize: 16 * MiB, parts: Math.ceil(size / (16 * MiB)) },
		});
		fns.signUploadParts.mockImplementation(
			async ({ data }: { data: { parts: number[] } }) => ({
				urls: data.parts.map((part) => ({
					part,
					url: `http://s3/part-${part}?sig=${fns.signUploadParts.mock.calls.length}`,
				})),
			}),
		);
		fns.completeUpload.mockResolvedValue({
			...dto("everyone"),
			id: VIDEO_ID,
			kind: "video",
		});
		return blob;
	}

	const start = (blob: Blob) =>
		startUploads([new File([blob], "fuji.mp4", { type: "video/mp4" })], {
			tripId: TRIP,
			target: { kind: "trip" },
			queryClient: new QueryClient(),
			label: "Fuji",
		});

	it("PUTs every part, a few at a time, with no Content-Type, then completes", async () => {
		start(video(100 * MiB));
		await vi.waitFor(() => expect(fns.completeUpload).toHaveBeenCalled());
		const byPart = new Map(
			puts.map((p) => [Number(/part-(\d+)/.exec(p.url)?.[1]), p]),
		);
		expect([...byPart.keys()].sort((a, b) => a - b)).toEqual([
			1, 2, 3, 4, 5, 6, 7,
		]);
		expect(byPart.get(1)?.size).toBe(16 * MiB);
		expect(byPart.get(7)?.size).toBe(4 * MiB);
		expect(puts.every((p) => !("content-type" in p.headers))).toBe(true);
		expect(maxInFlight).toBeGreaterThan(1);
		expect(maxInFlight).toBeLessThanOrEqual(PART_CONCURRENCY);
		// URLs are asked for in batches, not one call per part.
		expect(fns.signUploadParts.mock.calls.length).toBeLessThan(7);
		expect(fns.completeUpload).toHaveBeenCalledWith({
			data: expect.objectContaining({ id: VIDEO_ID }),
		});
		expect(fns.abortUpload).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(toasts.success).toHaveBeenCalled());
	});

	it("retries a failed part alone, with a fresh URL, and the file still goes up", async () => {
		answer = (url, attempt) =>
			url.includes("part-2?") && attempt < 2 ? "fail" : "ok";
		start(video(40 * MiB));
		await vi.waitFor(() => expect(fns.completeUpload).toHaveBeenCalled());
		const part2 = puts.filter((p) => p.url.includes("part-2?"));
		expect(part2.length).toBeGreaterThanOrEqual(3);
		// Parts 1 and 3 went up once each.
		expect(puts.filter((p) => p.url.includes("part-1?"))).toHaveLength(1);
		expect(puts.filter((p) => p.url.includes("part-3?"))).toHaveLength(1);
		// Each retry of part 2 asked for a new URL.
		expect(
			fns.signUploadParts.mock.calls.filter(
				(args: unknown[]) =>
					(args[0] as { data: { parts: number[] } }).data.parts[0] === 2,
			).length,
		).toBeGreaterThanOrEqual(2);
	});

	it("a part that keeps failing fails the upload and drops it (abortUpload)", async () => {
		answer = (url) => (url.includes("part-3") ? "fail" : "ok");
		start(video(40 * MiB));
		await vi.waitFor(() =>
			expect(fns.abortUpload).toHaveBeenCalledWith({ data: { id: VIDEO_ID } }),
		);
		expect(fns.completeUpload).not.toHaveBeenCalled();
		await vi.waitFor(() =>
			expect(useUploads.getState().items[0]).toMatchObject({
				phase: "failed",
				retryable: true,
			}),
		);
	});

	it("cancel aborts every part in flight and drops the upload", async () => {
		answer = () => "hold";
		start(video(64 * MiB));
		await vi.waitFor(() => expect(inFlight).toBe(PART_CONCURRENCY));
		const key = useUploads.getState().items[0]?.key as string;
		cancelUpload(key);
		expect(inFlight).toBe(0);
		expect(fns.abortUpload).toHaveBeenCalledWith({ data: { id: VIDEO_ID } });
		expect(useUploads.getState().items).toEqual([]);
		await new Promise((r) => setTimeout(r, 20));
		expect(fns.completeUpload).not.toHaveBeenCalled();
		// Nothing started after the cancel.
		expect(puts).toHaveLength(PART_CONCURRENCY);
	});
});

describe("storage quota (ADDENDUM §12)", () => {
	it("an upload over the quota is refused before any bytes go up: a toast with the numbers, no tile", async () => {
		const blob = new Blob(["%PDF-1.4"], { type: "application/pdf" });
		prep.prepareFile.mockResolvedValue({
			blob,
			type: "application/pdf",
			name: "big.pdf",
			kind: "pdf",
			previewUrl: null,
		});
		const why =
			"This upload needs 20.0 MB but you have 300 MB left (4.7 GB of 5 GB used). Delete some uploads or ask the trip owner.";
		fns.createUpload.mockRejectedValue(new Error(`STORAGE_QUOTA: ${why}`));
		startUploads([new File([blob], "big.pdf", { type: "application/pdf" })], {
			tripId: TRIP,
			target: { kind: "trip" },
			queryClient: new QueryClient(),
			label: "Tokyo",
		});
		await vi.waitFor(() =>
			expect(toasts.error).toHaveBeenCalledWith(why, expect.anything()),
		);
		expect(puts).toHaveLength(0);
		expect(useUploads.getState().items).toEqual([]);
	});
});
