/**
 * "How long in each city?" at the top of the Plan (`day-split.ts`), always
 * for the whole trip. Before any trip day has a city: the trip's days shared
 * between the cities with places, from what their shortlists need, with − /
 * +, the stops to reorder and "Use these days" (each city's nights in turn
 * from the first day). With no dates yet: about how many days first, and the
 * first day to use them (the trip's dates, then the nights). After: "Tokyo 4
 * days · Kyoto 3" with Change (the same panel, prefilled from the days).
 * While it's open the map shows the stops in order. Writes go through
 * `trip.dates`, `day.stay` and `item.move`, so suggest mode, proposals and
 * live sync hold.
 */
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { Star } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { toast } from "sonner";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/features/home/date-fields";
import { cityDayTable } from "@/features/places/lib/days";
import { raters } from "@/features/places/lib/rate";
import { useMoveItem, useSetDayStay } from "@/features/places/mutations";
import { buildRows, placesInScope } from "@/features/places/tab/model";
import { useShortlistBar } from "@/features/places/tab/use-bar";
import { setTripDates } from "@/functions/trips.functions";
import { indexGraph } from "@/lib/engine/graph-index";
import { addDays } from "@/lib/engine/time";
import { humanError } from "@/lib/errors";
import { formatDayDate } from "@/lib/format";
import { meKeys, tripKeys } from "@/lib/query/keys";
import { tripGraphQuery } from "@/lib/query/trip-queries";
import { isProposed } from "@/lib/schemas/proposals";
import { type SplitStop, useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	type ApplyPlan,
	applyPlan,
	dayCityIds,
	displacedText,
	layoutDays,
	leftToRate,
	leftToRateText,
	moveAt,
	overText,
	runsOf,
	type SplitEntry,
	splitCities,
	splitText,
	stepCity,
	stepEntry,
	suggestSplit,
	unusedText,
	withOrder,
	withOverrides,
} from "./day-split";
import { NO_FREE_DAY, SplitRows, type SplitRowView } from "./SplitRows";
import { SPLIT_TESTID as T } from "./testids";

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

/** The split's inputs, always for the whole trip (the days are the whole trip's). */
export function useDaySplit() {
	const { ix, graph, counts, access, schedule } = useWorkspace();
	const threshold = useShortlistBar().bar;
	const cityDays = useMemo(
		() => cityDayTable(ix, schedule, null),
		[ix, schedule],
	);
	const trip = useMemo(() => {
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
	}, [ix, graph, threshold, counts, cityDays]);
	const cities = useMemo(
		() =>
			splitCities(ix, trip.rows, cityDays, {
				raterIds: trip.raters.map((m) => m.id),
				capacityMin: ix.settings.dayCapacityMin,
			}),
		[ix, trip, cityDays],
	);
	const current = useMemo(() => dayCityIds(ix, cityDays), [ix, cityDays]);
	const left = useMemo(
		() => leftToRate(trip.rows, trip.raters, access.memberId),
		[trip, access.memberId],
	);
	// No day in a city with places yet: the split leads the Plan.
	const listed = new Set(cities.map((c) => c.id));
	const hasDays = current.some((c) => c !== null && listed.has(c));
	const rowById = useMemo(
		() => new Map(trip.rows.map((r) => [r.id, r])),
		[trip.rows],
	);
	return { cities, current, left, hasDays, rowById };
}

export type DaySplitInfo = ReturnType<typeof useDaySplit>;

/**
 * Applies a split: places first (off their day), then the nights. With no
 * dates yet, the trip's dates first, then the nights on the new days.
 */
export function useApplySplit() {
	const { graph } = useWorkspace();
	const tripId = graph.trip.id;
	const qc = useQueryClient();
	const move = useMoveItem(tripId);
	const stay = useSetDayStay(tripId);
	const dates = useTripMutation(
		(v: { startDate: string; endDate: string }) =>
			setTripDates({ data: { tripId, ...v } }),
		{
			tripId,
			keys: [
				tripKeys.graph(tripId),
				tripKeys.lists(tripId),
				tripKeys.counts(tripId),
				meKeys.trips,
			],
		},
	);
	const [busy, setBusy] = useState(false);
	const moveAsync = move.mutateAsync;
	const stayAsync = stay.mutateAsync;
	const datesAsync = dates.mutateAsync;
	const run = useCallback(async (fn: () => Promise<boolean>) => {
		setBusy(true);
		try {
			return await fn();
		} catch (e) {
			toast.error(humanError(e));
			return false;
		} finally {
			setBusy(false);
		}
	}, []);
	const apply = useCallback(
		(plan: ApplyPlan) =>
			run(async () => {
				for (const it of plan.displaced)
					await moveAsync({ itemId: it.id, dayId: null });
				for (const s of plan.stays) await stayAsync(s);
				return true;
			}),
		[run, moveAsync, stayAsync],
	);
	const applyWithDates = useCallback(
		(startDate: string, tripDays: number, entries: readonly SplitEntry[]) =>
			run(async () => {
				const endDate = addDays(startDate, tripDays - 1);
				// A suggestion: the dates wait for an editor, so the nights can't follow.
				if (isProposed(await datesAsync({ startDate, endDate }))) return false;
				const g = await qc.fetchQuery({
					...tripGraphQuery(tripId),
					staleTime: 0,
				});
				const next = indexGraph(g);
				const plan = applyPlan(
					next,
					layoutDays(entries, next.days.length),
					next.days.map(() => null),
				);
				for (const s of plan.stays) await stayAsync(s);
				return true;
			}),
		[run, datesAsync, qc, tripId, stayAsync],
	);
	return { apply, applyWithDates, busy };
}

