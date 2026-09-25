/**
 * The gallery's rollup (QA ROLL-09/11, SPEC §8.4) on the demo fixture, and
 * which documents are kept offline (ADDENDUM §9).
 */
import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import { demo, N } from "@/lib/fixtures/demo";
import type { AttachmentTarget } from "@/lib/schemas/targets";
import { buildGroups } from "../gallery-groups";
import { offlineDocs, offlineUrls } from "../offline/doc-cache";
import type { MediaDto } from "../types";

const ix = indexGraph(demo.graph);
const schedule = computeSchedule(ix);

let n = 0;
function media(
	kind: MediaDto["kind"],
	target: AttachmentTarget,
	extra: Partial<MediaDto> = {},
): MediaDto {
	n += 1;
	return {
		id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
		target,
		kind,
		status: "ready",
		visibility: "everyone",
		mime: null,
		width: 400,
		height: 300,
		durationSec: null,
		thumbhash: null,
		takenAt: null,
		url: null,
		provider: null,
		embedId: null,
		title: null,
		siteName: null,
		caption: null,
		position: `a${n}`,
		createdAt: "2026-09-23T00:00:00.000Z",
		updatedAt: "2026-09-23T00:00:00.000Z",
		description: null,
		author: null,
		sizeBytes: null,
		hasThumb: true,
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
		mine: false,
		...extra,
	};
}

// ROLL-09 on the demo: a photo at the ryokan (Mt. Fuji), a video and a
// YouTube link on the Fuji Excursion leg (Itoya in Tokyo → the ryokan), a
// Reel at Kawaguchiko, and a photo at Shibuya Sky (Tokyo).
const ryokanPhoto = media("photo", {
	kind: "node",
	nodeId: N.ryokan as string,
});
const legVideo = media("video", { kind: "leg", legId: demo.L.fuji as string });
const legYouTube = media(
	"embed",
	{ kind: "leg", legId: demo.L.fuji as string },
	{ provider: "youtube" },
);
const reel = media(
	"embed",
	{ kind: "node", nodeId: N.kawaguchiko as string },
	{ provider: "instagram" },
);
const skyPhoto = media("photo", {
	kind: "node",
	nodeId: N.shibuyaSky as string,
});
const receipt = media("pdf", {
	kind: "expense",
	expenseId: "00000000-0000-7000-8000-00000000e001",
});
const all = [ryokanPhoto, legVideo, legYouTube, reel, skyPhoto, receipt];

const ids = (
	scopeId: string | null,
	lens: "area" | "city" | "place" = "area",
	extra = {},
) =>
	buildGroups(ix, schedule, all, { scopeId, lens, ...extra }, scopeId)
		.flatMap((g) => g.tiles)
		.map((t) => t.item.id);

describe("rollup (ROLL-09)", () => {
	it("Mt. Fuji: the ryokan photo, the leg's video and link, the Reel — not Shibuya", () => {
		const got = ids(N.mtFuji as string);
		expect(new Set(got)).toEqual(
			new Set([ryokanPhoto.id, legVideo.id, legYouTube.id, reel.id]),
		);
	});

	it("Tokyo: the leg media (it starts at Itoya) and the Shibuya Sky photo", () => {
		const got = ids(N.tokyo as string);
		expect(new Set(got)).toEqual(
			new Set([legVideo.id, legYouTube.id, skyPhoto.id]),
		);
	});

	it("the trip: everything but receipts (they live with the money)", () => {
		expect(new Set(ids(null, "city"))).toEqual(
			new Set([
				ryokanPhoto.id,
				legVideo.id,
				legYouTube.id,
				reel.id,
				skyPhoto.id,
			]),
		);
	});

	it("Only Tokyo: just Tokyo's own", () => {
		expect(
			ids(N.tokyo as string, "area", { includeDescendants: false }),
		).toEqual([]);
	});

	it("names each tile's source in a rollup", () => {
		const groups = buildGroups(
			ix,
			schedule,
			all,
			{ scopeId: N.tokyo as string, lens: "area" },
			N.tokyo as string,
		);
		const sources = Object.fromEntries(
			groups.flatMap((g) => g.tiles).map((t) => [t.item.id, t.source]),
		);
		expect(sources[skyPhoto.id]).toBe("Shibuya › Shibuya Sky");
		expect(sources[legVideo.id]).toMatch(/^Transit · /);
		const shibuya = groups.find(
			(g) => g.header?.kind === "rep" && g.header.repId === N.shibuya,
		);
		expect(shibuya?.tiles.map((t) => t.item.id)).toEqual([skyPhoto.id]);
	});

	it("a day's rollup (ROLL-11) shows only that day's items and legs", () => {
		const d1 = ix.days[0];
		if (!d1) throw new Error("no day");
		const got = ids(null, "place", {
			dayRange: { from: d1.date, to: d1.date },
		});
		expect(got).toEqual([skyPhoto.id]);
	});
});

describe("offline documents", () => {
	it("keeps small rendered PDFs, never receipts or big ones", () => {
		const small = media(
			"pdf",
			{ kind: "node", nodeId: N.tokyo as string },
			{ pages: 2, sizeBytes: 300_000 },
		);
		const big = media(
			"pdf",
			{ kind: "node", nodeId: N.tokyo as string },
			{ pages: 3, sizeBytes: 6 * 1024 * 1024 },
		);
		const unrendered = media(
			"pdf",
			{ kind: "trip" },
			{ pages: 0, sizeBytes: 1000 },
		);
		const paperReceipt = media(
			"pdf",
			{ kind: "expense", expenseId: "00000000-0000-7000-8000-00000000e002" },
			{ pages: 1, sizeBytes: 1000 },
		);
		const docs = offlineDocs([small, big, unrendered, paperReceipt, skyPhoto]);
		expect(docs.map((d) => d.id)).toEqual([small.id]);
		expect(offlineUrls(docs)).toEqual([
			`/media/${small.id}/thumb`,
			`/media/${small.id}/page-1`,
			`/media/${small.id}/page-2`,
		]);
	});
});
