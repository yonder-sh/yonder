import { describe, expect, it } from "vitest";
import { isSafePushUrl, tripUrl } from "./links";
import { buildPayload, clip } from "./payload";
import type { PushItem } from "./types";

const TRIP = { id: "trip-1", name: "Asia 2027", slug: "asia-2027" };
const ID = "0192b3c4-0000-7000-8000-00000000abcd";

const item = (over: Partial<PushItem> = {}): PushItem => ({
	key: "k1",
	at: 1_000,
	actor: "Maya",
	headline: "Maya mentioned you in Kyoto",
	body: "@Dennis can you book the ryokan?",
	url: tripUrl("asia-2027", { sel: `i.${ID}` }),
	...over,
});

describe("tripUrl", () => {
	it("builds the inbox's workspace search on the trip path", () => {
		const url = tripUrl("asia-2027", {
			tab: "lists",
			list: "todo",
			sel: `i.${ID}`,
		});
		const u = new URL(url, "https://yonder.sh");
		expect(u.pathname).toBe("/t/asia-2027");
		expect(Object.fromEntries(u.searchParams)).toEqual({
			tab: "lists",
			list: "todo",
			sel: `i.${ID}`,
		});
		expect(isSafePushUrl(url)).toBe(true);
	});

	it("drops what the inbox would drop (bad sel, the default tab)", () => {
		expect(tripUrl("asia-2027", { sel: "javascript:alert(1)" })).toBe(
			"/t/asia-2027",
		);
		expect(tripUrl("asia-2027", { tab: "plan" })).toBe("/t/asia-2027");
	});

	it("only same-origin paths are safe", () => {
		expect(isSafePushUrl("/")).toBe(true);
		expect(isSafePushUrl("//evil.example/x")).toBe(false);
		expect(isSafePushUrl("https://evil.example/")).toBe(false);
	});
});

describe("buildPayload", () => {
	it("one item: the trip name as the title prefix, a short body, the deep link", () => {
		expect(buildPayload("mention", [item()], TRIP)).toEqual({
			title: "Asia 2027 · Maya mentioned you in Kyoto",
			body: "@Dennis can you book the ryokan?",
			url: `/t/asia-2027?sel=i.${ID}`,
			tag: "mention:trip-1:k1",
			ts: 1_000,
		});
	});

	it("nothing to say → null", () => {
		expect(buildPayload("mention", [], TRIP)).toBeNull();
	});

	it("a burst from one person reads as one sentence; mixed people as a count", () => {
		const two = [
			item({ key: "a", at: 1 }),
			item({ key: "b", at: 2, body: "newest" }),
		];
		expect(buildPayload("mention", two, TRIP)).toMatchObject({
			title: "Asia 2027 · Maya mentioned you 2 times",
			body: "newest",
			tag: "mention:trip-1:b+2",
		});
		const mixed = [item({ key: "a" }), item({ key: "b", actor: "Kai" })];
		expect(buildPayload("mention", mixed, TRIP)?.title).toBe(
			"Asia 2027 · 2 new mentions",
		);
		expect(
			buildPayload(
				"review",
				[item({ key: "a" }), item({ key: "b", actor: "Kai" })],
				TRIP,
			)?.title,
		).toBe("Asia 2027 · 2 suggestions to review");
	});

	it("suggestion results count what was accepted and rejected", () => {
		const p = buildPayload(
			"result",
			[
				item({ key: "1", meta: { decision: "accepted" } }),
				item({ key: "2", meta: { decision: "rejected" } }),
				item({ key: "3", meta: { decision: "accepted" } }),
			],
			TRIP,
		);
		expect(p?.title).toBe("Asia 2027 · Maya reviewed 3 suggestions of yours");
		expect(p?.body).toBe("2 accepted, 1 rejected");
	});

	it("a summary opens the shared link, else the group's own place", () => {
		const a = item({ key: "a", url: tripUrl("asia-2027", { sel: `i.${ID}` }) });
		const b = item({ key: "b", url: tripUrl("asia-2027", { sel: `d.${ID}` }) });
		expect(buildPayload("due", [a, b], TRIP)?.url).toBe(
			"/t/asia-2027?tab=lists&list=todo",
		);
		expect(buildPayload("changes", [a, b], TRIP)?.url).toBe("/t/asia-2027");
		expect(buildPayload("assigned", [a, { ...a, key: "c" }], TRIP)?.url).toBe(
			a.url,
		);
	});

	it("countdown reads as one sentence; states keep only the newest", () => {
		const cd = buildPayload(
			"countdown",
			[
				item({
					key: "cd7",
					headline: "starts in 7 days",
					body: "Day 1 is Sun 3 Oct in Tokyo",
				}),
			],
			TRIP,
		);
		expect(cd?.title).toBe("Asia 2027 starts in 7 days");
		expect(cd?.tag).toBe("countdown:trip-1");
		const m = buildPayload(
			"membership",
			[
				item({ key: "m1", at: 1, headline: "Maya added you to the trip" }),
				item({ key: "m2", at: 2, headline: "Your role is now Can edit" }),
			],
			TRIP,
		);
		expect(m?.title).toBe("Asia 2027 · Your role is now Can edit");
	});

	it("keeps the title and body short", () => {
		const long = "x".repeat(500);
		const p = buildPayload(
			"changes",
			[item({ headline: long, body: long })],
			TRIP,
		);
		expect(p?.title.length).toBeLessThanOrEqual(120);
		expect(p?.body.length).toBeLessThanOrEqual(240);
		expect(p?.body.endsWith("…")).toBe(true);
		expect(clip("  a \n b ", 10)).toBe("a b");
	});
});
