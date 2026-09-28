/**
 * DESIGN §6 mobile (< 768), One Yonder (P09–P12): a header (home, Where, the
 * map button, the inbox, who's here and the trip menu), the tab's page at
 * full height, and a bottom tab bar (Overview · Plan · Places · Lists ·
 * Money). The map is a button, not the ground: "Map" swaps the page for it,
 * "List" swaps back. The details open as a sheet over either; the (+) sits
 * above the tab bar.
 *
 * Which of the two you look at is `sheetSnap` (the pre-One Yonder sheet's
 * name, kept for the follow and cursor code that reads it): its first snap
 * is the map, anything else the page.
 */
import { Link } from "@tanstack/react-router";
import {
	CalendarDays,
	Compass,
	List as ListIcon,
	ListTodo,
	Map as MapIcon,
	MapPin,
	MoreHorizontal,
	Plane,
	Plus,
	Wallet,
} from "lucide-react";
import { type ComponentType, useEffect, useState } from "react";
import { Drawer as Vaul } from "vaul";
import { useEditGuard } from "@/components/common/edit-guard";
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
import { useListsOverdue } from "@/features/lists/use-lists-overdue";
import { OfflineBanner } from "@/features/offline/OfflineBanner";
import { RatePill } from "@/features/places/tab/RatePill";
import { usePlacesToDecide } from "@/features/places/tab/use-places";
import { FillDay } from "@/features/plan/FillDay";
import { NowNext } from "@/features/plan/NowNext";
import { MuteTripMenuItem } from "@/features/push/MuteTripMenuItem";
import { NotificationsDialog } from "@/features/push/NotificationsDialog";
import { PUSH_TESTID } from "@/features/push/testids";
import { useHasAccount } from "@/features/push/use-push";
import {
	SuggestModeControl,
	SuggestModeMenuItem,
} from "@/features/suggest/SuggestModeControl";
import { WelcomeMenuItem } from "@/features/welcome/WelcomeDialog";
import { mustRedact } from "@/lib/auth/roles";
import { signOut } from "@/lib/auth/sign-out";
import { useFollowedStore } from "@/lib/realtime/view-ui";
import { TESTID } from "@/lib/testids";
import { cn } from "@/lib/utils";
import type { Tab } from "@/lib/workspace/search";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { quickExpenseTarget } from "./bundle-target";
import { CenterTabContent, SuggestRule, visibleTabs } from "./CenterPanel";
import { ConnectionPill } from "./ConnectionPill";
import {
	ElsewhereChips,
	FollowersBadge,
	SpotlightBar,
	SpotlightMenuItem,
} from "./cursors/presence-ui";
import { SHEET_SNAPS, snapForFocus } from "./cursors/scroll-rules";
import { FollowBar } from "./FollowBar";
import { useFollowPause } from "./follow-pause";
import { InboxBell } from "./InboxBell";
import { InspectorBody } from "./InspectorBody";
import { MapRegion } from "./MapRegion";
import { PresenceAvatars } from "./PresenceAvatars";
import { RateMenuItem } from "./rate-entry";
import { useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";
import { WherePicker } from "./WherePicker";

const MAP = SHEET_SNAPS[0];
const PAGE = SHEET_SNAPS[2];

/**
 * The what-if chip is 28px tall (it is the TopBar's): on a phone each of its
 * buttons gets an invisible hit area of at least 44×44 (MOB-07).
 */
const WHAT_IF_TOUCH =
	"[&_button]:relative [&_button]:before:absolute [&_button]:before:-inset-x-2.5 [&_button]:before:-inset-y-3.5";

/** On the map (`sheetSnap` at its first snap) or on the page. */
function useMapOpen(): [boolean, (open: boolean) => void] {
	const snap = useUi((s) => s.sheetSnap);
	const setSnap = useUi((s) => s.setSheetSnap);
	return [snap === MAP, (open) => setSnap(open ? MAP : PAGE)];
}

function MobileHeader() {
	const { graph, mode } = useWorkspace();
	const [mapOpen, setMapOpen] = useMapOpen();
	const setShareOpen = useUi((s) => s.setShareOpen);
	const setSettingsOpen = useUi((s) => s.setSettingsOpen);
	const setProfileOpen = useUi((s) => s.setProfileOpen);
	const openShiftTrip = useUi((s) => s.openShiftTrip);
	const setViewSettingsOpen = useShell((s) => s.setViewSettingsOpen);
	// Web Push settings (the desktop has them in the account menu).
	const account = useHasAccount(mode === "live");
	const [notificationsOpen, setNotificationsOpen] = useState(false);
	return (
		<header
			data-testid={TESTID.mobilePills}
			className="relative z-40 shrink-0 border-b bg-background pt-[env(safe-area-inset-top)]"
		>
			<div className="flex h-14 items-center gap-1 px-1.5">
				{/* Home to your trips, as on the desktop top bar. */}
				<Link
					to="/dashboard"
					aria-label="Your trips"
					className="flex size-11 shrink-0 items-center justify-center rounded-full text-primary"
				>
					<YonderMark className="size-5" />
				</Link>
				<WherePicker short className="h-11 min-w-0 flex-1 justify-start" />
				{/* An icon, so Where keeps the width for its name. */}
				<Button
					variant="ghost"
					size="icon"
					data-testid={SHELL_TESTID.mobileMapToggle}
					aria-pressed={mapOpen}
					aria-label={mapOpen ? "Show the list" : "Show the map"}
					onClick={() => {
						// Following: my own switch holds the view until Resume.
						if (useUi.getState().following)
							useFollowPause.getState().pauseSheet();
						setMapOpen(!mapOpen);
					}}
					className="size-11 shrink-0"
				>
					{mapOpen ? (
						<ListIcon className="size-5" />
					) : (
						<MapIcon className="size-5" />
					)}
				</Button>
				<SuggestModeControl />
				<InboxBell className="size-11 rounded-full" />
				<ConnectionPill compact />
				{mode === "live" ? (
					// FB-17a: "Audrey is following you" on the presence cluster.
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
						<MuteTripMenuItem iconless />
						<DropdownMenuItem
							onSelect={() => setViewSettingsOpen(true)}
							data-testid={SHELL_TESTID.viewSettingsButton}
						>
							View settings…
						</DropdownMenuItem>
						<WelcomeMenuItem iconless />
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => setProfileOpen(true)}>
							Profile
						</DropdownMenuItem>
						{account ? (
							<DropdownMenuItem
								onSelect={() => setNotificationsOpen(true)}
								data-testid={PUSH_TESTID.accountItem}
							>
								Notifications
							</DropdownMenuItem>
						) : null}
						<DropdownMenuItem onSelect={() => void signOut()}>
							Sign out
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{/* FB-17b: "Following Dennis · Stop" (and the presenter's own bar). */}
			<div className="overflow-hidden empty:hidden [&>*]:h-9">
				<FollowBar />
				<SpotlightBar />
			</div>
			{/* FB-17a: where the others are ("Audrey · in Kyoto"). */}
			{mode === "live" ? <ElsewhereChips /> : null}
			{/* COLLAB-R3-03: a what-if draft's chip (Review · ✕). */}
			<div
				data-testid={SHELL_TESTID.mobileWhatIf}
				className={cn("mx-auto mb-1 w-fit empty:hidden", WHAT_IF_TOUCH)}
			>
				<WhatIfChip />
			</div>
			{account ? (
				<NotificationsDialog
					open={notificationsOpen}
					onOpenChange={setNotificationsOpen}
				/>
			) : null}
		</header>
	);
}

const TAB_ICON: Record<
	Exclude<Tab, "media" | "notes">,
	ComponentType<{ className?: string }>
> = {
	overview: Compass,
	plan: CalendarDays,
	places: MapPin,
	lists: ListTodo,
	money: Wallet,
};
const TAB_LABEL: Record<Exclude<Tab, "media" | "notes">, string> = {
	overview: "Overview",
	plan: "Plan",
	places: "Places",
	lists: "Lists",
	money: "Money",
};

/** The five tabs at the foot (P09), 56px tall; tapping one shows its page. */
function BottomTabs() {
	const ws = useWorkspace();
	const [, setMapOpen] = useMapOpen();
	const toDecide = usePlacesToDecide();
	const overdue = useListsOverdue();
	const tabs = visibleTabs(ws.graph.me) as Exclude<Tab, "media" | "notes">[];
	return (
		<div
			role="tablist"
			aria-label="Views"
			data-testid={TESTID.centerTabs}
			className="relative z-40 flex shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)]"
		>
			{tabs.map((t) => {
				const Icon = TAB_ICON[t];
				const selected = ws.tab === t;
				return (
					<button
						key={t}
						type="button"
						role="tab"
						aria-selected={selected}
						data-tab={t}
						data-cursor-anchor={`tab:${t}`}
						onClick={() => {
							setMapOpen(false);
							ws.nav.setTab(t);
						}}
						className={cn(
							"relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-2xs font-medium",
							selected ? "text-foreground" : "text-muted-foreground",
						)}
					>
						<span className="relative">
							<Icon className="size-6" />
							{t === "places" && toDecide ? (
								<span
									data-testid={SHELL_TESTID.placesToDecide}
									className="absolute -top-1.5 left-4 min-w-4.5 rounded-full bg-accent px-1 text-center text-2xs font-semibold text-accent-foreground tnum"
								>
									{toDecide}
									<span className="sr-only">
										{" "}
										{toDecide === 1 ? "idea" : "ideas"}
									</span>
								</span>
							) : null}
							{t === "lists" && overdue ? (
								<span
									role="img"
									aria-label="overdue to-dos"
									className="absolute -top-0.5 -right-1 size-2 rounded-full bg-warning"
								/>
							) : null}
						</span>
						{TAB_LABEL[t]}
					</button>
				);
			})}
		</div>
	);
}

function MobileInspector() {
	const { sel, nav } = useWorkspace();
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
					<InspectorBody onClose={() => nav.select(null)} />
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
					"fixed right-4 bottom-[calc(72px+var(--plan-dock-h,0px)+env(safe-area-inset-bottom))] z-40 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-float transition-transform active:scale-95 data-[state=open]:rotate-45",
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
	const { tab, search, days } = useWorkspace();
	const [mapOpen, setMapOpen] = useMapOpen();
	// Lock the page while the trip is open on a phone (see `app-locked`).
	useEffect(() => {
		const root = document.documentElement;
		root.classList.add("app-locked");
		return () => root.classList.remove("app-locked");
	}, []);
	// The page first (the map is a button).
	useEffect(() => {
		if (useUi.getState().sheetSnap === null) setMapOpen(false);
	}, [setMapOpen]);
	// Follow: the leader on their map (or their page) takes mine there too.
	const filling = !!search.fill && !!days && tab === "plan";
	const following = useUi((s) => s.following);
	const focus = useFollowedStore((s) => s.focus);
	const held = useFollowPause((s) => s.sheet);
	useEffect(() => {
		if (!following || !focus || held) return;
		useUi
			.getState()
			.setSheetSnap(
				snapForFocus(focus, useUi.getState().sheetSnap, SHEET_SNAPS),
			);
	}, [following, focus, held]);
	return (
		<div className="relative flex h-svh flex-col overflow-hidden bg-background">
			<MobileHeader />
			<SuggestRule />
			<div className="shrink-0 empty:hidden">
				<OfflineBanner />
			</div>
			{/* One Yonder (P09/P10): the Plan's own stepper and day rows move
			    between days; on the road, what's now and next. */}
			{!mapOpen && tab === "plan" ? (
				<div className="shrink-0 border-b empty:hidden">
					<NowNext underway />
				</div>
			) : null}
			{/* The phone's page: the tab (or the map) and the tab bar. */}
			<div
				data-testid={TESTID.mobileSheet}
				className="flex min-h-0 flex-1 flex-col"
			>
				<main className="relative flex min-h-0 flex-1 flex-col">
					{mapOpen ? (
						<div className="absolute inset-0 bg-basemap-land">
							<MapRegion variant="mobile" />
						</div>
					) : filling ? (
						// D04: the day's ideas take the page ("Show map" or the tabs leave).
						<FillDay />
					) : (
						<CenterTabContent whereChips={false} phone />
					)}
				</main>
				<BottomTabs />
			</div>
			{/* The flow (owner, 2026-09-25): "★ Rate 12" above the tab bar. */}
			<RatePill />
			<Fab />
			<MobileInspector />
		</div>
	);
}
