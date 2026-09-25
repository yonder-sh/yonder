/**
 * QA RT-10 (COLLAB-1): two people press Enter at the end of the same note at
 * the same moment and type. Each Enter must make its own paragraph and each
 * person's text must stay together and in order. Two TipTap editors on two
 * Y.Docs, with the updates exchanged by hand so "at the same moment" is
 * exact: both Enters happen before either sees the other's.
 */
import { type AnyExtension, Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NOTE_FIELD } from "@/lib/notes/extensions.shared";
import {
	liveNoteExtensions,
	YjsCaretOnly,
	yjsCaretOnly,
} from "../note-extensions";

const REMOTE = Symbol("remote");
const editors: Editor[] = [];

type Peer = { doc: Y.Doc; editor: Editor; outbox: Uint8Array[] };

function peer(doc: Y.Doc): Peer {
	const outbox: Uint8Array[] = [];
	doc.on("update", (u: Uint8Array, origin: unknown) => {
		if (origin !== REMOTE) outbox.push(u);
	});
	const extensions: AnyExtension[] = [
		...liveNoteExtensions(() => ({ members: [], addPerson: null })),
		Collaboration.configure({ document: doc, field: NOTE_FIELD }),
		YjsCaretOnly,
	];
	const editor = new Editor({
		element: document.createElement("div"),
		extensions,
	});
	editors.push(editor);
	return { doc, editor, outbox };
}

/** Delivers everything each peer has sent so far to every other peer. */
function sync(peers: Peer[]): void {
	const sent = peers.map((p) => p.outbox.splice(0));
	peers.forEach((from, i) => {
		for (const to of peers)
			if (to !== from)
				for (const u of sent[i] ?? []) Y.applyUpdate(to.doc, u, REMOTE);
	});
}

function typeChar(ed: Editor, ch: string): void {
	const view = ed.view;
	const { from, to } = view.state.selection;
	const handled = view.someProp("handleTextInput", (f) =>
		f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
	);
	if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
}

const paragraphs = (ed: Editor) => {
	const out: string[] = [];
	ed.state.doc.forEach((n) => {
		out.push(n.textContent);
	});
	return out;
};

const FIRST = "Bic Camera: duty free on floor 1.";

async function setup(n: number): Promise<Peer[]> {
	const first = peer(new Y.Doc());
	first.editor.commands.setContent(`<p>${FIRST}</p>`);
	const peers = [first];
	for (let i = 1; i < n; i++) {
		peers.push(peer(new Y.Doc()));
		for (const u of first.outbox)
			Y.applyUpdate(peers[i]?.doc as Y.Doc, u, REMOTE);
	}
	first.outbox.splice(0);
	await new Promise((r) => setTimeout(r, 0));
	for (const p of peers) expect(paragraphs(p.editor)).toEqual([FIRST]);
	return peers;
}

/**
 * Everyone at the end presses Enter at once, then they type in lock step
 * (every keystroke crosses the others'), like QA's rt02.mjs.
 */
async function race(
	texts: string[],
	opts: { firstCharBeforeSync: boolean },
): Promise<string[][]> {
	const peers = await setup(texts.length);
	for (const p of peers) {
		p.editor.commands.focus("end");
		p.editor.commands.enter();
	}
	let i = 0;
	if (opts.firstCharBeforeSync) {
		peers.forEach((p, k) => {
			typeChar(p.editor, (texts[k] as string)[0] as string);
		});
		i = 1;
	}
	sync(peers);
	const longest = Math.max(...texts.map((t) => t.length));
	for (; i < longest; i++) {
		peers.forEach((p, k) => {
			const ch = (texts[k] as string)[i];
			if (ch) typeChar(p.editor, ch);
		});
		sync(peers);
	}
	return peers.map((p) => paragraphs(p.editor));
}

afterEach(() => {
	for (const e of editors.splice(0)) e.destroy();
});

describe("concurrent new lines at the end of a note (RT-10)", () => {
	for (const firstCharBeforeSync of [false, true]) {
		const when = firstCharBeforeSync ? "before" : "after";
		it(`two people: each Enter keeps its own paragraph, text in order (first key ${when} the sync)`, async () => {
			const texts = ["Alpha one two.", "Beta three four."];
			const [pa, pb] = await race(texts, { firstCharBeforeSync });
			expect(pa).toEqual(pb);
			expect(pa?.[0]).toBe(FIRST);
			expect(pa?.slice(1).sort()).toEqual([...texts].sort());
		});

		it(`three people (first key ${when} the sync)`, async () => {
			const texts = [
				"Dennis line 3566.",
				"Audrey: cash only at most bars.",
				"Guest line 1123.",
			];
			const docs = await race(texts, { firstCharBeforeSync });
			for (const d of docs) expect(d).toEqual(docs[0]);
			expect(docs[0]?.[0]).toBe(FIRST);
			expect(docs[0]?.slice(1).sort()).toEqual([...texts].sort());
		});
	}

	it("keeps the relative positions and drops only the absolute ones", () => {
		const binding = { beforeTransactionSelection: null as unknown };
		yjsCaretOnly(binding);
		binding.beforeTransactionSelection = {
			type: "text",
			anchor: { a: 1 },
			head: { h: 2 },
			absAnchor: 7,
			absHead: 9,
		};
		expect(binding.beforeTransactionSelection).toEqual({
			type: "text",
			anchor: { a: 1 },
			head: { h: 2 },
			absAnchor: undefined,
			absHead: undefined,
		});
		binding.beforeTransactionSelection = null;
		expect(binding.beforeTransactionSelection).toBeNull();
	});
});