type Apply = ReturnType<typeof useApplySplit>;

/** The stops in order on the map while this is shown (the trip map beside the Plan). */
function useRouteOnMap(rows: readonly SplitRowView[]) {
	const { ix } = useWorkspace();
	const setRoute = useUi((s) => s.setSplitRoute);
	const key = useMemo(() => {
		const out: SplitStop[] = [];
		let n = 0;
		for (const r of rows) {
			if (r.days < 1) continue;
			n += 1;
			const at = ix.coordOf(r.id);
			if (at)
				out.push({
					cityId: r.id,
					name: r.name,
					lng: at[0],
					lat: at[1],
					stop: n,
					days: r.days,
				});
		}
		return JSON.stringify(out);
	}, [ix, rows]);
	useEffect(() => setRoute(JSON.parse(key)), [key, setRoute]);
	useEffect(() => () => setRoute(null), [setRoute]);
}

/** "4 days not planned yet", or (none left, editors) how to free one. */
function UnusedLine({ unused, canEdit }: { unused: number; canEdit: boolean }) {
	if (!unused && !canEdit) return null;
	return (
		<p data-testid={T.splitUnused} className="text-sm text-muted-foreground">
			{unused ? unusedText(unused) : NO_FREE_DAY}
		</p>
	);
}

type SplitDraft = {
	/** − / + per city. */
	days?: Record<string, number>;
	/** The stops in the order you set. */
	order?: string[];
	/** No dates yet: about how many days, and the first. */
	tripDays?: number;
	start?: string | null;
};

/** Your changes to the suggestion, per trip: kept while the page is open, never saved. */
export const splitDrafts = new Map<string, SplitDraft>();

function useSplitDraft(tripId: string) {
	const [draft, setDraft] = useState<SplitDraft>(
		() => splitDrafts.get(tripId) ?? {},
	);
	const update = useCallback(
		(patch: SplitDraft) =>
			setDraft((d) => {
				const next = { ...d, ...patch };
				splitDrafts.set(tripId, next);
				return next;
			}),
		[tripId],
	);
	return [draft, update] as const;
}

const MAX_DAYS = 60;

