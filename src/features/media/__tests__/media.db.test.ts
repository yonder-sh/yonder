/**
 * WP-Media server functions against real Postgres, Redis and S3 (s3proxy):
 * the upload flow (presigned PUT with signed type/length, HeadObject + magic
 * bytes, the variants job), permissions (edit-only uploads, receipts under
 * manageExpenses, viewers and guests), ADDENDUM §9 visibility (defaults for
 * PDFs on flights/stays/reserved transit, "Hide from guests" by any member,
 * never a guest; hidden rows invisible to guests in lists, updates and
 * deletes), links, captions, moves, delete/restore and the purge.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import exifr from "exifr";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_media_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-mediatest-${hex}`;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	return { hex, scratchUrl: scratch.toString() };
});

/** `/media/…` reads the session from the request: tests name the user. */
const sessions = vi.hoisted(() => ({ byId: new Map<string, unknown>() }));

vi.mock("@tanstack/react-start", () => import("@/test/start-mock"));
vi.mock("@/server/authz/session.server", async (orig) => ({
	...(await orig<typeof import("@/server/authz/session.server")>()),
	loadSession: async (h: Headers) => {
		const u = sessions.byId.get(h.get("x-test-user") ?? "");
		return u ? { user: u, session: {} } : null;
	},
}));
vi.mock(
	"@tanstack/react-start/server",
	() => import("@/test/start-server-mock"),
);

import { closeDb, getDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { attachments, expenses, tripMembers, user } from "@/db/schema";
import { resolveProposal } from "@/functions/proposals.functions";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import {
	cloneDemoTrip,
	type FixtureClone,
	joinTestLink,
} from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { quotaBytes, usedBytes } from "@/server/quota.server";
import { ensureBucket } from "@/server/s3.server";
import {
	abortUpload,
	addLink,
	type CreatedUpload,
	completeUpload,
	createUpload,
	deleteAttachment,
	listTripMedia,
	type MediaDto,
	restoreAttachment,
	setAttachmentVisibility,
	signUploadParts,
	updateAttachment,
} from "../media.functions";
import { linkPreview, mediaVariants } from "../server/jobs.server";
import { logMediaAdd } from "../server/media-activity.server";
import { purge } from "../server/purge.server";
import type { SafeFetcher } from "../server/safe-fetch.server";
import { serveMedia } from "../server/serve.server";
import {
	checkParts,
	deletePrefix,
	headObject,
	objectKey,
	partSizes,
	readObject,
	uploadKey,
} from "../server/storage.server";
import { makePdf } from "./make-pdf";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const { scratchUrl } = testEnv;

type Fn = (opts: { data?: unknown; context?: unknown }) => Promise<unknown>;
const call = <T = Record<string, unknown>>(
	fn: unknown,
	u: AuthUser,
	data: unknown,
) => (fn as Fn)({ data, context: { user: u } }) as Promise<T>;

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "ok";
	} catch (e) {
		return (
			errorCode(e) ??
			`unexpected: ${e instanceof Error ? e.message : String(e)}`
		);
	}
}

async function newUser(
	name: { first: string; last: string } | null,
): Promise<AuthUser> {
	const id = randomUUID();
	const anonymous = name === null;
	await getDb()
		.insert(user)
		.values({
			id,
			email: `${anonymous ? "temp" : "u"}-${id}@${anonymous ? "guest.yonder.invalid" : "example.test"}`,
			emailVerified: !anonymous,
			name: anonymous ? "Guest Wren" : `${name.first} ${name.last}`,
			firstName: name?.first ?? "",
			lastName: name?.last ?? "",
			isAnonymous: anonymous,
		});
	const [row] = await getDb()
		.select()
		.from(user)
		.where(sql`${user.id} = ${id}`);
	return row as unknown as AuthUser;
}

const U = {} as Record<
	"owner" | "viewer" | "suggester" | "stranger" | "guestViewer" | "guestEditor",
	AuthUser
>;
const trips: string[] = [];

async function freshTrip(): Promise<FixtureClone> {
	const c = await cloneDemoTrip(getDb(), U.owner.id);
	trips.push(c.tripId);
	await getDb().insert(tripMembers).values({
		tripId: c.tripId,
		userId: U.viewer.id,
		status: "active",
		role: "viewer",
		color: 5,
	});
	await getDb().insert(tripMembers).values({
		tripId: c.tripId,
		userId: U.suggester.id,
		status: "active",
		role: "suggester",
		color: 6,
	});
	await joinTestLink(getDb(), c, U.guestViewer.id, "viewer");
	await joinTestLink(getDb(), c, U.guestEditor.id, "editor");
	return c;
}

/** createUpload → PUT (as the browser would) → completeUpload. */
async function upload(
	who: AuthUser,
	tripId: string,
	target: unknown,
	body: Buffer,
	type: string,
	name: string,
	extra: Record<string, unknown> = {},
): Promise<MediaDto> {
	const { id, url } = await call<{ id: string; url: string }>(
		createUpload,
		who,
		{
			tripId,
			target,
			type,
			size: body.length,
			name,
		},
	);
	const put = await fetch(url, {
		method: "PUT",
		body: new Uint8Array(body),
		headers: { "content-type": type },
	});
	expect(put.status).toBe(200);
	return call<MediaDto>(completeUpload, who, {
		id,
		hasPoster: false,
		...extra,
	});
}

const jpeg = () =>
	sharp({
		create: { width: 64, height: 48, channels: 3, background: "#cf3b1d" },
	})
		.jpeg()
		.toBuffer();

beforeAll(async () => {
	await ensureDatabase(scratchUrl);
	await migrateDatabase(scratchUrl);
	await ensureBucket();
	U.owner = await newUser({ first: "Dev", last: "Owner" });
	U.viewer = await newUser({ first: "Vic", last: "Viewer" });
	U.suggester = await newUser({ first: "Sue", last: "Suggester" });
	U.stranger = await newUser({ first: "Sam", last: "Stranger" });
	U.guestViewer = await newUser(null);
	U.guestEditor = await newUser(null);
	for (const u of Object.values(U)) sessions.byId.set(u.id, u);
});

afterAll(async () => {
	for (const t of trips) await deletePrefix(`trips/${t}/`).catch(() => {});
	await closeQueues().catch(() => {});
	const r = redis();
	let cursor = "0";
	do {
		const [next, keys] = await r.scan(
			cursor,
			"MATCH",
			`${redisPrefix()}:*`,
			"COUNT",
			500,
		);
		cursor = next;
		if (keys.length) await r.unlink(...keys);
	} while (cursor !== "0");
	await closeRedis();
	await closeDb();
	await dropDatabase(scratchUrl);
});

