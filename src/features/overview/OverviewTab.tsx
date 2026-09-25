/**
 * The trip Overview (docs/OVERVIEW.md): the first centre tab, where a trip
 * link lands. Planning before, glancing during, looking back after.
 *
 * - A dark hero band in both themes (the globe reads best on black): the
 *   cinematic globe, the phase-aware header with the stats, and the route
 *   strip under it. The rest of the page follows the app theme: day by day,
 *   highlights, still to plan and the deadlines, typical weather, people and
 *   recent activity (moved here from the inspector's trip overview).
 * - Desktop: one scrolling page over the centre, the map's and the
 *   inspector's space (DesktopWorkspace). Narrow (the phone sheet): stacked
 *   like the phone mocks.
 * - `?asOf=YYYY-MM-DD` stands in for today (demos, e2e).
 */
import "./overview.css";
import { cn } from "cn";
import {
	type ReactNode,
	type RefObject,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { Button } from "@/components/ui/button";
import { ClimateCard } from "@/features/insights/ClimateCard";
import { useCovers } from "@/features/places/tab/PlacesBoard";
import { StillToPlan } from "@/features/shell/StillToPlan";
import type { LngLat } from "@/lib/engine/geo";
import { mediaUrl } from "@/lib/media-url";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { DayByDay } from "./DayByDay";
import { OverviewGlobe } from "./globe/OverviewGlobe";
import { Highlights } from "./Highlights";
import {
	CountryChips,
	dateLine,
	dayClock,
	PhaseChip,
	PlanningLine,
	routeLine,
	Stats,
	Title,
	TodayList,
} from "./PhaseHeader";
import { RouteStrip } from "./RouteStrip";
import { ShareButton } from "./share/ShareButton";
import { Deadlines, People, Recent } from "./TripSections";
import { OVERVIEW_TESTID } from "./testids";
import { type OverviewData, useOverview } from "./use-overview";

/** Below this width the page stacks (the phone sheet, a narrow panel). */
const WIDE_PX = 860;

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
	const ref = useRef<HTMLDivElement>(null);
	const [w, setW] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = () => setW(Math.round(el.getBoundingClientRect().width));
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return [ref, w];
}

