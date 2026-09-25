import { describe, expect, it } from "vitest";
import {
	cleanSlugBase,
	isSlugTail,
	isTripSlug,
	newSlugTail,
	SLUG_BASE_MAX,
	SLUG_TAIL_ALPHABET,
	SLUG_TAIL_LENGTH,
	slugBaseFromName,
	splitTripSlug,
	withSlugTail,
} from "./trip-slug";

describe("the address tail", () => {
	it("is 8 characters from 31 unambiguous ones: no 0/o, 1/l or i", () => {
		expect(SLUG_TAIL_ALPHABET).toHaveLength(31);
		expect(new Set(SLUG_TAIL_ALPHABET).size).toBe(31);
		for (const c of "0o1li") expect(SLUG_TAIL_ALPHABET).not.toContain(c);
		expect(SLUG_TAIL_ALPHABET).toMatch(/^[a-z2-9]+$/);
		for (let i = 0; i < 200; i++) {
			const t = newSlugTail();
			expect(t).toHaveLength(SLUG_TAIL_LENGTH);
			expect(isSlugTail(t)).toBe(true);
		}
	});

	it("comes from the CSPRNG, uniformly (rejection sampling drops bytes 248–255)", () => {
		// Bytes past the last whole cycle of 31 are skipped, not folded in.
		const bytes = [248, 255, 0, 30, 31, 247, 250, 62, 93, 1, 2];
		let at = 0;
		const random = (n: number) =>
			Uint8Array.from({ length: n }, () => bytes[at++ % bytes.length] ?? 0);
		const t = newSlugTail(random);
		const a = SLUG_TAIL_ALPHABET;
		// 0, 30, 31→0, 247→30, 62→0, 93→0, 1, 2
		expect(t).toBe(
			`${a[0]}${a[30]}${a[0]}${a[30]}${a[0]}${a[0]}${a[1]}${a[2]}`,
		);

		// Roughly uniform over many draws.
		const counts = new Map<string, number>();
		for (let i = 0; i < 4000; i++)
			for (const c of newSlugTail()) counts.set(c, (counts.get(c) ?? 0) + 1);
		expect(counts.size).toBe(31);
		const expected = (4000 * 8) / 31;
		for (const n of counts.values()) {
			expect(n).toBeGreaterThan(expected * 0.8);
			expect(n).toBeLessThan(expected * 1.2);
		}
	});

	it("rejects look-alikes, the wrong length and anything else", () => {
		expect(isSlugTail("k7m2qxw9")).toBe(true);
		for (const bad of [
			"k7m2qxw",
			"k7m2qxw99",
			"k7m2qxw0",
			"k7m2qxwo",
			"k7m2qxwl",
			"k7m2qxwi",
			"k7m2qxw1",
			"K7M2QXW9",
			"k7m2-xw9",
			12345678,
			null,
		])
			expect(isSlugTail(bad)).toBe(false);
	});
});

describe("the readable part", () => {
	it("is cleaned like a slug and fits beside the tail", () => {
		expect(cleanSlugBase("Asia 2027")).toBe("asia-2027");
		expect(cleanSlugBase("  --Asia  2027!!--  ")).toBe("asia-2027");
		expect(cleanSlugBase("a--b")).toBe("a-b");
		expect(cleanSlugBase("!!!")).toBe("");
		const long = cleanSlugBase("x".repeat(200));
		expect(long).toHaveLength(SLUG_BASE_MAX);
		expect(withSlugTail(long, "k7m2qxw9")).toHaveLength(100);
		expect(isTripSlug(withSlugTail(long, "k7m2qxw9"))).toBe(true);
		// A cut never leaves a dash before the tail's own.
		expect(cleanSlugBase(`${"a".repeat(90)}-b`)).toBe("a".repeat(90));
	});

	it("comes from the trip's name (CJK falls back to an id-based part)", () => {
		expect(slugBaseFromName("Asia 2027", "id")).toBe("asia-2027");
		expect(slugBaseFromName("Hội An & Huế", "id")).toBe("hoi-an-hue");
		expect(slugBaseFromName("東京", "0199aabb-ccdd")).toBe("n-0199aa");
	});
});

describe("splitting an address", () => {
	it("splits off the tail it was given, and keeps a tail-less (seeded) slug whole", () => {
		expect(splitTripSlug("asia-2027-k7m2qxw9", "k7m2qxw9")).toEqual({
			base: "asia-2027",
			tail: "k7m2qxw9",
		});
		expect(splitTripSlug("asia-2027", null)).toEqual({
			base: "asia-2027",
			tail: null,
		});
		// Never guesses a tail from the text (`demo-3a5b7c9d` could be one).
		expect(splitTripSlug("demo-3a5b7c9d", null)).toEqual({
			base: "demo-3a5b7c9d",
			tail: null,
		});
		// A tail that isn't the slug's end is ignored.
		expect(splitTripSlug("asia-2027", "k7m2qxw9")).toEqual({
			base: "asia-2027",
			tail: null,
		});
	});

	it("round-trips with withSlugTail", () => {
		const tail = newSlugTail();
		const slug = withSlugTail("my-trip", tail);
		expect(splitTripSlug(slug, tail)).toEqual({ base: "my-trip", tail });
	});
});
