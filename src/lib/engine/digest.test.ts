import { describe, expect, it } from "vitest";
import type { DigestRow } from "@/functions/activity.functions";
import { demo, N } from "@/lib/fixtures/demo";
import { buildDigest, DIGEST_LINES_PER_ACTOR, digestCount } from "./digest";
import { indexGraph } from "./graph-index";

const ix = indexGraph(demo.graph);
let seq = 0;
function row(
	p: Partial<DigestRow> & Pick<DigestRow, "verb" | "summary">,
): DigestRow {
	seq += 1;
	return {
		id: `r${seq}`,
		at: new Date(Date.UTC(2027, 0, 1, 0, 0, 1000 - seq)).toISOString(),
		version: 1000 - seq,
		actorUserId: "user-audrey",
		actorName: "Audrey",
		nodeId: null,
		itemId: null,
		legId: null,
		dayId: null,
		meta: null,
		actorIsGuest: false,
		...p,
	};
}
const ME = { meUserId: "user-dennis" };

describe("buildDigest", () => {
	it("never shows my own rows", () => {
		const g = buildDigest(
			[
				row({
					verb: "node.update",
					summary: "renamed Tokyo",
					actorUserId: "user-dennis",
					actorName: "Dennis",
				}),
			],
			ix,
			ME,
		);
		expect(g).toEqual([]);
		expect(
			digestCount(
				[row({ verb: "x", summary: "y", actorUserId: "user-dennis" })],
				ME,
			),
		).toBe(0);
	});

	it("collapses places added in one city into one line with names", () => {
		const g = buildDigest(
			[
				row({
					verb: "node.create",
					summary: "added Kiyomizu-dera",
					nodeId: N.kiyomizu,
				}),
				row({
					verb: "node.create",
					summary: "added Nishiki",
					nodeId: null,
					meta: { name: "Nishiki Market" },
				}),
				row({
					verb: "node.create",
					summary: "added Shibuya Sky",
					nodeId: N.shibuyaSky,
				}),
				row({
					verb: "node.create",
					summary: "added Meiji Jingu",
					nodeId: N.meijiJingu,
				}),
				row({
					verb: "node.create",
					summary: "added Senso-ji",
					nodeId: N.sensoji,
				}),
			],
			ix,
			ME,
		);
		expect(g).toHaveLength(1);
		const texts = g[0]?.lines.map((l) => l.text);
		expect(texts).toContain(
			"added 3 places in Tokyo: Shibuya Sky, Meiji Jingu +1",
		);
		expect(texts).toContain("added Kiyomizu-dera");
		// The unlocated one keeps its own (single) line.
		expect(texts).toContain("added Nishiki");
		// Lines keep newest-first order: Kiyomizu (newest) first.
		expect(texts?.[0]).toBe("added Kiyomizu-dera");
	});

	it("keeps only the newest of several moves of one item", () => {
		const itoya = demo.I.itoya ?? "";
		const g = buildDigest(
			[
				row({
					verb: "item.move",
					summary: "moved Itoya Ginza to Day 5",
					itemId: itoya,
				}),
				row({
					verb: "item.move",
					summary: "moved Itoya Ginza to Day 3",
					itemId: itoya,
				}),
				row({
					verb: "item.move",
					summary: "moved Itoya Ginza to Day 1",
					itemId: itoya,
				}),
			],
			ix,
			ME,
		);
		expect(g[0]?.lines.map((l) => l.text)).toEqual([
			"moved Itoya Ginza to Day 5",
		]);
	});

	it("drops something created and then deleted", () => {
		const g = buildDigest(
			[
				row({
					verb: "node.delete",
					summary: "deleted Ramen Shop",
					nodeId: "00000000-0000-7000-8000-00000000abcd",
				}),
				row({
					verb: "node.create",
					summary: "added Ramen Shop",
					nodeId: "00000000-0000-7000-8000-00000000abcd",
				}),
				row({ verb: "node.update", summary: "renamed Tokyo", nodeId: N.tokyo }),
			],
			ix,
			ME,
		);
		expect(g[0]?.lines.map((l) => l.text)).toEqual(["renamed Tokyo"]);
	});

	it("collapses suggestions, to-dos and media", () => {
		const g = buildDigest(
			[
				row({ verb: "proposal.create", summary: "suggested moving Itoya" }),
				row({ verb: "proposal.create", summary: "suggested deleting Sky" }),
				row({ verb: "list.create", summary: "added a to-do" }),
				row({ verb: "list.create", summary: "added a to-do" }),
				row({ verb: "list.create", summary: "added a to-do" }),
				row({
					verb: "media.add",
					summary: "added 4 photos",
					nodeId: N.shibuyaSky,
					meta: { count: 4 },
				}),
				row({
					verb: "media.add",
					summary: "added 2 photos",
					nodeId: N.meijiJingu,
					meta: { count: 2 },
				}),
			],
			ix,
			ME,
		);
		const texts = g[0]?.lines.map((l) => l.text);
		expect(texts).toEqual([
			"suggested 2 changes",
			"added 3 to-dos",
			"added 6 photos and links to Tokyo",
		]);
	});

	it("groups by actor and caps lines per actor with a remainder", () => {
		const rows: DigestRow[] = [];
		for (let i = 0; i < DIGEST_LINES_PER_ACTOR + 3; i++)
			rows.push(row({ verb: "trip.update", summary: `change ${i}` }));
		rows.push(
			row({
				verb: "trip.update",
				summary: "Maya's change",
				actorUserId: "user-maya",
				actorName: "Maya",
			}),
		);
		const g = buildDigest(rows, ix, ME);
		expect(g.map((x) => x.actorName)).toEqual(["Audrey", "Maya"]);
		expect(g[0]?.lines).toHaveLength(DIGEST_LINES_PER_ACTOR);
		expect(g[0]?.more).toBe(3);
		expect(g[1]?.more).toBe(0);
	});

	it("uses the current name of a live entity", () => {
		const sky = demo.I.sky ?? "";
		const g = buildDigest(
			[
				row({
					verb: "item.create",
					summary: "added Old Name to Day 1",
					itemId: sky,
				}),
				row({
					verb: "item.create",
					summary: "added Hands to Day 1",
					itemId: demo.I.hands ?? "",
				}),
			],
			ix,
			ME,
		);
		expect(g[0]?.lines[0]?.text).toBe(
			"added 2 stops in Tokyo: Shibuya Sky, Hands Shibuya",
		);
	});
});
