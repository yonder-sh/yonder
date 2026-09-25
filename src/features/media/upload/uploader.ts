/**
 * The upload queue (SPEC §15.2, DESIGN §7.2, QA MED-01/02/06/08, ERR-05):
 * validate → prepare (HEIC, poster, EXIF) → `createUpload` → XHR PUT
 * straight to S3 with progress → poster PUT → `completeUpload` → the tile.
 *
 * - Files over one part (16 MB) go up as a multipart upload: `PART_CONCURRENCY`
 *   parts at a time, each PUT with its own presigned URL (`signUploadParts`,
 *   asked for in small batches as the upload gets there), a failed part
 *   retried on its own with backoff and a fresh URL; progress counts the
 *   bytes of every part in flight.
 * - Three files at a time; each batch gets one progress toast; a refused
 *   file (MED-06, or over the storage quota: ADDENDUM §12) says why in its
 *   own toast and leaves no tile.
 * - Cancel aborts every PUT and drops the upload (`abortUpload`: the parts
 *   and the pending row), so no broken tile or live orphan row remains; a
 *   failure keeps a tile with Retry (a retry starts over with a fresh row).
 * - While the worker makes the variants, tiles show the local preview
 *   (`localPreview(id)`).
 * - A link guest's upload that starts hidden from guests (ADDENDUM §9: a PDF
 *   on a flight, stay or reserved transit) never reaches their own gallery,
 *   so it never joins their cache and the batch toast says where it went.
 */
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { create } from "zustand";
import { errorCode, humanError } from "@/lib/errors";
import { tripKeys } from "@/lib/query/keys";
import type { AttachmentTarget } from "@/lib/schemas/targets";
import {
	abortUpload,
	completeUpload,
	createPosterUpload,
	createUpload,
	type MediaDto,
	signUploadParts,
	updateAttachment,
} from "../media.functions";
import type { UploadType } from "../media-kinds";
import { type Prepared, PrepareError, prepareFile } from "./prepare";

export type UploadPhase = "preparing" | "uploading" | "finishing" | "failed";

export type UploadItem = {
	key: string;
	tripId: string;
	target: AttachmentTarget;
	name: string;
	kind: "photo" | "video" | "pdf" | null;
	size: number;
	previewUrl: string | null;
	width?: number;
	height?: number;
	/** 0…1 */
	progress: number;
	phase: UploadPhase;
	error: string | null;
	/** A refused file (wrong type, too big, HEIC that won't convert) can't be retried. */
	retryable: boolean;
	attachmentId: string | null;
	/** `UploadContext.guest`, kept so a retry says the same thing. */
	guest: boolean;
};

type Store = {
	items: UploadItem[];
	/** attachmentId → local object URL, until the worker's thumb is ready. */
	previews: Record<string, string>;
};

export const useUploads = create<Store>(() => ({ items: [], previews: {} }));

const files = new Map<string, File>();
/** The PUTs in flight per upload (several parts of one file at once). */
const xhrs = new Map<string, Set<XMLHttpRequest>>();
let seq = 0;

/** Parts of one file in flight at once. */
export const PART_CONCURRENCY = 4;
/** Retries of one failed part (then the whole upload fails). */
export const PART_RETRIES = 5;
/** Part URLs asked for at once. */
const SIGN_BATCH = 8;
/** A part URL lives 10 min (SEC-R1-08); one older than this is signed again. */
const URL_FRESH_MS = 8 * 60_000;
/** 1 s, 2 s, 4 s … (+ up to 30 % jitter), tests shorten it. */
export const retryDelay = {
	ms: (attempt: number) => 1000 * 2 ** attempt * (1 + Math.random() * 0.3),
};

function patch(key: string, p: Partial<UploadItem>) {
	useUploads.setState((s) => ({
		items: s.items.map((i) => (i.key === key ? { ...i, ...p } : i)),
	}));
}

function removeItem(key: string, keepPreview = false) {
	const item = useUploads.getState().items.find((i) => i.key === key);
	if (item?.previewUrl && !keepPreview) URL.revokeObjectURL(item.previewUrl);
	files.delete(key);
	xhrs.delete(key);
	useUploads.setState((s) => ({ items: s.items.filter((i) => i.key !== key) }));
}

