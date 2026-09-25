/**
 * DEV/E2E ONLY — never imported by the app. WP-Insights' components are
 * mounted by other packages (WP-Plan's day headers and cards, WP-Places'
 * NodeOverview, WP-Shell's TopBar and global mounts, WP-Home's Trip settings),
 * none of which exist in this package's workspace. To prove acceptance on
 * "F plus this WP alone" (SPEC §18.3) the e2e specs mount this harness on a
 * live trip page (`mount.tsx`): a plain plan column and an inspector built
 * from nothing but F's workspace model and this package's components, wired
 * the way the owning packages are asked to wire them (EXTENSIONS §1.4).
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { CalendarRange, Settings2 } from "lucide-react";
import { useMemo, useState } from "react";
import { CategoryDot } from "@/components/common/glyphs";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/roles";
import { PLACE_CATEGORIES } from "@/lib/domain/taxonomy";
import type { TripGraph } from "@/lib/engine/types";
import { formatDuration, formatTime } from "@/lib/format";
import { tripGraphQuery, tripProposalsQuery } from "@/lib/query/trip-queries";
import {
	WorkspaceModelProvider,
	type WorkspaceRouteBinding,
} from "@/lib/workspace/model-context";
import type { NavTarget } from "@/lib/workspace/nav";
import type { parseSel, WorkspaceSearch } from "@/lib/workspace/search";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { ClimateCard } from "../ClimateCard";
import { DayHoursBadge } from "../DayHoursBadge";
import { DaySun } from "../DaySun";
import { HolidaysEditor } from "../HolidaysEditor";
import { HoursChip } from "../HoursChip";
import { HoursEditorDialog } from "../HoursEditorDialog";
import { HoursTable } from "../HoursTable";
import { ShiftTripDialog } from "../ShiftTripDialog";
import { useDateDraftImpact } from "../use-date-draft-impact";
import { WhatIfChip } from "../WhatIfChip";

export type HarnessOptions = {
	tripId: string;
	/** The node the inspector shows first (defaults to the first scheduled place). */
	nodeId?: string;
	/** Which panel to show on narrow screens. */
	panel?: "plan" | "inspector" | "settings";
};

export function InsightsHarness(opts: HarnessOptions) {
	const graph = useQuery(tripGraphQuery(opts.tripId)).data as
		| TripGraph
		| undefined;
	// Open suggestions, like the trip route (reviewers and proposers only).
	const mayProposals =
		!!graph && (can(graph.me, "propose") || can(graph.me, "reviewProposals"));
	const proposals = useQuery({
		...tripProposalsQuery(opts.tripId),
		enabled: mayProposals,
	}).data;
	const [search, setSearch] = useState<WorkspaceSearch>({});
	const route = useMemo<WorkspaceRouteBinding>(
		() => ({
			splat: "",
			search,
			go: (t: NavTarget) => setSearch(t.search),
			href: () => "#",
		}),
		[search],
	);
	if (!graph)
		return (
			<p className="p-6 text-sm text-muted-foreground">Loading the trip…</p>
		);
	return (
		<WorkspaceModelProvider
			graph={graph}
			mode="live"
			connection="live"
			route={route}
			{...(proposals ? { proposals } : {})}
		>
			<HarnessBody {...opts} />
			<HoursEditorDialog />
			<ShiftTripDialog />
		</WorkspaceModelProvider>
	);
}