describe("uploads (SPEC §15.2, MED-01/06/07, SEC-05)", () => {
	it("presigns a PUT, checks the object and makes the variants", async () => {
		const c = await freshTrip();
		const target = { kind: "node", nodeId: c.ids.nodes.shibuyaSky };
		const dto = await upload(
			U.owner,
			c.tripId,
			target,
			await jpeg(),
			"image/jpeg",
			"sky.jpg",
			{
				width: 64,
				height: 48,
			},
		);
		expect(dto).toMatchObject({
			kind: "photo",
			status: "processing",
			visibility: "everyone",
			mine: true,
		});
		const r = await mediaVariants({ tripId: c.tripId, attachmentId: dto.id });
		expect(r.keys).toContain("media");
		const list = await call<MediaDto[]>(listTripMedia, U.owner, {
			tripId: c.tripId,
		});
		const row = list.find((m) => m.id === dto.id);
		expect(row).toMatchObject({
			status: "ready",
			hasThumb: true,
			width: 64,
			height: 48,
		});
		expect(row?.thumbhash).toBeTruthy();
		expect(
			await headObject(objectKey(c.tripId, dto.id, "thumb.webp")),
		).toMatchObject({ contentType: "image/webp" });
		// Guests see it (MED-11).
		const guest = await call<MediaDto[]>(listTripMedia, U.guestViewer, {
			tripId: c.tripId,
		});
		expect(guest.some((m) => m.id === dto.id)).toBe(true);
	});

	it("signs the type and length: another type or size is refused by storage", async () => {
		const c = await freshTrip();
		const body = await jpeg();
		const { url } = await call<{ url: string }>(createUpload, U.owner, {
			tripId: c.tripId,
			target: { kind: "trip" },
			type: "image/jpeg",
			size: body.length,
			name: "x.jpg",
		});
		const wrongType = await fetch(url, {
			method: "PUT",
			body: new Uint8Array(body),
			headers: { "content-type": "text/html" },
		});
		expect(wrongType.status).toBe(403);
		const wrongSize = await fetch(url, {
			method: "PUT",
			body: new Uint8Array(Buffer.concat([body, Buffer.alloc(10)])),
			headers: { "content-type": "image/jpeg" },
		});
		expect(wrongSize.status).toBe(403);
	});

	it("a file that isn't what it claims fails the check and leaves no live row", async () => {
		const c = await freshTrip();
		const fake = Buffer.from("<html><script>alert(1)</script></html>");
		const { id, url } = await call<{ id: string; url: string }>(
			createUpload,
			U.owner,
			{
				tripId: c.tripId,
				target: { kind: "trip" },
				type: "image/png",
				size: fake.length,
				name: "fake.png",
			},
		);
		await fetch(url, {
			method: "PUT",
			body: new Uint8Array(fake),
			headers: { "content-type": "image/png" },
		});
		expect(
			await codeOf(call(completeUpload, U.owner, { id, hasPoster: false })),
		).toBe("VALIDATION");
		const list = await call<MediaDto[]>(listTripMedia, U.owner, {
			tripId: c.tripId,
		});
		expect(list.some((m) => m.id === id)).toBe(false);
	});

	it("completing an upload that never arrived is refused; pending rows never list", async () => {
		const c = await freshTrip();
		const { id } = await call<{ id: string }>(createUpload, U.owner, {
			tripId: c.tripId,
			target: { kind: "trip" },
			type: "image/jpeg",
			size: 100,
			name: "never.jpg",
		});
		const list = await call<MediaDto[]>(listTripMedia, U.owner, {
			tripId: c.tripId,
		});
		expect(list.some((m) => m.id === id)).toBe(false);
		expect(
			await codeOf(call(completeUpload, U.owner, { id, hasPoster: false })),
		).toBe("VALIDATION");
		// The uploader cancels: the pending row goes (soft delete, purged later).
		expect(await codeOf(call(deleteAttachment, U.owner, { id }))).toBe("ok");
	});

	it("viewers and guest viewers can't upload; guest editors can; strangers get 404; caps apply", async () => {
		const c = await freshTrip();
		const input = {
			tripId: c.tripId,
			target: { kind: "trip" },
			type: "image/jpeg",
			size: 10,
			name: "a.jpg",
		};
		expect(await codeOf(call(createUpload, U.viewer, input))).toBe("FORBIDDEN");
		expect(await codeOf(call(createUpload, U.guestViewer, input))).toBe(
			"FORBIDDEN",
		);
		expect(await codeOf(call(createUpload, U.guestEditor, input))).toBe("ok");
		expect(await codeOf(call(createUpload, U.stranger, input))).toBe(
			"NOT_FOUND",
		);
		// The validator refuses SVG outright (a zod error, before any handler code).
		expect(
			await codeOf(
				call(createUpload, U.owner, { ...input, type: "image/svg+xml" }),
			),
		).not.toBe("ok");
		expect(
			await codeOf(
				call(createUpload, U.owner, {
					...input,
					type: "application/pdf",
					size: 51 * 1024 * 1024,
				}),
			),
		).toBe("VALIDATION");
		// A target from another trip is NOT_FOUND.
		const other = await freshTrip();
		expect(
			await codeOf(
				call(createUpload, U.owner, {
					...input,
					target: { kind: "node", nodeId: other.ids.nodes.tokyo },
				}),
			),
		).toBe("NOT_FOUND");
		// A guest editor finishes their own upload, even one that starts
		// hidden from guests (a flight's PDF).
		expect(
			await upload(
				U.guestEditor,
				c.tripId,
				{ kind: "leg", legId: c.ids.legs.flight },
				makePdf(["E-ticket"]),
				"application/pdf",
				"ticket.pdf",
			),
		).toMatchObject({ status: "processing", visibility: "members" });
		// Someone else's pending upload can't be completed.
		const { id } = await call<{ id: string }>(createUpload, U.owner, input);
		expect(
			await codeOf(
				call(completeUpload, U.guestEditor, { id, hasPoster: false }),
			),
		).toBe("NOT_FOUND");
	});

	it("SEC-R1-08: a second PUT after finalize never reaches the served original; URLs are short-lived", async () => {
		const c = await freshTrip();
		const body = await jpeg();
		const { id, url } = await call<{ id: string; url: string }>(
			createUpload,
			U.owner,
			{
				tripId: c.tripId,
				target: { kind: "trip" },
				type: "image/jpeg",
				size: body.length,
				name: "swap.jpg",
			},
		);
		const put = new URL(url);
		// The browser writes an upload key only the server copies from.
		expect(put.pathname).toContain(`/${id}/original.upload`);
		expect(Number(put.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(
			600,
		);
		const send = (bytes: Buffer) =>
			fetch(url, {
				method: "PUT",
				body: new Uint8Array(bytes),
				headers: { "content-type": "image/jpeg" },
			}).then((r) => r.status);
		expect(await send(body)).toBe(200);
		expect(
			await call<MediaDto>(completeUpload, U.owner, { id, hasPoster: false }),
		).toMatchObject({ status: "processing" });
		// The upload object is gone; the served copy is what was checked.
		expect(
			await headObject(`trips/${c.tripId}/${id}/original.upload`),
		).toBeNull();
		// S3 can't revoke a presigned URL: the same URL still accepts N bytes
		// of HTML, but only into the (unserved) upload key.
		const html = Buffer.alloc(body.length, 0x20);
		html.write("<html><script>alert(1)</script></html>");
		expect(await send(html)).toBe(200);
		const res = await serveMedia(
			new Request(`http://localhost/media/${id}/original`, {
				headers: { "x-test-user": U.owner.id },
			}),
			id,
			"original",
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("cache-control")).toBe("private, max-age=300");
		const loc = new URL(res.headers.get("location") ?? "");
		expect(loc.pathname).toContain(`/${id}/original`);
		expect(loc.pathname).not.toContain("upload");
		// Storage is read directly in production (no proxy adds headers): the
		// URL names the checked type and an inline disposition with a safe name.
		expect(loc.searchParams.get("response-content-type")).toBe("image/jpeg");
		expect(loc.searchParams.get("response-content-disposition")).toBe(
			`inline; filename="swap.jpg"; filename*=UTF-8''swap.jpg`,
		);
		expect(Number(loc.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(
			900,
		);
		const served = Buffer.from(await (await fetch(loc)).arrayBuffer());
		expect(served.equals(body)).toBe(true);
		expect(served.toString("latin1")).not.toContain("<script>");
		// A retried finalize is a no-op (the row is already processing).
		expect(
			await call<MediaDto>(completeUpload, U.owner, { id, hasPoster: false }),
		).toMatchObject({ id, status: "processing" });
	});

	it("CONTENT-06: the stored original loses its GPS; link guests get the display WebP", async () => {
		const c = await freshTrip();
		// Chureito Pagoda: 35°29'50"N 138°48'3"E, orientation 6.
		const gpsJpeg = await sharp({
			create: { width: 64, height: 48, channels: 3, background: "#cf3b1d" },
		})
			.jpeg()
			.withMetadata({
				orientation: 6,
				exif: {
					IFD0: { Make: "QA Camera" },
					IFD3: {
						GPSLatitudeRef: "N",
						GPSLatitude: "35/1 29/1 50/1",
						GPSLongitudeRef: "E",
						GPSLongitude: "138/1 48/1 3/1",
					},
				},
			})
			.toBuffer();
		expect((await exifr.gps(gpsJpeg))?.latitude).toBeCloseTo(35.497, 2);
		const dto = await upload(
			U.owner,
			c.tripId,
			{ kind: "node", nodeId: c.ids.nodes.mtFuji },
			gpsJpeg,
			"image/jpeg",
			"chureito-sunrise.jpg",
		);
		await mediaVariants({ tripId: c.tripId, attachmentId: dto.id });
		const stored = await readObject(
			objectKey(c.tripId, dto.id, "original"),
			10 * 1024 * 1024,
		);
		expect(stored.length).toBe(gpsJpeg.length);
		expect(await exifr.gps(stored)).toBeUndefined();
		const tags = (await exifr.parse(stored, true)) as Record<string, unknown>;
		expect(tags.Make).toBe("QA Camera");
		expect(Object.keys(tags).some((k) => k.startsWith("GPS"))).toBe(false);
		expect((await sharp(stored).metadata()).orientation).toBe(6);

		const get = (who: AuthUser, qs = "") =>
			serveMedia(
				new Request(`http://localhost/media/${dto.id}/original${qs}`, {
					headers: { "x-test-user": who.id },
				}),
				dto.id,
				"original",
			);
		// Members get the (now GPS-free) original.
		const own = new URL((await get(U.owner)).headers.get("location") ?? "");
		expect(own.pathname).toMatch(/\/original$/);
		// A view-link guest gets the display WebP: re-encoded, upright, no EXIF.
		const res = await get(U.guestViewer, "?download=1");
		expect(res.status).toBe(302);
		const loc = new URL(res.headers.get("location") ?? "");
		expect(loc.pathname).toMatch(/\/display\.webp$/);
		expect(loc.searchParams.get("response-content-type")).toBe("image/webp");
		expect(loc.searchParams.get("response-content-disposition")).toContain(
			'filename="chureito-sunrise.webp"',
		);
		const served = Buffer.from(await (await fetch(loc)).arrayBuffer());
		const meta = await sharp(served).metadata();
		expect(meta.format).toBe("webp");
		expect(meta.exif).toBeUndefined();
		expect((meta.height ?? 0) > (meta.width ?? 0)).toBe(true);
	});
});

const MiB = 1024 * 1024;

/** An MP4-looking body (`ftyp` at 4, so it passes the magic-byte check) of `size` bytes. */
function mp4(size: number): Buffer {
	const b = Buffer.alloc(size, 0x2e);
	b.writeUInt32BE(24, 0);
	b.write("ftypisom", 4, "latin1");
	return b;
}

/** Signs and PUTs the given parts of a multipart upload (as the browser would). */
async function putParts(
	who: AuthUser,
	id: string,
	body: Buffer,
	partSize: number,
	parts: number[],
): Promise<number[]> {
	const { urls } = await call<{ urls: { part: number; url: string }[] }>(
		signUploadParts,
		who,
		{ id, parts },
	);
	const statuses: number[] = [];
	for (const { part, url } of urls) {
		const chunk = body.subarray((part - 1) * partSize, part * partSize);
		const r = await fetch(url, { method: "PUT", body: new Uint8Array(chunk) });
		statuses.push(r.status);
	}
	return statuses;
}

describe("multipart uploads (files over 16 MB)", () => {
	it("goes up in 16 MB parts signed for their exact length; complete checks the parts, copies and verifies", async () => {
		const c = await freshTrip();
		const body = mp4(33 * MiB + 123);
		const created = await call<CreatedUpload>(createUpload, U.owner, {
			tripId: c.tripId,
			target: { kind: "trip" },
			type: "video/mp4",
			size: body.length,
			name: "fuji.mp4",
		});
		expect(created.url).toBeUndefined();
		expect(created.multipart).toEqual({ partSize: 16 * MiB, parts: 3 });
		const { id } = created;
		const { urls } = await call<{ urls: { part: number; url: string }[] }>(
			signUploadParts,
			U.owner,
			{ id, parts: [1, 2, 3] },
		);
		expect(urls.map((u) => u.part)).toEqual([1, 2, 3]);
		for (const { url } of urls) {
			const u = new URL(url);
			// Signed for the host the browser uses, for exactly one part's length.
			expect(u.origin).toBe(
				new URL(process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:8080")
					.origin,
			);
			expect(u.pathname).toContain(`/${id}/original.upload`);
			expect(u.searchParams.get("X-Amz-SignedHeaders")).toContain(
				"content-length",
			);
			expect(Number(u.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(
				600,
			);
		}
		// A part of another length is refused by storage.
		const wrong = await fetch(urls[2]?.url ?? "", {
			method: "PUT",
			body: new Uint8Array(1234),
		});
		expect(wrong.status).toBe(403);
		expect(await putParts(U.owner, id, body, 16 * MiB, [1, 2, 3])).toEqual([
			200, 200, 200,
		]);
		const dto = await call<MediaDto>(completeUpload, U.owner, {
			id,
			hasPoster: false,
		});
		expect(dto).toMatchObject({ id, kind: "video", status: "processing" });
		expect(await headObject(objectKey(c.tripId, id, "original"))).toEqual({
			size: body.length,
			contentType: "video/mp4",
		});
		expect(
			await headObject(uploadKey(c.tripId, id, "original.upload")),
		).toBeNull();
		// Finished: no more part URLs, and a retried complete is a no-op.
		expect(
			await codeOf(call(signUploadParts, U.owner, { id, parts: [1] })),
		).toBe("CONFLICT");
		expect(
			await call<MediaDto>(completeUpload, U.owner, { id, hasPoster: false }),
		).toMatchObject({ id, status: "processing" });
	});

	it("a missing part fails the complete; abort drops the parts and the row", async () => {
		const c = await freshTrip();
		const body = mp4(20 * MiB);
		const { id } = await call<CreatedUpload>(createUpload, U.owner, {
			tripId: c.tripId,
			target: { kind: "trip" },
			type: "video/mp4",
			size: body.length,
			name: "half.mp4",
		});
		expect(await putParts(U.owner, id, body, 16 * MiB, [2])).toEqual([200]);
		expect(
			await codeOf(call(completeUpload, U.owner, { id, hasPoster: false })),
		).toBe("VALIDATION");
		const [row] = await getDb()
			.select()
			.from(attachments)
			.where(sql`${attachments.id} = ${id}`);
		const meta = (row?.meta ?? {}) as { multipart?: { uploadId: string } };
		const uploadId = meta.multipart?.uploadId as string;
		const key = uploadKey(c.tripId, id, "original.upload");
		expect(
			await checkParts(key, uploadId, partSizes(body.length, 16 * MiB)),
		).toEqual({ ok: false, reason: "incomplete" });
		expect(await codeOf(call(abortUpload, U.owner, { id }))).toBe("ok");
		// Storage forgets the upload (RGW: NoSuchUpload; s3proxy: no parts left).
		expect(
			await checkParts(key, uploadId, partSizes(body.length, 16 * MiB)),
		).toMatchObject({ ok: false });
		const [after] = await getDb()
			.select()
			.from(attachments)
			.where(sql`${attachments.id} = ${id}`);
		expect(after?.deletedAt).not.toBeNull();
		// Aborting again, or a finished upload, is a no-op.
		expect(await codeOf(call(abortUpload, U.owner, { id }))).toBe("ok");
	});

	it("parts: only the uploader, only this upload's part numbers; per-file caps (videos 2 GB, photos and PDFs 50 MB)", async () => {
		const c = await freshTrip();
		const { id } = await call<CreatedUpload>(createUpload, U.guestEditor, {
			tripId: c.tripId,
			target: { kind: "trip" },
			type: "application/pdf",
			size: 50 * MiB,
			name: "guide.pdf",
		});
		expect(
			await codeOf(call(signUploadParts, U.owner, { id, parts: [1] })),
		).toBe("NOT_FOUND");
		expect(
			await codeOf(call(signUploadParts, U.guestEditor, { id, parts: [5] })),
		).toBe("VALIDATION");
		expect(
			await codeOf(call(signUploadParts, U.guestEditor, { id, parts: [4] })),
		).toBe("ok");
		expect(await codeOf(call(abortUpload, U.owner, { id }))).toBe("NOT_FOUND");
		expect(await codeOf(call(abortUpload, U.guestEditor, { id }))).toBe("ok");
		const input = {
			tripId: c.tripId,
			target: { kind: "trip" },
			name: "x",
		};
		for (const [type, size] of [
			["video/mp4", 2 * 1024 * MiB + 1],
			["image/jpeg", 50 * MiB + 1],
			["application/pdf", 50 * MiB + 1],
		] as const)
			expect(
				await codeOf(call(createUpload, U.owner, { ...input, type, size })),
			).toBe("VALIDATION");
		const big = await call<CreatedUpload>(createUpload, U.owner, {
			...input,
			type: "video/mp4",
			size: 2 * 1024 * MiB,
		});
		expect(big.multipart).toEqual({ partSize: 16 * MiB, parts: 128 });
		await call(abortUpload, U.owner, { id: big.id });
	});
});

describe("storage quota (ADDENDUM §12: the uploader pays)", () => {
	const setQuota = (who: AuthUser, bytes: number | null) =>
		getDb().execute(
			sql`update "user" set storage_quota_bytes = ${bytes} where id = ${who.id}`,
		);

	it("counts the uploader's originals in every trip; a guest's upload counts against the trip owner", async () => {
		const owner = await newUser({ first: "Quinn", last: "Owner" });
		const editor = await newUser({ first: "Eddie", last: "Editor" });
		sessions.byId.set(owner.id, owner);
		sessions.byId.set(editor.id, editor);
		const a = await cloneDemoTrip(getDb(), owner.id);
		const b = await cloneDemoTrip(getDb(), editor.id);
		trips.push(a.tripId, b.tripId);
		await getDb().insert(tripMembers).values({
			tripId: a.tripId,
			userId: editor.id,
			status: "active",
			role: "editor",
			color: 4,
		});
		await joinTestLink(getDb(), a, U.guestEditor.id, "editor");
		const photo = await jpeg();
		const pdf = makePdf(["Guide"]);
		expect(await usedBytes(getDb(), owner.id)).toBe(0);

		await upload(
			owner,
			a.tripId,
			{ kind: "trip" },
			photo,
			"image/jpeg",
			"a.jpg",
		);
		expect(await usedBytes(getDb(), owner.id)).toBe(photo.length);
		// The editor pays for their upload to the owner's trip, and for their own trip's.
		await upload(
			editor,
			a.tripId,
			{ kind: "trip" },
			pdf,
			"application/pdf",
			"g.pdf",
		);
		await upload(
			editor,
			b.tripId,
			{ kind: "trip" },
			photo,
			"image/jpeg",
			"b.jpg",
		);
		expect(await usedBytes(getDb(), owner.id)).toBe(photo.length);
		expect(await usedBytes(getDb(), editor.id)).toBe(pdf.length + photo.length);
		// A link guest's upload counts against the trip's owner, not the guest.
		const g = await upload(
			U.guestEditor,
			a.tripId,
			{ kind: "trip" },
			pdf,
			"application/pdf",
			"guest.pdf",
		);
		expect(await usedBytes(getDb(), owner.id)).toBe(photo.length + pdf.length);
		expect(await usedBytes(getDb(), U.guestEditor.id)).toBe(0);
		// A pending upload counts at once (parallel uploads can't overshoot).
		const pending = await call<CreatedUpload>(createUpload, owner, {
			tripId: a.tripId,
			target: { kind: "trip" },
			type: "image/jpeg",
			size: 1000,
			name: "p.jpg",
		});
		expect(await usedBytes(getDb(), owner.id)).toBe(
			photo.length + pdf.length + 1000,
		);
		// Cancel, delete and a deleted trip free the space at once.
		await call(abortUpload, owner, { id: pending.id });
		await call(deleteAttachment, owner, { id: g.id });
		expect(await usedBytes(getDb(), owner.id)).toBe(photo.length);
		await getDb().execute(
			sql`update trips set deleted_at = now() where id = ${b.tripId}`,
		);
		expect(await usedBytes(getDb(), editor.id)).toBe(pdf.length);
	});

	it("a duplicated trip's re-referenced objects count once", async () => {
		const owner = await newUser({ first: "Dana", last: "Dup" });
		sessions.byId.set(owner.id, owner);
		const a = await cloneDemoTrip(getDb(), owner.id);
		const copy = await cloneDemoTrip(getDb(), owner.id);
		trips.push(a.tripId, copy.tripId);
		const photo = await jpeg();
		const dto = await upload(
			owner,
			a.tripId,
			{ kind: "trip" },
			photo,
			"image/jpeg",
			"a.jpg",
		);
		const [src] = await getDb()
			.select()
			.from(attachments)
			.where(sql`${attachments.id} = ${dto.id}`);
		// What duplicateTrip writes: a new row pointing at the source's objects.
		await getDb()
			.insert(attachments)
			.values({
				...(src as typeof attachments.$inferInsert),
				id: randomUUID(),
				tripId: copy.tripId,
			});
		expect(await usedBytes(getDb(), owner.id)).toBe(photo.length);
	});

	it("refuses an upload that doesn't fit before any bytes go up, with the numbers; the override and 'default'", async () => {
		const owner = await newUser({ first: "Tia", last: "Tight" });
		sessions.byId.set(owner.id, owner);
		const a = await cloneDemoTrip(getDb(), owner.id);
		trips.push(a.tripId);
		await joinTestLink(getDb(), a, U.guestEditor.id, "editor");
		expect(await quotaBytes(getDb(), owner.id)).toBe(5 * 1024 * MiB);
		const photo = await jpeg();
		await upload(
			owner,
			a.tripId,
			{ kind: "trip" },
			photo,
			"image/jpeg",
			"a.jpg",
		);
		await setQuota(owner, 1 * MiB);
		const input = {
			tripId: a.tripId,
			target: { kind: "trip" },
			type: "video/mp4",
			size: 20 * MiB,
			name: "big.mp4",
		};
		const err = await call(createUpload, owner, input).catch((e: unknown) => e);
		expect(errorCode(err)).toBe("STORAGE_QUOTA");
		expect((err as Error).message).toMatch(
			/^STORAGE_QUOTA: This upload needs 20\.0 MB but you have \d+ KB left \(\d+ (B|KB) of 1\.0 MB used\)\. Delete some uploads or ask the trip owner\.$/,
		);
		// A link guest hits the owner's quota, and is told so.
		const guest = await call(createUpload, U.guestEditor, input).catch(
			(e: unknown) => e,
		);
		expect((guest as Error).message).toContain("but the trip owner has");
		// Nothing was left behind.
		expect(await usedBytes(getDb(), owner.id)).toBe(photo.length);
		// Back to the default: it fits.
		await setQuota(owner, null);
		const ok = await call<CreatedUpload>(createUpload, owner, input);
		await call(abortUpload, owner, { id: ok.id });
	});

	it("re-checks at complete: over the quota by then, the upload goes", async () => {
		const owner = await newUser({ first: "Rex", last: "Recheck" });
		sessions.byId.set(owner.id, owner);
		const a = await cloneDemoTrip(getDb(), owner.id);
		trips.push(a.tripId);
		const photo = await jpeg();
		const { id, url } = await call<{ id: string; url: string }>(
			createUpload,
			owner,
			{
				tripId: a.tripId,
				target: { kind: "trip" },
				type: "image/jpeg",
				size: photo.length,
				name: "late.jpg",
			},
		);
		await fetch(url, {
			method: "PUT",
			body: new Uint8Array(photo),
			headers: { "content-type": "image/jpeg" },
		});
		await setQuota(owner, 100);
		expect(
			await codeOf(call(completeUpload, owner, { id, hasPoster: false })),
		).toBe("STORAGE_QUOTA");
		expect(
			await headObject(uploadKey(a.tripId, id, "original.upload")),
		).toBeNull();
		expect(await headObject(objectKey(a.tripId, id, "original"))).toBeNull();
		expect(await usedBytes(getDb(), owner.id)).toBe(0);
	});
});

describe("PDFs and 'Hide from guests' (ADDENDUM §9)", () => {
	it("defaults: flights, stays and lodging are members-only; general PDFs everyone", async () => {
		const c = await freshTrip();
		const pdf = makePdf(["E-ticket KE724"]);
		const flight = await upload(
			U.owner,
			c.tripId,
			{ kind: "leg", legId: c.ids.legs.flight },
			pdf,
			"application/pdf",
			"E-ticket KE724.pdf",
		);
		expect(flight).toMatchObject({
			kind: "pdf",
			visibility: "members",
			title: "E-ticket KE724.pdf",
		});
		const lodging = await upload(
			U.owner,
			c.tripId,
			{ kind: "node", nodeId: c.ids.nodes.ryokan },
			pdf,
			"application/pdf",
			"Ryokan booking.pdf",
		);
		expect(lodging.visibility).toBe("members");
		const guide = await upload(
			U.owner,
			c.tripId,
			{ kind: "node", nodeId: c.ids.nodes.tokyo },
			pdf,
			"application/pdf",
			"Tokyo map.pdf",
		);
		expect(guide.visibility).toBe("everyone");
		const walk = await upload(
			U.owner,
			c.tripId,
			{ kind: "leg", legId: c.ids.legs.handsLoft },
			pdf,
			"application/pdf",
			"Walk.pdf",
		);
		expect(walk.visibility).toBe("everyone");
		// A photo on the flight stays visible.
		const photo = await upload(
			U.owner,
			c.tripId,
			{ kind: "leg", legId: c.ids.legs.flight },
			await jpeg(),
			"image/jpeg",
			"wing.jpg",
		);
		expect(photo.visibility).toBe("everyone");

		// Guests never get members rows: not listed, not updatable, not deletable.
		for (const g of [U.guestViewer, U.guestEditor]) {
			const list = await call<MediaDto[]>(listTripMedia, g, {
				tripId: c.tripId,
			});
			expect(list.map((m) => m.id)).not.toContain(flight.id);
			expect(list.map((m) => m.id)).toContain(guide.id);
		}
		expect(
			await codeOf(
				call(updateAttachment, U.guestEditor, { id: flight.id, caption: "x" }),
			),
		).toBe("NOT_FOUND");
		expect(
			await codeOf(call(deleteAttachment, U.guestEditor, { id: flight.id })),
		).toBe("NOT_FOUND");
		expect(
			await codeOf(
				call(setAttachmentVisibility, U.guestEditor, {
					id: flight.id,
					visibility: "everyone",
				}),
			),
		).toBe("FORBIDDEN");
	});

	it("any member flips it (viewers too), never a guest; guests follow at once", async () => {
		const c = await freshTrip();
		const pdf = await upload(
			U.owner,
			c.tripId,
			{ kind: "node", nodeId: c.ids.nodes.tokyo },
			makePdf(["Menu"]),
			"application/pdf",
			"Menu.pdf",
		);
		expect(
			await codeOf(
				call(setAttachmentVisibility, U.guestViewer, {
					id: pdf.id,
					visibility: "members",
				}),
			),
		).toBe("FORBIDDEN");
		expect(
			await codeOf(
				call(setAttachmentVisibility, U.viewer, {
					id: pdf.id,
					visibility: "members",
				}),
			),
		).toBe("ok");
		let guest = await call<MediaDto[]>(listTripMedia, U.guestViewer, {
			tripId: c.tripId,
		});
		expect(guest.some((m) => m.id === pdf.id)).toBe(false);
		expect(
			await codeOf(
				call(setAttachmentVisibility, U.owner, {
					id: pdf.id,
					visibility: "everyone",
				}),
			),
		).toBe("ok");
		guest = await call<MediaDto[]>(listTripMedia, U.guestViewer, {
			tripId: c.tripId,
		});
		expect(guest.some((m) => m.id === pdf.id)).toBe(true);
		expect(
			await codeOf(
				call(setAttachmentVisibility, U.stranger, {
					id: pdf.id,
					visibility: "members",
				}),
			),
		).toBe("NOT_FOUND");
	});
});

describe("links, captions, moves, delete and restore", () => {
	it("classifies a link at once and queues its preview", async () => {
		const c = await freshTrip();
		const yt = await call<MediaDto>(addLink, U.owner, {
			tripId: c.tripId,
			target: { kind: "leg", legId: c.ids.legs.fuji },
			url: "https://youtu.be/abcdefghijk",
		});
		expect(yt).toMatchObject({
			kind: "embed",
			provider: "youtube",
			embedId: "abcdefghijk",
			status: "processing",
			aspect: 16 / 9,
		});
		const web = await call<MediaDto>(addLink, U.guestEditor, {
			tripId: c.tripId,
			target: { kind: "node", nodeId: c.ids.nodes.mtFuji },
			url: "https://www.japan-guide.com/e/e2172.html",
		});
		expect(web).toMatchObject({ kind: "link", provider: "web" });
		expect(
			await codeOf(
				call(addLink, U.viewer, {
					tripId: c.tripId,
					target: { kind: "trip" },
					url: "https://example.com/",
				}),
			),
		).toBe("FORBIDDEN");
		expect(
			await codeOf(
				call(addLink, U.owner, {
					tripId: c.tripId,
					target: { kind: "trip" },
					url: "javascript:alert(1)",
				}),
			),
		).not.toBe("ok");
		// One activity line per batch.
		const rows = await getDb().execute(
			sql`select summary from activity_log where trip_id = ${c.tripId} and verb = 'media.add'`,
		);
		expect(rows.rows.length).toBeGreaterThan(0);
	});

	it("recorded oEmbed/OG fixtures: a 9:16 TikTok poster, the Instagram card, a guide card with a re-hosted favicon", async () => {
		const c = await freshTrip();
		const png = (w: number, h: number, bg: string) =>
			sharp({ create: { width: w, height: h, channels: 3, background: bg } })
				.png()
				.toBuffer();
		const poster = await png(360, 640, "#1d3557");
		const og = await png(1200, 630, "#e76f51");
		const icon = await png(32, 32, "#2a9d8f");
		const json = (url: string, v: unknown) => ({
			status: 200,
			headers: {},
			finalUrl: url,
			contentType: "application/json",
			body: Buffer.from(JSON.stringify(v)),
		});
		const image = (url: string, body: Buffer) => ({
			status: 200,
			headers: {},
			finalUrl: url,
			contentType: "image/png",
			body,
		});
		const fetched: string[] = [];
		// What the providers answered when these fixtures were recorded.
		const stub: SafeFetcher = async (url) => {
			fetched.push(url);
			if (url.startsWith("https://www.tiktok.com/oembed"))
				return json(url, {
					title: "Golden Gai at night",
					author_name: "nightowl",
					thumbnail_url: "https://p16-sign.tiktokcdn.com/obj/fixture.png",
					thumbnail_width: 360,
					thumbnail_height: 640,
					embed_product_id: "7300000000000000001",
				});
			if (url.includes("tiktokcdn.com")) return image(url, poster);
			if (url === "https://www.japan-guide.com/e/e2172.html")
				return {
					status: 200,
					headers: {},
					finalUrl: url,
					contentType: "text/html; charset=utf-8",
					body: Buffer.from(`<!doctype html><html><head>
						<meta property="og:title" content="Mt. Fuji Travel Guide">
						<meta property="og:description" content="We&amp;#039;ve got you covered &amp;mdash; from the best stores">
						<meta property="og:site_name" content="japan-guide.com">
						<meta property="og:image" content="/g2/2172_01.jpg">
						<link rel="icon" href="/favicon.png"></head><body></body></html>`),
				};
			if (url === "https://www.instagram.com/reel/C0FIXTURE01/")
				return {
					status: 200,
					headers: {},
					finalUrl: url,
					contentType: "text/html; charset=utf-8",
					body: Buffer.from(`<!doctype html><html><head>
						<meta property="og:title" content="Maz on Instagram: &quot;Chureito at dawn&quot;">
						<meta property="og:description" content="where.to.find.me on May 2, 2026: &quot;Chureito at dawn&quot;">
						<meta property="og:image" content="https://scontent.cdninstagram.com/v/fixture.jpg">
						</head><body></body></html>`),
				};
			if (url.includes("cdninstagram.com")) return image(url, poster);
			if (url === "https://www.japan-guide.com/g2/2172_01.jpg")
				return image(url, og);
			if (url === "https://www.japan-guide.com/favicon.png")
				return image(url, icon);
			return { ...image(url, Buffer.alloc(0)), status: 404 };
		};
		const add = (url: string, nodeId: string | undefined) =>
			call<MediaDto>(addLink, U.owner, {
				tripId: c.tripId,
				target: { kind: "node", nodeId },
				url,
			});
		const tiktok = await add(
			"https://www.tiktok.com/@nightowl/video/7300000000000000001",
			c.ids.nodes.shibuyaSky,
		);
		const reel = await add(
			"https://www.instagram.com/reel/C0FIXTURE01/?igsh=abc",
			c.ids.nodes.mtFuji,
		);
		const guide = await add(
			"https://www.japan-guide.com/e/e2172.html",
			c.ids.nodes.mtFuji,
		);
		for (const a of [tiktok, reel, guide])
			await linkPreview({ tripId: c.tripId, attachmentId: a.id }, stub);
		const list = await call<MediaDto[]>(listTripMedia, U.owner, {
			tripId: c.tripId,
		});
		const byId = (id: string) => list.find((m) => m.id === id);
		// TikTok: the oEmbed thumbnail re-hosted at once (it expires), 9:16.
		expect(byId(tiktok.id)).toMatchObject({
			kind: "embed",
			provider: "tiktok",
			status: "ready",
			hasImage: true,
			title: "Golden Gai at night",
			author: "nightowl",
		});
		expect(byId(tiktok.id)?.aspect).toBeCloseTo(9 / 16, 2);
		// Instagram: the public post page's picture (re-hosted) and caption,
		// asked for without the tracking parameter.
		expect(byId(reel.id)).toMatchObject({
			provider: "instagram",
			status: "ready",
			hasImage: true,
			title: "Chureito at dawn",
			author: "where.to.find.me",
			igType: "reel",
			url: "https://www.instagram.com/reel/C0FIXTURE01/",
		});
		expect(fetched.filter((u) => u.includes("instagram.com/reel"))).toEqual([
			"https://www.instagram.com/reel/C0FIXTURE01/",
		]);
		// japan-guide: an OG card with the image and the favicon re-hosted.
		expect(byId(guide.id)).toMatchObject({
			kind: "link",
			status: "ready",
			title: "Mt. Fuji Travel Guide",
			siteName: "japan-guide.com",
			hasImage: true,
			hasFavicon: true,
		});
		// VIS-16: double-encoded meta text (WordPress/Yoast) is stored decoded…
		const [stored] = await getDb()
			.select()
			.from(attachments)
			.where(sql`${attachments.id} = ${guide.id}`);
		expect(stored?.description).toBe(
			"We've got you covered — from the best stores",
		);
		expect(byId(guide.id)?.description).toBe(stored?.description);
		// …and a card stored raw before the fix reads clean too (list, Rate screen).
		await getDb().execute(
			sql`update attachments set description = 'We&#039;ve got you covered when it comes to Kappabashi knife shopping &mdash; from&hellip;', title = 'Knives &amp; more' where id = ${guide.id}`,
		);
		const again = await call<MediaDto[]>(listTripMedia, U.owner, {
			tripId: c.tripId,
		});
		expect(again.find((m) => m.id === guide.id)).toMatchObject({
			title: "Knives & more",
			description:
				"We've got you covered when it comes to Kappabashi knife shopping — from…",
		});
		const fav = await serveMedia(
			new Request(`http://localhost/media/${guide.id}/favicon`, {
				headers: { "x-test-user": U.guestViewer.id },
			}),
			guide.id,
			"favicon",
		);
		expect(fav.status).toBe(200);
		expect(fav.headers.get("content-type")).toBe("image/webp");
		const meta = await sharp(Buffer.from(await fav.arrayBuffer())).metadata();
		expect(meta.format).toBe("webp");
	});

	it("captions, moves (receipt rules), deletes with undo", async () => {
		const c = await freshTrip();
		const p = await upload(
			U.owner,
			c.tripId,
			{ kind: "node", nodeId: c.ids.nodes.shibuyaSky },
			await jpeg(),
			"image/jpeg",
			"p.jpg",
		);
		expect(
			await codeOf(
				call(updateAttachment, U.owner, {
					id: p.id,
					caption: "  **Sunset**  ",
				}),
			),
		).toBe("ok");
		expect(
			await codeOf(
				call(updateAttachment, U.viewer, { id: p.id, caption: "x" }),
			),
		).toBe("FORBIDDEN");
		expect(
			await codeOf(
				call(updateAttachment, U.owner, {
					id: p.id,
					target: { kind: "day", dayId: c.ids.days.d1 },
				}),
			),
		).toBe("ok");
		// Onto an expense of another trip: NOT_FOUND.
		expect(
			await codeOf(
				call(updateAttachment, U.owner, {
					id: p.id,
					target: { kind: "expense", expenseId: randomUUID() },
				}),
			),
		).toBe("NOT_FOUND");
		let list = await call<MediaDto[]>(listTripMedia, U.owner, {
			tripId: c.tripId,
		});
		expect(list.find((m) => m.id === p.id)).toMatchObject({
			caption: "**Sunset**",
			target: { kind: "day", dayId: c.ids.days.d1 },
		});
		expect(
			await codeOf(call(deleteAttachment, U.guestViewer, { id: p.id })),
		).toBe("FORBIDDEN");
		expect(await codeOf(call(deleteAttachment, U.owner, { id: p.id }))).toBe(
			"ok",
		);
		list = await call<MediaDto[]>(listTripMedia, U.owner, { tripId: c.tripId });
		expect(list.some((m) => m.id === p.id)).toBe(false);
		expect(await codeOf(call(restoreAttachment, U.viewer, { id: p.id }))).toBe(
			"FORBIDDEN",
		);
		expect(await codeOf(call(restoreAttachment, U.owner, { id: p.id }))).toBe(
			"ok",
		);
		list = await call<MediaDto[]>(listTripMedia, U.owner, { tripId: c.tripId });
		expect(list.some((m) => m.id === p.id)).toBe(true);
	});

	it("COLLAB-R3-04: a suggested link reads as one link, even right after the author's accepted one", async () => {
		const c = await freshTrip();
		const nodeId = c.ids.nodes.shibuyaSky as string;
		const target = { kind: "node", nodeId };
		const one = "added a link to Shibuya Sky";
		const suggest = (url: string) =>
			call<{ proposed?: { id: string; summary: string } }>(
				addLink,
				U.suggester,
				{ tripId: c.tripId, id: randomUUID(), target, url },
			);
		const accept = (proposalId: string | undefined) =>
			call(resolveProposal, U.owner, { proposalId, decision: "accept" });
		const addRows = async () =>
			(
				await getDb().execute(sql`
					select actor_name as "actor", summary from activity_log
					 where trip_id = ${c.tripId} and verb = 'media.add' and node_id = ${nodeId}
					 order by created_at`)
			).rows as { actor: string; summary: string }[];

		// The owner adds one directly, Sue suggests one and it is accepted…
		await call(addLink, U.owner, {
			tripId: c.tripId,
			target,
			url: "https://www.japan-guide.com/e/e3007.html",
		});
		const first = await suggest("https://www.japan-guide.com/e/e3011.html");
		expect(first.proposed?.summary).toBe(one);
		expect(await accept(first.proposed?.id)).toMatchObject({ ok: true });
		// …then, within two minutes, she suggests another link to the same place.
		const second = await suggest("https://www.japan-guide.com/e/e3002.html");
		expect(second.proposed?.summary, "one suggested link is one link").toBe(
			one,
		);
		const [p] = (
			await getDb().execute(
				sql`select summary from proposals where id = ${second.proposed?.id}`,
			)
		).rows as { summary: string }[];
		expect(p?.summary).toBe(one);
		// Accepting it batches her accepted adds only; the owner's line is untouched.
		expect(await accept(second.proposed?.id)).toMatchObject({ ok: true });
		expect(await addRows()).toEqual([
			{ actor: "Dev Owner", summary: one },
			{
				actor: "Sue (accepted by Dev)",
				summary: "added 2 links to Shibuya Sky",
			},
		]);
		// A direct add within the window still joins the owner's own batch.
		await call(addLink, U.owner, {
			tripId: c.tripId,
			target,
			url: "https://www.japan-guide.com/e/e3001.html",
		});
		expect((await addRows())[0]).toEqual({
			actor: "Dev Owner",
			summary: "added 2 links to Shibuya Sky",
		});
		// A dry run (an owner suggesting in suggest mode) never joins even the
		// same person's own batch: its line is the suggestion's summary.
		const rolledBack = new Error("rollback");
		await getDb()
			.transaction(async (tx) => {
				await logMediaAdd(
					tx,
					{ version: 0 },
					{
						tripId: c.tripId,
						actor: { userId: U.owner.id, name: "Dev Owner" },
						target: { kind: "node", nodeId },
						kind: "link",
						visibility: "everyone",
						dryRun: true,
					},
				);
				const rows = (
					await tx.execute(sql`
						select summary from activity_log
						 where trip_id = ${c.tripId} and verb = 'media.add' and version = 0`)
				).rows as { summary: string }[];
				expect(rows).toEqual([{ summary: one }]);
				throw rolledBack;
			})
			.catch((e) => {
				if (e !== rolledBack) throw e;
			});
	});
});

describe("receipts (ADDENDUM §6/§9)", () => {
	async function expense(tripId: string, by: AuthUser, isPrivate = false) {
		const [row] = await getDb()
			.insert(expenses)
			.values({
				tripId,
				title: "Ramen Ichiran",
				amountMinor: 1200,
				currency: "JPY",
				isPrivate,
				createdBy: by.id,
			})
			.returning({ id: expenses.id });
		return row?.id as string;
	}

	it("suggester members add and delete receipts directly; guests never see them", async () => {
		const c = await freshTrip();
		const expenseId = await expense(c.tripId, U.owner);
		const target = { kind: "expense", expenseId };
		const r = await upload(
			U.suggester,
			c.tripId,
			target,
			makePdf(["Receipt ¥1,200"]),
			"application/pdf",
			"receipt.pdf",
		);
		expect(r).toMatchObject({ kind: "pdf", visibility: "members", target });
		// Viewers can't add receipts; guests don't even see them.
		expect(
			await codeOf(
				call(createUpload, U.viewer, {
					tripId: c.tripId,
					target,
					type: "image/jpeg",
					size: 10,
					name: "r.jpg",
				}),
			),
		).toBe("FORBIDDEN");
		const guest = await call<MediaDto[]>(listTripMedia, U.guestEditor, {
			tripId: c.tripId,
		});
		expect(guest.some((m) => m.id === r.id)).toBe(false);
		expect(
			await codeOf(
				call(setAttachmentVisibility, U.owner, {
					id: r.id,
					visibility: "everyone",
				}),
			),
		).toBe("VALIDATION");
		// A suggester deletes directly (a ledger, not a plan), never as a proposal.
		expect(
			await codeOf(call(deleteAttachment, U.suggester, { id: r.id })),
		).toBe("ok");
		// ...but a general photo's caption or delete becomes a suggestion
		// (E7), keyed on the existing row (not claimed as a new id).
		const p = await upload(
			U.owner,
			c.tripId,
			{ kind: "trip" },
			await jpeg(),
			"image/jpeg",
			"p.jpg",
		);
		const del = await call<{ proposed?: { id: string } }>(
			deleteAttachment,
			U.suggester,
			{ id: p.id },
		);
		expect(del.proposed?.id).toBeTruthy();
		const cap = await call<{ proposed?: { id: string } }>(
			updateAttachment,
			U.suggester,
			{ id: p.id, caption: "Golden hour" },
		);
		expect(cap.proposed?.id).toBeTruthy();
		const still = await call<MediaDto[]>(listTripMedia, U.owner, {
			tripId: c.tripId,
		});
		expect(still.find((m) => m.id === p.id)?.caption ?? null).toBeNull();
		// Viewers can't even suggest.
		expect(await codeOf(call(deleteAttachment, U.viewer, { id: p.id }))).toBe(
			"FORBIDDEN",
		);
		// The owner accepts both: the caption lands, then the photo goes.
		for (const proposalId of [cap.proposed?.id, del.proposed?.id])
			expect(
				await call(resolveProposal, U.owner, {
					proposalId,
					decision: "accept",
				}),
			).toMatchObject({ ok: true, status: "accepted" });
		const after = await call<MediaDto[]>(listTripMedia, U.owner, {
			tripId: c.tripId,
		});
		expect(after.some((m) => m.id === p.id)).toBe(false);
	});

	it("a private expense's receipts reach only its creator", async () => {
		const c = await freshTrip();
		const expenseId = await expense(c.tripId, U.suggester, true);
		const r = await upload(
			U.suggester,
			c.tripId,
			{ kind: "expense", expenseId },
			await jpeg(),
			"image/jpeg",
			"gift.jpg",
		);
		const mine = await call<MediaDto[]>(listTripMedia, U.suggester, {
			tripId: c.tripId,
		});
		expect(mine.some((m) => m.id === r.id)).toBe(true);
		const owner = await call<MediaDto[]>(listTripMedia, U.owner, {
			tripId: c.tripId,
		});
		expect(owner.some((m) => m.id === r.id)).toBe(false);
		expect(await codeOf(call(deleteAttachment, U.owner, { id: r.id }))).toBe(
			"NOT_FOUND",
		);
		// SEC-R1-07: nobody else can put a file into it either (no upload, no
		// move), and the answer doesn't reveal that it exists.
		expect(
			await codeOf(
				call(createUpload, U.owner, {
					tripId: c.tripId,
					target: { kind: "expense", expenseId },
					type: "image/jpeg",
					size: 100,
					name: "r.jpg",
				}),
			),
		).toBe("NOT_FOUND");
		const photo = await upload(
			U.owner,
			c.tripId,
			{ kind: "trip" },
			await jpeg(),
			"image/jpeg",
			"mine.jpg",
		);
		expect(
			await codeOf(
				call(updateAttachment, U.owner, {
					id: photo.id,
					target: { kind: "expense", expenseId },
				}),
			),
		).toBe("NOT_FOUND");
		// A pending upload onto it that predates the rule can't be finished.
		const { id: pendingId } = await call<{ id: string }>(
			createUpload,
			U.owner,
			{
				tripId: c.tripId,
				target: { kind: "trip" },
				type: "image/jpeg",
				size: 100,
				name: "late.jpg",
			},
		);
		await getDb().execute(
			sql`update attachments set expense_id = ${expenseId} where id = ${pendingId}`,
		);
		expect(
			await codeOf(
				call(completeUpload, U.owner, { id: pendingId, hasPoster: false }),
			),
		).toBe("NOT_FOUND");
		// Its creator still adds receipts; a shared expense takes anyone's.
		expect(
			await codeOf(
				call(createUpload, U.suggester, {
					tripId: c.tripId,
					target: { kind: "expense", expenseId },
					type: "image/jpeg",
					size: 100,
					name: "r2.jpg",
				}),
			),
		).toBe("ok");
		const shared = await expense(c.tripId, U.suggester);
		expect(
			await codeOf(
				call(createUpload, U.owner, {
					tripId: c.tripId,
					target: { kind: "expense", expenseId: shared },
					type: "image/jpeg",
					size: 100,
					name: "r3.jpg",
				}),
			),
		).toBe("ok");
	});
});

describe("purge (SPEC §15.5)", () => {
	it("deletes old soft-deleted and abandoned pending attachments, S3 first", async () => {
		const c = await freshTrip();
		const p = await upload(
			U.owner,
			c.tripId,
			{ kind: "trip" },
			await jpeg(),
			"image/jpeg",
			"old.jpg",
		);
		await call(deleteAttachment, U.owner, { id: p.id });
		const { id: pendingId } = await call<{ id: string }>(
			createUpload,
			U.owner,
			{
				tripId: c.tripId,
				target: { kind: "trip" },
				type: "image/jpeg",
				size: 10,
				name: "abandoned.jpg",
			},
		);
		await getDb().execute(
			sql`update attachments set deleted_at = now() - interval '31 days' where id = ${p.id}`,
		);
		await getDb().execute(
			sql`update attachments set created_at = now() - interval '25 hours' where id = ${pendingId}`,
		);
		const dropped: string[] = [];
		const dry = await purge(getDb(), {
			dryRun: true,
			deletePrefix: async (x) => {
				dropped.push(x);
				return 0;
			},
		});
		expect(dry.attachments).toBeGreaterThanOrEqual(2);
		expect(dropped).toEqual([]);
		const r = await purge(getDb(), {
			deletePrefix: async (x) => {
				dropped.push(x);
				return 1;
			},
		});
		expect(r.attachments).toBeGreaterThanOrEqual(2);
		expect(dropped).toContain(`trips/${c.tripId}/${p.id}/`);
		const left = await getDb()
			.select()
			.from(attachments)
			.where(sql`${attachments.id} in (${p.id}, ${pendingId})`);
		expect(left).toEqual([]);
	});
});

describe("duplicated trips share objects (ADDENDUM §9, WP-Home request 6)", () => {
	/** What `duplicateTrip` writes: a new row in another trip, same keys. */
	async function copyRow(srcId: string, tripId: string): Promise<string> {
		const id = randomUUID();
		await getDb().execute(sql`
			insert into attachments (id, trip_id, kind, status, storage_key, mime, size_bytes, width,
			                         height, thumbhash, image_key, favicon_key, meta, position,
			                         visibility, created_by)
			select ${id}, ${tripId}, kind, status, storage_key, mime, size_bytes, width, height,
			       thumbhash, image_key, favicon_key, meta || jsonb_build_object('copiedFrom', id::text),
			       position, visibility, created_by
			  from attachments where id = ${srcId}`);
		return id;
	}
	const get = (id: string, variant: string) =>
		serveMedia(
			new Request(`http://localhost/media/${id}/${variant}`, {
				headers: { "x-test-user": U.owner.id },
			}),
			id,
			variant,
		);

	it("serves a copy from the source's objects; a processing copy follows its source", async () => {
		const a = await freshTrip();
		const b = await freshTrip();
		const src = await upload(
			U.owner,
			a.tripId,
			{ kind: "trip" },
			await jpeg(),
			"image/jpeg",
			"shared.jpg",
		);
		// Duplicated while the source was still processing.
		const copy = await copyRow(src.id, b.tripId);
		await mediaVariants({ tripId: a.tripId, attachmentId: src.id });
		const [row] = await getDb()
			.select()
			.from(attachments)
			.where(sql`${attachments.id} = ${copy}`);
		expect(row).toMatchObject({ status: "ready", tripId: b.tripId });
		expect((row?.meta as { thumb?: boolean } | undefined)?.thumb).toBe(true);

		const thumb = await get(copy, "thumb");
		expect(thumb.status).toBe(200);
		expect((await thumb.arrayBuffer()).byteLength).toBeGreaterThan(0);
		const display = await get(copy, "display");
		expect(display.status).toBe(302);
		expect(display.headers.get("location")).toContain(
			`trips/${a.tripId}/${src.id}/display.webp`,
		);
		// A stranger's request (no session) never gets it.
		const anon = await serveMedia(
			new Request(`http://localhost/media/${copy}/thumb`),
			copy,
			"thumb",
		);
		expect(anon.status).toBe(404);
	});

	it("the purge keeps a prefix while a copy (or another trip's copy) still points at it", async () => {
		const a = await freshTrip();
		const b = await freshTrip();
		const src = await upload(
			U.owner,
			a.tripId,
			{ kind: "trip" },
			await jpeg(),
			"image/jpeg",
			"src.jpg",
		);
		await mediaVariants({ tripId: a.tripId, attachmentId: src.id });
		const other = await upload(
			U.owner,
			a.tripId,
			{ kind: "trip" },
			await jpeg(),
			"image/jpeg",
			"only-here.jpg",
		);
		const copy = await copyRow(src.id, b.tripId);
		const srcPrefix = `trips/${a.tripId}/${src.id}/`;
		const otherPrefix = `trips/${a.tripId}/${other.id}/`;
		const run = async () => {
			const dropped: string[] = [];
			await purge(getDb(), {
				deletePrefix: async (x) => {
					dropped.push(x);
					return 1;
				},
				listSubPrefixes: async () => [srcPrefix, otherPrefix],
			});
			return dropped;
		};
		const age = (id: string) =>
			getDb().execute(
				sql`update attachments set deleted_at = now() - interval '31 days' where id = ${id}`,
			);

		// The source row goes; its objects stay for the copy.
		await age(src.id);
		let dropped = await run();
		expect(dropped).not.toContain(srcPrefix);
		expect(
			(await get(copy, "thumb")).status,
			"the copy still has its picture",
		).toBe(200);

		// The source trip goes: its prefix is purged except the shared one.
		await getDb().execute(
			sql`update trips set deleted_at = now() - interval '31 days' where id = ${a.tripId}`,
		);
		dropped = await run();
		expect(dropped).not.toContain(`trips/${a.tripId}/`);
		expect(dropped).not.toContain(srcPrefix);
		expect(dropped).toContain(otherPrefix);

		// The last copy goes: now the shared prefix is deleted too.
		await age(copy);
		dropped = await run();
		expect(dropped).toContain(srcPrefix);
		expect(dropped).toContain(`trips/${b.tripId}/${copy}/`);
	});
});
