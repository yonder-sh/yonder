/**
 * Mentions without a DOM: `MentionInput`'s token round-trip (SPEC §7.10), the
 * popup's candidates (members only, ADDENDUM §8 "Add “Name”"), and the notes
 * hook's parser (valid ids only, the block each first appears in).
 */
import { describe, expect, it } from "vitest";
import type { GraphMember } from "@/lib/engine/types";
import { mentionToken, parseMentionIds } from "@/lib/notes/mentions";
import { mentionsInNote } from "../../../../collab/notes-hooks";
import { docToTokens, tokensToDoc } from "../MentionInput";
import { mentionCandidates } from "../mention-suggestion";

const MAYA = "01a0cd9b-31b0-71a1-b351-bbe524456fb0";
const KAI = "01a0cd9b-31b0-71a1-b351-bbe524456fb1";

const member = (
	id: string,
	name: string,
	extra: Partial<GraphMember> = {},
): GraphMember => ({
	id,
	userId: null,
	status: "active",
	role: "editor",
	name,
	color: 1,
	...extra,
});

describe("MentionInput tokens", () => {
	it("round-trips text and mention tokens, escaped labels included", () => {
		const value = `Ask ${mentionToken("Maya [MC] Chen", MAYA)} about **cash**`;
		const doc = tokensToDoc(value, false);
		expect(doc.content?.[0]?.content?.map((n) => n.type)).toEqual([
			"text",
			"mention",
			"text",
		]);
		expect(doc.content?.[0]?.content?.[1]?.attrs).toEqual({
			id: MAYA,
			label: "Maya [MC] Chen",
		});
		expect(docToTokens(doc)).toBe(value);
		expect(parseMentionIds(docToTokens(doc))).toEqual([MAYA]);
	});

	it("single-line folds newlines; multi-line keeps them", () => {
		expect(docToTokens(tokensToDoc("a\nb", false))).toBe("a b");
		expect(docToTokens(tokensToDoc("a\n\nb", true))).toBe("a\n\nb");
		expect(docToTokens(tokensToDoc("", false))).toBe("");
	});
});

describe("the mention popup", () => {
	const members = [
		member(MAYA, "Maya Chen"),
		member(KAI, "Kai Viewer", { status: "removed" }),
		member("01a0cd9b-31b0-71a1-b351-bbe524456fb2", "Laura Maas"),
	];
	const add = async () => "new-id";

	it("lists members only (never removed ones), prefix matches first", () => {
		const c = mentionCandidates("ma", { members, addPerson: add });
		expect(c.map((x) => (x.kind === "member" ? x.label : x.name))).toEqual([
			"Maya Chen",
			"Laura Maas",
		]);
		expect(mentionCandidates("kai", { members, addPerson: null })).toEqual([]);
	});

	it("offers a new person only when nobody matches (and only to people who may add)", () => {
		expect(mentionCandidates("Audrey", { members, addPerson: add })).toEqual([
			{ kind: "add", name: "Audrey" },
		]);
		expect(mentionCandidates("Audrey", { members, addPerson: null })).toEqual(
			[],
		);
		expect(
			mentionCandidates("a very long sentence here", {
				members,
				addPerson: add,
			}),
		).toEqual([]);
	});
});

describe("mentionsInNote", () => {
	it("keeps valid ids once, with the text of their block", () => {
		const json = {
			type: "doc",
			content: [
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [
								{
									type: "paragraph",
									content: [
										{ type: "text", text: "Book with " },
										{
											type: "mention",
											attrs: { id: MAYA, label: "Maya Chen" },
										},
									],
								},
							],
						},
					],
				},
				{
					type: "paragraph",
					content: [
						{ type: "mention", attrs: { id: MAYA, label: "Maya Chen" } },
						{ type: "mention", attrs: { id: "not-a-uuid", label: "x" } },
						{ type: "mention", attrs: { id: "<script>", label: "x" } },
					],
				},
			],
		};
		const m = mentionsInNote(json);
		expect([...m.entries()]).toEqual([[MAYA, "Book with @Maya Chen"]]);
		expect(mentionsInNote(null).size).toBe(0);
	});
});