function HarnessBody({ nodeId, panel = "plan" }: HarnessOptions) {
	const { graph, ix, sel } = useWorkspace();
	const openShift = useUi((s) => s.openShiftTrip);
	const [tab, setTab] = useState(panel);
	const selected = sel ? parseSelNode(sel, ix) : null;
	const firstPlace = ix.ordered.find(
		(i) => i.nodeId && ix.node(i.nodeId)?.type === "place",
	)?.nodeId;
	const inspectorNode = selected ?? nodeId ?? firstPlace ?? null;
	const node = inspectorNode ? ix.node(inspectorNode) : undefined;
	const city = node
		? ix.path(node.id).find((n) => n.type === "city")
		: undefined;
	const country = node
		? ix.path(node.id).find((n) => n.type === "country")
		: undefined;
	return (
		<div
			data-testid="insights-harness"
			className="flex min-h-full flex-col bg-background text-foreground"
		>
			<header className="sticky top-0 z-20 flex h-[52px] shrink-0 items-center gap-3 border-b bg-background/96 px-4 backdrop-blur">
				<span className="min-w-0 truncate text-[17px] leading-6 font-semibold">
					{graph.trip.name}
				</span>
				<WhatIfChip />
				<span className="flex-1" />
				<Button
					variant="ghost"
					size="sm"
					data-testid="harness-try-dates"
					onClick={() => openShift(true)}
					className="h-8 gap-1.5 text-[13px]"
				>
					<CalendarRange className="size-4" strokeWidth={1.75} />
					<span className="max-sm:hidden">Try other dates…</span>
				</Button>
			</header>
			<nav className="flex gap-1 border-b px-3 py-1.5 md:hidden">
				{(["plan", "inspector", "settings"] as const).map((t) => (
					<button
						key={t}
						type="button"
						data-testid={`harness-tab-${t}`}
						onClick={() => setTab(t)}
						className={cn(
							"h-8 rounded-full px-3 text-[13px] font-medium capitalize",
							tab === t
								? "bg-foreground text-background"
								: "text-muted-foreground",
						)}
					>
						{t === "inspector" ? "Place" : t}
					</button>
				))}
			</nav>
			<div className="grid flex-1 md:grid-cols-[minmax(0,520px)_minmax(0,1fr)] md:gap-6 md:px-6 md:py-5">
				<section className={cn("min-w-0", tab !== "plan" && "max-md:hidden")}>
					<PlanColumn />
				</section>
				<aside
					className={cn(
						"grid content-start gap-4 max-md:p-4 md:max-w-[420px]",
						tab === "plan" && "max-md:hidden",
					)}
				>
					{node ? (
						<div
							data-testid="harness-inspector"
							className={cn(
								"grid gap-5 rounded-2xl border bg-card p-4 shadow-float",
								tab === "settings" && "max-md:hidden",
							)}
						>
							<div className="grid gap-0.5">
								<h2 className="text-[22px] leading-7 font-semibold">
									{node.name}
								</h2>
								<p className="text-[12px] text-muted-foreground">
									{ix
										.path(node.id)
										.slice(0, -1)
										.map((n) => n.name)
										.join(" › ")}
								</p>
							</div>
							<HoursTable nodeId={node.id} />
							{/* A place never gets a climate line (CLIM-03): this renders nothing. */}
							<div data-testid="harness-place-climate" className="contents">
								<ClimateCard nodeId={node.id} />
							</div>
							{city ? <ClimateCard nodeId={city.id} /> : null}
						</div>
					) : null}
					{country ? (
						<div
							className={cn(
								"rounded-2xl border bg-card p-4",
								tab === "settings" && "max-md:hidden",
							)}
						>
							<p className="mb-3 text-[15px] font-semibold">{country.name}</p>
							<ClimateCard nodeId={country.id} />
						</div>
					) : null}
					<div
						data-testid="harness-settings"
						className={cn(
							"rounded-2xl border bg-card p-4",
							tab === "inspector" && "max-md:hidden",
						)}
					>
						<p className="mb-3 flex items-center gap-1.5 text-[15px] font-semibold">
							<Settings2 className="size-4" strokeWidth={1.75} /> Trip settings
						</p>
						<HolidaysEditor />
					</div>
				</aside>
			</div>
		</div>
	);
}

function parseSelNode(
	sel: NonNullable<ReturnType<typeof parseSel>>,
	ix: ReturnType<typeof useWorkspace>["ix"],
) {
	if (sel.kind === "node") return sel.id;
	if (sel.kind === "item") return ix.item(sel.id)?.nodeId ?? null;
	return null;
}