/** The local preview of an uploaded attachment still being processed. */
export function localPreview(attachmentId: string): string | null {
	return useUploads.getState().previews[attachmentId] ?? null;
}

/** Drop a local preview once the server thumb exists. */
export function releasePreview(attachmentId: string) {
	const url = useUploads.getState().previews[attachmentId];
	if (!url) return;
	URL.revokeObjectURL(url);
	useUploads.setState((s) => {
		const { [attachmentId]: _gone, ...rest } = s.previews;
		return { previews: rest };
	});
}

class Cancelled extends Error {}
/** A failure whose message is written for the person uploading. */
class UploadError extends Error {}

function isActive(key: string): boolean {
	return useUploads.getState().items.some((i) => i.key === key);
}

/** One PUT to a presigned URL. `type` null: no Content-Type (a part; the upload has it). */
function put(
	key: string,
	url: string,
	body: Blob,
	type: string | null,
	onProgress?: (f: number) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		const mine = xhrs.get(key) ?? new Set<XMLHttpRequest>();
		xhrs.set(key, mine);
		mine.add(xhr);
		const done = () => mine.delete(xhr);
		xhr.open("PUT", url);
		if (type) xhr.setRequestHeader("Content-Type", type);
		if (onProgress)
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable) onProgress(e.loaded / e.total);
			};
		xhr.onload = () => {
			done();
			if (xhr.status >= 200 && xhr.status < 300) resolve();
			else
				reject(
					new UploadError("The upload was refused by storage. Try again."),
				);
		};
		xhr.onerror = () => {
			done();
			reject(
				new UploadError(
					"The upload stopped — check your connection and retry.",
				),
			);
		};
		xhr.onabort = () => {
			done();
			reject(new Cancelled("cancelled"));
		};
		xhr.send(body);
	});
}

