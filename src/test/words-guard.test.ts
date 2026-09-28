/**
 * The words guard (One Yonder, "one word per thing"): on-screen text never
 * uses the words the plan retired. It reads what a person sees in the TSX
 * (text between tags, label-like attributes, toasts) and fails on a banned
 * word, with the word to use instead. `ALLOW` keeps the few uses that mean
 * something else (the map's "Zoom in", files you drop).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const BANNED: [RegExp, string][] = [
	[/\bunschedul(ed?|e)\b/i, "Ideas / Remove from this day"],
	[/\bto decide\b/i, "Ideas"],
	[/\bnot on (a|the) (day|plan)\b/i, "Ideas"],
	[/\b(my )?priorit(y|ies)\b/i, "Rating"],
	[/\binspector\b/i, "Details"],
	[/\bunlinked transit\b/i, "Check travel"],
	[/\bstay leg\b/i, "Where you sleep"],
	[/\bblock of time\b/i, "Custom stop"],
	[/\best\./i, "about"],
	[/\btalk about it\b/i, "Disagreements"],
	[
		/\bpin(ned)? (start|at)\b|\bpin start time\b|\bdrop a pin\b/i,
		"Set start time / Pick on the map",
	],
	[/\bdropped\b/i, "Not going"],
	[/\bcosts?\b/i, "Expense"],
	[/\bwhat changed\b/i, "Activity"],
	[/\blens(es)?\b/i, "Where / less or more detail"],
];

/** `file` (relative) and the text it may keep. */
const ALLOW: [string, RegExp][] = [];

/** What a person reads in one TSX file: [line, text]. */
function visibleText(src: string): [number, string][] {
	const out: [number, string][] = [];
	const lines = src.split("\n");
	for (const [i, raw] of lines.entries()) {
		const line = raw.trim();
		if (!line || /^(\/\/|\*|\/\*|import |export |\{\s*\/\*)/.test(line))
			continue;
		// Text between tags on one line: `>Talk about it<`.
		for (const m of line.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g))
			out.push([i + 1, m[1] as string]);
		// Label-like attributes and toasts.
		for (const m of line.matchAll(
			/\b(?:aria-label|title|placeholder|label|description|alt)=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g,
		))
			out.push([i + 1, (m[1] ?? m[2] ?? m[3]) as string]);
		for (const m of line.matchAll(
			/\btoast(?:\.\w+)?\(\s*(?:"([^"]*)"|`([^`]*)`)/g,
		))
			out.push([i + 1, (m[1] ?? m[2]) as string]);
		// A line of JSX text on its own (no code on it).
		if (/^[A-Za-z][^<>{}()=;:"`]*[.?!…]?$/.test(line) && /\s/.test(line))
			out.push([i + 1, line]);
	}
	return out;
}

function tsxFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((f) => {
		const p = join(dir, f);
		if (statSync(p).isDirectory())
			return /__tests__|__harness__|__fixtures__/.test(f) ? [] : tsxFiles(p);
		return p.endsWith(".tsx") && !p.endsWith(".test.tsx") ? [p] : [];
	});
}

describe("the words guard", () => {
	it("keeps the retired words off the screen", () => {
		const root = process.cwd();
		const found: string[] = [];
		for (const dir of ["src/features", "src/components", "src/routes"])
			for (const file of tsxFiles(join(root, dir))) {
				const rel = relative(root, file);
				for (const [line, raw] of visibleText(readFileSync(file, "utf8"))) {
					// A template's code (`${status === "dropped" ? …}`) isn't text.
					const text = raw.replace(/\$\{[^}]*\}/g, "…");
					for (const [re, use] of BANNED)
						if (
							re.test(text) &&
							!ALLOW.some(([f, ok]) => f === rel && ok.test(text))
						)
							found.push(`${rel}:${line} "${text.trim()}" → ${use}`);
				}
			}
		expect(found).toEqual([]);
	});

	it("reads text between tags, labels and toasts, not code", () => {
		const text = visibleText(
			[
				"<span>Talk about it</span>",
				'<Button aria-label="Pinned start" />',
				'toast("Dropped Osaka")',
				"const dropped = rows.filter((r) => r.dropped);",
				"// a comment about the Inspector",
			].join("\n"),
		).map(([, t]) => t);
		expect(text).toEqual(["Talk about it", "Pinned start", "Dropped Osaka"]);
	});
});
