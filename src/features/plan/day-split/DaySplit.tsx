/**
 * The day split on the Schedule step (`day-split.ts`). Before any trip day
 * has a city: the trip's days shared between the cities with places, from
 * what their shortlists need, with − / + and "Use these days" (each city's
 * nights in turn from the first day). After: "Days: Tokyo 4 · Kyoto 3" with
 * Change (the same − / +, prefilled from the days). Writes go through
 * `day.stay` and `item.move`, so suggest mode, proposals and live sync hold.
 */
import { cn } from "cn";
import { ChevronRight, Minus, Plus, Star } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { CategoryIcon } from "@/components/common/glyphs";
import { Button } from "@/components/ui/button";
import { raters } from "@/features/places/lib/rate";
import { useMoveItem, useSetDayStay } from "@/features/places/mutations";
import {
	buildRows,
	type PlaceRow,
	placesInScope,
} from "@/features/places/tab/model";
import { PLACES_TAB_TESTID as T } from "@/features/places/tab/testids";
import { ScoreChip } from "@/features/places/tab/ui";
import type { PlacesData } from "@/features/places/tab/use-places";
import { humanError } from "@/lib/errors";
import { formatDayDate, formatDuration } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	type ApplyPlan,
	applyPlan,
	dayCityIds,
	displacedText,
	layoutDays,
	leftToRate,
	leftToRateText,
	overText,
	runsOf,
	type SplitEntry,
	splitCities,
	splitText,
	stepCity,
	stepEntry,
	suggestSplit,
	unusedText,
	withOverrides,
} from "./day-split";

const NO_FREE_DAY = "No free days left. Take one from another city first.";

/** "Sat 2 – Fri 15 Oct", "Thu 30 Sep – Wed 6 Oct". */
function tripRange(first: string, last: string): string {
	const a = formatDayDate(first);
	if (first === last) return a;
	const b = formatDayDate(last);
	return first.slice(0, 7) === last.slice(0, 7)
		? `${a.replace(/ \w+$/, "")} – ${b}`
		: `${a} – ${b}`;
}

const dayWord = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** The split's inputs, trip-wide whatever the scope (the days are the whole trip's). */
export function useDaySplit(data: PlacesData) {
	const { ix, graph, scope, counts, access } = useWorkspace();
	const { rows: scoped, members: scopedRaters, threshold, cityDays } = data;
	const trip = useMemo(() => {
		if (!scope) return { rows: scoped, raters: scopedRaters };
		const liveIds = new Set(graph.nodes.map((n) => n.id));
		const nodes = placesInScope(ix, null, liveIds);
		const members = raters(graph.members, nodes);
		const rows = buildRows(ix, nodes, {
			memberIds: members.map((m) => m.id),
			threshold,
			counts,
			cityDays,
		});
		return { rows, raters: members };
	}, [scope, scoped, scopedRaters, threshold, cityDays, ix, graph, counts]);
	const cities = useMemo(
		() =>
			splitCities(ix, trip.rows, cityDays, {
				raterIds: trip.raters.map((m) => m.id),
				capacityMin: ix.settings.dayCapacityMin,
			}),
		[ix, trip, cityDays],
	);
	const suggestion = useMemo(
		() => suggestSplit(ix, cities, ix.days.length),
		[ix, cities],
	);
	const current = useMemo(() => dayCityIds(ix, cityDays), [ix, cityDays]);
	const left = useMemo(
		() => leftToRate(trip.rows, trip.raters, access.memberId),
		[trip, access.memberId],
	);
	// No day in a city with places yet: the split is the step's main content.
	const listed = new Set(cities.map((c) => c.id));
	const hasDays = current.some((c) => c !== null && listed.has(c));
	const rowById = useMemo(
		() => new Map(trip.rows.map((r) => [r.id, r])),
		[trip.rows],
	);
	return { cities, suggestion, current, left, hasDays, rowById };
}

export type DaySplitInfo = ReturnType<typeof useDaySplit>;

/** Applies a split: places first (off their day), then the nights. */
export function useApplySplit() {
	const { graph } = useWorkspace();
	const move = useMoveItem(graph.trip.id);
	const stay = useSetDayStay(graph.trip.id);
	const [busy, setBusy] = useState(false);
	const moveAsync = move.mutateAsync;
	const stayAsync = stay.mutateAsync;
	const apply = useCallback(
		async (plan: ApplyPlan): Promise<boolean> => {
			setBusy(true);
			try {
				for (const it of plan.displaced)
					await moveAsync({ itemId: it.id, dayId: null });
				for (const s of plan.stays) await stayAsync(s);
				return true;
			} catch (e) {
				toast.error(humanError(e));
				return false;
			} finally {
				setBusy(false);
			}
		},
		[moveAsync, stayAsync],
	);
	return { apply, busy };
}

