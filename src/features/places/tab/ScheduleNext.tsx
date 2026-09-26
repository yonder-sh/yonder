/**
 * The Schedule step: "Schedule next" (docs/PLACES.md §4), only the bridge
 * onto the days the Plan already has. Per stay window (a run of days in one
 * city, under its country where the country changes) the city's
 * shortlisted places not on a day, grouped by area, each with a fit hint per
 * day (closed days struck, its time needed against the day's free time, the
 * distance from that day's stay or stops) and a one-click "Add to Mon 11
 * Oct" that puts it at the best spot of the best day. Then the cities with
 * shortlisted places but no days, and what can't fit. Before any day has a
 * city (or with no dates): what the shortlist needs per city, and the way to
 * the Plan to decide it; this step never writes days. Read-only for people
 * who can't edit.
 */
import { cn } from "cn";
import { CalendarPlus, ChevronRight, Star } from "lucide-react";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DaysPerCityTable } from "@/features/places/DaysPerCityTable";
import { useDaySplit } from "@/features/plan/day-split/DaySplit";
import { headingText, needText } from "@/features/plan/day-split/day-split";
import {
	formatDateRange,
	formatDayDate,
	formatDistance,
	formatDuration,
} from "@/lib/format";
import { copyAnchorId } from "@/lib/realtime/cursor-protocol";
import { bool, useFollowState } from "@/lib/realtime/view-ui";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { formatDays } from "../lib/days";
import type { FlowTally } from "./flow";
import { formatDayNumbers } from "./model";
import { categoryLabel } from "./PlacesTable";
import {
	bestSpot,
	type DayFit,
	type Near,
	type ScheduleCandidate,
	scheduleNext,
	type WindowPlan,
} from "./schedule-next";
import { PLACES_TAB_TESTID } from "./testids";
import { ScoreChip, SectionLabel, SplitMark } from "./ui";
import { usePlaceActions } from "./use-place-actions";
import type { PlacesData } from "./use-places";

/** "10 min from Kiyomizu-dera" (walkable), else "3.2 km from Hotel Gion". */
function nearText(n: Near | null): string | null {
	if (!n) return null;
	return n.walkMin <= 30
		? `${n.walkMin} min from ${n.name}`
		: `${formatDistance(n.km * 1000)} from ${n.name}`;
}

/** "half a day", "1 day", "1.5 days". */
export function daysText(days: number): string {
	if (days === 0.5) return "half a day";
	return `${formatDays(days)} ${days <= 1 ? "day" : "days"}`;
}

/** "3h free · open · 10 min from Kiyomizu-dera". */
export function fitHint(d: DayFit, needMin: number): string {
	return [
		d.fits
			? `${formatDuration(d.freeMin)} free`
			: `${formatDuration(d.freeMin)} free, needs ${formatDuration(needMin)}`,
		d.hoursKnown ? "open" : null,
		nearText(d.near),
	]
		.filter(Boolean)
		.join(" · ");
}

function DayChip({
	d,
	needMin,
	best,
	onAdd,
}: {
	d: DayFit;
	needMin: number;
	best: boolean;
	onAdd: (() => void) | null;
}) {
	const date = formatDayDate(d.date).replace(/ \w+$/, "");
	const title = d.closed
		? `${formatDayDate(d.date)}: ${d.closed}`
		: `${formatDayDate(d.date)}: ${fitHint(d, needMin)}${onAdd ? ". Click to add it here." : ""}`;
	const body = (
		<>
			<span className={cn("font-medium", d.closed && "line-through")}>
				{date}
			</span>
			{d.closed ? (
				<span>closed</span>
			) : (
				<>
					<span className={cn(!d.fits && "text-warning")}>
						<span className="font-mono tnum">
							{formatDuration(d.freeMin, { compact: true })}
						</span>{" "}
						free
					</span>
					{d.near ? (
						d.near.walkMin <= 30 ? (
							<span>
								<span className="font-mono tnum">{d.near.walkMin}</span> min
								walk
							</span>
						) : (
							<span className="font-mono tnum">
								{formatDistance(d.near.km * 1000)}
							</span>
						)
					) : null}
				</>
			)}
		</>
	);
	const cls = cn(
		"inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] whitespace-nowrap text-muted-foreground",
		d.closed && "border-dashed opacity-70",
		best && "border-primary/40 bg-primary/5 text-foreground",
	);
	return onAdd && !d.closed ? (
		<button
			type="button"
			data-testid={PLACES_TAB_TESTID.scheduleDay}
			data-day={d.dayId}
			data-closed={d.closed ? "" : undefined}
			title={title}
			onClick={onAdd}
			className={cn(
				cls,
				"cursor-pointer hover:border-primary/50 hover:text-foreground",
			)}
		>
			{body}
		</button>
	) : (
		<span
			data-testid={PLACES_TAB_TESTID.scheduleDay}
			data-day={d.dayId}
			data-closed={d.closed ? "" : undefined}
			title={title}
			className={cls}
		>
			{body}
		</span>
	);
}