export function OverviewTab({ phone = false }: { phone?: boolean }) {
	const ws = useWorkspace();
	const { ix, graph } = ws;
	const data = useOverview();
	const covers = useCovers();
	const [ref, width] = useWidth();
	const wide = !phone && width >= WIDE_PX;
	const [focus, setFocus] = useState<number | null>(null);
	const { route, phase, lines } = data;
	const firstDate = ix.days[0]?.date ?? null;
	const lastDate = ix.days.at(-1)?.date ?? null;
	// No stays yet: look at the trip's countries (or the whole planet).
	const fallbackPoints = useMemo<LngLat[]>(
		() =>
			ix
				.children(null)
				.filter((n) => n.type === "country")
				.flatMap((n) => {
					const c = ix.coordOf(n.id);
					return c ? [c] : [];
				}),
		[ix],
	);
	const today =
		phase.kind === "during"
			? phase.today
			: phase.kind === "after"
				? (lastDate ?? null)
				: null;
	const todayLine =
		phase.kind === "during" ? (lines[phase.index] ?? null) : null;
	const tomorrowLine =
		phase.kind === "during" ? (lines[phase.index + 1] ?? null) : null;
	const after = phase.kind === "after";
	// Day by day marks today (and opens its country) only during the trip.
	const dayMark = phase.kind === "during" ? phase.today : null;
	const hasRoute = route.stays.length > 0;

	const globe = (
		<OverviewGlobe
			route={route}
			fallbackPoints={fallbackPoints}
			today={today}
			hereStay={data.hereStay}
			focus={focus}
			interactive={!phone}
			className={cn(wide ? "h-full min-h-[540px] w-full" : "h-[300px] w-full")}
		/>
	);
	const strip = hasRoute ? (
		<RouteStrip
			route={route}
			compact={!wide}
			focus={focus}
			onFocus={setFocus}
			hereStay={data.hereStay}
			firstDate={firstDate}
			lastDate={lastDate}
		/>
	) : null;
	const header = (
		<Header
			data={data}
			wide={wide}
			todayLine={todayLine}
			tomorrowLine={tomorrowLine}
			firstDate={firstDate}
			lastDate={lastDate}
			covers={covers}
		/>
	);

	return (
		<div
			ref={ref}
			data-testid={OVERVIEW_TESTID.page}
			data-phase={phase.kind}
			data-layout={wide ? "wide" : "stacked"}
			className="min-h-full bg-background"
		>
			{/* The hero band: dark in both themes (tokens inside read dark). */}
			<div
				className="dark relative overflow-hidden bg-[#040507] text-white"
				style={{
					backgroundImage:
						"radial-gradient(ellipse 70% 60% at 30% 40%, rgb(24 34 52 / .55), transparent 70%)",
				}}
			>
				{wide ? (
					<>
						<div className="grid grid-cols-[minmax(0,1.3fr)_minmax(400px,1fr)] items-stretch gap-2 px-6">
							{globe}
							<div className="flex flex-col justify-center py-8 pr-2">
								{header}
							</div>
						</div>
						{strip ? <div className="px-6 pt-2 pb-7">{strip}</div> : null}
					</>
				) : (
					<div className="flex flex-col">
						<div className="px-4 pt-5 pb-3">{header}</div>
						{globe}
						{strip ? <div className="px-4 pt-1 pb-4">{strip}</div> : null}
						{/* After the trip the recap's numbers lead (the header has them). */}
						{(hasRoute || ix.days.length) && !after ? (
							<div className="px-4 pb-5">
								<Stats data={data} cols={2} after={after} />
							</div>
						) : null}
					</div>
				)}
			</div>

			<div
				className={cn(
					"grid gap-8 text-foreground",
					wide
						? "grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] px-6 pt-8 pb-12"
						: "grid-cols-[minmax(0,1fr)] px-4 pt-6 pb-10",
				)}
			>
				{wide ? (
					<>
						<DayByDay
							route={route}
							lines={lines}
							today={dayMark}
							narrow={false}
						/>
						<SideColumn data={data} covers={covers} after={after} />
					</>
				) : (
					<>
						{after ? (
							<Highlights candidates={data.highlights} covers={covers} after />
						) : null}
						<DayByDay route={route} lines={lines} today={dayMark} narrow />
						<SideColumn
							data={data}
							covers={covers}
							after={after}
							highlights={!after}
						/>
					</>
				)}
			</div>
			<span className="sr-only">{graph.trip.name} overview</span>
		</div>
	);
}

function SideColumn({
	data,
	covers,
	after,
	highlights = true,
}: {
	data: OverviewData;
	covers: ReturnType<typeof useCovers>;
	after: boolean;
	highlights?: boolean;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-7">
			{highlights ? (
				<Highlights
					candidates={data.highlights}
					covers={covers}
					after={after}
				/>
			) : null}
			{after ? null : (
				<div className="rounded-2xl border bg-card p-4">
					<StillToPlan />
				</div>
			)}
			{after ? null : <Deadlines />}
			{/* EXTENSIONS §6 (CLIM-03): the visited cities' typical weather. */}
			<ClimateCard nodeId="root" />
			<People />
			<Recent />
		</div>
	);
}

// ---- the header ----------------------------------------------------------------

