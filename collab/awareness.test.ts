import { describe, expect, it } from "vitest";
import type { CollabContext } from "./auth";
import { sanitizeAwarenessUpdate } from "./awareness";

const ctx: CollabContext = {
	userId: "u-ada",
	tripId: "0192f5a0-0000-7000-8000-000000000001",
	slug: "asia-2027",
	role: "editor",
	memberId: "0192f5a0-0000-7000-8000-0000000000aa",
	guest: false,
	color: 3,
	name: "Ada Lovelace",
	docKind: "channel",
};

const view = (path: string) => ({
	scopeId: null,
	scopeName: "Japan",
	lens: "city",
	tab: "plan",
	days: null,
	sel: null,
	path,
});

describe("sanitizeAwarenessUpdate", () => {
	it("replaces a forged user and drops unknown fields", () => {
		const states = new Map<number, Record<string, unknown> | null>([
			[
				1,
				{
					user: { id: "u-mallory", name: "Mallory", email: "m@x" },
					evil: "<img>",
				},
			],
		]);
		sanitizeAwarenessUpdate(states, new Map(), ctx);
		expect(states.get(1)).toEqual({
			user: {
				id: "u-ada",
				memberId: ctx.memberId,
				name: "Ada Lovelace",
				color: 3,
				guest: false,
			},
		});
	});

	it("keeps a valid view of this trip and drops one outside it", () => {
		const ok = new Map<number, Record<string, unknown> | null>([
			[1, { view: view("/t/asia-2027/japan?lens=city") }],
		]);
		sanitizeAwarenessUpdate(ok, new Map(), ctx);
		expect(ok.get(1)?.view).toMatchObject({
			path: "/t/asia-2027/japan?lens=city",
		});

		for (const path of [
			"/t/asia-2027x/japan",
			"/t/other-trip",
			"https://evil.test/t/asia-2027",
			"//evil.test/t/asia-2027",
			"/t/asia-2027/../../admin",
			"javascript:alert(1)",
		]) {
			const bad = new Map<number, Record<string, unknown> | null>([
				[1, { view: view(path) }],
			]);
			sanitizeAwarenessUpdate(bad, new Map(), ctx);
			expect(bad.get(1)?.view, path).toBeUndefined();
		}
	});

	it("validates editing and keeps TipTap carets only on note docs", () => {
		const s = new Map<number, Record<string, unknown> | null>([
			[
				1,
				{
					editing: { kind: "item", id: "abc", field: "title" },
					cursor: { anchor: {}, head: {} },
				},
			],
			[2, { editing: { kind: "bank-account", id: "x" } }],
		]);
		sanitizeAwarenessUpdate(s, new Map(), ctx);
		expect(s.get(1)?.editing).toEqual({
			kind: "item",
			id: "abc",
			field: "title",
		});
		expect(s.get(1)?.cursor).toBeUndefined(); // channel doc
		expect(s.get(2)?.editing).toBeUndefined();

		const note = new Map<number, Record<string, unknown> | null>([
			[1, { cursor: { anchor: { a: 1 }, head: { a: 2 } } }],
		]);
		sanitizeAwarenessUpdate(note, new Map(), { ...ctx, docKind: "note" });
		expect(note.get(1)?.cursor).toEqual({ anchor: { a: 1 }, head: { a: 2 } });

		const huge = new Map<number, Record<string, unknown> | null>([
			[1, { cursor: { pad: "x".repeat(5000) } }],
		]);
		sanitizeAwarenessUpdate(huge, new Map(), { ...ctx, docKind: "note" });
		expect(huge.get(1)?.cursor).toBeUndefined();
	});

	it("refuses to overwrite or remove another user's client state", () => {
		const current = new Map<number, Record<string, unknown>>([
			[7, { user: { id: "u-bob" } }],
		]);
		const s = new Map<number, Record<string, unknown> | null>([
			[7, { view: view("/t/asia-2027") }],
			[8, null],
		]);
		current.set(8, { user: { id: "u-bob" } });
		sanitizeAwarenessUpdate(s, current, ctx);
		expect(s.has(7)).toBe(false);
		expect(s.has(8)).toBe(false);
	});
});
