/**
 * DESIGN §4.3 centre panel: tab bar (Overview · Plan · Places · Media 42 ·
 * Lists 17 · Notes · Money), the rollup toggle under Media/Lists/Notes (only when the scope has
 * something inside it, FB-12), and the tab content from
 * each owning package (OverviewTab, PlanTab, MediaTab, ListsTab, NotesTab,
 * MoneyTab). The tab lives in the URL (`tab`), so it deep-links and survives
 * reloads; a bare trip link opens the Overview (docs/OVERVIEW.md).
 *
 * - Counts are summed over the rollup targets (`scope-counts.ts`, SPEC §8.4).
 * - The Plan tab opens with the one-line digest (EXTENSIONS §9).
 * - Suggest mode (E7, EXTENSIONS §3.7): a 2px primary/40 rule on top of the
 *   panel and "Suggesting — your changes need approval" (dashed stays for
 *   proposals and estimates only).
 * - Money is never rendered for link guests; it is read-only for viewers
 *   (the MoneyTab's own guard).
 */
import { cn } from "cn";
import { useEffect, useMemo, useRef } from "react";
import { RollupToggle } from "@/components/common/rollup-toggle";
import { ListsTab } from "@/features/lists/ListsTab";
import { useListsOverdue } from "@/features/lists/use-lists-overdue";
import { MediaTab } from "@/features/media/MediaTab";
import { MoneyTab } from "@/features/money/MoneyTab";
import { NotesTab } from "@/features/notes/NotesTab";
import { OverviewTab } from "@/features/overview/OverviewTab";
import { PlacesTab } from "@/features/places/tab/PlacesTab";
import { ReminderLine } from "@/features/places/tab/ReminderLine";
import { usePlacesToDecide } from "@/features/places/tab/use-places";
import { PlanTab } from "@/features/plan/PlanTab";
import { mustRedact } from "@/lib/auth/roles";
import { TESTID } from "@/lib/testids";
import type { Tab } from "@/lib/workspace/search";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { hasChildNodes } from "./bundle-target";
import { ElsewhereChips } from "./cursors/presence-ui";
import { DigestBanner } from "./DigestBanner";
import { scopeCounts } from "./scope-counts";
import { SHELL_TESTID } from "./testids";

const TAB_LABEL: Record<Tab, string> = {
	overview: "Overview",
	plan: "Plan",
	places: "Places",
	media: "Media",
	lists: "Lists",
	notes: "Notes",
	money: "Money",
};

/** The tabs this viewer gets: guests never see money (EXTENSIONS §1.4). */
export function visibleTabs(me: {
	role: Parameters<typeof mustRedact>[0]["role"];
	isGuest: boolean;
}): Tab[] {
	const all = Object.keys(TAB_LABEL) as Tab[];
	return mustRedact(me) ? all.filter((t) => t !== "money") : all;
}

export function CenterTabBar({
	className,
	touch = false,
}: {
	className?: string;
	/** Phone sheet (MOB-07): a 44px bar and tabs at least 44px wide. */
	touch?: boolean;
}) {
	const ws = useWorkspace();
	const { counts: c, ix, scope, only, lens, days, model } = ws;
	const counts = useMemo(
		() => scopeCounts({ counts: c, ix, scope, only, lens, days, model }),
		[c, ix, scope, only, lens, days, model],
	);
	// docs/PLACES.md §1: the places in scope still to decide.
	const toDecide = usePlacesToDecide();
	const count: Record<Tab, number | null> = {
		overview: null,
		plan: null,
		places: null,
		media: counts.media || null,
		lists: counts.lists || null,
		notes: null,
		money: null,
	};
	// EXTENSIONS §7: overdue to-dos (or windows open > 72 h) in scope.
	const listsOverdue = useListsOverdue();
	const tabs = visibleTabs(ws.graph.me);
	// A guest's URL may still say `tab=money`: show the plan instead.
	const active = tabs.includes(ws.tab) ? ws.tab : "plan";
	// A narrow bar scrolls sideways: keep the selected tab in view (a `?tab=money`
	// link on a phone, past the Overview and Plan).
	const bar = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const b = bar.current;
		const el = b?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
		if (!b || !el) return;
		const left = el.offsetLeft;
		const right = left + el.offsetWidth;
		if (left < b.scrollLeft) b.scrollLeft = Math.max(0, left - 16);
		else if (right > b.scrollLeft + b.clientWidth)
			b.scrollLeft = right - b.clientWidth + 16;
	}, [active]);
	return (
		<div
			ref={bar}
			role="tablist"
			aria-label="Views"
			data-testid={TESTID.centerTabs}
			className={cn(
				"relative flex h-[var(--tabbar-h)] shrink-0 items-end gap-4 overflow-x-auto border-b px-4 [scrollbar-width:none]",
				// 44px tabs inside the 1px bottom border. Sideways only: a vertical
				// drag moves the sheet (like the day chips), never wobbles the bar.
				touch &&
					"h-[45px] touch-pan-x gap-2 overflow-y-hidden overscroll-x-contain",
				className,
			)}
		>
			{tabs.map((t) => {
				const selected = active === t;
				return (
					<button
						key={t}
						type="button"
						role="tab"
						aria-selected={selected}
						data-tab={t}
						data-cursor-anchor={`tab:${t}`}
						data-cursor-vis={t === "money" ? "members" : undefined}
						onClick={() => ws.nav.setTab(t)}
						className={cn(
							"-mb-px flex h-full shrink-0 items-center gap-1.5 border-b-2 text-sm font-medium transition-colors",
							touch && "min-w-11 justify-center px-1",
							selected
								? "border-foreground text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground",
						)}
					>
						{TAB_LABEL[t]}
						{t === "places" && toDecide ? (
							<span
								className="rounded-full bg-warning-wash px-1.5 font-mono text-[11px] font-normal text-warning tnum"
								title={`${toDecide} ${toDecide === 1 ? "place" : "places"} to decide`}
								data-testid={SHELL_TESTID.placesToDecide}
							>
								{toDecide}
								<span className={touch ? "sr-only" : undefined}>
									{" "}
									to decide
								</span>
							</span>
						) : null}
						{count[t] ? (
							<span className="font-mono text-xs font-normal text-muted-foreground tnum">
								{count[t]}
							</span>
						) : null}
						{t === "lists" && listsOverdue ? (
							<span
								role="img"
								aria-label="overdue to-dos"
								className="size-1.5 rounded-full bg-warning"
							/>
						) : null}
						{t === "notes" && counts.notes ? (
							<span
								role="img"
								aria-label="has notes"
								className="size-1.5 rounded-full bg-muted-foreground/60"
							/>
						) : null}
					</button>
				);
			})}
		</div>
	);
}

