/**
 * ADDENDUM §9 "Hide from guests": a lock toggle on the tile, the lightbox and
 * the PDF viewer. Label "Hide from guests" when visible, "Hidden from
 * guests" when on (click again to show). Any member may flip it (viewers
 * too, capability `setMediaVisibility`), never a link guest — guests don't
 * get the button at all (they never see hidden rows anyway). Offline it stays
 * visible but disabled with the reason (DESIGN "never hide disabled controls").
 */
import { cn } from "cn";
import { Lock, LockOpen } from "lucide-react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { can } from "@/lib/auth/roles";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { MEDIA_TESTID } from "../testids";
import type { MediaDto } from "../types";

export function useVisibilityGuard(): {
	show: boolean;
	disabled: boolean;
	reason: string | null;
} {
	const { graph, connection, mode } = useWorkspace();
	const me = graph.me;
	if (!can({ role: me.role, isGuest: me.isGuest }, "setMediaVisibility"))
		return { show: false, disabled: true, reason: null };
	if (mode !== "live") return { show: true, disabled: true, reason: "Preview" };
	if (connection === "offline")
		return { show: true, disabled: true, reason: "Offline — editing paused" };
	return { show: true, disabled: false, reason: null };
}

export function VisibilityButton({
	item,
	onToggle,
	variant = "tile",
	className,
}: {
	item: Pick<MediaDto, "id" | "visibility" | "target">;
	onToggle: (next: MediaDto["visibility"]) => void;
	/** `tile`: a round icon over the media; `toolbar`: icon + label (lightbox, viewer). */
	variant?: "tile" | "toolbar" | "menu";
	className?: string;
}) {
	const guard = useVisibilityGuard();
	if (!guard.show) return null;
	const hidden = item.visibility === "members";
	// Receipts are money: always hidden, never toggled here.
	const receipt = item.target.kind === "expense";
	const label = hidden ? "Hidden from guests" : "Hide from guests";
	const tip = receipt
		? "Receipts are never shown to guests"
		: (guard.reason ??
			(hidden
				? "Hidden from guests · click to show them"
				: "Hide from link guests"));
	const Icon = hidden ? Lock : LockOpen;
	const button = (
		<button
			type="button"
			data-testid={MEDIA_TESTID.visibility}
			data-state={hidden ? "hidden" : "visible"}
			aria-pressed={hidden}
			aria-label={label}
			disabled={guard.disabled || receipt}
			onClick={(e) => {
				e.stopPropagation();
				onToggle(hidden ? "everyone" : "members");
			}}
			className={cn(
				"inline-flex items-center gap-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
				variant === "tile" &&
					"grid size-7 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm hover:bg-black/75",
				variant === "toolbar" &&
					"h-8 rounded-md px-2.5 text-[13px] font-medium text-white/90 hover:bg-white/15 hover:text-white",
				variant === "menu" &&
					"h-8 w-full rounded-sm px-2 text-sm hover:bg-accent",
				variant === "toolbar" && hidden && "bg-white/15 text-white",
				className,
			)}
		>
			<Icon
				className={variant === "tile" ? "size-3.5" : "size-4"}
				strokeWidth={1.75}
			/>
			{variant !== "tile" ? <span>{label}</span> : null}
		</button>
	);
	// The label says it all where there's room (the lightbox sits above tooltips).
	if (variant !== "tile") return <span title={tip}>{button}</span>;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{guard.disabled || receipt ? (
					<span className="inline-flex">{button}</span>
				) : (
					button
				)}
			</TooltipTrigger>
			<TooltipContent>{tip}</TooltipContent>
		</Tooltip>
	);
}
