/**
 * The desktop side panels' hide and show controls (owner, 2026-09-25): the
 * Outline (xl) hides from its header and comes back from a slim rail at the
 * left edge; the map hides from a button on the map and comes back from a
 * rail at the right edge. Both are personal layout (`useShell`, remembered
 * on this device, never followed), with ⌘\ and ⌘⇧\ as shortcuts.
 */
import { cn } from "cn";
import {
	PanelLeftClose,
	PanelLeftOpen,
	PanelRightClose,
	PanelRightOpen,
} from "lucide-react";
import type { ReactNode } from "react";
import { Kbd } from "@/components/common/glyphs";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { MOD, SHIFT } from "./ShortcutsDialog";
import { useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";

/** The label and its shortcut, in the tooltip. */
function Tip({
	label,
	keys,
	side,
	children,
}: {
	label: string;
	keys: string[];
	side: "left" | "right" | "bottom";
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent side={side} className="flex items-center gap-2">
				{label}
				<span className="flex items-center gap-0.5">
					{keys.map((k) => (
						<Kbd key={k}>{k}</Kbd>
					))}
				</span>
			</TooltipContent>
		</Tooltip>
	);
}

/** "Hide the outline", in the Outline's header. */
export function OutlineHideButton() {
	const toggle = useShell((s) => s.toggleOutline);
	return (
		<Tip label="Hide the outline" keys={[MOD, "\\"]} side="bottom">
			<Button
				variant="ghost"
				size="icon"
				className="size-7"
				aria-label="Hide the outline"
				data-testid={SHELL_TESTID.outlineHide}
				onClick={toggle}
			>
				<PanelLeftClose className="size-4" />
			</Button>
		</Tip>
	);
}

/** A slim rail at a panel's edge while it's hidden: one button brings it back. */
function Rail({
	side,
	label,
	word,
	icon,
	keys,
	onShow,
	testId,
	buttonTestId,
}: {
	side: "left" | "right";
	label: string;
	word: string;
	icon: ReactNode;
	keys: string[];
	onShow: () => void;
	testId: string;
	buttonTestId: string;
}) {
	return (
		<div
			data-testid={testId}
			className={cn(
				"flex w-10 shrink-0 flex-col items-center py-1.5",
				side === "left"
					? "border-r bg-sidebar text-sidebar-foreground"
					: "border-l bg-background",
			)}
		>
			<Tip label={label} keys={keys} side={side === "left" ? "right" : "left"}>
				<button
					type="button"
					aria-label={label}
					data-testid={buttonTestId}
					onClick={onShow}
					className="flex flex-col items-center gap-2 rounded-md px-1.5 py-2 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				>
					{icon}
					<span
						aria-hidden
						className="text-[11px] font-semibold tracking-[.06em] uppercase [writing-mode:vertical-rl]"
					>
						{word}
					</span>
				</button>
			</Tip>
		</div>
	);
}

/** xl, the Outline hidden: its rail at the left edge. */
export function OutlineRail() {
	const toggle = useShell((s) => s.toggleOutline);
	return (
		<Rail
			side="left"
			label="Show the outline"
			word="Outline"
			icon={<PanelLeftOpen className="size-4" />}
			keys={[MOD, "\\"]}
			onShow={toggle}
			testId={SHELL_TESTID.outlineRail}
			buttonTestId={SHELL_TESTID.outlineShow}
		/>
	);
}

/** The map hidden: its rail at the right edge. */
export function MapRail() {
	const toggle = useShell((s) => s.toggleMap);
	return (
		<Rail
			side="right"
			label="Show the map"
			word="Map"
			icon={<PanelRightOpen className="size-4" />}
			keys={[MOD, SHIFT, "\\"]}
			onShow={toggle}
			testId={SHELL_TESTID.mapRail}
			buttonTestId={SHELL_TESTID.mapShow}
		/>
	);
}

/** "Hide the map", in the map's top-left corner (next to the centre panel). */
export function MapHideButton() {
	const toggle = useShell((s) => s.toggleMap);
	return (
		<Tip label="Hide the map" keys={[MOD, SHIFT, "\\"]} side="right">
			<button
				type="button"
				aria-label="Hide the map"
				data-testid={SHELL_TESTID.mapHide}
				onClick={toggle}
				className="absolute top-3 left-3 z-20 grid size-8 place-items-center rounded-[10px] bg-card text-foreground shadow-float outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
			>
				<PanelRightClose className="size-4" strokeWidth={1.75} />
			</button>
		</Tip>
	);
}
