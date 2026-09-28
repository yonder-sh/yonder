/**
 * The Lists tab (SPEC §12.5 `ListsTab()`, DESIGN §7.3, EXTENSIONS §7):
 * to-dos, bookings, shopping and packing rolled up over the scope (SPEC §8.4;
 * the rollup toggle "Everything inside · Only Tokyo" above is the shell's).
 * One Yonder D12: one list at a time, the switch its tabs (each with its
 * count), under "Lists" and "Add a booking" when wide. At the trip root
 * To-dos open in View = Due: the MAIN list of everything, overdue first. The
 * list is the URL's `list=todo|bookings|shopping|packing` (the inbox
 * deep-links with it).
 */

import { CalendarPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { Segmented } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { oneOf, useFollowValue } from "@/lib/realtime/view-ui";
import type { BundleTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { LISTS_TABS, type ListsTabKey } from "@/lib/workspace/search";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { BookingsBoard } from "./BookingsBoard";
import { ListBoard } from "./ListBoard";
import { type ScopeOptions, tabCounts } from "./list-model";
import { PackingBoard } from "./PackingBoard";
import { useListItems } from "./queries";
import { LISTS_TESTID } from "./testids";

const KIND_KEY = "yonder:lists:kind";
const isTab = oneOf<ListsTabKey>(LISTS_TABS);
/** Wide enough for the page's heading. */
const HEADING_PX = 640;
/** Wide enough for a booking's details beside the list. */
const BESIDE_PX = 880;

const TAB_LABEL: Record<ListsTabKey, string> = {
	todo: "To-dos",
	bookings: "Bookings",
	shopping: "Shopping",
	packing: "Packing",
};

const TAB_TESTID: Record<ListsTabKey, string> = {
	todo: LISTS_TESTID.kindTodo,
	bookings: LISTS_TESTID.kindBookings,
	shopping: LISTS_TESTID.kindShopping,
	packing: LISTS_TESTID.kindPacking,
};

export function ListsTab() {
	const ws = useWorkspace();
	const { graph, scope, only, days, lens, model, search, who, nav } = ws;
	const { items, loading } = useListItems();
	const editGuard = useEditGuard();
	const canAdd = ws.mode === "live" && !editGuard.disabled;
	const root = useRef<HTMLDivElement>(null);
	// 0 narrow, 1 wide enough for the heading, 2 for details beside the list.
	const [size, setSize] = useState(0);
	// "Add a booking" focuses the Bookings add row (a new tick each time).
	const [addTick, setAddTick] = useState(0);
	// The list is in the URL (`list`, so a deep link or the inbox opens the
	// right one); without it, the last one this browser used.
	const [stored, setStored] = useState<ListsTabKey>("todo");
	useEffect(() => {
		try {
			const k = localStorage.getItem(KIND_KEY);
			if (isTab.safeParse(k).success) setStored(k as ListsTabKey);
		} catch {
			// storage blocked
		}
	}, []);
	const kind: ListsTabKey = search.list ?? stored;
	// FB-21d: a follower opens the same list even when it isn't in the URL.
	useFollowValue("lists.kind", kind, setStored, isTab);
	const pickKind = (k: ListsTabKey) => {
		setStored(k);
		try {
			localStorage.setItem(KIND_KEY, k);
		} catch {
			// storage blocked
		}
		if (k !== search.list) nav.setList(k);
	};

	useEffect(() => {
		const el = root.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		// Only the size class re-renders the lists, not every pixel of a resize.
		const ro = new ResizeObserver(([e]) => {
			const w = e?.contentRect.width ?? 0;
			setSize(w >= BESIDE_PX ? 2 : w >= HEADING_PX ? 1 : 0);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const wide = size >= 1;

	const scopeId = scope?.id ?? null;
	const opts = useMemo<ScopeOptions>(
		() => ({
			scopeId,
			lens,
			includeDescendants: !only,
			dayRange: days,
			model,
		}),
		[scopeId, lens, only, days, model],
	);
	const addTarget = useMemo<BundleTarget>(
		() => (scopeId ? { kind: "node", nodeId: scopeId } : { kind: "trip" }),
		[scopeId],
	);
	const where = scope?.name ?? graph.trip.name;
	const counts = useMemo(
		() => tabCounts(ws.ix, items, opts),
		[ws.ix, items, opts],
	);

	const common = {
		items,
		scope: opts,
		addTarget,
		who,
		setWho: nav.setWho,
		where,
		loading,
	};

	const switcher = (
		// Four tabs with counts: a phone scrolls them rather than squeezing them.
		<div className="max-w-full overflow-x-auto">
			<Segmented
				label="Which list"
				value={kind}
				onValueChange={(k) => {
					// Only "Add a booking" lands on the add row.
					setAddTick(0);
					pickKind(k);
				}}
				options={LISTS_TABS.map((k) => ({
					value: k,
					label: TAB_LABEL[k],
					count: counts[k],
					testId: TAB_TESTID[k],
				}))}
			/>
		</div>
	);

	return (
		<div ref={root} data-testid={TESTID.listsTab} className="pb-16">
			{wide ? (
				// D12: on a page of its own, "Lists" and where head it.
				<div className="flex items-center gap-3 px-6 pt-4 pb-1">
					<h2 className="flex min-w-0 items-baseline gap-2">
						<span className="font-display text-2xl leading-8 font-semibold">
							Lists
						</span>
						<span className="truncate text-meta text-muted-foreground">
							{scopeId ? where : "Whole trip"} · shared with everyone
						</span>
					</h2>
					{canAdd ? (
						<Button
							size="sm"
							variant="outline"
							className="ml-auto"
							data-testid={LISTS_TESTID.addBooking}
							onClick={() => {
								pickKind("bookings");
								setAddTick((t) => t + 1);
							}}
						>
							<CalendarPlus /> Add a booking
						</Button>
					) : null}
				</div>
			) : null}
			{/* D12: one list at a time, the switch its tabs, at every width. */}
			{kind === "bookings" ? (
				<BookingsBoard
					{...common}
					headerStart={switcher}
					beside={size === 2}
					focusAdd={addTick}
				/>
			) : kind === "packing" ? (
				<PackingBoard {...common} headerStart={switcher} />
			) : (
				<ListBoard
					key={kind}
					{...common}
					storageScope={scopeId ?? "root"}
					kind={kind}
					headerStart={switcher}
				/>
			)}
		</div>
	);
}