type Row = {
	key: string;
	id: string;
	name: string;
	days: number;
	shortlisted: number;
	notRated: number;
};

/** A city's places under its row: the shortlist (what its days are for), then what's left to rate. */
function CityPlaces({ info, cityId }: { info: DaySplitInfo; cityId: string }) {
	const { nav } = useWorkspace();
	const city = info.cities.find((c) => c.id === cityId);
	if (!city) return null;
	const rowsOf = (ids: readonly string[]) =>
		ids.flatMap((id) => info.rowById.get(id) ?? []);
	const short = rowsOf(city.shortlistIds);
	const toRate = rowsOf(city.toRateIds);
	const open = (r: PlaceRow) => nav.select({ kind: "node", id: r.id });
	return (
		<div
			data-testid={T.splitPlaces}
			className="grid gap-2 pb-3 pl-11 pr-4 text-sm"
		>
			{short.length ? (
				<>
					<p className="text-xs text-muted-foreground">
						About {formatDuration(city.minutes, { compact: true })} of sights on
						the shortlist
					</p>
					<ul className="grid gap-0.5">
						{short.map((r) => (
							<li key={r.id}>
								<button
									type="button"
									data-testid={T.splitPlace}
									onClick={() => open(r)}
									className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent"
								>
									{r.node.category ? (
										<CategoryIcon
											category={r.node.category}
											className="size-3.5 text-muted-foreground"
										/>
									) : (
										<span className="size-3.5" />
									)}
									<span className="min-w-0 flex-1 truncate">{r.node.name}</span>
									<span className="shrink-0 font-mono text-xs text-muted-foreground tnum">
										{r.timeMin
											? formatDuration(r.timeMin, { compact: true })
											: ""}
									</span>
									<ScoreChip score={r.score} size="sm" />
								</button>
							</li>
						))}
					</ul>
				</>
			) : (
				<p className="text-xs text-muted-foreground">
					Nothing shortlisted here yet.
				</p>
			)}
			{toRate.length ? (
				<p className="text-xs text-muted-foreground">
					<span className="font-medium text-foreground">Not rated yet:</span>{" "}
					{toRate.map((r, i) => (
						<span key={r.id}>
							{i ? ", " : ""}
							<button
								type="button"
								onClick={() => open(r)}
								className="cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
							>
								{r.node.name}
							</button>
						</span>
					))}
				</p>
			) : null}
			{city.belowShortlist ? (
				<p className="text-xs text-muted-foreground">
					{city.belowShortlist}{" "}
					{city.belowShortlist === 1 ? "other place" : "other places"} didn't
					make the shortlist.
				</p>
			) : null}
		</div>
	);
}

function SplitRows({
	info,
	rows,
	unused,
	onStep,
	busy,
}: {
	info: DaySplitInfo;
	rows: readonly Row[];
	unused: number;
	/** Null: read-only (no − / +). */
	onStep: ((index: number, delta: 1 | -1) => void) | null;
	busy: boolean;
}) {
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
	const toggle = (id: string) =>
		setOpen((s) => {
			const n = new Set(s);
			if (n.has(id)) n.delete(id);
			else n.add(id);
			return n;
		});
	return (
		<ul className="@container divide-y rounded-xl border bg-card">
			{rows.map((r, i) => (
				<li
					key={r.key}
					data-testid={T.splitRow}
					data-city={r.id}
					data-days={r.days}
				>
					<div className="flex items-center gap-3 px-4 py-2.5 @lg:grid @lg:grid-cols-[1.5rem_minmax(0,10rem)_4.5rem_minmax(0,1fr)_auto]">
						<button
							type="button"
							data-testid={T.splitExpand}
							aria-expanded={open.has(r.id)}
							aria-label={`${open.has(r.id) ? "Hide" : "Show"} the places in ${r.name}`}
							onClick={() => toggle(r.id)}
							className="-ml-1.5 grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
						>
							<ChevronRight
								className={cn(
									"size-4 transition-transform",
									open.has(r.id) && "rotate-90",
								)}
							/>
						</button>
						<div className="min-w-0 flex-1 @lg:contents">
							<div className="flex min-w-0 items-baseline gap-2 @lg:contents">
								<button
									type="button"
									onClick={() => toggle(r.id)}
									className={cn(
										"cursor-pointer truncate text-left text-[15px] font-medium hover:underline",
										!r.days && "text-muted-foreground",
									)}
								>
									{r.name}
								</button>
								<span
									className={cn(
										"shrink-0 text-sm",
										!r.days && "text-muted-foreground",
									)}
								>
									<span className="font-mono tnum">{r.days}</span>{" "}
									{r.days === 1 ? "day" : "days"}
								</span>
							</div>
							<span className="block truncate text-xs text-muted-foreground @lg:text-[13px]">
								{r.shortlisted} shortlisted
								{r.notRated ? ` · ${r.notRated} not rated yet` : ""}
							</span>
						</div>
						{onStep ? (
							<div className="flex shrink-0 gap-1">
								<Button
									variant="outline"
									size="icon-sm"
									data-testid={T.splitMinus}
									aria-label={`One day less in ${r.name}`}
									disabled={busy || r.days < 1}
									onClick={() => onStep(i, -1)}
								>
									<Minus />
								</Button>
								<Button
									variant="outline"
									size="icon-sm"
									data-testid={T.splitPlus}
									aria-label={`One day more in ${r.name}`}
									title={unused < 1 ? NO_FREE_DAY : undefined}
									disabled={busy || unused < 1}
									onClick={() => onStep(i, 1)}
								>
									<Plus />
								</Button>
							</div>
						) : null}
					</div>
					{open.has(r.id) ? <CityPlaces info={info} cityId={r.id} /> : null}
				</li>
			))}
		</ul>
	);
}