/** The first split: the suggestion with − / + and your order on top, and "Use these days". */
function SplitSuggestion({
	info,
	canEdit,
	apply,
}: {
	info: DaySplitInfo;
	canEdit: boolean;
	apply: Apply;
}) {
	const { ix, graph, nav, access } = useWorkspace();
	const tripId = graph.trip.id;
	const [draft, update] = useSplitDraft(tripId);
	const dated = ix.days.length > 0;
	const [typed, setTyped] = useState(() =>
		draft.tripDays ? String(draft.tripDays) : "",
	);
	const tripDays = dated ? ix.days.length : (draft.tripDays ?? 0);
	const suggestion = useMemo(
		() => suggestSplit(ix, info.cities, tripDays),
		[ix, info.cities, tripDays],
	);
	const split = useMemo(
		() => withOrder(withOverrides(suggestion, draft.days ?? {}), draft.order),
		[suggestion, draft.days, draft.order],
	);
	const rows = useMemo<SplitRowView[]>(
		() => split.rows.map((r) => ({ ...r, key: r.id })),
		[split.rows],
	);
	const shown = tripDays > 0;
	useRouteOnMap(shown ? rows : []);
	const rateLine = leftToRateText(info.left);
	const entries: SplitEntry[] = split.rows
		.filter((r) => r.days > 0)
		.map((r) => ({ cityId: r.id, days: r.days }));
	const suggesting = access.mode === "suggest";
	const done = () => splitDrafts.delete(tripId);
	const use = async () => {
		if (dated) {
			const next = layoutDays(entries, ix.days.length);
			if (await apply.apply(applyPlan(ix, next, info.current))) done();
		} else if (draft.start) {
			if (await apply.applyWithDates(draft.start, tripDays, entries)) done();
		}
	};
	const need = info.cities.reduce((s, c) => s + c.need, 0);
	const first = ix.days[0]?.date ?? "";
	const last = ix.days.at(-1)?.date ?? first;
	return (
		<section
			data-testid={T.split}
			data-unused={split.unused}
			className="flex flex-col gap-3"
		>
			<header className="flex flex-col gap-1">
				<div className="flex flex-wrap items-baseline justify-between gap-x-3">
					<h2 className="font-display text-lg font-semibold">
						How long in each city?
					</h2>
					{dated ? (
						<span className="text-sm text-muted-foreground">
							{dayWord(tripDays)}, {tripRange(first, last)}
						</span>
					) : null}
				</div>
				<p className="max-w-prose text-sm text-muted-foreground">
					{canEdit
						? "Based on your shortlist. Change the days, reorder the stops, then use them."
						: "Based on your shortlist."}
				</p>
			</header>
			{dated ? null : (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<label
						htmlFor="split-trip-days"
						className="text-sm font-medium whitespace-nowrap"
					>
						About how many days?
					</label>
					<Input
						id="split-trip-days"
						type="number"
						inputMode="numeric"
						min={1}
						max={MAX_DAYS}
						data-testid={T.tripDays}
						value={typed}
						onChange={(e) => {
							setTyped(e.target.value);
							const n = Number(e.target.value);
							const ok = Number.isInteger(n) && n >= 1 && n <= MAX_DAYS;
							update({ tripDays: ok ? n : undefined });
						}}
						className="h-8 w-20"
					/>
					{need && !shown ? (
						<span className="text-sm text-muted-foreground">
							Your shortlist needs about {dayWord(need)}.
						</span>
					) : null}
				</div>
			)}
			{rateLine ? (
				<div
					data-testid={T.splitRate}
					className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted/60 px-3 py-2"
				>
					<p className="min-w-0 flex-1 text-sm">{rateLine}</p>
					{info.left[0]?.you ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() =>
								nav.openPlaces({ scopeId: null, patch: { pv: "rate" } })
							}
						>
							<Star />
							Rate
						</Button>
					) : null}
				</div>
			) : null}
			{shown ? (
				<>
					{split.need > split.tripDays ? (
						<p data-testid={T.splitOver} className="text-sm text-warning">
							{overText(split.need, split.tripDays)}
						</p>
					) : null}
					<SplitRows
						info={info}
						rows={rows}
						unused={split.unused}
						busy={apply.busy}
						onStep={
							canEdit
								? (i, delta) => {
										const id = split.rows[i]?.id;
										const o = id
											? stepCity(split, draft.days ?? {}, id, delta)
											: null;
										if (o) update({ days: o });
									}
								: null
						}
						onMove={
							canEdit
								? (from, to) => {
										const order = moveAt(
											split.rows.map((r) => r.id),
											from,
											to,
										);
										if (order) update({ order });
									}
								: null
						}
					/>
					<UnusedLine unused={split.unused} canEdit={canEdit} />
					{canEdit && !dated && suggesting ? (
						<p
							data-testid={T.suggestNote}
							className="max-w-prose text-sm text-muted-foreground"
						>
							You're suggesting, so this suggests the dates only. Once they're
							accepted, come back here to use these days.
						</p>
					) : null}
					{canEdit ? (
						<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
							{dated ? null : (
								<div className="flex items-center gap-2">
									<span className="text-sm whitespace-nowrap">Starting on</span>
									<div className="w-44">
										<DateField
											value={draft.start ?? null}
											onChange={(start) => update({ start })}
											testId={T.start}
										/>
									</div>
								</div>
							)}
							<Button
								data-testid={T.splitUse}
								disabled={
									apply.busy || !entries.length || (!dated && !draft.start)
								}
								onClick={() => void use()}
							>
								{!dated && suggesting
									? "Suggest these dates"
									: "Use these days"}
							</Button>
						</div>
					) : null}
				</>
			) : null}
		</section>
	);
}

