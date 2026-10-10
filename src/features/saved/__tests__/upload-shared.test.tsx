/**
 * A share's files up to Saved: a HEIC photo goes through the trip uploads'
 * converter and its EXIF location goes up with it; a file refused for good
 * is left out (never retried), and a share with nothing left is dropped
 * from the device, saying why.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type SharedEntry,
	sanitizeShared,
} from "@/features/offline/share-store";

const calls = vi.hoisted(() => ({
	prepared: [] as { name: string; type: string }[],
	started: [] as Record<string, unknown>[],
	completed: [] as Record<string, unknown>[],
	deleted: [] as string[],
	toasts: [] as { kind: string; text: string; description?: string }[],
	inbox: [] as unknown[],
}));

vi.mock("@/features/media/upload/prepare", async (orig) => {
	const real = await orig<typeof import("@/features/media/upload/prepare")>();
	return {
		...real,
		prepareFile: async (f: File) => {
			calls.prepared.push({ name: f.name, type: f.type });
			if (f.name.endsWith(".tif"))
				throw new real.PrepareError(`${f.name} isn't a photo, video or PDF.`);
			const heic = /\.heic$/i.test(f.name);
			return {
				blob: heic ? new Blob(["jpeg"], { type: "image/jpeg" }) : f,
				type: heic ? "image/jpeg" : f.type,
				name: heic ? f.name.replace(/\.heic$/i, ".jpg") : f.name,
				kind: "photo",
				width: 4032,
				height: 3024,
				takenAt: "2026-04-02T09:30:00.000Z",
				...(heic ? { gps: { lat: 35.0116, lng: 135.7681 } } : {}),
				previewUrl: null,
			};
		},
	};
});
vi.mock("@/features/media/upload/uploader", () => ({
	putBlob: async () => {},
}));
vi.mock("../saved.functions", () => ({
	startSavedUpload: async (o: { data: Record<string, unknown> }) => {
		calls.started.push(o.data);
		return {
			savedId: "s1",
			fileId: `f${calls.started.length}`,
			done: false,
			url: "x",
		};
	},
	completeSavedUpload: async (o: { data: Record<string, unknown> }) => {
		calls.completed.push(o.data);
		return { savedId: "s1", done: true };
	},
	signSavedUploadParts: async () => ({ urls: [] }),
	saveSharedLink: async () => ({ id: "x" }),
}));
vi.mock("@/features/offline/share-store", async (orig) => ({
	...(await orig<typeof import("@/features/offline/share-store")>()),
	listShared: async () => calls.inbox,
	deleteShared: async (id: string) => {
		calls.deleted.push(id);
		calls.inbox = calls.inbox.filter((e) => (e as SharedEntry).id !== id);
	},
}));
vi.mock("sonner", () => {
	const t = (kind: string) => (text: string, o?: { description?: string }) => {
		calls.toasts.push({ kind, text, description: o?.description });
		return "t";
	};
	return {
		toast: Object.assign(t("plain"), {
			loading: t("loading"),
			success: t("success"),
			error: t("error"),
		}),
	};
});
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({
		navigate: async () => {},
		options: {
			context: { queryClient: { invalidateQueries: async () => {} } },
		},
	}),
}));
vi.mock("@/features/push/use-push", () => ({ useHasAccount: () => true }));

import { ShareRefused, uploadShare } from "../upload-shared";
import { useSharedUpload } from "../use-shared-upload";

afterEach(() => {
	for (const k of Object.keys(calls) as (keyof typeof calls)[])
		(calls[k] as unknown[]).length = 0;
});

const file = (name: string, type: string) => {
	const blob = new Blob(["x".repeat(10)], { type });
	return { name, type, size: blob.size, blob };
};
const entry = (id: string, files: SharedEntry["files"]): SharedEntry => ({
	id,
	createdAt: Date.now(),
	title: null,
	text: "Kyoto morning",
	url: null,
	files,
});

describe("a share's photos up to Saved", () => {
	it("converts a HEIC first and sends where it was taken", async () => {
		const r = await uploadShare(
			entry("e1", [file("IMG_1.HEIC", "image/heic")]),
		);
		expect(calls.prepared).toEqual([
			{ name: "IMG_1.HEIC", type: "image/heic" },
		]);
		expect(calls.started[0]).toMatchObject({ type: "image/jpeg", position: 0 });
		expect(calls.completed[0]).toMatchObject({
			id: "f1",
			gps: { lat: 35.0116, lng: 135.7681 },
			takenAt: "2026-04-02T09:30:00.000Z",
			width: 4032,
		});
		expect(r).toEqual({ savedId: "s1", refused: [] });
	});

	it("leaves out a file refused for good, and saves the rest", async () => {
		const r = await uploadShare(
			entry("e2", [
				file("scan.tif", "image/tiff"),
				file("a.jpg", "image/jpeg"),
			]),
		);
		expect(calls.started).toHaveLength(1);
		expect(calls.started[0]).toMatchObject({ position: 0, type: "image/jpeg" });
		expect(r.refused).toEqual(["scan.tif isn't a photo, video or PDF."]);
	});

	it("nothing left: ShareRefused", async () => {
		await expect(
			uploadShare(entry("e3", [file("scan.tif", "image/tiff")])),
		).rejects.toBeInstanceOf(ShareRefused);
	});

	it("a share on the device with nothing it can take is dropped, saying why", async () => {
		calls.inbox.push(entry("e4", [file("scan.tif", "image/tiff")]));
		renderHook(() => useSharedUpload());
		await waitFor(() => expect(calls.deleted).toEqual(["e4"]));
		expect(calls.toasts.at(-1)).toMatchObject({
			kind: "error",
			text: "A share couldn't be saved",
			description: "scan.tif isn't a photo, video or PDF.",
		});
	});

	it("the share target keeps a HEIC, even one without a type", () => {
		const e = sanitizeShared(
			{ files: [file("IMG_2.heic", ""), file("IMG_3.HEIC", "image/heic")] },
			"e5",
		);
		expect(e.files.map((f) => f.type)).toEqual(["image/heic", "image/heic"]);
	});
});
