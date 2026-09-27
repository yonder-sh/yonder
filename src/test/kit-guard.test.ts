/**
 * The kit guard: what the kit replaces can only go down, file by file.
 * Arbitrary text sizes, raw palette colours and hex colours in classes (see
 * `kit-guard.ts`). A migration that lowers a count updates the baseline with
 * `pnpm kit:baseline`, so the gain is locked in.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	BASELINE_PATH,
	type GuardKind,
	type GuardReport,
	rawCnImports,
	scanKitGuard,
} from "./kit-guard";

const root = process.cwd();
const baseline = JSON.parse(
	readFileSync(`${root}/${BASELINE_PATH}`, "utf8"),
) as GuardReport;
const current = scanKitGuard(root);
const HINT: Record<GuardKind, string> = {
	text: "use the type scale (text-xs, text-meta, text-sm, text-body, text-lg, text-2xl)",
	palette:
		"use a token (warning, good, destructive, primary, muted…) or a kit Chip tone",
	hex: "use a CSS variable token",
};

describe("the kit guard", () => {
	it("adds no arbitrary text sizes, palette colours or hex colours", () => {
		const grew: string[] = [];
		for (const [file, counts] of Object.entries(current)) {
			for (const [kind, n] of Object.entries(counts) as [GuardKind, number][]) {
				const was = baseline[file]?.[kind] ?? 0;
				if (n > was)
					grew.push(`${file}: ${kind} ${was} → ${n} (${HINT[kind]})`);
			}
		}
		expect(grew).toEqual([]);
	});

	it("has a baseline no looser than the code (run `pnpm kit:baseline` after a migration)", () => {
		const loose: string[] = [];
		for (const [file, counts] of Object.entries(baseline)) {
			for (const [kind, was] of Object.entries(counts) as [
				GuardKind,
				number,
			][]) {
				const n = current[file]?.[kind] ?? 0;
				if (n < was) loose.push(`${file}: ${kind} ${was} → ${n}`);
			}
		}
		expect(loose).toEqual([]);
	});

	it('imports cn from "@/lib/utils", which knows text-meta and text-body', () => {
		expect(rawCnImports(root)).toEqual([]);
	});
});
