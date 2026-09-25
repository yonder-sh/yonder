/**
 * Rollup controls (SPEC §8.4, DESIGN §4.3): "Everything inside · Only Tokyo"
 * (reads and writes `only`), and the sticky mini-breadcrumb that heads each
 * group in the Media, Lists and Notes tabs.
 */
import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatDateRange } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { Crumbs } from "./crumbs";

export function RollupToggle({ className }: { className?: string }) {
	const { scope, only, days, nav } = useWorkspace();
	const everything = days
		? `Everything on ${formatDateRange(days.from, days.to)}`
		: "Everything inside";
	return (
		<ToggleGroup
			type="single"
			size="sm"
			variant="outline"
			value={only ? "only" : "all"}
			onValueChange={(v) => v && nav.setOnly(v === "only")}
			className={cn("h-7", className)}
			aria-label="What to include"
		>
			<ToggleGroupItem value="all" className="h-7 px-2.5 text-xs">
				{everything}
			</ToggleGroupItem>
			<ToggleGroupItem
				value="only"
				className="h-7 px-2.5 text-xs"
				disabled={!scope}
			>
				Only {scope?.name ?? "the trip"}
			</ToggleGroupItem>
		</ToggleGroup>
	);
}

/** Sticky group header: crumbs relative to the scope, a count, and a zoom-in chevron. */
export function GroupSubhead({
	repId,
	count,
	onZoom,
}: {
	repId: string | null;
	count?: number;
	onZoom?: () => void;
}) {
	const { scope } = useWorkspace();
	return (
		<div className="sticky top-0 z-20 flex h-8 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
			{repId ? (
				<Crumbs
					nodeIds={repId}
					relativeTo={scope?.id ?? null}
					className="text-foreground"
				/>
			) : (
				<span className="text-xs text-foreground">{scope?.name ?? "Trip"}</span>
			)}
			{count !== undefined ? (
				<span className="font-mono text-xs text-muted-foreground tnum">
					{count}
				</span>
			) : null}
			{onZoom ? (
				<button
					type="button"
					onClick={onZoom}
					className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					aria-label="Zoom in"
				>
					<ChevronRight className="size-4" />
				</button>
			) : null}
		</div>
	);
}
