/**
 * docs/OVERVIEW.md §5 "Day by day": one line per day — Day N · date · the
 * night's city with its country's dot · the day's headline places — grouped
 * by stay, the whole trip in two screens. A long trip folds per country
 * (the route's rows); the country you're in (or the first two) stay open.
 * A click opens that day in the Plan. Which countries are open travels with
 * my view (a follower's open with mine).
 */
import { cn } from "cn";
import { ChevronDown } from "lucide-react";
import { useMemo } from "react";
import { formatDayDate } from "@/lib/format";
import { ids, useFollowState } from "@/lib/realtime/view-ui";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { type DayLine, type DaySection, daySections } from "./lib/day-lines";
import { countryLabel, type TripRoute } from "./lib/trip-route";
import { OVERVIEW_TESTID } from "./testids";

/** Past this many days, each country's days fold. */
const FOLD_AFTER = 21;

/** A country section's id: its first day. */
const keyOf = (sec: DaySection, i: number) =>
	sec.groups[0]?.lines[0]?.dayId ?? `s${i}`;

export function DayByDay({
	route,
	lines,
	today,
	narrow,
}: {
	route: TripRoute;
	lines: DayLine[];
	/** During the trip: today's date (its line is marked, its country open). */
	today: string | null;
	narrow: boolean;
}) {
	const sections = useMemo(() => daySections(lines, route), [lines, route]);
	const fold = lines.length > FOLD_AFTER && sections.length > 1;
	const current = today
		? sections.findIndex((s) =>
				s.groups.some((g) => g.lines.some((l) => l.date === today)),
			)
		: -1;
	const [open, setOpen] = useFollowState<string[]>(
		"overview.days",
		() =>
			(current >= 0 ? [current] : [0, 1]).flatMap((i) => {
				const sec = sections[i];
				return sec ? [keyOf(sec, i)] : [];
			}),
		ids,
	);
	if (!lines.length) return null;
	return (
		<section
			data-testid={OVERVIEW_TESTID.days}
			data-cursor-anchor="sec:ov.days"
			className="min-w-0"
		>
			<h2 className="mb-3 font-display text-[22px] font-semibold">
				Day by day
			</h2>
			<div className="flex flex-col gap-3">
				{sections.map((sec, i) => {
					const key = keyOf(sec, i);
					const isOpen = !fold || open.includes(key);
					return (
						<div
							key={`${sec.rowIndex}-${key}`}
							data-testid={OVERVIEW_TESTID.daySection}
							data-open={isOpen}
							data-cursor-anchor={`sec:ov.days.${key}`}
						>
							{fold ? (
								<SectionHeader
									sec={sec}
									open={isOpen}
									onToggle={() =>
										setOpen((s) =>
											s.includes(key)
												? s.filter((k) => k !== key)
												: [...s, key],
										)
									}
								/>
							) : null}
							{isOpen ? (
								<div className="flex flex-col gap-2">
									{sec.groups.map((g) => (
										<div
											key={g.lines[0]?.dayId}
											className="border-l-2 pl-2.5"
											style={{
												borderColor:
													g.stayIndex !== null
														? `${route.stays[g.stayIndex]?.color ?? "#a3a3a3"}99`
														: "transparent",
											}}
										>
											{g.lines.map((l) => (
												<Line
													key={l.dayId}
													line={l}
													today={l.date === today}
													narrow={narrow}
												/>
											))}
										</div>
									))}
								</div>
							) : null}
						</div>
					);
				})}
			</div>
		</section>
	);
}

function SectionHeader({
	sec,
	open,
	onToggle,
}: {
	sec: DaySection;
	open: boolean;
	onToggle: () => void;
}) {
	const row = sec.row;
	const name = row ? countryLabel(row) : "The trip";
	return (
		<button
			type="button"
			aria-expanded={open}
			onClick={onToggle}
			className="mb-1 flex w-full min-w-0 items-center gap-2.5 rounded-lg px-1 py-1.5 text-left hover:bg-accent/60"
		>
			<span
				className="size-2.5 shrink-0 rounded-full"
				style={{ background: row?.color ?? "#a3a3a3" }}
			/>
			<span className="shrink-0 text-sm font-semibold">{name}</span>
			<span className="shrink-0 font-mono text-xs text-muted-foreground tnum">
				{sec.days} {sec.days === 1 ? "day" : "days"}
			</span>
			<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
				{row?.cities.join(" · ")}
			</span>
			<ChevronDown
				className={cn(
					"size-4 shrink-0 text-muted-foreground transition-transform",
					open && "rotate-180",
				)}
			/>
		</button>
	);
}

function Line({
	line: l,
	today,
	narrow,
}: {
	line: DayLine;
	today: boolean;
	narrow: boolean;
}) {
	const { nav } = useWorkspace();
	const dot = (
		<span
			className="size-2 shrink-0 rounded-full"
			style={{ background: l.color ?? "var(--muted-foreground)" }}
		/>
	);
	const places = l.places.length ? l.places.join(" · ") : null;
	return (
		<button
			type="button"
			data-testid={OVERVIEW_TESTID.day}
			data-date={l.date}
			data-cursor-anchor={`day:${l.dayId}`}
			aria-current={today ? "date" : undefined}
			onClick={() => nav.setDays({ from: l.date, to: l.date })}
			className={cn(
				"w-full min-w-0 border-b border-border/60 text-left text-sm transition-colors last:border-b-0 hover:bg-accent/50",
				narrow
					? "flex flex-col gap-0.5 py-2"
					: "grid min-h-[42px] grid-cols-[30px_92px_minmax(0,150px)_minmax(0,1fr)] items-center gap-3",
				today && "rounded-md bg-primary/8 ring-1 ring-primary/30",
			)}
		>
			{narrow ? (
				<>
					<span className="flex min-w-0 items-center gap-2">
						<span className="font-mono text-xs text-muted-foreground tnum">
							Day {l.n}
						</span>
						<span className="text-muted-foreground">
							{formatDayDate(l.date)}
						</span>
						{dot}
						<span className="min-w-0 truncate font-semibold">
							{l.city || "—"}
						</span>
					</span>
					{places ? (
						<span className="truncate text-[13px] text-foreground/80">
							{places}
						</span>
					) : null}
				</>
			) : (
				<>
					<span className="pl-1 font-mono text-xs text-muted-foreground tnum">
						{l.n}
					</span>
					<span className="text-muted-foreground">{formatDayDate(l.date)}</span>
					<span className="flex min-w-0 items-center gap-2 font-semibold">
						{dot}
						<span className="truncate">{l.city || "—"}</span>
					</span>
					<span className="truncate text-foreground/80">
						{places ?? (
							<span className="text-muted-foreground">Nothing planned yet</span>
						)}
					</span>
				</>
			)}
		</button>
	);
}
