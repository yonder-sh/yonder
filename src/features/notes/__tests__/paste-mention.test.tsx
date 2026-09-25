/**
 * QA NOTE-04: a Google Docs paste keeps bold and links and drops the styling,
 * underline included, so the note's Markdown is `[the guide](…)`, never
 * `[++the guide++](…)`. And QA PLAN-R2-08: in a field that saves later, "Add
 * “Zed” as a new person" inserts a PENDING chip without creating anyone; the
 * live note (no `pendPerson`) still creates the person at once.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type MentionCtx, mentionSuggestion } from "../mention-suggestion";
import { liveNoteExtensions } from "../note-extensions";
import { PasteMarkdown, stripPastedUnderline } from "../paste-markdown";
import {
	pendingPerson,
	pendingPersonId,
	resetPendingPeople,
} from "../pending-people";

const TRIP = "01a0cd9b-31b0-71a1-b351-bbe524456f00";
const ZED = "01a0cd9b-31b0-71a1-b351-bbe524456fb9";

let editor: Editor | null = null;
afterEach(() => {
	editor?.destroy();
	editor = null;
	resetPendingPeople();
});

/** The first inline node of the first paragraph. */
const firstInline = (ed: Editor): JSONContent | undefined =>
	(ed.getJSON() as JSONContent).content?.[0]?.content?.[0];

function makeEditor(ctx: MentionCtx): Editor {
	editor = new Editor({
		element: document.createElement("div"),
		extensions: [...liveNoteExtensions(() => ctx), PasteMarkdown],
	});
	return editor;
}

const GOOGLE_DOCS =
	'<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-abc"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#ff0000;background-color:#ffff00;font-weight:700;">PASTEBOLD cash only</span><span style="font-size:11pt;font-family:Comic Sans MS;color:#000000;"> see </span><a href="https://www.japan-guide.com/e/e3011.html" style="text-decoration:none;"><span style="font-size:11pt;font-family:Arial;color:#1155cc;text-decoration:underline;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;">the guide</span></a></p></b>';

describe("pasting rich HTML (QA NOTE-04)", () => {
	it("Google Docs: bold and the link stay, the link's underline doesn't", () => {
		const ed = makeEditor({ members: [], addPerson: null });
		ed.view.pasteHTML(GOOGLE_DOCS);
		expect(ed.view.dom.querySelector("u")).toBeNull();
		expect(ed.getMarkdown().trim()).toBe(
			"**PASTEBOLD cash only** see [the guide](https://www.japan-guide.com/e/e3011.html)",
		);
	});

	it("a <u> from a web page is dropped too; the text stays", () => {
		const ed = makeEditor({ members: [], addPerson: null });
		ed.view.pasteHTML(
			'<p>Take <u>exact</u> change and <span style="text-decoration: underline wavy red">coins</span></p>',
		);
		expect(ed.getMarkdown().trim()).toBe("Take exact change and coins");
	});

	it("stripPastedUnderline leaves other styles, <ul> and our own editors' HTML alone", () => {
		expect(
			stripPastedUnderline(
				'<ul><li><span style="color:red;text-decoration:underline;font-weight:700">x</span></li></ul>',
			),
		).toBe(
			'<ul><li><span style="color:red;font-weight:700">x</span></li></ul>',
		);
		expect(
			stripPastedUnderline('<a style="text-decoration-line: underline">y</a>'),
		).toBe('<a style="">y</a>');
		const own = '<p data-pm-slice="1 1 []"><u>kept</u></p>';
		expect(stripPastedUnderline(own)).toBe(own);
	});
});

describe("Add “Name” as a new person (QA PLAN-R2-08)", () => {
	const pick = (ed: Editor, getCtx: () => MentionCtx) =>
		mentionSuggestion(getCtx).command?.({
			editor: ed,
			range: { from: 1, to: 1 },
			props: { id: "add:Zed", label: "Zed" },
		});

	it("a field that saves later gets a pending chip; nobody is created", () => {
		const addPerson = vi.fn(async () => ZED);
		const ctx: MentionCtx = {
			members: [],
			addPerson,
			pendPerson: (name) => pendingPersonId(TRIP, name),
		};
		const ed = makeEditor(ctx);
		pick(ed, () => ctx);
		expect(addPerson).not.toHaveBeenCalled();
		const chip = firstInline(ed);
		expect(chip?.type).toBe("mention");
		const id = String(chip?.attrs?.id);
		expect(pendingPerson(id)).toEqual({ name: "Zed", memberId: null });
		// It reads as the person, not as a former member.
		const el = ed.view.dom.querySelector("[data-mention]");
		expect(el?.textContent).toBe("@Zed");
		expect(el?.hasAttribute("data-former")).toBe(false);
	});

	it("the live note (no pendPerson) creates the person at once", async () => {
		const addPerson = vi.fn(async () => ZED);
		const ctx: MentionCtx = { members: [], addPerson };
		const ed = makeEditor(ctx);
		pick(ed, () => ctx);
		expect(addPerson).toHaveBeenCalledWith("Zed");
		await vi.waitFor(() => expect(firstInline(ed)?.attrs?.id).toBe(ZED));
	});
});
