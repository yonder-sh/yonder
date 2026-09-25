/**
 * DESIGN §6 mobile (< 768): full-bleed map, frosted floating pills, a
 * horizontally scrollable lens control (and under it the what-if chip while a
 * date draft is set), a vaul bottom sheet (peek 120px with day chips +
 * Now/Next, or "Where to first?" for a trip with no days; half and 92% with
 * the tabs; a selection or a `?tab=` link opens it at half, the Overview at
 * 92%), the inspector as a drawer over it, and the (+) FAB.
 */
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
	ChevronDown,
	ChevronLeft,
	MapPin,
	MoreHorizontal,
	Plane,
	Plus,
	Wallet,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useState } from "react";
import { Drawer as Vaul } from "vaul";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { YonderMark } from "@/components/common/yonder-mark";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WhatIfChip } from "@/features/insights/WhatIfChip";
import { OfflineBanner } from "@/features/offline/OfflineBanner";
import { Outline } from "@/features/outline/Outline";
import { DayChips } from "@/features/plan/DayChips";
import { NowNext } from "@/features/plan/NowNext";
import {
	SuggestModeControl,
	SuggestModeMenuItem,
} from "@/features/suggest/SuggestModeControl";
import { mustRedact } from "@/lib/auth/roles";
import { signOut } from "@/lib/auth/sign-out";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { quickExpenseTarget } from "./bundle-target";
import { CenterTabBar, CenterTabContent, SuggestRule } from "./CenterPanel";
import { ConnectionPill } from "./ConnectionPill";
import {
	ElsewhereChips,
	FollowersBadge,
	SpotlightBar,
	SpotlightMenuItem,
} from "./cursors/presence-ui";
import { FollowBar } from "./FollowBar";
import { InboxBell } from "./InboxBell";
import { InspectorBody } from "./InspectorBody";
import { LensControl } from "./LensControl";
import { MapRegion } from "./MapRegion";
import { PresenceAvatars } from "./PresenceAvatars";
import { PlacesDetailsOr } from "./places-details";
import { RateMenuItem } from "./rate-entry";
import { useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";

const SNAPS: (string | number)[] = ["120px", 0.5, 0.92];

/**
 * Short landscape screens (an iPhone SE on its side, 200% zoom on a laptop:
 * 640×360 CSS px; A11Y-04 / MOB-09): the map's control column (top 124px,
 * 3 × 44px) runs past the 120px peek, and the FAB sat on top of it. There the
 * sheet leaves a right rail free (`SHORT_SHEET`) and the FAB drops to the
 * rail's foot, under the controls (`SHORT_FAB`), so every map control stays
 * reachable. Taller screens keep the full-width sheet.
 */
// Full literals: Tailwind only generates classes it finds spelled out.
const SHORT_SHEET = "[@media(max-height:480px)]:right-[72px]";
const SHORT_FAB =
	"[@media(max-height:480px)]:right-1.5 [@media(max-height:480px)]:bottom-[max(12px,env(safe-area-inset-bottom))]";
/**
 * The what-if chip is 28px tall (it is the TopBar's): on a phone each of its
 * buttons gets an invisible hit area of at least 44×44 (MOB-07).
 */
const WHAT_IF_TOUCH =
	"[&_button]:relative [&_button]:before:absolute [&_button]:before:-inset-x-2.5 [&_button]:before:-inset-y-3.5";
/** 44px pills: every control in them is a 44×44 touch target (DESIGN §6, MOB-07). */
const PILL =
	"pointer-events-auto flex h-11 items-center rounded-full bg-background/92 shadow-float backdrop-blur-md";

function MobilePills() {
	const { scope, graph, nav, mode, search } = useWorkspace();
	const [outlineOpen, setOutlineOpen] = useState(false);
	// The Outline drawer closes when a tap in it navigates (a new scope or
	// selection), not on every click: chevrons, the filter, ⋯ menus and inline
	// rename all live inside it (WP-Outline CONTRACT_REQUESTS).
	const navKey = `${scope?.id ?? ""}|${search.sel ?? ""}|${search.days ?? ""}`;
	const [lastNav, setLastNav] = useState(navKey);
	if (lastNav !== navKey) {
		setLastNav(navKey);
		if (outlineOpen) setOutlineOpen(false);
	}
	const setShareOpen = useUi((s) => s.setShareOpen);
	const setSettingsOpen = useUi((s) => s.setSettingsOpen);
	const setProfileOpen = useUi((s) => s.setProfileOpen);
	const openShiftTrip = useUi((s) => s.openShiftTrip);
	const setViewSettingsOpen = useShell((s) => s.setViewSettingsOpen);
	return (
		<div
			data-testid={TESTID.mobilePills}
			className="pointer-events-none absolute inset-x-0 top-0 z-40 grid gap-2 px-3 pt-[max(env(safe-area-inset-top),12px)]"
		>
			<div className="flex items-center justify-between gap-2">
				<div className={`${PILL} min-w-0 pr-3`}>
					{/* Home to your trips, as on the desktop top bar. */}
					<Link
						to="/"
						aria-label="Your trips"
						className="flex size-11 shrink-0 items-center justify-center rounded-full text-primary"
					>
						<YonderMark className="size-5" />
					</Link>
					{/* Inside a place: one level up (Tokyo → Japan → the trip). */}
					{scope ? (
						<button
							type="button"
							onClick={() => nav.zoomOut()}
							aria-label="Zoom out"
							className="-ml-1 flex size-11 shrink-0 items-center justify-center"
						>
							<ChevronLeft className="size-5 text-muted-foreground" />
						</button>
					) : null}
					<button
						type="button"
						onClick={() => setOutlineOpen(true)}
						className="flex h-11 min-w-0 items-center gap-1 font-semibold"
					>
						<span className="truncate">{scope?.name ?? graph.trip.name}</span>
						<ChevronDown className="size-4 shrink-0 text-muted-foreground" />
					</button>
				</div>
				<div className={`${PILL} shrink-0 gap-0.5 px-0.5`}>
					<SuggestModeControl />
					<InboxBell className="size-11 rounded-full" />
					<ConnectionPill compact />
					{mode === "live" ? (
						// FB-17a: "Audrey is following you" on the presence cluster (no own avatar here).
						<span className="relative inline-flex">
							<PresenceAvatars max={2} size={20} />
							<FollowersBadge className="-bottom-0.5 -left-0.5" />
						</span>
					) : null}
					<DropdownMenu>
						<DropdownMenuTrigger
							aria-label="More"
							// FB-25: the trip menu, as on the desktop top bar.
							data-cursor-anchor="pane:tripmenu"
							className="flex size-11 items-center justify-center rounded-full"
						>
							<MoreHorizontal className="size-5" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onSelect={() => setShareOpen(true)}>
								Share
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
								Trip settings
							</DropdownMenuItem>
							{graph.trip.startDate ? (
								<DropdownMenuItem onSelect={() => openShiftTrip(true)}>
									Try other dates…
								</DropdownMenuItem>
							) : null}
							<SuggestModeMenuItem />
							{/* FB-05: the Rate screen (the top bar's "Rate" on larger screens). */}
							<RateMenuItem />
							{/* FB-17b: Spotlight. */}
							<SpotlightMenuItem />
							<DropdownMenuItem
								onSelect={() => setViewSettingsOpen(true)}
								data-testid={SHELL_TESTID.viewSettingsButton}
							>
								View settings…
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={() => setProfileOpen(true)}>
								Profile
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => void signOut()}>
								Sign out
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			<div className="pointer-events-auto flex justify-center">
				<LensControl
					scrollable
					className="bg-background/92 shadow-float backdrop-blur-md"
				/>
			</div>
			{/* FB-17b: "Following Dennis · Stop" (and the presenter's own bar) on phones
			    too; it leaves the map's control column on the right free. */}
			<div className="pointer-events-auto mr-14 overflow-hidden rounded-full shadow-float empty:hidden [&>*]:h-9">
				<FollowBar />
				<SpotlightBar />
			</div>
			{/* FB-17a: where the others are ("Audrey · in Kyoto"). */}
			{mode === "live" ? <ElsewhereChips /> : null}
			{/* COLLAB-R3-03: while a what-if draft is set, its chip (Review · ✕)
			    shows here, as it does after the trip title in the desktop TopBar. */}
			<div
				data-testid={SHELL_TESTID.mobileWhatIf}
				className={cn(
					"pointer-events-auto mx-auto w-fit rounded-full bg-background/92 shadow-float backdrop-blur-md empty:hidden",
					WHAT_IF_TOUCH,
				)}
			>
				<WhatIfChip />
			</div>
			<Vaul.Root open={outlineOpen} onOpenChange={setOutlineOpen}>
				<Vaul.Portal>
					<Vaul.Overlay className="fixed inset-0 z-50 bg-black/40" />
					<Vaul.Content className="fixed inset-x-0 bottom-0 z-50 flex h-[92svh] flex-col rounded-t-2xl bg-sidebar">
						<Vaul.Title className="px-4 pt-4 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
							Outline
						</Vaul.Title>
						<div className="min-h-0 flex-1 overflow-y-auto">
							<Outline />
						</div>
					</Vaul.Content>
				</Vaul.Portal>
			</Vaul.Root>
		</div>
	);
}

