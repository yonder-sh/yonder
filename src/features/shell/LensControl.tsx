/**
 * DESIGN §4.1 lens control: one segment per visible level; the selected one
 * is a foreground fill (a mode, not a selection, so never primary); disabled
 * levels explain why. `[` and `]` step it (use-workspace-hotkeys.ts).
 */
import { cn } from "cn";
import { useEffect, useRef } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { NODE_TYPES } from "@/lib/domain/taxonomy";
import type { Lens } from "@/lib/engine/types";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";

export function LensControl({
	scrollable = false,
	compact = false,
	className,
}: {
	/** Mobile: horizontally scrollable, every enabled level, selected scrolled into view. */
	scrollable?: boolean;
	/** Tablet top bar (md): a single dropdown instead of the segments. */
	compact?: boolean;
	className?: string;
}) {
	const { lens, lensOptions, nav } = useWorkspace();
	if (compact)
		return (
			<Select value={lens} onValueChange={(v) => nav.setLens(v as Lens)}>
				<SelectTrigger
					size="sm"
					aria-label="Granularity"
					data-testid={TESTID.lensControl}
					className={cn("h-8 w-auto shrink-0 gap-1 text-[13px]", className)}
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{lensOptions
						.filter((o) => o.visible || !o.enabled)
						.map((o) => (
							<SelectItem key={o.lens} value={o.lens} disabled={!o.enabled}>
								{NODE_TYPES[o.lens].label}
							</SelectItem>
						))}
				</SelectContent>
			</Select>
		);
	return <LensSegments scrollable={scrollable} className={className} />;
}

function LensSegments({
	scrollable,
	className,
}: {
	scrollable: boolean;
	className?: string;
}) {
	const { lens, lensOptions, scope, nav } = useWorkspace();
	const groupRef = useRef<HTMLDivElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll again whenever the lens changes
	useEffect(() => {
		if (!scrollable) return;
		groupRef.current
			?.querySelector<HTMLElement>('[data-state="on"]')
			?.scrollIntoView({ inline: "center", block: "nearest" });
	}, [scrollable, lens]);
	const options = scrollable
		? lensOptions.filter((o) => o.visible)
		: lensOptions.filter((o) => o.visible || !o.enabled);
	return (
		<ToggleGroup
			ref={groupRef}
			type="single"
			value={lens}
			onValueChange={(v) => v && nav.setLens(v as Lens)}
			aria-label="Granularity"
			data-testid={TESTID.lensControl}
			className={cn(
				"shrink-0 rounded-lg border bg-background p-0.5",
				scrollable &&
					"max-w-full overflow-x-auto px-0.5 py-0 [scrollbar-width:none]",
				className,
			)}
		>
			{options.map((o) => {
				const label = NODE_TYPES[o.lens].label;
				const item = scrollable ? (
					// Phone (MOB-07): a 44px-tall touch target around a 36px segment.
					<ToggleGroupItem
						key={o.lens}
						value={o.lens}
						disabled={!o.enabled}
						className={cn(
							"group/lens h-11 min-w-11 shrink-0 rounded-md px-0 text-[13px] font-medium whitespace-nowrap",
							"text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-transparent data-[state=on]:text-background",
							"disabled:opacity-40",
						)}
					>
						<span className="flex h-9 w-full items-center justify-center rounded-md px-3 group-data-[state=on]/lens:bg-foreground">
							{label}
						</span>
					</ToggleGroupItem>
				) : (
					<ToggleGroupItem
						key={o.lens}
						value={o.lens}
						disabled={!o.enabled}
						className={cn(
							"h-7 shrink-0 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap",
							"text-muted-foreground hover:text-foreground data-[state=on]:bg-foreground data-[state=on]:text-background",
							"disabled:opacity-40",
						)}
					>
						{label}
					</ToggleGroupItem>
				);
				if (o.enabled) return item;
				return (
					<Tooltip key={o.lens}>
						<TooltipTrigger asChild>
							<span>{item}</span>
						</TooltipTrigger>
						<TooltipContent>
							Already inside {scope?.name ?? "the trip"}
						</TooltipContent>
					</Tooltip>
				);
			})}
		</ToggleGroup>
	);
}