function CandidateRow({ c }: { c: ScheduleCandidate }) {
	const { ix, schedule, nav } = useWorkspace();
	const act = usePlaceActions();
	const [busy, setBusy] = useState(false);
	const row = c.row;
	const add = async (d: DayFit) => {
		if (busy) return;
		setBusy(true);
		const spot = bestSpot(ix, d.dayId, row.id, {
			schedule,
			needMin: c.needMin,
		});
		const label = [formatDayDate(d.date), spot.label]
			.filter(Boolean)
			.join(", ");
		await act.addToDay(row, d.dayId, label, spot);
		setBusy(false);
	};
	const canAdd = act.canEdit;
	return (
		<li
			data-testid={PLACES_TAB_TESTID.scheduleRow}
			data-place={row.id}
			data-best-day={c.best.dayId}
			data-cursor-anchor={`place:${row.id}`}
			className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:gap-4"
		>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2">
					<ScoreChip score={row.score} size="sm" />
					<button
						type="button"
						onClick={() => nav.select({ kind: "node", id: row.id })}
						className="min-w-0 cursor-pointer truncate text-left text-[15px] font-medium hover:underline"
					>
						{row.name}
					</button>
					{row.split ? <SplitMark /> : null}
					<span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
						{categoryLabel(row)} ·{" "}
						<span
							title={
								c.needSet
									? "Time needed"
									: "Time needed: the category's usual time"
							}
						>
							{c.needSet ? "" : "~"}
							{formatDuration(c.needMin)}
						</span>
					</span>
				</div>
				<div className="mt-1.5 flex flex-wrap gap-1.5">
					{c.days.map((d) => (
						<DayChip
							key={d.dayId}
							d={d}
							needMin={c.needMin}
							best={d.dayId === c.best.dayId}
							onAdd={canAdd && !busy ? () => void add(d) : null}
						/>
					))}
				</div>
			</div>
			<div className="flex shrink-0 flex-col gap-0.5 md:items-end">
				{canAdd ? (
					<Button
						size="sm"
						variant="outline"
						data-testid={PLACES_TAB_TESTID.scheduleAdd}
						disabled={busy}
						onClick={() => void add(c.best)}
						className="self-start md:self-auto"
					>
						<CalendarPlus />
						Add to {formatDayDate(c.best.date)}
					</Button>
				) : (
					<span className="text-[13px] font-medium">
						Best: {formatDayDate(c.best.date)}
					</span>
				)}
				<span
					className="max-w-72 truncate text-xs text-muted-foreground"
					title={fitHint(c.best, c.needMin)}
				>
					{fitHint(c.best, c.needMin)}
				</span>
			</div>
		</li>
	);
}

