/**
 * Shared by WP-Suggest's specs (`suggest-*.spec.ts`; not a spec itself).
 *
 * Until WP-Shell / WP-Lists / WP-Plan mount the components in this checkout
 * (`src/features/suggest/CONTRACT_REQUESTS.md` M1–M8), `withSuggestUi` loads
 * the dev harness (`src/features/suggest/__harness__/mount.tsx`), which
 * portals them into the same places. Once a real `SuggestModeControl` is
 * mounted the harness is not loaded and the same assertions run against the
 * real mounts.
 */
import { expect, type Page } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";

export type Graph = {
	trip: { id: string; startDate: string | null };
	items: { id: string; nodeId: string | null; dayId: string | null; title: string | null }[];
	nodes: { id: string; name: string }[];
	members: { id: string; name: string; userId: string | null }[];
};

export const graphOf = (page: Page) =>
	page.evaluate(() => (window as unknown as { __yonder: { graph: Graph } }).__yonder.graph);

/** Loads the harness unless the real mounts exist. Returns whether it did. */
export async function withSuggestUi(page: Page, proposals: "fixture" | "live"): Promise<boolean> {
	await expect(page.getByTestId(TESTID.workspace)).toBeVisible();
	await page.waitForFunction(() => !!(window as unknown as { __yonder?: unknown }).__yonder);
	await page.waitForTimeout(300);
	const real = await page
		.locator(`[data-testid="${TESTID.suggestModeControl}"]:not([data-suggest-slot] *)`)
		.count();
	if (real > 0) return false;
	await page.evaluate(async (mode) => {
		(window as unknown as { __suggestHarness: unknown }).__suggestHarness = { proposals: mode };
		await import(/* @vite-ignore */ "/src/features/suggest/__harness__/mount.tsx");
	}, proposals);
	return true;
}

/** A scheduled item by its place name or title. */
export async function itemIdByName(page: Page, name: string): Promise<string> {
	const g = await graphOf(page);
	const node = g.nodes.find((n) => n.name === name);
	const it = g.items.find((i) => i.dayId && (i.nodeId === node?.id || i.title === name));
	if (!it) throw new Error(`no item ${name}`);
	return it.id;
}

/** The item's day in the page's graph (null = unscheduled, undefined = gone). */
export async function dayOfItem(page: Page, itemId: string): Promise<string | null | undefined> {
	const g = await graphOf(page);
	return g.items.find((i) => i.id === itemId)?.dayId;
}

/**
 * Calls a server function the way the app does (the page's module graph, so
 * the tab's suggest-mode header travels with it). `file` is under `/src`.
 */
export async function callServerFn<T = unknown>(
	page: Page,
	file: string,
	fn: string,
	data: unknown,
): Promise<T> {
	return page.evaluate(
		async ({ file, fn, data }) => {
			const mod = (await import(/* @vite-ignore */ file)) as Record<
				string,
				(o: { data: unknown }) => Promise<unknown>
			>;
			const f = mod[fn];
			if (!f) throw new Error(`no ${fn} in ${file}`);
			const out = await f({ data });
			// The calling tab gets no live event for its own change: refresh
			// the app's queries the way its mutation hooks would.
			const { appQueryClient } = await import(
				/* @vite-ignore */ "/src/features/suggest/__harness__/app-query-client.ts"
			);
			await appQueryClient()?.invalidateQueries();
			return out;
		},
		{ file, fn, data },
	) as Promise<T>;
}

export async function settle(page: Page, ms = 350) {
	await page.waitForTimeout(ms);
}

/**
 * The suggest-mode rule on the center panel: WP-Shell's banner row
 * (`suggest-rule`, a 2px top border) in the merged app, else
 * WP-Suggest's own border on the panel.
 */
export async function centerRuleWidth(page: Page): Promise<string> {
	return page.getByTestId(TESTID.centerPanel).evaluate((el) => {
		const shell = el.querySelector('[data-testid="suggest-rule"]');
		return getComputedStyle(shell ?? el).borderTopWidth;
	});
}
