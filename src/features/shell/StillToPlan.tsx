/**
 * "Still to plan" on the trip overview (ADDENDUM §10): counts that link to a
 * filtered view — nights with no stay, still to book, booking windows opening
 * in the next 14 days, places unrated by each member (each count opens the
 * Rate screen on that person's unrated places, FB-05; "Show on the map" keeps
 * the shared filter), city-to-city moves with no transport, and days per city
 * against the trip's length. Pure numbers come from `still-to-plan.ts`.
 *
 * Calm by design (ADDENDUM §10 "fewer badges"): neutral text and mono counts,
 * no amber (nothing here is a conflict), rows only for what's left to do.
 */
import { cn } from "cn";
import {
	ArrowLeftRight,
	BedDouble,
	CalendarClock,
	ChevronRight,
	Star,
	Table2,
	Ticket,
} from "lucide-react";
import {
	type MouseEvent,
	type ReactNode,
	useCallback,
	useId,
	useMemo,
	useState,
} from "react";
import { MemberAvatar } from "@/components/common/member";
import { formatDayDate } from "@/lib/format";
import type { BundleTarget } from "@/lib/schemas/targets";
import { EMPTY_FILTER, serializeFilter } from "@/lib/workspace/filter";
import { parseSel } from "@/lib/workspace/search";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { PlacesDaysTable } from "./places-days-table";
import { useShell } from "./shell-store";
import {
	daysHint,
	type StillToPlan as StillToPlanResult,
	stillToPlan,
	todoTitle,
	todoView,
} from "./still-to-plan";
import { SHELL_TESTID } from "./testids";
import { formatDueWhen, useTripListItems } from "./trip-deadlines";
import { plainText, useTripGo } from "./use-trip-go";

/**
 * Opens a to-do's own filtered view (PLAN-I2-14, PLAN-R2-05): Lists › To-do
 * narrowed to its place or day, its item/place/leg/day selected, and the
 * inspector on that selection's Lists tab. Upcoming deadlines use it too.
 */
export function useOpenTodo(): (target: BundleTarget) => void {
	const { ix, search } = useWorkspace();
	const go = useTripGo();
	const openInspectorTab = useShell((s) => s.openInspectorTab);
	const from = search.sel ?? "none";
	return useCallback(
		(target: BundleTarget) => {
			const v = todoView(ix, target);
			if (v.inspectorTab && v.search.sel)
				openInspectorTab(v.search.sel, v.inspectorTab, from);
			go(v.search, v.scopeId ? { scopeId: v.scopeId } : { root: true });
		},
		[ix, go, openInspectorTab, from],
	);
}

