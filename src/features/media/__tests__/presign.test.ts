/**
 * Presigned URLs in production (Kubernetes): the browser reaches the storage
 * at S3_PUBLIC_ENDPOINT (https://s3.axolotl.cloud) while the pods talk to an
 * in-cluster S3_ENDPOINT. Every browser URL (single PUT, multipart part, GET)
 * is signed for the public host, path-style, with its length or type bound;
 * only the worker's internal GET uses the in-cluster host. Pure (no network).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnv } from "@/server/env.server";
import { resetS3 } from "@/server/s3.server";
import {
	partSizes,
	presignGet,
	presignPart,
	presignPut,
} from "../server/storage.server";

const saved = { ...process.env };

beforeAll(() => {
	Object.assign(process.env, {
		S3_ENDPOINT: "http://rook-ceph-rgw-store.rook-ceph.svc:80",
		S3_PUBLIC_ENDPOINT: "https://s3.axolotl.cloud",
		S3_BUCKET: "yonder-media",
		S3_REGION: "us-east-1",
		S3_FORCE_PATH_STYLE: "true",
	});
	resetEnv();
	resetS3();
});

afterAll(() => {
	for (const k of Object.keys(process.env))
		if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
	resetEnv();
	resetS3();
});

const KEY =
	"trips/0190c3e4-0000-7000-8000-000000000001/0190c3e4-0000-7000-8000-000000000002/original.upload";

describe("browser URLs are signed for S3_PUBLIC_ENDPOINT", () => {
	it("single PUT: public host, path-style, type and length signed", async () => {
		const u = new URL(await presignPut(KEY, "image/jpeg", 1234));
		expect(u.origin).toBe("https://s3.axolotl.cloud");
		expect(u.pathname).toBe(`/yonder-media/${KEY}`);
		expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe(
			"content-length;content-type;host",
		);
		expect(u.searchParams.get("X-Amz-Expires")).toBe("600");
		// No checksum a browser couldn't compute.
		expect([...u.searchParams.keys()].some((k) => /checksum/i.test(k))).toBe(
			false,
		);
	});

	it("multipart part: public host, its part number and upload id, length signed", async () => {
		const u = new URL(
			await presignPart(KEY, "upload-123", 3, 16 * 1024 * 1024),
		);
		expect(u.origin).toBe("https://s3.axolotl.cloud");
		expect(u.pathname).toBe(`/yonder-media/${KEY}`);
		expect(u.searchParams.get("partNumber")).toBe("3");
		expect(u.searchParams.get("uploadId")).toBe("upload-123");
		expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe(
			"content-length;host",
		);
		expect(u.searchParams.get("X-Amz-Expires")).toBe("600");
	});

	it("GET: public for the browser, in-cluster for the worker; type and disposition bound", async () => {
		const pub = new URL(
			await presignGet("trips/a/b/original", {
				contentType: "video/mp4",
				disposition: 'inline; filename="fuji.mp4"',
			}),
		);
		expect(pub.origin).toBe("https://s3.axolotl.cloud");
		expect(pub.searchParams.get("response-content-type")).toBe("video/mp4");
		expect(pub.searchParams.get("response-content-disposition")).toBe(
			'inline; filename="fuji.mp4"',
		);
		const internal = new URL(
			await presignGet("trips/a/b/original", { internal: true }),
		);
		expect(internal.origin).toBe("http://rook-ceph-rgw-store.rook-ceph.svc");
	});
});

describe("partSizes", () => {
	it("splits into full parts and the rest", () => {
		const MiB = 1024 * 1024;
		expect(partSizes(16 * MiB, 16 * MiB)).toEqual([16 * MiB]);
		expect(partSizes(16 * MiB + 1, 16 * MiB)).toEqual([16 * MiB, 1]);
		expect(partSizes(40 * MiB, 16 * MiB)).toEqual([
			16 * MiB,
			16 * MiB,
			8 * MiB,
		]);
		expect(partSizes(2048 * MiB, 16 * MiB)).toHaveLength(128);
	});
});
