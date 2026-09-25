import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	isShareToken,
	parseShareFragment,
	shareLinkPath,
	shareLinkUrl,
} from "./share-link";

const token = randomBytes(32).toString("base64url");

describe("share links (SECURITY §2)", () => {
	it("puts the token in the fragment of /join", () => {
		expect(shareLinkPath(token)).toBe(`/join#t=${token}`);
		const url = new URL(shareLinkUrl("https://yonder.example", token));
		expect(url.pathname).toBe("/join");
		expect(url.search).toBe("");
		expect(url.hash).toBe(`#t=${token}`);
	});

	it("accepts 43-char base64url tokens and rejects junk", () => {
		expect(token).toHaveLength(43);
		expect(isShareToken(token)).toBe(true);
		expect(isShareToken("short")).toBe(false);
		expect(isShareToken(`${token.slice(0, 40)}+/=`)).toBe(false);
		expect(isShareToken("x".repeat(129))).toBe(false);
		expect(isShareToken(undefined)).toBe(false);
	});

	it("parses #t=<token>, a bare #<token>, and round-trips shareLinkPath", () => {
		expect(parseShareFragment(`#t=${token}`)).toBe(token);
		expect(parseShareFragment(`t=${token}`)).toBe(token);
		expect(parseShareFragment(`#${token}`)).toBe(token);
		expect(
			parseShareFragment(
				new URL(shareLinkUrl("http://localhost:3000", token)).hash,
			),
		).toBe(token);
	});

	it("returns null for missing or malformed fragments", () => {
		expect(parseShareFragment("")).toBeNull();
		expect(parseShareFragment("#")).toBeNull();
		expect(parseShareFragment(null)).toBeNull();
		expect(parseShareFragment("#t=")).toBeNull();
		expect(parseShareFragment("#t=abc")).toBeNull();
		expect(parseShareFragment("#other=1")).toBeNull();
		expect(parseShareFragment("#t=%E0%A4%A")).toBeNull();
	});
});

describe("no per-person join links (FB-14)", () => {
	it("an old placeholder claim link (#c=) doesn't read as a share link", () => {
		expect(parseShareFragment(`#c=${token}`)).toBeNull();
	});
});
