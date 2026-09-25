import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guards for SPEC §3 ("versions are exact") and the one-Yjs rule (critique #65).
const read = (file: string) =>
	readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const pkg = JSON.parse(read("package.json")) as {
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
};
const lock = read("pnpm-lock.yaml");

/** Distinct resolved versions of `name` in the lockfile's packages section. */
function lockedVersions(name: string): string[] {
	const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	const entry = new RegExp(`^ {2}'?${escaped}@([^:(']+)'?:$`, "gm");
	return [...new Set([...lock.matchAll(entry)].map((m) => m[1] ?? ""))];
}

describe("dependencies", () => {
	it("pins every direct dependency to an exact version", () => {
		const all = { ...pkg.dependencies, ...pkg.devDependencies };
		const loose = Object.entries(all).filter(
			([, version]) => !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version),
		);
		expect(loose).toEqual([]);
	});

	it.each([
		"yjs",
		"y-protocols",
		"@tiptap/pm",
		"@tiptap/y-tiptap",
		"prosemirror-model",
		"react",
		"react-dom",
		"ioredis",
	])("resolves exactly one version of %s", (name) => {
		expect(lockedVersions(name)).toHaveLength(1);
	});

	it("never pulls in y-prosemirror (a second Yjs-ProseMirror binding)", () => {
		expect(lockedVersions("y-prosemirror")).toEqual([]);
	});
});
