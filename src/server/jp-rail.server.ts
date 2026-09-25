/**
 * Whether the Japan rail data (ADDENDUM §5, JAPAN_TRANSIT §4) is installed:
 * `pnpm data:jp` writes `src/data/jp-rail/manifest.json`. WP-Transit's
 * `estimate` provider loads the graph itself (lazily, with `fs.readFile`); this
 * only answers `getCapabilities().jpRail`.
 */
import { access } from "node:fs/promises";
import path from "node:path";

/**
 * Where the rail data lives: `JP_RAIL_DIR` when set, else `src/data/jp-rail`
 * under the working directory (the repo in dev; `/app/src/data/jp-rail` in
 * both production images, which copy it from the build stage).
 */
export const JP_RAIL_DIR = path.resolve(
	process.cwd(),
	process.env.JP_RAIL_DIR || "src/data/jp-rail",
);

let memo: Promise<boolean> | undefined;

export function jpRailAvailable(): Promise<boolean> {
	memo ??= access(path.join(JP_RAIL_DIR, "manifest.json")).then(
		() => true,
		() => false,
	);
	return memo;
}
