/**
 * The kit guard (One Yonder kit, 2026-09-27): counts, per file, what the kit
 * replaces, so it can only go down. Arbitrary text sizes (`text-[13px]`), raw
 * Tailwind palette colours (`text-amber-600`) and hex colours in classes
 * (`bg-[#040507]`). The kit itself, the shadcn primitives, tests and dev
 * pages are exempt. `pnpm kit:baseline` rewrites the baseline after a
 * migration lowers the counts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type GuardKind = "text" | "palette" | "hex";
export type GuardCounts = Partial<Record<GuardKind, number>>;
export type GuardReport = Record<string, GuardCounts>;

const PALETTE =
	"red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";
export const GUARD_PATTERNS: Record<GuardKind, RegExp> = {
	text: /\btext-\[\d+(?:\.\d+)?(?:px|rem)\]/g,
	palette: new RegExp(
		`\\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|divide|placeholder|caret|accent|shadow)-(?:${PALETTE})-\\d{2,3}\\b`,
		"g",
	),
	hex: /\[#[0-9a-fA-F]{3,8}\]/g,
};

const EXEMPT = [
	/^src\/components\/(ui|kit)\//,
	/^src\/routes\/dev\//,
	/^src\/test\//,
	/(^|\/)__tests__\//,
	/\.test\.tsx?$/,
	/\.d\.ts$/,
];

function walk(dir: string, out: string[]): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.tsx?$/.test(name)) out.push(p);
	}
	return out;
}

/** Counts per file (only files with any), paths relative to `root`. */
export function scanKitGuard(root: string): GuardReport {
	const report: GuardReport = {};
	for (const file of walk(join(root, "src"), [])) {
		const rel = relative(root, file).split("\\").join("/");
		if (EXEMPT.some((re) => re.test(rel))) continue;
		const text = readFileSync(file, "utf8");
		const counts: GuardCounts = {};
		for (const kind of Object.keys(GUARD_PATTERNS) as GuardKind[]) {
			const n = text.match(GUARD_PATTERNS[kind])?.length ?? 0;
			if (n) counts[kind] = n;
		}
		if (Object.keys(counts).length) report[rel] = counts;
	}
	return Object.fromEntries(
		Object.entries(report).sort(([a], [b]) => a.localeCompare(b)),
	);
}

export const BASELINE_PATH = "src/test/kit-guard.baseline.json";

/** Files importing `cn` from the package, which doesn't know the kit's sizes. */
export function rawCnImports(root: string): string[] {
	return walk(join(root, "src"), [])
		.map((f) => relative(root, f).split("\\").join("/"))
		.filter((rel) =>
			/^(?:import|export)\b[^;]*\bfrom "cn";/m.test(
				readFileSync(join(root, rel), "utf8"),
			),
		);
}