/** Room the floating pills (44) + lens control (46) take at the top of the map. */
const PILLS_H = 120;

function MobileSheet() {
	const snap = useUi((s) => s.sheetSnap);
	const setSnap = useUi((s) => s.setSheetSnap);
	const setMapPadding = useUi((s) => s.setMapPadding);
	const { sel, tab } = useWorkspace();
	useEffect(() => {
		if (snap === null) setSnap(SNAPS[0] ?? null);
	}, [snap, setSnap]);
	// DESIGN §6: selecting a pin or edge brings the sheet to half (the inspector
	// opens over it as a nested drawer).
	const selKey = sel ? JSON.stringify(sel) : null;
	useEffect(() => {
		if (selKey && useUi.getState().sheetSnap === SNAPS[0])
			setSnap(SNAPS[1] ?? null);
	}, [selKey, setSnap]);
	// VIS3-03 (UX-04): a link that names a tab (`?tab=lists`, money, media,
	// notes) opens at half as well, so the tab it names is on screen. Only a
	// change of tab does it: dragging back down to the peek stays there.
	const tabKey = tab === "plan" ? null : tab;
	useEffect(() => {
		if (!tabKey) return;
		// docs/OVERVIEW.md: the Overview is a page of its own (the phone mocks):
		// it opens full height; drag it down for the map.
		if (tabKey === "overview") {
			if (useUi.getState().sheetSnap !== SNAPS[2]) setSnap(SNAPS[2] ?? null);
			return;
		}
		if (useUi.getState().sheetSnap === SNAPS[0]) setSnap(SNAPS[1] ?? null);
	}, [tabKey, setSnap]);
	// The map fits what's visible: below the pills, above the half sheet. One
	// padding for every snap, so dragging the sheet never moves the map.
	useEffect(() => {
		const apply = () =>
			setMapPadding({
				top: PILLS_H,
				right: 16,
				bottom: Math.round(window.innerHeight * 0.5) + 16,
				left: 16,
			});
		apply();
		window.addEventListener("resize", apply);
		return () => window.removeEventListener("resize", apply);
	}, [setMapPadding]);
	// At the 120px peek only the day chips and Now/Next fit: the tab bar would be
	// cut in half at the screen edge, so it (and the tab content) fade in from
	// the half snap up.
	const peek = snap === null || snap === SNAPS[0];
	// The Overview has its own header (the day, today's list): the Plan's day
	// chips and Now/Next only come back at the peek.
	const planChrome = peek || tab !== "overview";
	return (
		<Vaul.Root
			open
			modal={false}
			dismissible={false}
			snapPoints={SNAPS}
			activeSnapPoint={snap}
			setActiveSnapPoint={setSnap}
		>
			{/* vaul 1.1.2 doesn't hand `modal={false}` to Radix, so its Dialog stays
			    modal: the always-open sheet would aria-hide the pills, the FAB and the
			    map and trap focus. A non-modal Radix root closest to the content fixes
			    that (vaul's drag logic reads its own context, not this one). */}
			<DialogPrimitive.Root open modal={false}>
				<Vaul.Portal>
					<Vaul.Content
						data-testid={TESTID.mobileSheet}
						aria-describedby={undefined}
						// vaul computes snap offsets from the window height, so the content is full height;
						// the bottom padding keeps the last rows reachable at the 92% snap.
						className={cn(
							"fixed inset-x-0 bottom-0 z-40 flex h-svh flex-col rounded-t-2xl border-t bg-background pb-[8svh] shadow-float outline-none",
							SHORT_SHEET,
						)}
					>
						<Vaul.Title className="sr-only">Plan</Vaul.Title>
						<div className="mx-auto mt-2 mb-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/30" />
						<SuggestRule />
						{planChrome ? <DayChips /> : null}
						{planChrome ? <NowNext /> : null}
						{peek ? <EmptyPeek /> : null}
						<div
							aria-hidden={peek || undefined}
							inert={peek || undefined}
							className={cn(
								"flex min-h-0 flex-1 flex-col transition-opacity duration-200",
								peek ? "pointer-events-none opacity-0" : "opacity-100",
							)}
						>
							<CenterTabBar touch className="mt-1" />
							<CenterTabContent whereChips={false} phone />
						</div>
					</Vaul.Content>
				</Vaul.Portal>
			</DialogPrimitive.Root>
		</Vaul.Root>
	);
}

