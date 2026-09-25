import { describe, expect, it } from "vitest";
import {
	isMentionHref,
	mentionIdOf,
	mentionToken,
	parseMentionIds,
} from "./mentions";
import {
	jsonToMarkdown,
	markdownToYdoc,
	ydocFromState,
	ydocToJSON,
} from "./ydoc.server";

const A = "0198a6f2-1111-7000-8000-000000000001";
const B = "0198a6f2-2222-7000-8000-000000000002";

describe("mention tokens", () => {
	it("parses distinct member ids in order", () => {
		const md = `Ask ${mentionToken("Maya Chen", A)} and ${mentionToken("Sam", B)}, then ${mentionToken("Maya", A)}.`;
		expect(parseMentionIds(md)).toEqual([A, B]);
	});

	it("ignores look-alikes and non-uuid ids", () => {
		expect(
			parseMentionIds("[@Maya](https://x.test) [@x](mention:123)"),
		).toEqual([]);
		expect(parseMentionIds(null)).toEqual([]);
	});

	it("escapes brackets in labels so the token stays one link", () => {
		const t = mentionToken("A [b] c", A);
		expect(t).toBe(`[@A \\[b\\] c](mention:${A})`);
		expect(parseMentionIds(t)).toEqual([A]);
	});

	it("recognises mention hrefs", () => {
		expect(isMentionHref(`mention:${A}`)).toBe(true);
		expect(isMentionHref("javascript:alert(1)")).toBe(false);
		expect(mentionIdOf(`mention:${A.toUpperCase()}`)).toBe(A);
	});
});

describe("markdownToYdoc", () => {
	it("round-trips a heading and a list through Yjs", () => {
		const snap = markdownToYdoc("# Title\n\n- a\n- **b**");
		const json = ydocToJSON(ydocFromState(snap.state));
		expect(json).toEqual(snap.json);
		expect(json.content?.[0]?.type).toBe("heading");
		expect(json.content?.[1]?.type).toBe("bulletList");
		expect(snap.plainText.split(/\n+/)).toEqual(["Title", "a", "b"]);
	});
});

describe("NOTE-04: markdown stays CommonMark (no underline)", () => {
	it("an underlined run (an old note) exports as plain text", () => {
		const md = jsonToMarkdown({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "UNDERKEY944",
							marks: [{ type: "underline" }],
						},
						{ type: "text", text: " plain" },
					],
				},
			],
		});
		expect(md.trim()).toBe("UNDERKEY944 plain");
	});

	it("`++` in markdown is just text (C++), never an underline", () => {
		const snap = markdownToYdoc("I write C++ and C++ daily");
		expect(JSON.stringify(snap.json)).not.toContain("underline");
		expect(snap.plainText.trim()).toBe("I write C++ and C++ daily");
	});
});
