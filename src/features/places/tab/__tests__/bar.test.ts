/**
 * The shortlist bar (bar.ts): a level per person × the people rating,
 * rounded up; people rating are those whose ratings count and who rated
 * at least half the places; the old fixed score maps to a level; and the
 * reason a place is on the shortlist or not.
 */
import { describe, expect, it } from "vitest";
import type { GraphMember } from "@/lib/engine/types";
import { raters } from "../../lib/rate";
import {
	levelFromMinScore,
	peopleRating,
	shortlistBar,
	shortlistLevel,
	shortlistReason,
} from "../bar";
import { placeStatus, type StatusInfo } from "../lifecycle";

const place = (priorities: Record<string, string> = {}) => ({ priorities });
/** `n` places, the first `rated[m]` of them rated Want by member m. */
function places(n: number, rated: Record<string, number>) {
	return Array.from({ length: n }, (_, i) =>
		place(
			Object.fromEntries(
				Object.entries(rated)
					.filter(([, k]) => i < k)
					.map(([m]) => [m, "want"]),
			),
		),
	);
}

describe("shortlistBar", () => {
	it("grows with the group: 1.5 per person, rounded up", () => {
		const bar = (people: number) =>
			shortlistBar(
				1.5,
				places(
					4,
					Object.fromEntries([...Array(people)].map((_, i) => [`m${i}`, 4])),
				),
				[...Array(people)].map((_, i) => `m${i}`),
			).bar;
		expect(bar(1)).toBe(2);
		expect(bar(2)).toBe(3);
		expect(bar(3)).toBe(5);
		expect(bar(4)).toBe(6);
	});

	it("uses the level: Want and Really want", () => {
		const ps = places(2, { a: 2, b: 2, c: 2 });
		expect(shortlistBar(1, ps, ["a", "b", "c"]).bar).toBe(3);
		expect(shortlistBar(2, ps, ["a", "b", "c"]).bar).toBe(6);
	});

	it("counts only people who rated at least half the places", () => {
		const ps = places(4, { a: 4, b: 2, c: 1 });
		expect(peopleRating(ps, ["a", "b", "c", "d"])).toBe(2);
		expect(shortlistBar(1.5, ps, ["a", "b", "c", "d"])).toEqual({
			level: 1.5,
			people: 2,
			bar: 3,
		});
	});

	it("is at least one person, even before anyone rates", () => {
		expect(shortlistBar(1.5, places(3, {}), ["a", "b"])).toMatchObject({
			people: 1,
			bar: 2,
		});
		expect(shortlistBar(2, [], [])).toMatchObject({ people: 1, bar: 2 });
	});

	it("someone new adds to scores before they raise the bar: nothing drops off", () => {
		// Two people rated all four places; the first is at +3 (Must + Sure).
		const rest = [1, 2, 3].map(() => place({ a: "want", b: "want" }));
		const ps = [place({ a: "must", b: "sure_why_not" }), ...rest];
		expect(shortlistBar(1.5, ps, ["a", "b"]).bar).toBe(3);
		// Carol joins and rates only that place Want: +4, the bar is still 3.
		const withCarol = [
			place({ a: "must", b: "sure_why_not", c: "want" }),
			...rest,
		];
		expect(shortlistBar(1.5, withCarol, ["a", "b", "c"]).bar).toBe(3);
	});

	it("leaves out people whose ratings aren't counted", () => {
		const members = ["a", "b", "c"].map(
			(id) =>
				({
					id,
					userId: id,
					status: "active",
					role: "editor",
					name: id,
					color: 0,
					...(id === "c" ? { ratingsCounted: false } : {}),
				}) as GraphMember,
		);
		const ps = places(2, { a: 2, b: 2, c: 2 });
		const ids = raters(members, ps as never).map((m) => m.id);
		expect(ids).toEqual(["a", "b"]);
		expect(shortlistBar(1.5, ps, ids).bar).toBe(3);
		// Counted again: exactly as before.
		const all = raters(
			members.map((m) => ({ ...m, ratingsCounted: true })),
			ps as never,
		).map((m) => m.id);
		expect(shortlistBar(1.5, ps, all).bar).toBe(5);
	});
});

describe("the level setting", () => {
	it("maps the old fixed score to the nearest level for two people", () => {
		expect(levelFromMinScore(2)).toBe(1);
		expect(levelFromMinScore(3)).toBe(1.5);
		expect(levelFromMinScore(4)).toBe(2);
		expect(levelFromMinScore(-4)).toBe(1);
		expect(levelFromMinScore(9)).toBe(2);
	});

	it("reads the level, else the old score, else 1.5", () => {
		expect(shortlistLevel(undefined)).toBe(1.5);
		expect(shortlistLevel({})).toBe(1.5);
		expect(shortlistLevel({ shortlistMinScore: 4 })).toBe(2);
		expect(shortlistLevel({ shortlistMinScore: 2 })).toBe(1);
		expect(shortlistLevel({ shortlistLevel: 1, shortlistMinScore: 4 })).toBe(1);
		expect(
			shortlistLevel({ shortlistLevel: 3 as never, shortlistMinScore: 3 }),
		).toBe(1.5);
	});
});

describe("shortlistReason", () => {
	const bar = { level: 1.5 as const, people: 4, bar: 6 };
	const info = (score: number, pin: "auto" | "pinned" | "unpinned" = "auto") =>
		placeStatus({
			dropped: false,
			scheduled: false,
			pin,
			score,
			threshold: 6,
			allNah: false,
		});

	it("on, off and unrated", () => {
		expect(shortlistReason({ info: info(7), score: 7, rated: true, bar })).toBe(
			"On the shortlist: the group gave it +7, and it needs +6 with 4 people rating.",
		);
		expect(shortlistReason({ info: info(4), score: 4, rated: true, bar })).toBe(
			"Not on the shortlist yet: the group gave it +4, and it needs +6 with 4 people rating.",
		);
		expect(
			shortlistReason({ info: info(-2), score: -2, rated: true, bar }),
		).toContain("gave it −2");
		expect(
			shortlistReason({
				info: info(0),
				score: 0,
				rated: false,
				bar: { level: 1.5, people: 1, bar: 2 },
			}),
		).toBe(
			"Not on the shortlist yet: nobody has rated it, and it needs +2 with 1 person rating.",
		);
	});

	it("pinned, taken off by hand, and places past the shortlist", () => {
		expect(
			shortlistReason({
				info: info(0, "pinned"),
				score: 0,
				rated: false,
				bar,
				pinnedBy: "Maya",
			}),
		).toBe("Pinned to the shortlist by Maya.");
		expect(
			shortlistReason({ info: info(0, "pinned"), score: 0, rated: false, bar }),
		).toBe("Pinned to the shortlist.");
		expect(
			shortlistReason({
				info: info(7, "unpinned"),
				score: 7,
				rated: true,
				bar,
			}),
		).toBe(
			"Taken off the shortlist by hand: the group gave it +7, and it needs +6 with 4 people rating.",
		);
		const onDay: StatusInfo = { ...info(7), status: "scheduled" };
		expect(
			shortlistReason({ info: onDay, score: 7, rated: true, bar }),
		).toBeNull();
	});
});
