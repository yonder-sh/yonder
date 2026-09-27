/**
 * `pnpm kit:baseline`: rewrites the kit guard's baseline from the code
 * (after a migration lowered the counts), and prints the totals.
 */
import { writeFileSync } from "node:fs";
import { BASELINE_PATH, scanKitGuard } from "../src/test/kit-guard";

const report = scanKitGuard(process.cwd());
writeFileSync(BASELINE_PATH, `${JSON.stringify(report, null, "\t")}\n`);
const totals = { text: 0, palette: 0, hex: 0 };
for (const counts of Object.values(report))
	for (const [k, n] of Object.entries(counts))
		totals[k as keyof typeof totals] += n ?? 0;
console.log(`[kit:baseline] ${Object.keys(report).length} files`, totals);