/** "Tokyo 4 days · Kyoto 3 · Osaka 2" and Change (the same panel, prefilled). */
function DaysLine({
	info,
	onChange,
}: {
	info: DaySplitInfo;
	/** Null: read-only, or the panel is open. */
	onChange: (() => void) | null;
}) {
	const { ix } = useWorkspace();
	const { entries, unused } = useMemo(
		() => runsOf(info.current),
		[info.current],
	);
	const nameOf = (id: string) => ix.node(id)?.name ?? "?";
	const text = splitText(entries, nameOf);
	// One quiet line: beside the filter when there's room, else its own row.
	return (
		<div className="flex min-w-0 grow basis-full items-center gap-2 @md:ml-1 @md:basis-0">
			<p
				data-testid={T.splitDays}
				title={unused ? `${text} · ${unusedText(unused)}` : text}
				className="min-w-0 truncate text-sm"
			>
				<span className="font-medium">{text}</span>
				{unused ? (
					<span className="text-muted-foreground"> · {unusedText(unused)}</span>
				) : null}
			</p>
			{onChange ? (
				<Button
					size="xs"
					variant="outline"
					data-testid={T.splitChange}
					onClick={onChange}
					className="shrink-0"
				>
					Change
				</Button>
			) : null}
		</div>
	);
}

type KeyedEntry = SplitEntry & { key: string };

function ChangePanel({
	info,
	initial,
	apply,
	onClose,
}: {
	info: DaySplitInfo;
	initial: readonly SplitEntry[];
	apply: Apply;
	onClose: () => void;
}) {
	const { ix } = useWorkspace();
	const tripDays = ix.days.length;
	const busy = apply.busy;
	// The runs, then the cities with places and no days yet (a city can come back: keys stay put as rows move).
	const [entries, setEntries] = useState<KeyedEntry[]>(() => {
		const seen = new Map<string, number>();
		const key = (cityId: string) => {
			const n = (seen.get(cityId) ?? 0) + 1;
			seen.set(cityId, n);
			return `${cityId}:${n}`;
		};
		const rest = suggestSplit(ix, info.cities, tripDays).rows.filter(
			(r) => !initial.some((e) => e.cityId === r.id),
		);
		return [
			...initial.map((e) => ({ ...e, key: key(e.cityId) })),
			...rest.map((r) => ({ cityId: r.id, days: 0, key: key(r.id) })),
		];
	});
	const [confirm, setConfirm] = useState(false);
	const byId = useMemo(
		() => new Map(info.cities.map((c) => [c.id, c])),
		[info.cities],
	);
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
	const rows = useMemo<SplitRowView[]>(
		() =>
			entries.map((e) => ({
				key: e.key,
				id: e.cityId,
				name: ix.node(e.cityId)?.name ?? "?",
				days: e.days,
				shortlisted: byId.get(e.cityId)?.shortlisted ?? 0,
				notRated: byId.get(e.cityId)?.notRated ?? 0,
			})),
		[entries, ix, byId],
	);
	useRouteOnMap(rows);
	const edit = (n: KeyedEntry[] | null) => {
		if (!n) return;
		setEntries(n);
		setConfirm(false);
	};
	const run = async () => {
		if (await apply.apply(plan)) onClose();
	};
	return (
		<div className="flex flex-col gap-3 rounded-xl bg-muted/50 p-3 sm:p-4">
			<SplitRows
				info={info}
				rows={rows}
				unused={unused}
				busy={busy}
				onStep={(i, delta) => edit(stepEntry(entries, i, delta, tripDays))}
				onMove={(from, to) => edit(moveAt(entries, from, to))}
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

/**
 * The top of the Plan: its `header` row (with the days line once days have
 * cities, and Change opening the panel under it), then "How long in each
 * city?" while no day has a city (with no dates too). `fallback` when the
 * trip has no places in a city yet. Always for the whole trip.
 */
export function PlanSplit({
	header,
	banner,
	fallback = null,
	className,
}: {
	header?: ReactNode;
	/** Between the header row and the panel. */
	banner?: ReactNode;
	fallback?: ReactNode;
	className?: string;
}) {
	const info = useDaySplit();
	const { access } = useWorkspace();
	const apply = useApplySplit();
	const [open, setOpen] = useState(false);
	const cities = info.cities.length > 0;
	const line = cities && info.hasDays;
	const current = useMemo(() => runsOf(info.current).entries, [info.current]);
	return (
		<>
			{header || line ? (
				<div className="flex min-h-10 flex-wrap items-center gap-2 px-4 py-1.5">
					{header}
					{line ? (
						<DaysLine
							info={info}
							onChange={access.canEdit && !open ? () => setOpen(true) : null}
						/>
					) : null}
				</div>
			) : null}
			{banner}
			{!cities ? (
				fallback
			) : line ? (
				open ? (
					<div className={cn("px-4 pb-4", className)}>
						<ChangePanel
							info={info}
							initial={current}
							apply={apply}
							onClose={() => setOpen(false)}
						/>
					</div>
				) : null
			) : (
				<div className={cn("px-4 pb-4", className)}>
					<SplitSuggestion info={info} canEdit={access.canEdit} apply={apply} />
				</div>
			)}
		</>
	);
}