/**
 * VIS3-09 (EMPTY-02): a trip with no days has no day chips and no Now/Next,
 * so the peek says what to do first, as the desktop Plan does: "Where to
 * first?" with Search places, or (places but no dates) the dates to set. At
 * half the Plan tab says the same, so this row is the peek's only.
 */
function EmptyPeek() {
	const { ix, graph } = useWorkspace();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const setSettingsOpen = useUi((s) => s.setSettingsOpen);
	if (ix.days.length > 0) return null;
	const first = graph.nodes.length === 0;
	return (
		<div
			data-testid={SHELL_TESTID.mobileEmptyPeek}
			className="flex items-center gap-3 px-4 pb-2"
		>
			<p className="min-w-0 flex-1 font-display text-[15px] leading-5 font-medium text-balance">
				{first ? "Where to first?" : "Set the trip dates to plan your days."}
			</p>
			<EditGuard>
				<Button
					size="sm"
					className="h-11 shrink-0 px-4"
					onClick={() =>
						first ? openAddPlace({ mode: "first" }) : setSettingsOpen(true)
					}
				>
					{first ? "Search places" : "Set dates"}
				</Button>
			</EditGuard>
		</div>
	);
}

function MobileInspector() {
	const { sel, nav, tab } = useWorkspace();
	return (
		<Vaul.Root
			open={sel !== null}
			onOpenChange={(open) => !open && nav.select(null)}
		>
			<Vaul.Portal>
				<Vaul.Overlay className="fixed inset-0 z-50 bg-black/30" />
				<Vaul.Content
					data-testid={TESTID.inspector}
					aria-describedby={undefined}
					className="fixed inset-x-0 bottom-0 z-50 flex h-[92svh] flex-col rounded-t-2xl bg-card outline-none"
				>
					<Vaul.Title className="sr-only">Details</Vaul.Title>
					<div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/30" />
					{/* docs/PLACES.md §2: a place picked in the Places tab opens its details. */}
					{tab === "places" ? (
						<PlacesDetailsOr onClose={() => nav.select(null)} />
					) : (
						<InspectorBody onClose={() => nav.select(null)} />
					)}
				</Vaul.Content>
			</Vaul.Portal>
		</Vaul.Root>
	);
}

