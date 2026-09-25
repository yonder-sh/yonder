/**
 * NOTE-04 in an editor: Ctrl+U never underlines and pasted `<u>` isn't kept
 * (the note markdown must stay CommonMark).
 */
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { noteExtensions } from "./extensions.shared";

describe("NOTE-04: no underline in the note schema", () => {
	it("Ctrl+U in the editor schema toggles nothing", () => {
		const editor = new Editor({
			extensions: noteExtensions(),
			content: "<p>hello</p><p>under <u>html</u></p>",
		});
		editor.commands.selectAll();
		const handled = editor.view.someProp("handleKeyDown", (f) =>
			f(editor.view, new KeyboardEvent("keydown", { key: "u", ctrlKey: true })),
		);
		expect(handled).toBe(true);
		// Pasted/parsed `<u>` isn't kept either.
		expect(JSON.stringify(editor.getJSON())).not.toContain("underline");
		editor.destroy();
	});
});
