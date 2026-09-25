import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import {
	type Attachment,
	attachments,
	nodes,
	timeline,
} from "./__fixtures__/asia-trip";
import {
	collectInScope,
	groupRollupByNode,
	type RollupContext,
	type RollupScope,
	resolveScope,
} from "./collect";
import { createHierarchy } from "./hierarchy";

const h = createHierarchy(nodes);
const ctx: RollupContext = { hierarchy: h, timeline, tripId: "asia-2027" };
const ids = (scope: RollupScope, c: RollupContext = ctx) =>
	collectInScope(attachments, scope, c).attachments.map((a) => a.id);

describe("node scopes (subtree incl. timeline items / legs / days that reference it)", () => {
	it("Shinjuku: area + places + items there + legs touching it + days visiting it", () => {
		const r = collectInScope(
			attachments,
			{ type: "node", id: "shinjuku" },
			ctx,
		);
		expect(r.attachments.map((a) => a.id)).toEqual([
			"a-tax-free",
			"a-camera",
			"a-gg-cash",
			"a-suica",
			"a-fuji-tickets",
		]);
		expect(r.countsByEntityType).toEqual({
			node: 2,
			item: 1,
			leg: 1,
			day: 1,
			trip: 0,
		});
		expect(r.unresolved.map((a) => a.id)).toEqual(["a-ghost", "a-ghost-item"]);
		expect(
			r.matches.find((m) => m.attachment.id === "a-fuji-tickets")?.nodeId,
		).toBe("shinjuku");
		expect(r.matches.find((m) => m.attachment.id === "a-gg-cash")?.nodeId).toBe(
			"golden-gai",
		);
		expect(
			r.matches.find((m) => m.attachment.id === "a-suica")?.nodeId,
		).toBeNull();
	});

	it("Golden Gai (a single place): only what hangs off it", () => {
		expect(ids({ type: "node", id: "golden-gai" })).toEqual(["a-gg-cash"]);
	});

	it("Tokyo", () => {
		expect(ids({ type: "node", id: "tokyo" })).toEqual([
			"a-ic-card",
			"a-jal-tour",
			"a-tax-free",
			"a-camera",
			"a-knife",
			"a-gg-cash",
			"a-sky-ticket",
			"a-suica",
			"a-fuji-tickets",
		]);
	});

	it("Japan picks up the KIX->ICN ticket (departs Japan) and the Osaka->Seoul day", () => {
		expect(ids({ type: "node", id: "jp" })).toEqual([
			"a-jr-pass",
			"a-ic-card",
			"a-jal-tour",
			"a-tax-free",
			"a-camera",
			"a-knife",
			"a-gg-cash",
			"a-sky-ticket",
			"a-suica",
			"a-fuji-tickets",
			"a-kix-icn-eticket",
			"a-d10-sim",
		]);
	});

	it("South Korea gets the same flight via its arrival end", () => {
		const r = collectInScope(attachments, { type: "node", id: "kr" }, ctx);
		expect(r.attachments.map((a) => a.id)).toEqual([
			"a-kix-icn-eticket",
			"a-d10-sim",
		]);
		expect(r.matches[0]?.nodeId).toBe("icn");
	});

	it("Vietnam", () => {
		expect(ids({ type: "node", id: "vn" })).toEqual([
			"a-train-tickets",
			"a-suit",
		]);
	});

	it("legMatch 'both' excludes legs that leave the subtree", () => {
		expect(ids({ type: "node", id: "shinjuku", legMatch: "both" })).toEqual([
			"a-tax-free",
			"a-camera",
			"a-gg-cash",
			"a-suica",
		]);
		expect(ids({ type: "node", id: "jp", legMatch: "both" })).not.toContain(
			"a-kix-icn-eticket",
		);
	});

	it("dayMatch 'all' / 'none'", () => {
		expect(
			ids({ type: "node", id: "shinjuku", dayMatch: "all" }),
		).not.toContain("a-suica");
		expect(
			ids({ type: "node", id: "shinjuku", dayMatch: "none" }),
		).not.toContain("a-suica");
		expect(ids({ type: "node", id: "tokyo", dayMatch: "all" })).toContain(
			"a-suica",
		); // day 1 is all-Tokyo
		expect(ids({ type: "node", id: "jp", dayMatch: "all" })).not.toContain(
			"a-d10-sim",
		); // Osaka -> Seoul day is mixed
	});

	it("includeAncestors / includeTrip", () => {
		expect(
			ids({
				type: "node",
				id: "shinjuku",
				includeAncestors: true,
				includeTrip: true,
			}),
		).toEqual([
			"a-insurance",
			"a-jr-pass",
			"a-ic-card",
			"a-tax-free",
			"a-camera",
			"a-gg-cash",
			"a-suica",
			"a-fuji-tickets",
		]);
	});

	it("an unknown node scope is empty", () => {
		expect(ids({ type: "node", id: "atlantis" })).toEqual([]);
	});

	it("explicit leg endpoint nodes override the items' nodes", () => {
		const t = {
			days: [
				{
					id: "x",
					items: [
						{ id: "lounge", title: "Lounge" },
						{ id: "arrive", title: "Arrive" },
					],
				},
			],
			legs: [
				{
					id: "flight",
					fromItemId: "lounge",
					toItemId: "arrive",
					fromNodeId: "kix",
					toNodeId: "icn",
				},
			],
		};
		const list: Attachment[] = [
			{
				id: "bp",
				kind: "attachment",
				title: "Boarding pass",
				entity: { type: "leg", id: "flight" },
			},
		];
		const c: RollupContext = { hierarchy: h, timeline: t };
		expect(
			collectInScope(list, { type: "node", id: "osaka" }, c).attachments,
		).toHaveLength(1);
		expect(
			collectInScope(list, { type: "node", id: "seoul" }, c).attachments,
		).toHaveLength(0);
		expect(
			collectInScope(list, { type: "node", id: "kr" }, c).matches[0]?.nodeId,
		).toBe("icn");
	});
});