function WindowSection({ w }: { w: WindowPlan }) {
	const { ix } = useWorkspace();
	const first = w.days[0]?.date;
	const last = w.days.at(-1)?.date;
	const nums = formatDayNumbers(w.dayIds.map((d) => ix.dayNumber(d)));
	return (
		<section
			data-testid={PLACES_TAB_TESTID.scheduleWindow}
			data-city={w.cityId}
			// A city can have several windows: each is one drawing of it.
			data-cursor-anchor={copyAnchorId(`city:${w.cityId}`, w.dayIds[0])}
			aria-label={`${w.cityName}, ${formatDateRange(first, last)}`}
		>
			<header className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 border-b pb-2">
				<h3 className="font-display text-lg font-semibold">{w.cityName}</h3>
				<span className="text-sm text-muted-foreground">
					{first === last
						? formatDayDate(first ?? "")
						: `${formatDayDate(first ?? "")} – ${formatDayDate(last ?? "")}`}{" "}
					· {nums}
				</span>
				<span className="ml-auto font-mono text-xs text-muted-foreground tnum">
					{w.count} not on a day
				</span>
			</header>
			{w.groups.map((g) => (
				<div key={g.key}>
					{g.label || w.groups.length > 1 ? (
						<h4 className="pt-3 text-[13px] font-semibold">
							{g.label || `Elsewhere in ${w.cityName}`}{" "}
							<span className="font-normal text-muted-foreground">
								· {g.items.length}
							</span>
						</h4>
					) : null}
					<ul className="divide-y">
						{g.items.map((c) => (
							<CandidateRow key={c.row.id} c={c} />
						))}
					</ul>
				</div>
			))}
		</section>
	);
}

function Section({
	title,
	testid,
	children,
}: {
	title: string;
	testid: string;
	children: ReactNode;
}) {
	return (
		<section data-testid={testid} className="flex flex-col gap-2">
			<SectionLabel>{title}</SectionLabel>
			{children}
		</section>
	);
}

