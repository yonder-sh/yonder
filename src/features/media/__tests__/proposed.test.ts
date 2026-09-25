/**
 * COLLAB-R3-05: a suggested link's ghost and the attachment it becomes share
 * one id, and accepting refetches `media` and `proposals` side by side.
 * `withGhosts` keeps one tile per id whichever lands first, so React never
 * sees two children with the same key and the tile never blinks out.
 */
import { describe, expect, it } from "vitest";
import type { ProposalDto } from "@/lib/schemas/proposals";
import { linkTileId, withGhosts } from "../proposed";
import type { MediaDto } from "../types";

const ATT = "00000000-0000-7000-8000-00000000a0a1";
const NODE = "00000000-0000-7000-8000-000000000101";

function proposal(
	status: ProposalDto["status"],
	extra: Partial<ProposalDto> = {},
): ProposalDto {
	return {
		id: "00000000-0000-7000-8000-00000000b0b1",
		tripId: "00000000-0000-7000-8000-000000000001",
		op: "attachment.link",
		payload: {
			tripId: "00000000-0000-7000-8000-000000000001",
			id: ATT,
			target: { kind: "node", nodeId: NODE },
			url: "https://www.japan-guide.com/e/e3007.html",
		},
		entityKind: "att",
		entityId: ATT,
		createdIds: [ATT],
		requires: [],
		summary: "added a link to Golden Gai",
		message: null,
		status,
		author: {
			userId: "maya",
			memberId: "00000000-0000-7000-8000-00000000c0c1",
			name: "Maya Chen",
			color: 3,
			isGuest: false,
		},
		fields: [],
		before: {},
		reviewedBy: null,
		reviewedAt: null,
		reviewNote: null,
		lastError: null,
		dependants: [],
		createdAt: "2026-09-23T10:00:00.000Z",
		updatedAt: "2026-09-23T10:00:00.000Z",
		...extra,
	};
}

/** The attachment the accept created (what `listTripMedia` returns). */
const row = {
	id: ATT,
	target: { kind: "node", nodeId: NODE },
	kind: "link",
	status: "processing",
	visibility: "everyone",
	url: "https://www.japan-guide.com/e/e3007.html",
	position: "a0",
} as MediaDto;

const ids = (xs: readonly MediaDto[]) => xs.map((x) => x.id);

describe("withGhosts (COLLAB-R3-05)", () => {
	it("an open suggestion is a ghost tile under its pinned attachment id", () => {
		const p = proposal("open");
		const out = withGhosts([], [p]);
		expect(ids(out)).toEqual([ATT]);
		expect(linkTileId(p)).toBe(ATT);
		expect(out[0]?.proposed).toMatchObject({ proposalId: p.id });
	});

	it("the media list lands first: the real row wins, never a second tile with its id", () => {
		const out = withGhosts([row], [proposal("open")]);
		expect(ids(out)).toEqual([ATT]);
		expect(out[0]).toBe(row);
		expect(out[0]?.proposed).toBeUndefined();
	});

	it("the proposals land first: the accepted link keeps a plain tile while media refetches", () => {
		const p = proposal("accepted");
		const out = withGhosts([], [p], new Set([p.id]));
		expect(ids(out)).toEqual([ATT]);
		expect(out[0]?.proposed).toBeUndefined();
		// …and the row replaces it when it arrives.
		expect(withGhosts([row], [p], new Set([p.id]))).toEqual([row]);
	});

	it("an accepted, rejected or withdrawn suggestion outside the bridge draws nothing", () => {
		for (const s of ["accepted", "rejected", "withdrawn"] as const)
			expect(withGhosts([], [proposal(s)])).toEqual([]);
		// Only an accepted one is bridged.
		const r = proposal("rejected");
		expect(withGhosts([], [r], new Set([r.id]))).toEqual([]);
	});

	it("a payload a guest can't read is skipped; other ops are ignored", () => {
		expect(withGhosts([], [proposal("open", { payload: {} })])).toEqual([]);
		expect(
			withGhosts([], [proposal("open", { op: "attachment.update" })]),
		).toEqual([]);
	});

	it("rows keep their identity when nothing is added", () => {
		const rows = [row];
		expect(withGhosts(rows, [])).toBe(rows);
	});
});