describe("day scopes", () => {
	it("day 1: its items, the nodes it visits, legs touching it, the day itself", () => {
		expect(ids({ type: "day", id: "d1" })).toEqual(["a-sky-ticket", "a-suica"]);
	});

	it("day 3 includes node attachments for places visited (Yodobashi camera)", () => {
		expect(ids({ type: "day", id: "d3" })).toEqual(["a-camera", "a-gg-cash"]);
	});

	it("day 5: exact nodes vs whole subtrees of visited nodes", () => {
		expect(ids({ type: "day", id: "d5" })).toEqual([
			"a-tax-free",
			"a-fuji-tickets",
		]);
		expect(ids({ type: "day", id: "d5", nodeMatch: "subtree" })).toEqual([
			"a-tax-free",
			"a-camera",
			"a-fuji-tickets",
		]);
	});

	it("overnight legs touch both days unless legMatch is 'departing'", () => {
		expect(ids({ type: "day", id: "d23" })).toEqual(["a-train-tickets"]);
		expect(ids({ type: "day", id: "d23", legMatch: "departing" })).toEqual([]);
		expect(ids({ type: "day", id: "d22", legMatch: "departing" })).toEqual([
			"a-train-tickets",
		]);
	});

	it("multiple days (a range already resolved to ids) + trip", () => {
		expect(ids({ type: "day", id: ["d1", "d10"], includeTrip: true })).toEqual([
			"a-insurance",
			"a-sky-ticket",
			"a-suica",
			"a-kix-icn-eticket",
			"a-d10-sim",
		]);
		expect(ids({ type: "day", id: "nope" })).toEqual([]);
	});
});

