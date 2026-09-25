/**
 * QA VIS3-08 (SPEC §19 PERF-05): the workspace's first load must not carry
 * TipTap/ProseMirror. What other packages import from notes (the field, the
 * panels, the static note, the previews) reaches TipTap only through a
 * dynamic `import()` (`LiveNote`, `StaticNoteRender`, `MentionInputEditor`).
 * This walks the static imports inside notes (and `@/lib/notes`) from those
 * entry points and fails on any value import of TipTap or ProseMirror.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../../..");
const NOTES = path.join(SRC, "features/notes");

/** What other packages import from `@/features/notes/*`. */
const ENTRIES = [
	"MentionInput.tsx",
	"NotesPanel.tsx",
	"NotesTab.tsx",
	"NoteBlock.tsx",
	"NoteEditor.tsx",
	"StaticNote.tsx",
	"use-note-preview.ts",
	"pending-people.ts",
].map((f) => path.join(NOTES, f));

const HEAVY = /^(@tiptap\/|prosemirror-|@hocuspocus\/extension|y-prosemirror)/;

/** Static value imports and re-exports (not `import type`, not `import()`). */
function staticImports(file: string): string[] {
	const code = readFileSync(file, "utf8");
	const out: string[] = [];
	const re =
		/^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;
	for (const m of code.matchAll(re)) {
		if (m[5]) {
			out.push(m[5]);
			continue;
		}
		if (m[2]) continue; // import type / export type
		out.push(m[4] as string);
	}
	return out;
}

function resolveLocal(from: string, spec: string): string | null {
	let base: string | null = null;
	if (spec.startsWith("./") || spec.startsWith("../"))
		base = path.resolve(path.dirname(from), spec);
	else if (
		spec.startsWith("@/features/notes/") ||
		spec.startsWith("@/lib/notes/")
	)
		base = path.join(SRC, spec.slice(2));
	if (!base) return null;
	for (const ext of ["", ".ts", ".tsx"])
		if (existsSync(base + ext) && (ext || /\.tsx?$/.test(base)))
			return base + ext;
	return null;
}

describe("notes keep TipTap out of the workspace's first load (VIS3-08)", () => {
	it("no static path from the notes entry points reaches TipTap or ProseMirror", () => {
		const seen = new Set<string>();
		const hits: string[] = [];
		const walk = (file: string, trail: string[]) => {
			if (seen.has(file)) return;
			seen.add(file);
			for (const spec of staticImports(file)) {
				if (HEAVY.test(spec)) {
					hits.push([...trail, path.relative(SRC, file), spec].join(" → "));
					continue;
				}
				const next = resolveLocal(file, spec);
				if (next) walk(next, [...trail, path.relative(SRC, file)]);
			}
		};
		for (const e of ENTRIES) walk(e, []);
		expect(hits).toEqual([]);
		// The walk really went somewhere (the entries exist and import locals).
		expect(seen.size).toBeGreaterThan(ENTRIES.length);
	});

	it("the TipTap modules are loaded with import()", () => {
		const lazy = (file: string, target: string) =>
			new RegExp(`lazy\\(\\(\\) => import\\("\\./${target}"\\)\\)`).test(
				readFileSync(path.join(NOTES, file), "utf8"),
			);
		expect(lazy("MentionInput.tsx", "MentionInputEditor")).toBe(true);
		expect(lazy("NoteEditor.tsx", "LiveNote")).toBe(true);
		expect(lazy("StaticNote.tsx", "StaticNoteRender")).toBe(true);
	});
});