/**
 * FB-12: a scope with nothing inside (an empty area or city, a trip with no
 * places yet) offers no "Everything inside / Only …" choice. A link that
 * still says `only` there shows everything instead, since nothing on screen
 * could switch it back (`nav.setOnly` replaces the history entry).
 */
function useRollupChoice(): boolean {
	const { ix, scope, only, nav } = useWorkspace();
	const choice = hasChildNodes(ix, scope?.id ?? null);
	useEffect(() => {
		if (!choice && only) nav.setOnly(false);
	}, [choice, only, nav]);
	return choice;
}

export function CenterTabContent({
	whereChips = true,
	phone = false,
}: {
	/** FB-17a "where are they" chips at the panel's foot (phones show them with the pills). */
	whereChips?: boolean;
	/** The phone's sheet (the Places tab lays out for it). */
	phone?: boolean;
} = {}) {
	const { tab, graph, mode } = useWorkspace();
	const active = visibleTabs(graph.me).includes(tab) ? tab : "plan";
	const rollupChoice = useRollupChoice();
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* "Dennis reminded you to rate 12 places", on every tab. */}
			{mode === "live" ? <ReminderLine /> : null}
			{active === "plan" ? <DigestBanner /> : null}
			{active !== "overview" &&
			active !== "plan" &&
			active !== "money" &&
			active !== "places" &&
			rollupChoice ? (
				<div className="flex h-8 shrink-0 items-center px-4 pt-2">
					<RollupToggle />
				</div>
			) : null}
			{/* FB-17: the whole scrolled tab is a cursor anchor (fractions of its
			    content), so a cursor between cards still lands in the same place. */}
			<div
				role="tabpanel"
				className={cn(
					"min-h-0 flex-1",
					// The Places tab scrolls inside its own views (the table sideways too).
					active === "places"
						? "flex flex-col overflow-hidden"
						: "overflow-y-auto",
				)}
				data-cursor-anchor={`pane:${active}`}
				data-cursor-scroll=""
				data-cursor-vis={active === "money" ? "members" : undefined}
			>
				{active === "overview" ? <OverviewTab phone={phone} /> : null}
				{active === "plan" ? <PlanTab /> : null}
				{active === "places" ? <PlacesTab phone={phone} /> : null}
				{active === "media" ? <MediaTab /> : null}
				{active === "lists" ? <ListsTab /> : null}
				{active === "notes" ? <NotesTab /> : null}
				{active === "money" ? <MoneyTab /> : null}
			</div>
			{/* FB-17a: where the others are when they aren't on this screen (a
			    quiet strip at the foot: it never covers the content). */}
			{mode === "live" && whereChips ? (
				<ElsewhereChips strip className="shrink-0 border-t px-3 py-1" />
			) : null}
		</div>
	);
}

/** E7 suggest-mode chrome: a primary/40 rule and the one-line reminder. */
export function SuggestRule() {
	const { access } = useWorkspace();
	if (access.mode !== "suggest") return null;
	return (
		<div
			data-testid={SHELL_TESTID.suggestRule}
			className="shrink-0 border-t-2 border-primary/40 bg-primary/5 px-4 py-1 text-xs text-primary"
		>
			Suggesting — your changes need approval
		</div>
	);
}

export function CenterPanel({ className }: { className?: string }) {
	return (
		<section
			aria-label="Overview, plan, places, media, lists, notes and money"
			data-testid={TESTID.centerPanel}
			className={cn("flex h-full min-h-0 flex-col bg-background", className)}
		>
			<SuggestRule />
			<CenterTabBar />
			<CenterTabContent />
		</section>
	);
}
