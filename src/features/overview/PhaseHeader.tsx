/**
 * docs/OVERVIEW.md §3–§4: the phase-aware header on the dark hero band —
 * before the trip a countdown, the route line, the countries, the stats and
 * the planning line; during it "Day 9 of 37 · Kyoto", today's list and
 * tomorrow's first stop; after it "That was Asia 2027." with the recap.
 */
import { cn } from "cn";
import type { ReactNode } from "react";
import { todoContext } from "@/features/shell/still-to-plan";
import { deadlineChip } from "@/features/shell/trip-deadlines";
import { plainText } from "@/features/shell/use-trip-go";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { ScheduleResult } from "@/lib/engine/types";
import { formatDayDate, formatTime } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import type { DayLine } from "./lib/day-lines";
import type { TripPhase } from "./lib/phase";
import type { TripRoute } from "./lib/trip-route";
import { OVERVIEW_TESTID } from "./testids";
import type { OverviewData } from "./use-overview";

const MONTHS = [
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
const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) =>
	n === 1 ? one : many;

// ---- the chip ------------------------------------------------------------------

export function PhaseChip({
	phase,
	lastDate,
	extra,
}: {
	phase: TripPhase;
	lastDate: string | null;
	extra?: ReactNode;
}) {
	let dot = "#f8b05d";
	let text: ReactNode = "Planning";
	if (phase.kind === "before") {
		text = (
			<>
				Planning ·{" "}
				<b className="font-mono font-semibold text-white tnum">
					{fmt(phase.daysToGo)}
				</b>{" "}
				{plural(phase.daysToGo, "day")} to go
			</>
		);
	} else if (phase.kind === "during") {
		dot = "#34c472";
		text = "On the trip";
	} else if (phase.kind === "after") {
		dot = "#8f8f8f";
		const m = lastDate ? Number(lastDate.slice(5, 7)) - 1 : -1;
		text = lastDate
			? `Back home · ${MONTHS[m] ?? ""} ${lastDate.slice(0, 4)}`
			: "Back home";
	}
	return (
		<span
			data-testid={OVERVIEW_TESTID.chip}
			className="inline-flex h-7 shrink-0 items-center gap-2 self-start rounded-full bg-white/[.09] px-3 text-[13px] text-white/80"
		>
			<span className="size-[7px] rounded-full" style={{ background: dot }} />
			{text}
			{extra}
		</span>
	);
}

// ---- title and route line ---------------------------------------------------

export function routeLine(route: TripRoute): string {
	const first = route.stays[0];
	const last = route.stays.at(-1);
	const parts = [
		route.start?.name,
		first?.name,
		last && last !== first ? last.name : undefined,
		route.stays.length
			? route.endsHome
				? "home"
				: route.end?.name
			: undefined,
	].filter((p): p is string => !!p);
	return parts.filter((p, i) => p !== parts[i - 1]).join(" → ");
}

export function dateLine(firstDate: string | null, lastDate: string | null) {
	if (!firstDate || !lastDate) return null;
	return `${formatDayDate(firstDate)} – ${formatDayDate(lastDate, { year: true })}`;
}

/** Poster type that shrinks with a long name (≤ 2 lines in the header column). */
export function titlePx(text: string, size: "hero" | "phone"): number {
	const n = Math.max(6, text.length);
	return size === "hero"
		? Math.max(40, Math.min(78, Math.round(1150 / n)))
		: Math.max(32, Math.min(46, Math.round(640 / n)));
}

export function Title({
	children,
	size,
}: {
	children: string;
	size: "hero" | "phone";
}) {
	return (
		<h1
			data-testid={OVERVIEW_TESTID.title}
			className="font-display leading-[.96] font-bold tracking-[-.02em] text-balance break-words text-white"
			style={{ fontSize: titlePx(children, size) }}
		>
			{children}
		</h1>
	);
}

// ---- countries -------------------------------------------------------------