describe("item / leg / trip scopes", () => {
	it("item scope includes the item's node unless disabled", () => {
		expect(ids({ type: "item", id: "yodobashi" })).toEqual(["a-camera"]);
		expect(ids({ type: "item", id: "yodobashi", includeNode: false })).toEqual(
			[],
		);
		expect(ids({ type: "item", id: "sky" })).toEqual(["a-sky-ticket"]);
		expect(ids({ type: "item", id: "nope" })).toEqual([]);
	});

	it("leg scope", () => {
		expect(ids({ type: "leg", id: "L-kix-icn" })).toEqual([
			"a-kix-icn-eticket",
		]);
		expect(ids({ type: "leg", id: "nope" })).toEqual([]);
	});

	it("trip scope returns everything that resolves", () => {
		const r = collectInScope(attachments, { type: "trip" }, ctx);
		expect(r.attachments).toHaveLength(attachments.length - 2);
		expect(r.unresolved.map((a) => a.id)).toEqual(["a-ghost", "a-ghost-item"]);
	});

	it("trip attachments for another trip id are unresolved", () => {
		const r = collectInScope(
			attachments,
			{ type: "trip" },
			{ ...ctx, tripId: "other-trip" },
		);
		expect(r.unresolved.map((a) => a.id)).toContain("a-insurance");
		// Without a tripId any trip ref resolves.
		expect(
			collectInScope(
				attachments,
				{ type: "trip" },
				{ hierarchy: h, timeline },
			).unresolved.map((a) => a.id),
		).not.toContain("a-insurance");
	});

	it("works without a timeline (node attachments only)", () => {
		const r = collectInScope(
			attachments,
			{ type: "node", id: "tokyo" },
			{ hierarchy: h },
		);
		expect(r.attachments.map((a) => a.id)).toEqual([
			"a-ic-card",
			"a-jal-tour",
			"a-tax-free",
			"a-camera",
			"a-knife",
		]);
		expect(r.unresolved.map((a) => a.id)).toContain("a-gg-cash"); // items can't be resolved without a timeline
	});
});

describe("resolveScope", () => {
	it("exposes the concrete members of a scope", () => {
		const m = resolveScope({ type: "node", id: "tokyo" }, ctx);
		expect(m.nodeIds.has("golden-gai")).toBe(true);
		expect(m.itemIds.has("golden-gai")).toBe(true);
		expect(m.itemIds.has("d1-dinner")).toBe(false); // nodeless
		expect(m.legIds.has("L-ewr-hnd")).toBe(true); // lands in Tokyo
		expect(m.legIds.has("L-fuji-excursion")).toBe(true);
		expect(m.legIds.has("L-fuji-nagoya")).toBe(false);
		expect([...m.dayIds]).toEqual(["d1", "d3", "d5"]);
		expect(m.trip).toBe(false);
	});
});

describe("groupRollupByNode", () => {
	it("groups a Tokyo rollup by area, nodeless matches last", () => {
		const r = collectInScope(attachments, { type: "node", id: "tokyo" }, ctx);
		const groups = groupRollupByNode(r.matches, h, "area");
		expect(
			groups.map((g) => [
				g.node?.id ?? null,
				g.matches.map((m) => m.attachment.id),
			]),
		).toEqual([
			["tokyo", ["a-ic-card"]],
			["haneda", ["a-jal-tour"]],
			["shinjuku", ["a-tax-free", "a-camera", "a-gg-cash", "a-fuji-tickets"]],
			["asakusa", ["a-knife"]],
			["shibuya", ["a-sky-ticket"]],
			[null, ["a-suica"]],
		]);
	});

	it("groups a Japan rollup by city", () => {
		const r = collectInScope(attachments, { type: "node", id: "jp" }, ctx);
		const groups = groupRollupByNode(r.matches, h, "city");
		expect(groups.map((g) => g.node?.id ?? null)).toEqual([
			"jp",
			"tokyo",
			"osaka",
			null,
		]);
	});
});
