/**
 * The phone's "★ Rate 12" pill (the flow, owner 2026-09-25: rating was very
 * hidden on phones). It floats just above the bottom sheet, on the left
 * (the map's controls and the (+) are on the right, the sheet's handle is
 * inside the sheet), and follows the sheet between its peek and half snaps;
 * with the sheet full height it sits at the foot of the screen. Shown
 * whenever you have places to rate here; hidden at 0, for people who can't
 * rate, and while the feed itself is open. A tap opens the full-screen feed.
 * Planning prompts step back while you travel: during the trip it shows only
 * on the Places tab.
 */

import { Star } from "lucide-react";
import type { CSSProperties, MouseEvent } from "react";
import { useRateTarget } from "@/features/shell/rate-entry";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { PLACES_TAB_TESTID } from "./testids";
import { useFlowTally } from "./use-flow";

/** The pill's bottom edge: just above the phone's 56px tab bar and the Plan's ideas dock (One Yonder). */
export const RATE_PILL_BOTTOM =
	"calc(56px + var(--plan-dock-h, 0px) + env(safe-area-inset-bottom) + 12px)";

export function RatePill() {
	const { tab, search, underway } = useWorkspace();
	const t = useRateTarget();
	const left = useFlowTally(t.scopeId).toRate ?? 0;
	const feedOpen = tab === "places" && search.pv === "rate";
	if (!left || feedOpen || (underway && tab !== "places")) return null;
	const style: CSSProperties = { bottom: RATE_PILL_BOTTOM };
	return (
		<a
			href={t.href}
			onClick={(e: MouseEvent) => {
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
				e.preventDefault();
				t.go();
			}}
			data-testid={PLACES_TAB_TESTID.ratePill}
			data-count={left}
			aria-label={`${t.label}: ${left} to rate`}
			style={style}
			className={cn(
				"fixed left-3 z-40 flex h-11 items-center gap-2 rounded-full bg-background/92 pr-4 pl-3.5 text-body font-semibold text-foreground shadow-float backdrop-blur-md transition-[bottom,transform] duration-300 active:scale-95 motion-reduce:transition-none",
			)}
		>
			<Star className="size-[18px] fill-glow text-glow" strokeWidth={1.75} />
			Rate
			<span className="text-sm tnum text-muted-foreground">{left}</span>
		</a>
	);
}