export function CountryChips({ route }: { route: TripRoute }) {
	const by = new Map<string, { name: string; color: string; nights: number }>();
	for (const r of route.rows) {
		const c = by.get(r.countryKey);
		if (c) c.nights += r.nights;
		else
			by.set(r.countryKey, {
				name: r.countryName,
				color: r.color,
				nights: r.nights,
			});
	}
	if (!by.size) return null;
	return (
		<ul className="flex flex-wrap gap-2">
			{[...by.entries()].map(([k, c]) => (
				<li
					key={k}
					className="inline-flex h-[30px] items-center gap-2 rounded-full border border-white/10 bg-white/[.05] px-3 text-[13px] text-white"
				>
					<span
						className="size-2 rounded-full"
						style={{ background: c.color }}
					/>
					{c.name}
					<span className="font-mono text-white/55 tnum">
						{c.nights} {plural(c.nights, "night")}
					</span>
				</li>
			))}
		</ul>
	);
}

// ---- stats -------------------------------------------------------------------

export function Stats({
	data,
	cols,
	after,
}: {
	data: OverviewData;
	cols: 2 | 3;
	after: boolean;
}) {
	const { stats, rows } = data.route;
	const oneCountry = stats.countries === 1 ? rows[0]?.countryName : null;
	const items: { k: string; v: string; label: string }[] = [
		{
			k: "days",
			v: fmt(stats.days),
			label: after ? "days away" : plural(stats.days, "day"),
		},
		{
			k: "cities",
			v: fmt(stats.cities),
			label: `${plural(stats.cities, "city", "cities")} in ${oneCountry ?? `${stats.countries} ${plural(stats.countries, "country", "countries")}`}`,
		},
		{
			k: "places",
			v: fmt(stats.placesPlanned),
			label: after ? "places visited" : "places planned",
		},
		{
			k: "flights",
			v: fmt(stats.flights),
			label: stats.flights
				? `${plural(stats.flights, "flight")} · ~${stats.airHours} h in the air`
				: "flights",
		},
		{ k: "km", v: fmt(stats.km), label: "km travelled" },
		{ k: "media", v: fmt(data.media), label: "photos & videos saved" },
	];
	return (
		<div
			data-testid={OVERVIEW_TESTID.stats}
			className={cn("grid gap-2.5", cols === 3 ? "grid-cols-3" : "grid-cols-2")}
		>
			{items.map((s) => (
				<div
					key={s.k}
					data-testid={OVERVIEW_TESTID.stat}
					data-stat={s.k}
					className="flex min-w-0 flex-col gap-0.5 rounded-2xl border border-white/[.08] bg-white/[.04] px-4 py-3.5"
				>
					<span className="font-display text-[30px] leading-[1.1] font-bold text-white tnum">
						{s.v}
					</span>
					<span className="text-[13px] leading-snug text-white/60">
						{s.label}
					</span>
				</div>
			))}
		</div>
	);
}

// ---- the planning line (before) ------------------------------------------------

export function PlanningLine({ data }: { data: OverviewData }) {
	const { ix } = useWorkspace();
	const p = data.planning;
	const bits: { key: string; node: ReactNode }[] = [];
	const n = (v: number) => <b className="font-mono text-white tnum">{v}</b>;
	if (p.must)
		bits.push({
			key: "must",
			node: (
				<>
					{n(p.mustScheduled)} of {n(p.must)} Must places scheduled
				</>
			),
		});
	if (p.toBook)
		bits.push({
			key: "book",
			node: (
				<>
					{n(p.toBook)} {plural(p.toBook, "thing")} to book
				</>
			),
		});
	if (p.nightsWithoutStay)
		bits.push({
			key: "nights",
			node: (
				<>
					{n(p.nightsWithoutStay)} {plural(p.nightsWithoutStay, "night")}{" "}
					without a stay
				</>
			),
		});
	const next = p.next;
	if (!bits.length && !next) return null;
	return (
		<div
			data-testid={OVERVIEW_TESTID.planning}
			className="flex flex-col gap-1 text-sm text-white/70"
		>
			{bits.length ? (
				<p className="flex flex-wrap gap-x-2">
					{bits.map((b, i) => (
						<span key={b.key}>
							{i ? <span className="mr-2 text-white/30">·</span> : null}
							{b.node}
						</span>
					))}
				</p>
			) : null}
			{next ? (
				<p className="truncate text-[13px] text-white/55">
					Next deadline:{" "}
					<span className="text-white/85">
						{plainText(next.li.text)}
						{(() => {
							const c = todoContext(ix, next.li.target, next.li.text);
							return c ? ` · ${c}` : "";
						})()}
					</span>{" "}
					· {deadlineChip(next, data.now)}
				</p>
			) : null}
		</div>
	);
}