function Header({
	data,
	wide,
	todayLine,
	tomorrowLine,
	firstDate,
	lastDate,
	covers,
}: {
	data: OverviewData;
	wide: boolean;
	todayLine: OverviewData["lines"][number] | null;
	tomorrowLine: OverviewData["lines"][number] | null;
	firstDate: string | null;
	lastDate: string | null;
	covers: ReturnType<typeof useCovers>;
}) {
	const { graph, ix, schedule, nav } = useWorkspace();
	const guard = useEditGuard();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const setSettingsOpen = useUi((s) => s.setSettingsOpen);
	const { route, phase } = data;
	const name = graph.trip.name;
	const size = wide ? "hero" : "phone";
	const chipRow = (
		<div className="flex items-center gap-2">
			<PhaseChip phase={phase} lastDate={lastDate} />
			{phase.kind === "during" && todayLine ? (
				<span className="ml-auto font-mono text-xs text-white/70 tnum">
					{dayClock(
						todayLine.date,
						schedule.days[todayLine.dayId]?.tz ?? ix.defaultTz,
						data.now,
						data.asOf,
					)}
				</span>
			) : (
				<span className="ml-auto" />
			)}
			<ShareButton variant="toolbar" />
		</div>
	);
	const dates = dateLine(firstDate, lastDate);
	const line = routeLine(route);
	const sub = (
		<p className={cn("text-white/60", wide ? "text-lg" : "text-[15px]")}>
			{[dates, line].filter(Boolean).join(" · ")}
		</p>
	);
	// The hero's two actions: the main one (Explore plan; Open today on the
	// trip) and a muted one. Sharing lives in the chip row's Share.
	const PRIMARY =
		"h-10 rounded-[10px] bg-[#a3aefa] px-4 text-[#11132c] hover:bg-[#b7c0fb]";
	const MUTED =
		"h-10 rounded-[10px] border-white/20 bg-transparent px-4 text-white hover:bg-white/10 hover:text-white";
	const buttons = (main: ReactNode, extra: ReactNode) => (
		<div className="flex flex-wrap items-center gap-2.5">
			{main}
			{extra}
		</div>
	);
	const openPlan = (
		<Button
			data-testid={OVERVIEW_TESTID.openPlan}
			onClick={() => nav.setTab("plan")}
			className={PRIMARY}
		>
			Explore plan
		</Button>
	);
	const seePlaces = (
		<Button
			variant="outline"
			data-testid={OVERVIEW_TESTID.seePlaces}
			onClick={() => nav.setTab("places")}
			className={MUTED}
		>
			See places
		</Button>
	);

	// ---- empty: no days, or no stays yet ----------------------------------------
	if (phase.kind === "empty" || !route.stays.length) {
		const noDays = phase.kind === "empty";
		return (
			<div
				data-testid={OVERVIEW_TESTID.header}
				data-phase={phase.kind}
				className="flex flex-col gap-5"
			>
				{chipRow}
				<div className="flex flex-col gap-2">
					<Title size={size}>{name}</Title>
					{dates ? sub : null}
				</div>
				<div
					data-testid={OVERVIEW_TESTID.empty}
					className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[.04] p-4"
				>
					<p className="font-display text-lg font-semibold text-white">
						{noDays ? "Where to first?" : "Add where you're staying"}
					</p>
					<p className="text-sm text-white/65">
						{noDays
							? "Set the trip's dates and add places: the route draws itself here."
							: "Pick where you sleep each night in the plan, and the route draws itself here, night by night."}
					</p>
					<div className="flex flex-wrap gap-2">
						{noDays ? (
							<>
								<Button
									className="h-10 rounded-[10px] bg-[#a3aefa] px-4 text-[#11132c] hover:bg-[#b7c0fb]"
									onClick={() => setSettingsOpen(true)}
									disabled={guard.disabled}
									title={guard.reason ?? undefined}
								>
									Set dates
								</Button>
								<Button
									variant="outline"
									onClick={() => openAddPlace({ mode: "first" })}
									disabled={guard.disabled}
									title={guard.reason ?? undefined}
									className="h-10 rounded-[10px] border-white/20 bg-transparent px-4 text-white hover:bg-white/10 hover:text-white"
								>
									Search places
								</Button>
							</>
						) : (
							openPlan
						)}
					</div>
				</div>
				{!noDays && wide ? <Stats data={data} cols={3} after={false} /> : null}
			</div>
		);
	}

	// ---- during -------------------------------------------------------------------
	if (phase.kind === "during" && todayLine) {
		const photo = todayPhoto(ix, todayLine.dayId, covers);
		const pct = Math.round(
			((phase.index + 1) / Math.max(1, ix.days.length)) * 100,
		);
		return (
			<div
				data-testid={OVERVIEW_TESTID.header}
				data-phase="during"
				className="flex flex-col gap-5"
			>
				{chipRow}
				<div
					className={cn(
						"relative flex flex-col justify-end gap-1 overflow-hidden",
						photo && "-mx-4 min-h-[190px] px-4 pb-4 sm:mx-0 sm:rounded-2xl",
					)}
				>
					{photo ? (
						<>
							<img
								src={photo}
								alt=""
								className="absolute inset-0 size-full object-cover"
							/>
							<span className="absolute inset-0 bg-linear-to-b from-black/25 via-black/10 to-[#040507]" />
						</>
					) : null}
					<span className="relative text-sm text-white/75">
						Day {phase.index + 1} of {ix.days.length}
					</span>
					<div className="relative">
						<Title size={size}>{todayLine.city || name}</Title>
					</div>
					<div
						data-testid={OVERVIEW_TESTID.progress}
						role="progressbar"
						aria-label="Trip progress"
						aria-valuenow={pct}
						aria-valuemin={0}
						aria-valuemax={100}
						className="relative mt-2 h-1 rounded-full bg-white/20"
					>
						<div
							className="h-1 rounded-full bg-white"
							style={{ width: `${pct}%` }}
						/>
					</div>
				</div>
				<TodayList data={data} line={todayLine} tomorrow={tomorrowLine} />
				{wide ? <Stats data={data} cols={3} after={false} /> : null}
				{buttons(
					<Button
						data-testid={OVERVIEW_TESTID.openToday}
						onClick={() =>
							nav.setDays({ from: todayLine.date, to: todayLine.date })
						}
						className={PRIMARY}
					>
						Open today
					</Button>,
					<Button
						variant="outline"
						data-testid={OVERVIEW_TESTID.openPlan}
						onClick={() => nav.setTab("plan")}
						className={MUTED}
					>
						Explore plan
					</Button>,
				)}
			</div>
		);
	}

	// ---- after ----------------------------------------------------------------------
	if (phase.kind === "after") {
		return (
			<div
				data-testid={OVERVIEW_TESTID.header}
				data-phase="after"
				className="flex flex-col gap-5"
			>
				{chipRow}
				<div className="flex flex-col gap-1.5">
					<span className={cn("text-white/60", wide ? "text-lg" : "text-base")}>
						That was
					</span>
					<Title size={size}>{`${name.replace(/[.!?]$/, "")}.`}</Title>
					{sub}
				</div>
				{wide ? <CountryChips route={route} /> : null}
				<Stats data={data} cols={wide ? 3 : 2} after />
				{buttons(openPlan, seePlaces)}
			</div>
		);
	}

	// ---- before ---------------------------------------------------------------------
	return (
		<div
			data-testid={OVERVIEW_TESTID.header}
			data-phase="before"
			className="flex flex-col gap-5"
		>
			{chipRow}
			<div className="flex flex-col gap-2">
				<Title size={size}>{name}</Title>
				{sub}
			</div>
			<CountryChips route={route} />
			{wide ? <Stats data={data} cols={3} after={false} /> : null}
			<PlanningLine data={data} />
			{buttons(openPlan, seePlaces)}
		</div>
	);
}

/** Today's photo: the first of today's places with a cover. */
function todayPhoto(
	ix: ReturnType<typeof useWorkspace>["ix"],
	dayId: string,
	covers: ReturnType<typeof useCovers>,
): string | null {
	for (const it of ix.itemsByDay.get(dayId) ?? []) {
		const c = it.nodeId ? covers.get(it.nodeId) : undefined;
		if (c) return mediaUrl(c.id, "display");
	}
	return null;
}