export function ScheduleNext({
	data,
	tally,
	onRate,
}: {
	data: PlacesData;
	tally: FlowTally;
	/** Opens the Rate step (nothing shortlisted yet). */
	onRate: () => void;
}) {
	const { ix, schedule, graph, nav } = useWorkspace();
	const act = usePlaceActions();
	const [daysTable, setDaysTable] = useFollowState(
		"places.daysTable",
		false,
		bool,
	);
	const holidays = graph.trip.settings.holidays;
	const plan = useMemo(
		() =>
			scheduleNext(ix, schedule, data.rows, data.cityDays, {
				holidays: holidays ?? [],
			}),
		[ix, schedule, data.rows, data.cityDays, holidays],
	);
	const split = useDaySplit();
	// No day in a city yet: what the shortlist needs, decided in the Plan.
	const needs = useMemo(
		() => (split.hasDays ? null : needText(ix, split.cities)),
		[split.hasDays, split.cities, ix],
	);
	// A heading where the country changes (none for a trip in one country).
	const countryAt = useMemo(() => {
		const out = new Map<string, { name: string; days: number }>();
		const runs = plan.countries.filter((r) => r.name);
		if (runs.length < 2) return out;
		const shown = new Set(plan.windows.map((w) => w.key));
		for (const r of runs) {
			const first = r.windowKeys.find((k) => shown.has(k));
			if (first) out.set(first, r);
		}
		return out;
	}, [plan]);
	const shell = (mode: string, children: ReactNode) => (
		<div
			data-testid={PLACES_TAB_TESTID.schedule}
			data-waiting={plan.waiting}
			data-mode={mode}
			className="min-h-0 flex-1 overflow-y-auto"
			// The phone's sheet never drags from the list: a swipe here scrolls it.
			data-vaul-no-drag=""
		>
			<div className="mx-auto flex max-w-4xl flex-col gap-8 px-4 pt-4 pb-10 md:px-6">
				{children}
			</div>
		</div>
	);
	if (needs)
		return shell(
			"needs",
			<div
				data-testid={PLACES_TAB_TESTID.scheduleNeeds}
				className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-5"
			>
				<p className="max-w-prose text-[15px]">
					Your shortlist needs about:{" "}
					<span className="font-medium">{needs}</span>
				</p>
				{act.canEdit ? (
					<Button size="sm" onClick={() => nav.setTab("plan")}>
						Decide how long in each city
					</Button>
				) : null}
			</div>,
		);
	return shell(
		"schedule",
		<>
			<div className="flex flex-col gap-4">
				{plan.waiting === 0 ? (
					<div
						data-testid={PLACES_TAB_TESTID.scheduleDone}
						className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-5"
					>
						<p className="font-display text-lg font-semibold">
							{tally.shortlisted
								? "Everything on the shortlist is on a day."
								: "Nothing on the shortlist yet."}
						</p>
						<p className="max-w-prose text-sm text-muted-foreground">
							{tally.shortlisted
								? "New places join the shortlist as people rate them. They'll wait here, next to the days you're in their city."
								: "Rate places first: the places the group likes most make the shortlist and show up here with the days they fit."}
						</p>
						{!tally.shortlisted && tally.toRate ? (
							<Button size="sm" onClick={onRate}>
								<Star />
								Rate {tally.toRate} {tally.toRate === 1 ? "place" : "places"}
							</Button>
						) : null}
					</div>
				) : (
					<header
						data-testid={PLACES_TAB_TESTID.scheduleIntro}
						className="flex flex-col gap-1"
					>
						<h2 className="font-display text-lg font-semibold">
							Put your shortlist on days
						</h2>
						<p className="max-w-prose text-sm text-muted-foreground">
							{act.canEdit
								? "Each place lists the days you're in its city. The button adds it to the best one."
								: "Each place lists the days you're in its city and the best one."}
						</p>
					</header>
				)}
			</div>

			{plan.windows.map((w) => {
				const country = countryAt.get(w.key);
				return (
					<Fragment key={w.key}>
						{country ? (
							<h2
								data-testid={PLACES_TAB_TESTID.scheduleCountry}
								className="-mb-4 font-display text-[15px] font-semibold text-muted-foreground"
							>
								{headingText(country.name, country.days)}
							</h2>
						) : null}
						<WindowSection w={w} />
					</Fragment>
				);
			})}

			{plan.noDays.length ? (
				<Section
					title="Cities with shortlisted places but no days yet"
					testid={PLACES_TAB_TESTID.scheduleNoDays}
				>
					<ul className="divide-y rounded-xl border">
						{plan.noDays.map((c) => (
							<li
								key={c.key}
								data-city={c.cityId ?? ""}
								data-cursor-anchor={
									c.cityId
										? copyAnchorId(`city:${c.cityId}`, "none")
										: undefined
								}
								className="flex flex-col gap-0.5 px-4 py-2.5"
							>
								<span className="text-[15px]">
									<span className="font-medium">{c.name}</span>
									<span className="text-muted-foreground">
										{" "}
										· {c.rows.length} shortlisted · about {daysText(c.days)} of
										sights · no days planned
									</span>
								</span>
								<span className="truncate text-xs text-muted-foreground">
									{c.rows.map((r) => r.name).join(", ")}
								</span>
							</li>
						))}
					</ul>
					<button
						type="button"
						aria-expanded={daysTable}
						onClick={() => setDaysTable((v) => !v)}
						className="inline-flex h-7 cursor-pointer items-center gap-1 self-start text-xs font-medium text-primary underline-offset-2 hover:underline"
					>
						Days per city
						<ChevronRight
							className={cn(
								"size-3 transition-transform",
								daysTable && "rotate-90",
							)}
						/>
					</button>
					{daysTable ? (
						<div className="rounded-xl border p-3">
							<DaysPerCityTable />
						</div>
					) : null}
				</Section>
			) : null}

			{plan.cantFit.length ? (
				<Section title="Can't fit" testid={PLACES_TAB_TESTID.scheduleCantFit}>
					<ul className="divide-y rounded-xl border">
						{plan.cantFit.map((c) => (
							<li
								key={`${c.kind}:${c.row.id}`}
								data-place={c.row.id}
								data-kind={c.kind}
								className="flex items-center gap-2.5 px-4 py-2.5"
							>
								<ScoreChip score={c.row.score} size="sm" />
								<span className="min-w-0 flex-1">
									<button
										type="button"
										onClick={() => nav.select({ kind: "node", id: c.row.id })}
										className="cursor-pointer text-[15px] font-medium hover:underline"
									>
										{c.row.name}
									</button>
									<span className="block truncate text-xs text-muted-foreground">
										{c.reason}
										{c.detail ? ` · ${c.detail}` : ""}
									</span>
								</span>
							</li>
						))}
					</ul>
				</Section>
			) : null}
		</>,
	);
}
