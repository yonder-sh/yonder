/**
 * WP-Insights e2e helpers. The package's components are mounted by other
 * packages (Plan, Places, Shell, Home) that don't exist in this workspace, so
 * the specs mount the dev-only harness (`src/features/insights/dev/mount.tsx`)
 * over a live, cloned trip (SPEC §18.3: acceptance on F plus this WP alone).
 * Data is prepared through the real server functions, called from the page.
 */
import { expect, type Page } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import type { FixtureClone } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

export { INSIGHTS_TESTID } from "../../../src/features/insights/testids";

const MOUNT = "/src/features/insights/dev/mount.tsx";

/** Calls a server function from inside the page (the real HTTP path: CSRF, middleware, authz). */
export async function callFn<T = unknown>(
	page: Page,
	module: string,
	fn: string,
	data: unknown,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
	return page.evaluate(
		async ({ module, fn, data }) => {
			try {
				const m = await import(/* @vite-ignore */ module);
				return { ok: true as const, value: await m[fn]({ data }) };
			} catch (e) {
				return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
			}
		},
		{ module, fn, data },
	) as Promise<{ ok: true; value: T } | { ok: false; error: string }>;
}

async function must<T>(p: Promise<{ ok: true; value: T } | { ok: false; error: string }>): Promise<T> {
	const r = await p;
	if (!r.ok) throw new Error(r.error);
	return r.value;
}

/** Opens the cloned trip and mounts the harness over it. */
export async function openHarness(
	page: Page,
	c: FixtureClone,
	opts: { nodeId?: string; panel?: "plan" | "inspector" | "settings"; live?: boolean } = {},
): Promise<void> {
	await page.goto(`/t/${c.slug}?tab=plan`);
	if (opts.live !== false) await expectLive(page);
	else await expect(page.getByTestId(TESTID.workspace)).toBeVisible({ timeout: 20_000 });
	await page.evaluate(
		async ({ mod, o }) => {
			const m = await import(/* @vite-ignore */ mod);
			m.mountInsightsHarness(o);
		},
		{ mod: MOUNT, o: { tripId: c.tripId, ...(opts.nodeId ? { nodeId: opts.nodeId } : {}), ...(opts.panel ? { panel: opts.panel } : {}) } },
	);
	await expect(page.getByTestId("insights-harness")).toBeVisible({ timeout: 20_000 });
}

/** Sheet hours on a node (`details.openHoursText`, as the importer writes them). */
export function setSheetHours(page: Page, nodeId: string, text: string) {
	return must(
		callFn(page, "/src/functions/nodes.functions.ts", "updateNode", {
			nodeId,
			patch: { details: { openHoursText: text } },
		}),
	);
}

export function updateItem(page: Page, itemId: string, patch: Record<string, unknown>) {
	return must(callFn(page, "/src/functions/items.functions.ts", "updateItem", { itemId, patch }));
}

/** Refetches the harness's graph (a change made from this tab never comes back as a live event). */
export async function refreshGraph(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const r = (globalThis as unknown as {
			__TSR_ROUTER__?: { options: { context: { queryClient: { invalidateQueries: (o: unknown) => Promise<void> } } } };
		}).__TSR_ROUTER__;
		await r?.options.context.queryClient.invalidateQueries({ queryKey: ["trip"] });
	});
}

/** The harness card of an item. */
export const card = (page: Page, itemId: string) =>
	page.locator(`[data-testid=harness-card][data-item="${itemId}"]`);
/** The harness day section. */
export const daySection = (page: Page, dayId: string) =>
	page.locator(`[data-testid=harness-day][data-day="${dayId}"]`);