export function StillToPlan() {
	const ws = useWorkspace();
	const { ix, schedule, graph, nav } = ws;
	const { items, due } = useTripListItems();
	const go = useTripGo();
	const [now] = useState(() => Date.now());
	// The Places tab's Rate feed on the whole trip with that filter (a link).
	const placesLink = (f: string | undefined) => {
		const opts = { scopeId: null, patch: { pv: "rate" as const, f } };
		return {
			href: nav.hrefPlaces(opts),
			onClick: (e: MouseEvent) => {
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
				e.preventDefault();
				nav.openPlaces(opts);
			},
		};
	};
	// `graph` is the server's; `ix` also holds proposal ghosts (PLAN-R3-02).
	const liveIds = useMemo(
		() => new Set(graph.nodes.map((n) => n.id)),
		[graph.nodes],
	);
	const s = useMemo(
		() =>
			stillToPlan({
				ix,
				schedule,
				members: graph.members,
				listItems: items,
				due,
				liveIds,
				now,
			}),
		[ix, schedule, graph.members, items, due, liveIds, now],
	);
	const me = graph.me.memberId;
	const unrated = s.unrated.filter((u) => u.count > 0);
	// PLAN-I2-14: each to-do opens its own context (a filtered view), never the
	// whole list; "All to-dos" at the end of the expanded row does that.
	const openTodo = useOpenTodo();
	const allTodos = () => go({ tab: "lists", list: "todo" }, { root: true });

	return (
		<section
			data-testid={SHELL_TESTID.stillToPlan}
			aria-labelledby="still-to-plan-h"
		>
			<h3
				id="still-to-plan-h"
				className="mb-1 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase"
			>
				Still to plan
			</h3>
			{s.open === 0 ? (
				<p className="py-2 text-sm text-muted-foreground">
					Nothing left to plan. Nice.
				</p>
			) : null}
			<ul className="-mx-2">
				{s.nights.length ? (
					<Row
						id="nights"
						icon={<BedDouble />}
						count={s.nights.length}
						label={
							s.nights.length === 1
								? "night without a stay"
								: "nights without a stay"
						}
					>
						{s.nights.map((n) => (
							<SubRow
								key={n.dayId}
								onClick={() => nav.select({ kind: "day", id: n.dayId })}
							>
								<span>{formatDayDate(n.date)}</span>
								<Meta>Day {ix.dayNumber(n.dayId)}</Meta>
							</SubRow>
						))}
					</Row>
				) : null}
				{s.toBook.length ? (
					<Row
						id="book"
						icon={<Ticket />}
						count={s.toBook.length}
						label="still to book"
					>
						{s.toBook.map((b) => (
							<SubRow
								key={b.listItemId}
								testId={SHELL_TESTID.stillToPlanItem}
								title={todoTitle(plainText(b.text), b.context)}
								onClick={() => openTodo(b.target)}
							>
								<TodoText text={b.text} context={b.context} />
								{b.due ? <Meta>{formatDayDate(b.due.date)}</Meta> : null}
							</SubRow>
						))}
						<li className="pl-8">
							<button
								type="button"
								onClick={allTodos}
								className="inline-flex h-7 items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
							>
								All to-dos
								<ChevronRight className="size-3" />
							</button>
						</li>
					</Row>
				) : null}
				{s.opening.length ? (
					<Row
						id="opening"
						icon={<CalendarClock />}
						count={s.opening.length}
						label={
							s.opening.length === 1
								? "booking window opens in the next 14 days"
								: "booking windows open in the next 14 days"
						}
					>
						{s.opening.map((o) => (
							<SubRow
								key={o.listItemId}
								testId={SHELL_TESTID.stillToPlanItem}
								title={todoTitle(plainText(o.text), o.context)}
								onClick={() => openTodo(o.target)}
							>
								<TodoText text={o.text} context={o.context} />
								<Meta>{formatDueWhen(o.due)}</Meta>
							</SubRow>
						))}
					</Row>
				) : null}
				{unrated.length ? (
					<Row
						id="unrated"
						icon={<Star />}
						label="unrated places"
						count={unrated.find((u) => u.memberId === me)?.count ?? null}
						countHint={me ? "by you" : undefined}
					>
						{/* FB-05: each count opens the Places tab's Rate feed on that person's unrated places. */}
						{unrated.map((u) => (
							<li key={u.memberId}>
								<a
									{...placesLink(
										unratedFilter(u.memberId === me ? "me" : u.memberId),
									)}
									className={SUB_ROW}
								>
									<MemberAvatar memberId={u.memberId} size={16} ring={false} />
									<span className="truncate">
										{u.memberId === me ? "You" : u.name}
									</span>
									<Meta>
										{u.count} of {u.total}
									</Meta>
								</a>
							</li>
						))}
						{me && unrated.some((u) => u.memberId === me) ? (
							<li className="flex items-center gap-4 pl-8">
								<a
									{...placesLink(unratedFilter("me"))}
									className="inline-flex h-7 items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
								>
									Rate them one by one
									<ChevronRight className="size-3" />
								</a>
								{/* The same places on the map and in the Outline (the shared filter). */}
								<button
									type="button"
									onClick={() => go({ f: unratedFilter("me") }, { root: true })}
									className="inline-flex h-7 items-center text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
								>
									Show on the map
								</button>
							</li>
						) : null}
					</Row>
				) : null}
				{s.moves.length ? (
					<Row
						id="moves"
						icon={<ArrowLeftRight />}
						count={s.moves.length}
						label={
							s.moves.length === 1
								? "city move without transport"
								: "city moves without transport"
						}
					>
						{s.moves.map((m) => (
							<SubRow
								key={m.sel}
								onClick={() => {
									const sel = parseSel(m.sel);
									if (sel) nav.select(sel);
								}}
							>
								<span className="truncate">
									{m.from} → {m.to}
								</span>
								{m.dayId ? <Meta>Day {ix.dayNumber(m.dayId)}</Meta> : null}
							</SubRow>
						))}
					</Row>
				) : null}
				{s.days.tripDays && (PlacesDaysTable || s.days.cities.length) ? (
					<Row
						id="days"
						icon={<Table2 />}
						label="Days per city"
						countHint={daysHint(s.days)}
					>
						<li className="pr-2 pl-8">
							{PlacesDaysTable ? (
								<PlacesDaysTable />
							) : (
								<ReadOnlyDaysTable days={s.days} />
							)}
						</li>
					</Row>
				) : null}
			</ul>
		</section>
	);
}