// ---- today (during) --------------------------------------------------------------

type TodayEntry = { id: string; name: string; done: boolean };

export function todayEntries(
	ix: GraphIndex,
	schedule: ScheduleResult,
	dayId: string,
	now: number,
): TodayEntry[] {
	const out: TodayEntry[] = [];
	for (const it of ix.itemsByDay.get(dayId) ?? []) {
		const node = it.nodeId ? ix.node(it.nodeId) : undefined;
		if (node?.category === "lodging") continue;
		const name = (it.title ?? node?.name ?? "").trim();
		if (!name) continue;
		const end = schedule.items[it.id]?.end.getTime();
		out.push({ id: it.id, name, done: end !== undefined && end <= now });
	}
	return out;
}

export function TodayList({
	data,
	line,
	tomorrow,
}: {
	data: OverviewData;
	line: DayLine;
	tomorrow: DayLine | null;
}) {
	const { ix, schedule, nav } = useWorkspace();
	const entries = todayEntries(ix, schedule, line.dayId, data.now);
	const shown = entries.slice(0, 7);
	const tIx = tomorrow ? todayEntries(ix, schedule, tomorrow.dayId, 0) : [];
	const first = tIx[0]?.name;
	// A travel day reads "Mt. Fuji → Kyoto": tomorrow is "on to Kyoto".
	const next = tomorrow?.city.split(" → ").at(-1) ?? "";
	const moving = !!next && next !== line.city;
	return (
		<div className="flex flex-col gap-2.5">
			<span className="text-xs font-semibold tracking-[.08em] text-white/55 uppercase">
				Today
			</span>
			{shown.length ? (
				<ul
					data-testid={OVERVIEW_TESTID.today}
					className="flex flex-col gap-1.5"
				>
					{shown.map((e) => (
						<li key={e.id}>
							<button
								type="button"
								data-testid={OVERVIEW_TESTID.todayItem}
								data-done={e.done}
								onClick={() => nav.select({ kind: "item", id: e.id })}
								className="flex w-full min-w-0 items-center gap-2.5 text-left text-[15px]"
							>
								<span
									className={cn(
										"size-2 shrink-0 rounded-full",
										e.done ? "bg-[#34c472]" : "border-[1.5px] border-white/40",
									)}
								/>
								<span
									className={cn(
										"min-w-0 truncate hover:underline",
										e.done ? "text-white/50 line-through" : "text-white",
									)}
								>
									{e.name}
								</span>
							</button>
						</li>
					))}
					{entries.length > shown.length ? (
						<li className="pl-[18px] text-[13px] text-white/50">
							+{entries.length - shown.length} more
						</li>
					) : null}
				</ul>
			) : (
				<p className="text-[15px] text-white/60">A free day.</p>
			)}
			{tomorrow && (first || moving) ? (
				<p
					data-testid={OVERVIEW_TESTID.tomorrow}
					className="text-[13px] text-white/55"
				>
					Tomorrow: {moving ? `on to ${next}` : null}
					{moving && first ? " · " : null}
					{first ? `${first} first` : null}
				</p>
			) : null}
		</div>
	);
}

/** "Sun 10 Oct · 07:12" (the day's own zone; no clock on an `?asOf` day). */
export function dayClock(
	date: string,
	tz: string,
	now: number,
	asOf: string | null,
): string {
	return asOf
		? formatDayDate(date)
		: `${formatDayDate(date)} · ${formatTime(now, tz)}`;
}
