import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import { demo, N } from "@/lib/fixtures/demo";
import type { InboxItem } from "@/lib/schemas/inbox";
import {
	formatDelta,
	groupInbox,
	inboxSearch,
	keepScope,
	timeAgo,
} from "./inbox-model";

const base = {
	tripId: "t",
	tripName: "Trip",
	read: false,
	actor: null,
	title: "x",
	link: { tripSlug: "demo" },
};

const items: InboxItem[] = [
	{
		...base,
		kind: "mention",
		key: "mention:1",
		mentionId: "1",
		excerpt: null,
		at: "2027-01-01T10:00:00Z",
	},
	{
		...base,
		kind: "review",
		key: "review:t:2",
		count: 3,
		at: "2027-01-01T09:00:00Z",
	},
	{
		...base,
		kind: "mention",
		key: "mention:3",
		mentionId: "3",
		excerpt: null,
		at: "2027-01-01T11:00:00Z",
	},
	{
		...base,
		kind: "balance_changed",
		key: "balance:t:m:4",
		deltaMinor: 620,
		currency: "USD",
		cause: null,
		at: "2027-01-01T08:00:00Z",
	},
];

describe("inbox model", () => {
	it("groups by kind in a fixed order, newest first", () => {
		const g = groupInbox(items);
		expect(g.map((x) => x.key)).toEqual(["suggestions", "mentions", "money"]);
		expect(g[1]?.items.map((i) => i.key)).toEqual(["mention:3", "mention:1"]);
	});

	it("validates links before they become URL state", () => {
		const id = N.tokyo ?? "";
		expect(
			inboxSearch({ tripSlug: "demo", sel: `n.${id}`, tab: "notes" }),
		).toEqual({ sel: `n.${id}`, tab: "notes" });
		expect(
			inboxSearch({ tripSlug: "demo", sel: "javascript:1", tab: "plan" }),
		).toEqual({});
		expect(
			inboxSearch({ tripSlug: "demo", tab: "evil" as never, list: "todo" }),
		).toEqual({ list: "todo" });
	});

	it("keeps the scope only when the entity is inside it", () => {
		const ix = indexGraph(demo.graph);
		const sky = demo.I.sky ?? "";
		expect(
			keepScope(ix, N.tokyo ?? null, { tripSlug: "d", sel: `i.${sky}` }),
		).toBe(true);
		expect(
			keepScope(ix, N.kyoto ?? null, { tripSlug: "d", sel: `i.${sky}` }),
		).toBe(false);
		expect(keepScope(ix, null, { tripSlug: "d" })).toBe(true);
		expect(
			keepScope(ix, N.kyoto ?? null, { tripSlug: "d", review: true }),
		).toBe(false);
	});

	it("short relative times and signed deltas", () => {
		const now = Date.parse("2027-01-10T12:00:00Z");
		expect(timeAgo("2027-01-10T11:59:30Z", now)).toBe("just now");
		expect(timeAgo("2027-01-10T11:55:00Z", now)).toBe("5m ago");
		expect(timeAgo("2027-01-10T10:00:00Z", now)).toBe("2h ago");
		expect(timeAgo("2027-01-07T12:00:00Z", now)).toBe("3d ago");
		expect(timeAgo("2026-12-01T12:00:00Z", now)).toMatch(/Dec/);
		expect(formatDelta(620, "USD")).toBe("+$6.20");
		expect(formatDelta(-1200, "JPY")).toBe("−¥1,200");
	});
});
