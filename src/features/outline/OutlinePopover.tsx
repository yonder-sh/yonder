/**
 * The Outline at lg and md (SPEC §12.5 `OutlinePopover()`, DESIGN §5.2–§5.3):
 * a PanelLeft button before the breadcrumb opens the tree and Ideas in a
 * 360 × 70vh popover. A small dot on the button says a place filter is on
 * (the filter is shared with the map, so it matters even when closed).
 */
import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { bool, useFollowState } from "@/lib/realtime/view-ui";
import { TESTID } from "@/lib/testids";
import { IdeasBin } from "./IdeasBin";
import { Outline } from "./Outline";
import { usePlaceFilter } from "./use-place-filter";

export function OutlinePopover() {
	const { active } = usePlaceFilter();
	// Open or closed travels with my view.
	const [open, setOpen] = useFollowState("outline.pop", false, bool);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="relative size-8 shrink-0"
					aria-label={active ? "Outline (filtered)" : "Outline"}
					data-testid={TESTID.outlinePopoverButton}
				>
					<PanelLeft className="size-4" />
					{active ? (
						<span
							aria-hidden
							className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary"
						/>
					) : null}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				data-testid={TESTID.outlinePopover}
				className="flex h-[70vh] w-[360px] max-w-[calc(100vw-24px)] flex-col overflow-hidden bg-sidebar p-0 text-sidebar-foreground"
			>
				<Outline />
				<IdeasBin />
			</PopoverContent>
		</Popover>
	);
}