function abortPuts(key: string) {
	for (const xhr of [...(xhrs.get(key) ?? [])]) xhr.abort();
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * A multipart upload's parts: `PART_CONCURRENCY` at a time, each retried on
 * its own (`PART_RETRIES`, backoff, a freshly signed URL) before the upload
 * fails; `onProgress` gets the fraction of all bytes sent.
 */
async function putParts(
	key: string,
	id: string,
	blob: Blob,
	mp: { partSize: number; parts: number },
	onProgress: (f: number) => void,
	active: () => boolean = () => isActive(key),
): Promise<void> {
	const sent = new Array<number>(mp.parts).fill(0);
	const report = () =>
		onProgress(sent.reduce((a, b) => a + b, 0) / Math.max(1, blob.size));
	const urls = new Map<number, { url: string; at: number }>();
	const signing = new Map<number, Promise<void>>();

	async function urlFor(part: number, fresh: boolean): Promise<string> {
		const have = urls.get(part);
		if (!fresh && have && Date.now() - have.at < URL_FRESH_MS) return have.url;
		const flying = !fresh && signing.get(part);
		if (flying) {
			await flying;
			const got = urls.get(part);
			if (got) return got.url;
		}
		// This part and the next few nobody has asked for yet.
		const batch = [part];
		for (let p = part + 1; p <= mp.parts && batch.length < SIGN_BATCH; p++)
			if (!urls.has(p) && !signing.has(p)) batch.push(p);
		const at = Date.now();
		const req = signUploadParts({ data: { id, parts: batch } }).then((r) => {
			for (const u of r.urls) urls.set(u.part, { url: u.url, at });
		});
		for (const p of batch) signing.set(p, req);
		try {
			await req;
		} finally {
			for (const p of batch) if (signing.get(p) === req) signing.delete(p);
		}
		const got = urls.get(part);
		if (!got) throw new UploadError("The upload was refused. Try again.");
		return got.url;
	}

	let next = 1;
	let failed = false;
	const worker = async () => {
		for (let part = next++; part <= mp.parts; part = next++) {
			const start = (part - 1) * mp.partSize;
			const body = blob.slice(start, Math.min(blob.size, start + mp.partSize));
			for (let attempt = 0; ; attempt++) {
				if (failed || !active()) throw new Cancelled("cancelled");
				try {
					const url = await urlFor(part, attempt > 0);
					await put(key, url, body, null, (f) => {
						sent[part - 1] = f * body.size;
						report();
					});
					sent[part - 1] = body.size;
					report();
					break;
				} catch (e) {
					if (e instanceof Cancelled) throw e;
					sent[part - 1] = 0;
					report();
					if (attempt >= PART_RETRIES) {
						// The upload fails: stop the other parts too.
						failed = true;
						abortPuts(key);
						throw e;
					}
					await sleep(retryDelay.ms(attempt));
				}
			}
		}
	};
	const results = await Promise.allSettled(
		Array.from({ length: Math.min(PART_CONCURRENCY, mp.parts) }, worker),
	);
	const real = results.find(
		(r) => r.status === "rejected" && !(r.reason instanceof Cancelled),
	) as PromiseRejectedResult | undefined;
	if (real) throw real.reason;
	const cancelled = results.find((r) => r.status === "rejected") as
		| PromiseRejectedResult
		| undefined;
	if (cancelled) throw cancelled.reason;
}

/**
 * One file straight to storage outside the queue (the share target, a
 * receipt in the expense editor): `createUpload`, its PUT or its parts,
 * `completeUpload`. A failure drops the upload (`abortUpload`) and throws.
 */
export async function uploadOne(p: {
	tripId: string;
	target: AttachmentTarget;
	blob: Blob;
	type: UploadType;
	name: string;
}): Promise<MediaDto> {
	const key = `x${++seq}`;
	const created = await createUpload({
		data: {
			tripId: p.tripId,
			target: p.target,
			type: p.type,
			size: p.blob.size,
			name: p.name.slice(0, 255),
		},
	});
	try {
		if (created.multipart)
			await putParts(
				key,
				created.id,
				p.blob,
				created.multipart,
				() => {},
				() => true,
			);
		else await put(key, created.url, p.blob, p.type);
		return await completeUpload({ data: { id: created.id, hasPoster: false } });
	} catch (e) {
		void abortUpload({ data: { id: created.id } }).catch(() => {});
		throw e;
	} finally {
		xhrs.delete(key);
	}
}

export type UploadContext = {
	tripId: string;
	target: AttachmentTarget;
	queryClient: QueryClient;
	/** "Shibuya Sky" for toasts. */
	label: string;
	/**
	 * `mustRedact(me)`: this viewer never sees `members` rows (a link guest,
	 * ADDENDUM §9) — their own upload included, so the toast says so.
	 */
	guest?: boolean;
	videoMaxBytes?: number;
	/** EXIF GPS → a nearby place other than the target ("Taken near … — attach there?"). */
	suggestNear?: (gps: { lat: number; lng: number }) => {
		nodeId: string;
		name: string;
	} | null;
};

function upsert(qc: QueryClient, tripId: string, dto: MediaDto) {
	qc.setQueryData(tripKeys.media(tripId), (xs?: MediaDto[]) =>
		xs ? [...xs.filter((x) => x.id !== dto.id), dto] : [dto],
	);
}

async function runOne(key: string, ctx: UploadContext): Promise<MediaDto> {
	const file = files.get(key);
	if (!file) throw new Cancelled("gone");
	let prepared: Prepared;
	try {
		prepared = await prepareFile(file, ctx.videoMaxBytes);
	} catch (e) {
		if (e instanceof PrepareError) throw e;
		throw new Error(humanError(e));
	}
	if (!useUploads.getState().items.some((i) => i.key === key))
		throw new Cancelled("cancelled");
	patch(key, {
		kind: prepared.kind,
		name: prepared.name,
		size: prepared.blob.size,
		previewUrl: prepared.previewUrl,
		width: prepared.width,
		height: prepared.height,
		phase: "uploading",
	});
	const created = await createUpload({
		data: {
			tripId: ctx.tripId,
			target: ctx.target,
			type: prepared.type,
			size: prepared.blob.size,
			name: prepared.name,
		},
	});
	const { id } = created;
	patch(key, { attachmentId: id });
	if (!isActive(key)) {
		// Cancelled while the upload was being created: drop it here.
		void abortUpload({ data: { id } }).catch(() => {});
		throw new Cancelled("cancelled");
	}
	const onProgress = (f: number) => patch(key, { progress: Math.min(0.98, f) });
	if (created.multipart)
		await putParts(key, id, prepared.blob, created.multipart, onProgress);
	else await put(key, created.url, prepared.blob, prepared.type, onProgress);
	let hasPoster = false;
	if (prepared.poster) {
		try {
			const p = await createPosterUpload({
				data: { id, size: prepared.poster.size },
			});
			await put(key, p.url, prepared.poster, "image/jpeg");
			hasPoster = true;
		} catch (e) {
			if (e instanceof Cancelled) throw e;
			hasPoster = false; // the worker's ffmpeg makes one
		}
	}
	patch(key, { phase: "finishing", progress: 1 });
	const dto = await completeUpload({
		data: {
			id,
			hasPoster,
			...(prepared.width ? { width: prepared.width } : {}),
			...(prepared.height ? { height: prepared.height } : {}),
			...(prepared.durationSec !== undefined
				? { durationSec: prepared.durationSec }
				: {}),
			...(prepared.takenAt ? { takenAt: prepared.takenAt } : {}),
		},
	});
	// ADDENDUM §9: hidden from guests, the uploading guest included — no tile
	// (the next refetch would drop it anyway); the batch toast says why.
	if (hiddenFrom(ctx.guest, dto)) {
		removeItem(key);
		return dto;
	}
	if (prepared.previewUrl)
		useUploads.setState((s) => ({
			previews: { ...s.previews, [dto.id]: prepared.previewUrl as string },
		}));
	upsert(ctx.queryClient, ctx.tripId, dto);
	removeItem(key, true);
	// "Taken near Shibuya Sky — attach there?"
	const near = prepared.gps ? ctx.suggestNear?.(prepared.gps) : null;
	if (near && dto.kind === "photo")
		toast(`Taken near ${near.name} — attach there?`, {
			duration: 10_000,
			action: {
				label: "Move there",
				onClick: () =>
					void updateAttachment({
						data: { id: dto.id, target: { kind: "node", nodeId: near.nodeId } },
					})
						.then(() =>
							ctx.queryClient.invalidateQueries({
								queryKey: tripKeys.media(ctx.tripId),
							}),
						)
						.catch((e) => toast.error(humanError(e))),
			},
		});
	return dto;
}

type BatchResult = { done: MediaDto[]; failed: number; refused: string[] };

async function runBatch(
	keys: string[],
	ctx: UploadContext,
): Promise<BatchResult> {
	const done: MediaDto[] = [];
	const refused: string[] = [];
	let failed = 0;
	const queue = [...keys];
	const worker = async () => {
		for (let key = queue.shift(); key; key = queue.shift()) {
			try {
				done.push(await runOne(key, ctx));
			} catch (e) {
				if (e instanceof Cancelled) continue;
				// The pending row (if any) never shows; drop it (and its parts) now
				// instead of in 24 h.
				const id = useUploads
					.getState()
					.items.find((i) => i.key === key)?.attachmentId;
				if (id) void abortUpload({ data: { id } }).catch(() => {});
				if (e instanceof PrepareError) {
					// Refused before upload (MED-06): say why; no tile to clutter the gallery.
					refused.push(e.message);
					removeItem(key);
					continue;
				}
				if (errorCode(e) === "STORAGE_QUOTA") {
					// ADDENDUM §12: refused before any bytes went up; the message says
					// how much space is left. Retrying wouldn't help, so no tile.
					refused.push(humanError(e));
					removeItem(key);
					continue;
				}
				failed += 1;
				patch(key, {
					phase: "failed",
					error: e instanceof UploadError ? e.message : humanError(e),
					retryable: true,
				});
			}
		}
	};
	await Promise.all([worker(), worker(), worker()]);
	void ctx.queryClient.invalidateQueries({
		queryKey: tripKeys.counts(ctx.tripId),
	});
	void ctx.queryClient.invalidateQueries({
		queryKey: tripKeys.activity(ctx.tripId),
	});
	return { done, failed, refused };
}

function noun(n: number, kinds: Set<string>): string {
	const only = kinds.size === 1 ? [...kinds][0] : null;
	const [one, many] =
		only === "photo"
			? ["photo", "photos"]
			: only === "video"
				? ["video", "videos"]
				: only === "pdf"
					? ["PDF", "PDFs"]
					: ["file", "files"];
	return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** Whether this finished upload is one the uploader can't see (ADDENDUM §9). */
function hiddenFrom(
	guest: boolean | undefined,
	dto: Pick<MediaDto, "visibility">,
): boolean {
	return !!guest && dto.visibility !== "everyone";
}

/**
 * The batch's success line: "2 photos added to Shibuya Sky". A link guest's
 * upload that starts hidden from guests (an e-ticket on a flight) is gone
 * from their gallery at once, so the line says where it went.
 */
export function addedMessage(
	done: Pick<MediaDto, "kind" | "visibility">[],
	label: string,
	guest?: boolean,
): string {
	const line = `${noun(done.length, new Set(done.map((d) => d.kind)))} added to ${label}`;
	const hidden = done.filter((d) => hiddenFrom(guest, d));
	if (!hidden.length) return line;
	const them = hidden.length === 1 ? "it" : "them";
	return hidden.length === done.length
		? `${line} — hidden from guests; only trip members can see ${them}`
		: `${line} — ${noun(hidden.length, new Set(hidden.map((d) => d.kind)))} hidden from guests; only trip members can see ${them}`;
}

/**
 * Queues files for upload to `ctx.target`. Files that can't be uploaded are
 * refused before any request with a specific message (MED-06).
 */
export function startUploads(
	input: File[] | FileList,
	ctx: UploadContext,
): void {
	const list = [...input];
	if (!list.length) return;
	const keys: string[] = [];
	const kinds = new Set<string>();
	for (const file of list) {
		const key = `u${++seq}`;
		files.set(key, file);
		keys.push(key);
		const guess = /^image\//.test(file.type)
			? "photo"
			: /^video\//.test(file.type)
				? "video"
				: file.type === "application/pdf"
					? "pdf"
					: "file";
		kinds.add(guess);
		useUploads.setState((s) => ({
			items: [
				...s.items,
				{
					key,
					tripId: ctx.tripId,
					target: ctx.target,
					name: file.name,
					kind: null,
					size: file.size,
					previewUrl: null,
					progress: 0,
					phase: "preparing",
					error: null,
					retryable: true,
					attachmentId: null,
					guest: !!ctx.guest,
				},
			],
		}));
	}
	// One progress toast per batch (DESIGN §8.8: uploads use a promise toast).
	const id = toast.loading(
		`Uploading ${noun(keys.length, kinds)} to ${ctx.label}…`,
	);
	void runBatch(keys, ctx).then(({ done, failed, refused }) => {
		if (done.length)
			toast.success(addedMessage(done, ctx.label, ctx.guest), {
				id,
				// Long enough to read where a hidden upload went.
				...(done.some((d) => hiddenFrom(ctx.guest, d))
					? { duration: 10_000 }
					: {}),
			});
		else toast.dismiss(id);
		for (const [i, why] of refused.entries())
			toast.error(why, { id: `${id}-refused-${i}` });
		if (failed)
			toast.error(
				failed === 1
					? "An upload failed — retry it from the gallery."
					: `${failed} uploads failed — retry them from the gallery.`,
				{ id: `${id}-failed` },
			);
	});
}

/** Stops an upload; nothing of it remains. */
export function cancelUpload(key: string): void {
	const item = useUploads.getState().items.find((i) => i.key === key);
	if (!item) return;
	// Removed before the PUTs are aborted, so no part starts or retries after.
	const inFlight = [...(xhrs.get(key) ?? [])];
	removeItem(key);
	for (const xhr of inFlight) xhr.abort();
	if (item.attachmentId)
		void abortUpload({ data: { id: item.attachmentId } }).catch(() => {});
}

/** Starts a failed upload over (a fresh row and PUT). */
export function retryUpload(
	key: string,
	ctx: Omit<UploadContext, "target" | "tripId">,
): void {
	const item = useUploads.getState().items.find((i) => i.key === key);
	const file = files.get(key);
	if (!item || !file) return;
	removeItem(key);
	startUploads([file], {
		guest: item.guest,
		...ctx,
		tripId: item.tripId,
		target: item.target,
	});
}

/** Forgets a failed upload. */
export function dismissUpload(key: string): void {
	removeItem(key);
}