/** Planned vs scheduled days per city, read-only (until WP-Places' table is in the build). */
function ReadOnlyDaysTable({ days }: { days: StillToPlanResult["days"] }) {
	const { nav } = useWorkspace();
	return (
		<table className="w-full text-[13px]">
			<thead>
				<tr className="text-left text-[11px] text-muted-foreground">
					<th className="py-1 font-medium">City</th>
					<th className="py-1 text-right font-medium">Planned</th>
					<th className="py-1 text-right font-medium">Scheduled</th>
				</tr>
			</thead>
			<tbody>
				{days.cities.map((c) => (
					<tr key={c.nodeId} className="border-t border-border/60">
						<td className="py-1">
							<button
								type="button"
								className="hover:underline"
								onClick={() => nav.select({ kind: "node", id: c.nodeId })}
							>
								{c.name}
							</button>
						</td>
						<td className="py-1 text-right font-mono tnum">
							{c.planned ?? "–"}
						</td>
						<td className="py-1 text-right font-mono tnum">{c.scheduled}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/** "Book ahead · JAL Sky Museum · Day 2": the to-do, then what it's for. */
export function TodoText({
	text,
	context,
	className,
}: {
	text: string;
	context: string | null;
	className?: string;
}) {
	return (
		<span className={cn("min-w-0 truncate", className)}>
			{plainText(text)}
			{context ? <span data-part="context"> · {context}</span> : null}
		</span>
	);
}

function Meta({ children }: { children: ReactNode }) {
	return (
		<span className="ml-auto shrink-0 pl-2 font-mono text-[11px] text-muted-foreground tnum">
			{children}
		</span>
	);
}

/** A 36px row: icon, mono count, label; expands (children) or links (onClick). */
function Row({
	id,
	icon,
	count,
	countHint,
	label,
	onClick,
	children,
}: {
	id: string;
	icon: ReactNode;
	count?: number | null;
	countHint?: string;
	label: string;
	onClick?: () => void;
	children?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const panelId = useId();
	const expandable = !!children;
	return (
		<li data-testid={SHELL_TESTID.stillToPlanRow} data-row={id}>
			<button
				type="button"
				onClick={expandable ? () => setOpen((v) => !v) : onClick}
				aria-expanded={expandable ? open : undefined}
				aria-controls={expandable ? panelId : undefined}
				className="flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors hover:bg-accent"
			>
				<span className="text-muted-foreground [&_svg]:size-3.5">{icon}</span>
				<span className="min-w-0 flex-1 truncate">
					{count !== null && count !== undefined ? (
						<>
							<span className="font-mono font-medium tnum">{count}</span>{" "}
						</>
					) : null}
					{label}
					{countHint ? (
						<span className="text-muted-foreground"> · {countHint}</span>
					) : null}
				</span>
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
						expandable && open && "rotate-90",
					)}
				/>
			</button>
			{expandable && open ? (
				<ul id={panelId} className="pb-1">
					{children}
				</ul>
			) : null}
		</li>
	);
}

/** The shared filter "unrated by me / by a member" (`f=u:me`). */
function unratedFilter(by: string): string | undefined {
	return serializeFilter({ ...EMPTY_FILTER, unratedBy: by });
}

const SUB_ROW =
	"flex h-7 w-full items-center gap-2 rounded-md pr-2 pl-8 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

function SubRow({
	onClick,
	testId,
	title,
	children,
}: {
	onClick(): void;
	testId?: string;
	/** The full text, for a row the panel's width truncates. */
	title?: string;
	children: ReactNode;
}) {
	return (
		<li>
			<button
				type="button"
				data-testid={testId}
				title={title}
				onClick={onClick}
				className={SUB_ROW}
			>
				{children}
			</button>
		</li>
	);
}
