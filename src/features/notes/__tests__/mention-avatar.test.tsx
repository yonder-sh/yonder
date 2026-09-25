/**
 * Owner FB-16 (QA FB-16-mention-chips): a mentioned member with a profile
 * picture shows it as a round avatar in the chip, not just the presence dot:
 * in the live editor (`liveMention` renderHTML, also `MentionInput`), in the
 * static render (`StaticNoteRender`) and in its pre-load fallback
 * (`PlainNote`). Members without a picture keep the dot; removed members stay
 * plain muted text; pending people have no picture.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphMember } from "@/lib/engine/types";
import { demoGraph } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { mentionView, NoteMentionChip } from "../mention-chip";
import { liveNoteExtensions } from "../note-extensions";
import { pendingPersonId, resetPendingPeople } from "../pending-people";
import { PlainNote } from "../plain-note";
import StaticNoteRender from "../StaticNoteRender";

const NORA = "01a0cd9b-31b0-71a1-b351-bbe524456fc1";
const MAYA = "01a0cd9b-31b0-71a1-b351-bbe524456fc2";
const KAI = "01a0cd9b-31b0-71a1-b351-bbe524456fc3";
const OLD = "01a0cd9b-31b0-71a1-b351-bbe524456fc4";
const NORA_IMAGE = "/api/avatar/nora_user?v=abc123";
/** `avatarSrc(NORA_IMAGE, 16)`: 64px covers a 16px circle at 2×. */
const NORA_SRC = `${NORA_IMAGE}&s=64`;

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
	color: 2,
	...extra,
});

const MEMBERS: GraphMember[] = [
	member(NORA, "Nora Photo", { userId: "nora_user", image: NORA_IMAGE }),
	member(MAYA, "Maya Chen", { userId: "maya_user" }),
	member(KAI, "Kai Viewer", {
		userId: "kai_user",
		status: "removed",
		image: "/api/avatar/kai_user?v=k1",
	}),
	// A placeholder merged into Nora: old mentions show her, picture included.
	member(OLD, "Nora (placeholder)", { status: "removed", mergedIntoId: NORA }),
];
const graph = { ...demoGraph, members: [...demoGraph.members, ...MEMBERS] };

const mention = (id: string, label: string): JSONContent => ({
	type: "mention",
	attrs: { id, label },
});
const DOC: JSONContent = {
	type: "doc",
	content: [
		{
			type: "paragraph",
			content: [
				{ type: "text", text: "Ask " },
				mention(NORA, "Nora Photo"),
				{ type: "text", text: " and " },
				mention(MAYA, "Maya Chen"),
				{ type: "text", text: " and " },
				mention(KAI, "Kai Viewer"),
				{ type: "text", text: " and " },
				mention(OLD, "Nora (placeholder)"),
			],
		},
	],
};

/** Every chip-shape assertion, shared by the live and static renders. */
function expectChips(root: ParentNode) {
	const nora = root.querySelector(`[data-mention="${NORA}"]`);
	expect(nora?.hasAttribute("data-avatar")).toBe(true);
	const img = nora?.querySelector("img.mention-avatar");
	expect(img?.getAttribute("src")).toBe(NORA_SRC);
	expect(img?.getAttribute("alt")).toBe("");
	expect(nora?.textContent).toBe("@Nora Photo");
	// The presence colour stays as the avatar's ground.
	expect(nora?.getAttribute("style")).toContain("--mention-dot");

	// No picture: the presence dot, no <img>.
	const maya = root.querySelector(`[data-mention="${MAYA}"]`);
	expect(maya?.hasAttribute("data-avatar")).toBe(false);
	expect(maya?.querySelector("img")).toBeNull();
	expect(maya?.textContent).toBe("@Maya Chen");

	// Removed: plain muted text, never their picture.
	const kai = root.querySelector(`[data-mention="${KAI}"]`);
	expect(kai?.hasAttribute("data-former")).toBe(true);
	expect(kai?.querySelector("img")).toBeNull();

	// Merged placeholder → the member it became, with her picture.
	const old = root.querySelector(`[data-mention="${OLD}"]`);
	expect(old?.textContent).toBe("@Nora Photo");
	expect(old?.querySelector("img.mention-avatar")?.getAttribute("src")).toBe(
		NORA_SRC,
	);
}

let editor: Editor | null = null;
afterEach(() => {
	editor?.destroy();
	editor = null;
	resetPendingPeople();
});

describe("mentionView (FB-16)", () => {
	it("carries the chip-size picture for members that have one, else null", () => {
		expect(mentionView(MEMBERS, NORA, "x").image).toBe(NORA_SRC);
		expect(mentionView(MEMBERS, MAYA, "x").image).toBeNull();
		expect(mentionView(MEMBERS, KAI, "x")).toMatchObject({
			former: true,
			image: null,
		});
		expect(mentionView(MEMBERS, OLD, "x").image).toBe(NORA_SRC);
		expect(mentionView(MEMBERS, "gone", "Zed")).toMatchObject({
			name: "Zed",
			former: true,
			image: null,
		});
		const pending = pendingPersonId(demoGraph.trip.id, "Zoe");
		expect(mentionView(MEMBERS, pending, "Zoe")).toMatchObject({
			name: "Zoe",
			former: false,
			image: null,
		});
	});
});

describe("the live editor's chip shows the round picture (FB-16)", () => {
	it("renders <img class=mention-avatar> in the chip, in the view and in its HTML", () => {
		editor = new Editor({
			element: document.createElement("div"),
			extensions: liveNoteExtensions(() => ({
				members: graph.members,
				addPerson: null,
			})),
			content: DOC,
		});
		expectChips(editor.view.dom);
		// The node stays a plain mention in the document and the Markdown.
		const html = document.createElement("div");
		html.innerHTML = editor.getHTML();
		expectChips(html);
		expect(editor.getJSON().content?.[0]?.content?.[1]).toEqual({
			type: "mention",
			attrs: { id: NORA, label: "Nora Photo", mentionSuggestionChar: "@" },
		});
		expect(editor.getMarkdown()).not.toContain("avatar");
	});
});

describe("static renders show the same round picture (FB-16)", () => {
	it("StaticNoteRender", () => {
		const { container } = renderWithWorkspace(<StaticNoteRender json={DOC} />, {
			graph,
		});
		expectChips(container);
	});

	it("PlainNote (before the TipTap chunk loads)", () => {
		const { container } = renderWithWorkspace(<PlainNote json={DOC} />, {
			graph,
		});
		expectChips(container);
	});

	it("NoteMentionChip for someone not on the trip: no picture", () => {
		const { container } = renderWithWorkspace(
			<NoteMentionChip id={NORA} label="Nora Photo" />,
		);
		expect(container.querySelector("img")).toBeNull();
	});
});