/** "4 days not used", or (none left, editors) how to free one. */
function UnusedLine({ unused, canEdit }: { unused: number; canEdit: boolean }) {
	if (!unused && !canEdit) return null;
	return (
		<p data-testid={T.splitUnused} className="text-sm text-muted-foreground">
			{unused ? unusedText(unused) : NO_FREE_DAY}
		</p>
	);
}

/** − / + on the suggestion, per trip: kept while the page is open (the Rate step and back), never saved. */
export const splitOverrides = new Map<string, Record<string, number>>();

/** The first split: the suggestion with − / + on top and "Use these days". */
export function SplitSuggestion({
	info,
	canEdit,
	onRate,
	apply,
	busy,
}: {
	info: DaySplitInfo;
	canEdit: boolean;
	onRate: () => void;
	apply: (plan: ApplyPlan) => Promise<boolean>;
	busy: boolean;
}) {
	const { ix, graph } = useWorkspace();
	const tripId = graph.trip.id;
	const [overrides, setState] = useState(
		() => splitOverrides.get(tripId) ?? {},
	);
	const setOverrides = (o: Record<string, number>) => {
		splitOverrides.set(tripId, o);
		setState(o);
	};
	const split = useMemo(
		() => withOverrides(info.suggestion, overrides),
		[info.suggestion, overrides],
	);
	const rateLine = leftToRateText(info.left);
	const first = ix.days[0]?.date ?? "";
	const last = ix.days.at(-1)?.date ?? first;
	const entries: SplitEntry[] = split.rows
		.filter((r) => r.days > 0)
		.map((r) => ({ cityId: r.id, days: r.days }));
	const use = async () => {
		const next = layoutDays(entries, ix.days.length);
		if (await apply(applyPlan(ix, next, info.current)))
			splitOverrides.delete(tripId);
	};
	return (
		<section
			data-testid={T.split}
			data-unused={split.unused}
			className="flex flex-col gap-3"
		>
			<h2 className="font-display text-lg font-semibold">
				{dayWord(split.tripDays)}, {tripRange(first, last)}
			</h2>
			{rateLine ? (
				<div
					data-testid={T.splitRate}
					className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted/60 px-3 py-2"
				>
					<p className="min-w-0 flex-1 text-sm">{rateLine}</p>
					{info.left[0]?.you ? (
						<Button size="sm" variant="outline" onClick={onRate}>
							<Star />
							Rate
						</Button>
					) : null}
				</div>
			) : null}
			{split.need > split.tripDays ? (
				<p data-testid={T.splitOver} className="text-sm text-warning">
					{overText(split.need, split.tripDays)}
				</p>
			) : null}
			<SplitRows
				info={info}
				rows={split.rows.map((r) => ({ ...r, key: r.id }))}
				unused={split.unused}
				busy={busy}
				onStep={
					canEdit
						? (i, delta) => {
								const id = split.rows[i]?.id;
								const o = id ? stepCity(split, overrides, id, delta) : null;
								if (o) setOverrides(o);
							}
						: null
				}
			/>
			<UnusedLine unused={split.unused} canEdit={canEdit} />
			{canEdit ? (
				<Button
					data-testid={T.splitUse}
					className="self-start"
					disabled={busy || !entries.length}
					onClick={() => void use()}
				>
					Use these days
				</Button>
			) : null}
		</section>
	);
}