/** DESIGN §6 (+): a 56px primary FAB opening Place · Flight · Expense (EXTENSIONS §1.4). */
function Fab() {
	const ws = useWorkspace();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const openAddFlight = useUi((s) => s.openAddFlight);
	const openAddExpense = useUi((s) => s.openAddExpense);
	const guard = useEditGuard();
	const guest = mustRedact(ws.graph.me);
	const dayId = ws.sel?.kind === "day" ? ws.sel.id : undefined;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				data-testid={TESTID.fab}
				aria-label="Add"
				className={cn(
					"fixed right-4 bottom-[136px] z-40 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-float transition-transform active:scale-95 data-[state=open]:rotate-45",
					SHORT_FAB,
				)}
			>
				<Plus className="size-6" />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				side="top"
				align="end"
				sideOffset={10}
				className="w-48"
				data-testid={SHELL_TESTID.fabMenu}
			>
				<DropdownMenuItem
					className="h-11"
					disabled={guard.disabled}
					onSelect={() => openAddPlace({ mode: "search", dayId })}
					data-testid={SHELL_TESTID.fabPlace}
				>
					<MapPin /> Place
				</DropdownMenuItem>
				<DropdownMenuItem
					className="h-11"
					disabled={guard.disabled}
					onSelect={() => openAddFlight({ dayId })}
				>
					<Plane /> Flight
				</DropdownMenuItem>
				{guest ? null : (
					<DropdownMenuItem
						className="h-11"
						disabled={guard.disabled}
						onSelect={() =>
							openAddExpense({
								target: quickExpenseTarget(ws.ix, ws.sel, ws.scope?.id ?? null),
							})
						}
						data-testid={SHELL_TESTID.fabExpense}
					>
						<Wallet /> Expense
					</DropdownMenuItem>
				)}
				{guard.disabled && guard.reason ? (
					<p className="px-2 py-1.5 text-xs text-muted-foreground">
						{guard.reason}
					</p>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function MobileWorkspace() {
	return (
		<div className="relative h-svh overflow-hidden bg-basemap-land">
			<div className="absolute inset-0">
				<MapRegion variant="mobile" inspector={null} />
			</div>
			<MobilePills />
			<div className="absolute inset-x-3 top-[120px] z-30">
				<OfflineBanner />
			</div>
			<MobileSheet />
			<Fab />
			<MobileInspector />
		</div>
	);
}
