/**
 * DEV/E2E ONLY — never imported by the app. Mounts `InsightsHarness` over a
 * live trip page, sharing the page's QueryClient (so the page's session,
 * cache and invalidation apply) and its `useUi` store:
 *
 *   await page.evaluate(async (tripId) => {
 *     const m = await import("/src/features/insights/dev/mount.tsx");
 *     m.mountInsightsHarness({ tripId });
 *   }, tripId);
 */
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type HarnessOptions, InsightsHarness } from "./InsightsHarness";

let root: Root | null = null;

export function mountInsightsHarness(opts: HarnessOptions): void {
	if (!import.meta.env.DEV) throw new Error("the insights harness is dev-only");
	const router = (
		globalThis as {
			__TSR_ROUTER__?: { options: { context: { queryClient: QueryClient } } };
		}
	).__TSR_ROUTER__;
	const queryClient = router?.options.context.queryClient;
	if (!queryClient) throw new Error("no router on this page");
	let host = document.getElementById("insights-harness-root");
	if (!host) {
		host = document.createElement("div");
		host.id = "insights-harness-root";
		host.className = "fixed inset-0 z-40 overflow-auto bg-background";
		document.body.appendChild(host);
	}
	root?.unmount();
	root = createRoot(host);
	root.render(
		<QueryClientProvider client={queryClient}>
			<TooltipProvider delayDuration={200}>
				<InsightsHarness {...opts} />
			</TooltipProvider>
		</QueryClientProvider>,
	);
}

export function unmountInsightsHarness(): void {
	root?.unmount();
	root = null;
	document.getElementById("insights-harness-root")?.remove();
}
