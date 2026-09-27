/**
 * The details pane (owner, 2026-09-26): on lg/xl a selection's panel docks
 * at the right edge as a pane of its own, beside the map instead of over it.
 * Drag its left edge (or ← / → on it) to resize, remembered on this device;
 * « folds it to a rail with the selection's name, ✕ closes it (nothing
 * selected). The fold is that selection's: another opens unfolded. Where the window has no room for
 * the list, the map and the pane, `DesktopWorkspace` folds the Outline, or
 * lets the panel float over the map as before.
 */
import { PanelRightOpen } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { TESTID } from "@/lib/testids";
import { serializeSel } from "@/lib/workspace/search";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { InspectorBody } from "./InspectorBody";
import { inspectorHeader } from "./inspector-header";
import { useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";

export const DETAILS_MIN = 340;
export const DETAILS_MAX = 560;
const STEP = 16;

/** The pane's width for a breakpoint: the remembered one, else the old floating panel's. */
export function useDetailsWidth(bp: "lg" | "xl"): number {
	const saved = useShell((s) => s.detailsWidth);
	return clampWidth(saved ?? (bp === "xl" ? 400 : 380));
}

export function clampWidth(w: number, max = DETAILS_MAX): number {
	return Math.round(Math.max(DETAILS_MIN, Math.min(max, w)));
}

/** Is the pane folded (for this selection), and fold or unfold it. */
export function useDetailsFold(): {
	folded: boolean;
	fold: () => void;
	unfold: () => void;
} {
	const { sel } = useWorkspace();
	const key = sel ? (serializeSel(sel) ?? "root") : null;
	const foldedFor = useShell((s) => s.detailsFoldedFor);
	const foldDetails = useShell((s) => s.foldDetails);
	return {
		folded: key !== null && foldedFor === key,
		fold: () => foldDetails(key),
		unfold: () => foldDetails(null),
	};
}

export function DetailsPane({
	width,
	maxWidth,
}: {
	width: number;
	/** The widest it may be here (the list and the map keep their minimums). */
	maxWidth: number;
}) {
	const { nav } = useWorkspace();
	const { folded, fold, unfold } = useDetailsFold();
	if (folded) return <DetailsRail onShow={unfold} />;
	return (
		<aside
			data-testid={TESTID.inspector}
			aria-label="Details"
			className="relative flex shrink-0 flex-col overflow-hidden border-l bg-card"
			style={{ width }}
		>
			<ResizeEdge width={width} maxWidth={maxWidth} />
			<InspectorBody onClose={() => nav.select(null)} onCollapse={fold} />
		</aside>
	);
}

/** The pane's left edge: drag it, or ← / → with it focused. */
function ResizeEdge({ width, maxWidth }: { width: number; maxWidth: number }) {
	const setWidth = useShell((s) => s.setDetailsWidth);
	const drag = useRef<{ x: number; w: number } | null>(null);
	const clamp = (w: number) => clampWidth(w, Math.max(DETAILS_MIN, maxWidth));
	return (
		// biome-ignore lint/a11y/useSemanticElements: a vertical separator that takes the pointer and keys
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize the details"
			aria-valuemin={DETAILS_MIN}
			aria-valuemax={Math.max(DETAILS_MIN, maxWidth)}
			aria-valuenow={width}
			tabIndex={0}
			data-testid={SHELL_TESTID.detailsResize}
			className="absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize touch-none outline-none hover:bg-primary/40 focus-visible:bg-primary/40"
			onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
				e.currentTarget.setPointerCapture(e.pointerId);
				drag.current = { x: e.clientX, w: width };
			}}
			onPointerMove={(e) => {
				const d = drag.current;
				if (d) setWidth(clamp(d.w + (d.x - e.clientX)));
			}}
			onPointerUp={() => {
				drag.current = null;
			}}
			onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
				if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
				e.preventDefault();
				setWidth(clamp(width + (e.key === "ArrowLeft" ? STEP : -STEP)));
			}}
		/>
	);
}

/** Folded: a rail with the selection's name; one click brings the pane back. */
function DetailsRail({ onShow }: { onShow: () => void }) {
	const ws = useWorkspace();
	const title = inspectorHeader(ws).title;
	return (
		<div
			data-testid={SHELL_TESTID.detailsRail}
			className="flex w-10 shrink-0 flex-col items-center border-l bg-card py-1.5"
		>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-label={`Show the details of ${title}`}
						data-testid={SHELL_TESTID.detailsShow}
						onClick={onShow}
						className="flex min-h-0 flex-col items-center gap-2 rounded-md px-1.5 py-2 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					>
						<PanelRightOpen className="size-4 shrink-0" />
						<span
							aria-hidden
							className="max-h-[60svh] truncate text-xs font-medium [writing-mode:vertical-rl]"
						>
							{title}
						</span>
					</button>
				</TooltipTrigger>
				<TooltipContent side="left">Show the details</TooltipContent>
			</Tooltip>
		</div>
	);
}
