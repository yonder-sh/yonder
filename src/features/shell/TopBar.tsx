/**
 * DESIGN §4.1 top bar (52px; xl, lg and md): mark → dashboard, trip title
 * menu (+ the what-if chip), [Outline popover at lg/md, or at xl while the
 * Outline is collapsed], breadcrumb, lens control, then connection · inbox
 * bell · presence · suggest mode · Rate (FB-05) · Share · ⌘K · account.
 *
 * Tablet widths never scroll sideways: at lg and md the breadcrumb shows only
 * the current place (min-width kept), the trip name is shorter, the ⌘K hint
 * goes (the button stays), and at md the lens becomes a dropdown.
 */
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
	CalendarRange,
	ChevronDown,
	Keyboard,
	Search,
	Settings,
	Share2,
	SlidersHorizontal,
	SquareArrowLeft,
} from "lucide-react";
import { Kbd } from "@/components/common/glyphs";
import { YonderMark } from "@/components/common/yonder-mark";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AccountMenu } from "@/features/home/AccountMenu";
import { WhatIfChip } from "@/features/insights/WhatIfChip";
import { OutlinePopover } from "@/features/outline/OutlinePopover";
import { MuteTripMenuItem } from "@/features/push/MuteTripMenuItem";
import {
	SuggestModeControl,
	SuggestModeMenuItem,
} from "@/features/suggest/SuggestModeControl";
import { WelcomeMenuItem } from "@/features/welcome/WelcomeDialog";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { ConnectionPill } from "./ConnectionPill";
import { FollowersBadge, SpotlightMenuItem } from "./cursors/presence-ui";
import { InboxBell } from "./InboxBell";
import { LensControl } from "./LensControl";
import { PresenceAvatars } from "./PresenceAvatars";
import { RateButton, RateMenuItem } from "./rate-entry";
import { ScopeBreadcrumb } from "./ScopeBreadcrumb";
import { useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";
import type { Breakpoint } from "./use-breakpoint";

/** The trip-title ▾ menu (DESIGN §4.1 + EXTENSIONS §1.4 "Try other dates…"). */
export function TripMenuItems() {
	const setShareOpen = useUi((s) => s.setShareOpen);
	const setSettingsOpen = useUi((s) => s.setSettingsOpen);
	const openShiftTrip = useUi((s) => s.openShiftTrip);
	const setViewSettingsOpen = useShell((s) => s.setViewSettingsOpen);
	const setShortcutsOpen = useShell((s) => s.setShortcutsOpen);
	const { graph } = useWorkspace();
	return (
		<>
			<DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
				<Settings /> Trip settings
			</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => setShareOpen(true)}>
				<Share2 /> Share
			</DropdownMenuItem>
			{graph.trip.startDate ? (
				<DropdownMenuItem
					onSelect={() => openShiftTrip(true)}
					data-testid={SHELL_TESTID.tryOtherDates}
				>
					<CalendarRange /> Try other dates…
				</DropdownMenuItem>
			) : null}
			{/* WP-Suggest M6: the way into suggest mode for an editor with nothing to review. */}
			<SuggestModeMenuItem />
			{/* FB-05: the Rate screen, from the menu too. */}
			<RateMenuItem />
			{/* FB-17b: Spotlight, "Ask everyone to follow me". */}
			<SpotlightMenuItem />
			{/* Web Push: this trip's notifications off for me. */}
			<MuteTripMenuItem />
			<DropdownMenuSeparator />
			<DropdownMenuItem
				onSelect={() => setViewSettingsOpen(true)}
				data-testid={SHELL_TESTID.viewSettingsButton}
			>
				<SlidersHorizontal /> View settings…
			</DropdownMenuItem>
			<DropdownMenuItem onSelect={() => setShortcutsOpen(true)}>
				<Keyboard /> Keyboard shortcuts
				<DropdownMenuShortcut>?</DropdownMenuShortcut>
			</DropdownMenuItem>
			<WelcomeMenuItem />
			<DropdownMenuSeparator />
			<DropdownMenuItem asChild>
				<Link to="/dashboard">
					<SquareArrowLeft /> Back to dashboard
				</Link>
			</DropdownMenuItem>
		</>
	);
}

export function TopBar({ bp }: { bp: Breakpoint }) {
	const { graph, mode } = useWorkspace();
	const setShareOpen = useUi((s) => s.setShareOpen);
	const openAddPlace = useUi((s) => s.openAddPlace);
	const outlineCollapsed = useShell((s) => s.outlineCollapsed);
	const tablet = bp === "md" || bp === "lg";
	return (
		<header
			data-testid={TESTID.topBar}
			className={cn(
				"flex h-[var(--topbar-h)] min-w-0 shrink-0 items-center border-b bg-background px-3",
				tablet ? "gap-2" : "gap-3",
			)}
		>
			<Link
				to="/dashboard"
				aria-label="Your trips"
				className="rounded-md p-1 text-primary hover:bg-accent"
			>
				<YonderMark className="size-5" />
			</Link>
			<DropdownMenu>
				<DropdownMenuTrigger
					data-testid={TESTID.tripMenu}
					// FB-25: others see this menu (anchored here) when it is open.
					data-cursor-anchor="pane:tripmenu"
					className={cn(
						"flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[17px] leading-6 font-semibold hover:bg-accent",
						bp === "md" ? "max-w-32" : bp === "lg" ? "max-w-44" : "max-w-56",
					)}
				>
					<span className="truncate">{graph.trip.name}</span>
					<ChevronDown className="size-4 shrink-0 text-muted-foreground" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-56">
					<TripMenuItems />
				</DropdownMenuContent>
			</DropdownMenu>
			{/* The what-if chip (E2) shrinks before the top bar ever scrolls sideways. */}
			<div
				className={cn(
					"flex min-w-0 shrink items-center overflow-hidden empty:hidden",
					tablet && "max-w-44",
				)}
			>
				<WhatIfChip />
			</div>
			{bp !== "xl" || outlineCollapsed ? <OutlinePopover /> : null}
			<ScopeBreadcrumb
				className={cn("flex-1", tablet ? "min-w-20" : "min-w-0")}
				compact={tablet}
			/>
			<LensControl compact={bp === "md"} />
			<div
				className={cn(
					"ml-auto flex shrink-0 items-center",
					tablet ? "gap-1.5" : "gap-2.5",
				)}
			>
				<ConnectionPill compact={bp === "md"} />
				<InboxBell />
				{mode === "live" ? <PresenceAvatars max={bp === "md" ? 2 : 3} /> : null}
				<SuggestModeControl compact={bp === "md"} />
				{/* FB-05: the Rate screen, one click from anywhere in the workspace. */}
				<RateButton compact={bp === "md"} />
				<Button
					variant="outline"
					size="sm"
					onClick={() => setShareOpen(true)}
					data-testid={TESTID.shareButton}
				>
					<Share2 />{" "}
					<span className={bp === "md" ? "sr-only" : undefined}>Share</span>
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => openAddPlace({ mode: "search" })}
					data-testid={TESTID.commandButton}
					aria-label="Search, add or jump"
				>
					<Search />
					{tablet ? null : <Kbd>⌘K</Kbd>}
				</Button>
				{/* FB-17a: "Audrey is following you" sits on my own avatar. */}
				<span className="relative inline-flex">
					<AccountMenu />
					{mode === "live" ? <FollowersBadge /> : null}
				</span>
			</div>
		</header>
	);
}
