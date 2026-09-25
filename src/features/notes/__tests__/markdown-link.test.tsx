/**
 * QA NOTE-01 (CONTENT-05): typing `[text](url)` in a note makes a link, like
 * the other Markdown shortcuts. Keystrokes go through ProseMirror's
 * `handleTextInput`, the path real typing takes.
 */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import {
	liveNoteExtensions,
	MARKDOWN_LINK_INPUT,
	markdownLinkHref,
} from "../note-extensions";

let editor: Editor | null = null;

function makeEditor(): Editor {
	editor = new Editor({
		element: document.createElement("div"),
		extensions: liveNoteExtensions(() => ({ members: [], addPerson: null })),
	});
	return editor;
}

function type(ed: Editor, text: string): void {
	for (const ch of text) {
		const view = ed.view;
		const { from, to } = view.state.selection;
		const handled = view.someProp("handleTextInput", (f) =>
			f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
		);
		if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
	}
}

const links = (ed: Editor) =>
	[...ed.view.dom.querySelectorAll("a")].map((a) => ({
		text: a.textContent,
		href: a.getAttribute("href"),
	}));

afterEach(() => {
	editor?.destroy();
	editor = null;
});

describe("Markdown link shortcut", () => {
	it("[guide](url) typed at the end becomes a link", () => {
		const ed = makeEditor();
		type(ed, "See [guide](https://www.japan-guide.com/e/e3011.html) first");
		expect(ed.getText()).toBe("See guide first");
		expect(links(ed)).toEqual([
			{ text: "guide", href: "https://www.japan-guide.com/e/e3011.html" },
		]);
		// Text typed after the link isn't part of it.
		expect(ed.getJSON()).toMatchObject({
			content: [
				{
					type: "paragraph",
					content: [
						{ text: "See " },
						{ text: "guide", marks: [{ type: "link" }] },
						{ text: " first" },
					],
				},
			],
		});
	});

	it("keeps the link through a Markdown round trip", () => {
		const ed = makeEditor();
		type(ed, "[guide](https://www.japan-guide.com/e/e3011.html) ");
		expect(ed.getMarkdown().trim()).toBe(
			"[guide](https://www.japan-guide.com/e/e3011.html)",
		);
	});

	it("a www. address gets https; unsafe schemes and images stay text", () => {
		const ed = makeEditor();
		type(ed, "[menu](www.example.com/menu)");
		expect(links(ed)).toEqual([
			{ text: "menu", href: "https://www.example.com/menu" },
		]);
		ed.commands.setContent("");
		type(ed, "[x](javascript:alert(1))");
		expect(links(ed)).toEqual([]);
		expect(MARKDOWN_LINK_INPUT.test("![pic](https://a.example/p.png)")).toBe(
			false,
		);
		expect(markdownLinkHref("mailto:a@b.example")).toBe("mailto:a@b.example");
		expect(markdownLinkHref("data:text/html,x")).toBeNull();
	});

	it("does nothing inside inline code", () => {
		const ed = makeEditor();
		ed.commands.setContent({
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [
						{
							type: "text",
							text: "[a](https://a.example",
							marks: [{ type: "code" }],
						},
					],
				},
			],
		});
		ed.commands.focus("end");
		type(ed, ")");
		expect(links(ed)).toEqual([]);
	});
});