function PlanColumn() {
	const { ix, schedule, nav, sel } = useWorkspace();
	const ring = useDateDraftImpact();
	return (
		<div className="grid">
			{ix.days.map((day) => {
				const items = ix.itemsByDay.get(day.id) ?? [];
				const n = ix.dayNumber(day.id);
				const sd = schedule.days[day.id];
				return (
					<section
						key={day.id}
						data-testid="harness-day"
						data-day={day.id}
						className="pb-3"
					>
						<header className="sticky top-[52px] z-10 border-b bg-background/96 px-4 py-2 backdrop-blur md:px-0">
							<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
								<h3 className="font-display text-[19px] leading-6 font-semibold">
									{dayLabel(day.date)}
								</h3>
								<span className="text-[13px] text-muted-foreground">
									Day {n}
								</span>
								<span className="hidden sm:inline-flex">
									<DaySun dayId={day.id} />
								</span>
								<span className="flex-1" />
								<DayHoursBadge dayId={day.id} />
							</div>
							<div className="mt-0.5 flex items-center gap-2 sm:hidden">
								<DaySun dayId={day.id} compact />
								{sd ? (
									<span className="text-[12px] text-muted-foreground">
										<span aria-hidden className="mr-2">
											·
										</span>
										<span className="font-mono tnum">
											{formatDuration(sd.activitiesMin, { compact: true })}
										</span>{" "}
										planned
									</span>
								) : null}
							</div>
						</header>
						<ol className="grid gap-1.5 px-4 pt-2 md:px-0">
							{items.map((item) => {
								const s = schedule.items[item.id];
								const node = item.nodeId ? ix.node(item.nodeId) : undefined;
								const tz = node ? ix.tzOf(node.id) : ix.defaultTz;
								const selected = sel?.kind === "item" && sel.id === item.id;
								const ringed = ring?.items.has(item.id);
								return (
									<li
										key={item.id}
										data-testid="harness-card"
										data-item={item.id}
										data-ring={ringed || undefined}
									>
										{/* biome-ignore lint/a11y/useSemanticElements: a card with nested controls (chips) can't be a button */}
										<div
											role="button"
											tabIndex={0}
											onClick={() => nav.select({ kind: "item", id: item.id })}
											onKeyDown={(e) => {
												if (e.key === "Enter")
													nav.select({ kind: "item", id: item.id });
											}}
											className={cn(
												"grid min-h-14 cursor-pointer grid-cols-[3rem_minmax(0,1fr)] items-center gap-2 rounded-lg border bg-card px-3 py-2 transition-colors hover:border-foreground/20",
												!node && "border-dashed",
												selected && "border-foreground/40 bg-accent/40",
												ringed &&
													"ring-2 ring-primary/70 ring-offset-1 ring-offset-background",
											)}
										>
											<span className="grid text-right font-mono text-[12px] leading-4 text-muted-foreground tnum">
												{s ? (
													<>
														<span className="text-foreground">
															{formatTime(s.start, tz)}
														</span>
														<span>{formatTime(s.end, tz)}</span>
													</>
												) : (
													"—"
												)}
											</span>
											<span className="flex min-w-0 items-center gap-2">
												<span className="min-w-0 flex-1">
													<span className="block truncate text-[14px] leading-5 font-medium">
														{item.title ?? node?.name ?? "Untitled"}
													</span>
													{node?.category ? (
														<span className="flex items-center gap-1.5 text-[12px] text-muted-foreground max-sm:hidden">
															<CategoryDot category={node.category} />
															{PLACE_CATEGORIES[node.category].label}
														</span>
													) : null}
												</span>
												<HoursChip itemId={item.id} />
												<span className="inline-flex h-[22px] shrink-0 items-center rounded-full bg-muted px-2 font-mono text-xs tnum">
													{formatDuration(item.durationMin, { compact: true })}
												</span>
											</span>
										</div>
									</li>
								);
							})}
							{items.length === 0 ? (
								<li className="px-1 py-2 text-[13px] text-muted-foreground">
									A free day.
								</li>
							) : null}
						</ol>
					</section>
				);
			})}
		</div>
	);
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];
function dayLabel(date: string): string {
	const d = new Date(`${date}T00:00:00Z`);
	return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
}