/** "Days: Tokyo 4 · Kyoto 3 · Osaka 2" and Change (the − / + panel). */
export function DaysLine({
	info,
	canEdit,
	apply,
	busy,
}: {
	info: DaySplitInfo;
	canEdit: boolean;
	apply: (plan: ApplyPlan) => Promise<boolean>;
	busy: boolean;
}) {
	const { ix } = useWorkspace();
	const [open, setOpen] = useState(false);
	const { entries, unused } = useMemo(
		() => runsOf(info.current),
		[info.current],
	);
	const nameOf = (id: string) => ix.node(id)?.name ?? "?";
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<p data-testid={T.splitDays} className="text-sm">
					<span className="text-muted-foreground">Days:</span>{" "}
					<span className="font-medium">{splitText(entries, nameOf)}</span>
					{unused ? (
						<span className="text-muted-foreground">
							{" "}
							· {unusedText(unused)}
						</span>
					) : null}
				</p>
				{canEdit && !open ? (
					<Button
						size="xs"
						variant="outline"
						data-testid={T.splitChange}
						onClick={() => setOpen(true)}
					>
						Change
					</Button>
				) : null}
			</div>
			{open ? (
				<ChangePanel
					info={info}
					initial={entries}
					apply={apply}
					busy={busy}
					onClose={() => setOpen(false)}
				/>
			) : null}
		</div>
	);
}

function ChangePanel({
	info,
	initial,
	apply,
	busy,
	onClose,
}: {
	info: DaySplitInfo;
	initial: readonly SplitEntry[];
	apply: (plan: ApplyPlan) => Promise<boolean>;
	busy: boolean;
	onClose: () => void;
}) {
	const { ix } = useWorkspace();
	const tripDays = ix.days.length;
	// The runs, then the cities with places and no days yet.
	const [entries, setEntries] = useState<SplitEntry[]>(() => {
		const seen = new Set(initial.map((e) => e.cityId));
		return [
			...initial,
			...info.suggestion.rows
				.filter((r) => !seen.has(r.id))
				.map((r) => ({ cityId: r.id, days: 0 })),
		];
	});
	const [confirm, setConfirm] = useState(false);
	const byId = new Map(info.cities.map((c) => [c.id, c]));
	const used = entries.reduce((s, e) => s + e.days, 0);
	const unused = Math.max(0, tripDays - used);
	const next = useMemo(
		() =>
			layoutDays(
				entries.filter((e) => e.days > 0),
				tripDays,
			),
		[entries, tripDays],
	);
	const plan = useMemo(
		() => applyPlan(ix, next, info.current),
		[ix, next, info.current],
	);
	const changed = next.some((c, i) => c !== (info.current[i] ?? null));
	const rows: Row[] = entries.map((e, i) => ({
		key: `${e.cityId}:${i}`,
		id: e.cityId,
		name: ix.node(e.cityId)?.name ?? "?",
		days: e.days,
		shortlisted: byId.get(e.cityId)?.shortlisted ?? 0,
		notRated: byId.get(e.cityId)?.notRated ?? 0,
	}));
	const run = async () => {
		if (await apply(plan)) onClose();
	};
	return (
		<div className="flex flex-col gap-3 rounded-xl bg-muted/50 p-3 sm:p-4">
			<SplitRows
				info={info}
				rows={rows}
				unused={unused}
				busy={busy}
				onStep={(i, delta) => {
					const n = stepEntry(entries, i, delta, tripDays);
					if (n) {
						setEntries(n);
						setConfirm(false);
					}
				}}
			/>
			<UnusedLine unused={unused} canEdit />
			{confirm ? (
				<div
					data-testid={T.splitConfirm}
					className="flex flex-col gap-2 rounded-lg bg-warning-wash px-3 py-2.5"
				>
					<p className="text-sm">{displacedText(plan.displaced.length)}</p>
					<div className="flex gap-2">
						<Button
							size="sm"
							data-testid={T.splitApply}
							disabled={busy}
							onClick={() => void run()}
						>
							Apply
						</Button>
						<Button
							size="sm"
							variant="ghost"
							data-testid={T.splitCancel}
							disabled={busy}
							onClick={() => setConfirm(false)}
						>
							Cancel
						</Button>
					</div>
				</div>
			) : (
				<div className="flex gap-2">
					<Button
						size="sm"
						data-testid={T.splitApply}
						disabled={busy || !changed}
						onClick={() =>
							plan.displaced.length ? setConfirm(true) : void run()
						}
					>
						Apply
					</Button>
					<Button
						size="sm"
						variant="ghost"
						data-testid={T.splitCancel}
						disabled={busy}
						onClick={onClose}
					>
						Cancel
					</Button>
				</div>
			)}
		</div>
	);
}
