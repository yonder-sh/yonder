/**
 * "How long in each city?" at the top of the Plan (`day-split.ts`), always
 * for the whole trip: the route, in nights. With no city yet: "Where to
 * first?". Before any night has a city: the trip's nights shared between its
 * cities, from what their shortlists need (a city added on its own gets a
 * few), with − / +, the stops to reorder, "Where next?" and "Put it on the
 * days" (each city's nights in turn from the first day; the last day, the
 * day you leave, is a day of the last city). With no dates yet: "When do you
 * arrive?" first, and the trip then ends when the route does. After: Cities &
 * nights (the same rows, prefilled from the days).
 *
 * Until a place is on a day, every change is saved as it's made (the latest
 * one, one save at a time), so a reload keeps the route and the group sees
 * it. After that, a change waits for Apply, which says which places leave
 * their day; so does everything while suggesting. While it's open the map
 * shows the stops in order. Writes go through `trip.dates`, `day.stays` and
 * `item.move`, so suggest mode, proposals and live sync hold.
 */
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Star } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { DateInput, Segmented } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { cityDayTable, cityRowNodes } from "@/features/places/lib/days";
import { raters } from "@/features/places/lib/rate";
import { useMoveItem, useSetDayStays } from "@/features/places/mutations";
import { buildRows, placesInScope } from "@/features/places/tab/model";
import { useShortlistBar } from "@/features/places/tab/use-bar";
import { setTripDates } from "@/functions/trips.functions";
import { indexGraph } from "@/lib/engine/graph-index";
import { addDays } from "@/lib/engine/time";
import type { TripGraph } from "@/lib/engine/types";
import { humanError } from "@/lib/errors";
import { formatDayDate } from "@/lib/format";
import { meKeys, tripKeys } from "@/lib/query/keys";
import { tripGraphQuery } from "@/lib/query/trip-queries";
import { bool, useFollowState } from "@/lib/realtime/view-ui";
import { isProposed } from "@/lib/schemas/proposals";
import { cn } from "@/lib/utils";
import { type SplitStop, useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	type ApplyPlan,
	applyPlan,
	type DaySplit,
	dayCityIds,
	dayRange,
	displacedText,
	hasPlacesOnDays,
	layoutNights,
	leftToRate,
	leftToRateText,
	moveAt,
	nightRunsOf,
	nightsIn,
	overText,
	type SplitEntry,
	type StayRange,
	splitCities,
	stepCity,
	stepEntry,
	suggestSplit,
	unusedText,
	withOrder,
	withOverrides,
} from "./day-split";
import { NO_FREE_DAY, SplitRows, type SplitRowView } from "./SplitRows";
import { SPLIT_TESTID as T } from "./testids";

const nightWord = (n: number) => `${n} ${n === 1 ? "night" : "nights"}`;

/** What you travel through, not to: a city holding only these isn't a stop. */
const THROUGH = new Set(["airport", "station", "port"]);

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
	const current = useMemo(() => dayCityIds(ix, cityDays), [ix, cityDays]);
	// The route's cities: every city but one that only holds what you travel
	// through (Newark for its airport), unless it has nights or was picked in
	// "Where to first?".
	const routeCities = useUi((s) => s.routeCities);
	const cities = useMemo(() => {
		const on = new Set([...routeCities, ...current.filter((c) => c !== null)]);
		const through = (id: string) => {
			const kids = ix.children(id);
			return (
				kids.length > 0 &&
				kids.every((k) => k.type === "place" && THROUGH.has(k.category ?? ""))
			);
		};
		return splitCities(ix, trip.rows, cityDays, {
			raterIds: trip.raters.map((m) => m.id),
			capacityMin: ix.settings.dayCapacityMin,
			cities: cityRowNodes(ix).filter((n) => on.has(n.id) || !through(n.id)),
		});
	}, [ix, trip, cityDays, current, routeCities]);
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
	// A place on a day: route changes wait for Apply (before, each is saved as it's made).
	const planned = useMemo(() => hasPlacesOnDays(ix), [ix]);
	return { cities, current, left, hasDays, rowById, planned };
}

export type DaySplitInfo = ReturnType<typeof useDaySplit>;

/**
 * Applies a split: places first (off their day), then the nights in one
 * save. With no dates yet, the trip's dates first, then the nights on the
 * new days. `save` is the route saved as it changes (no place on a day).
 */
export function useApplySplit() {
	const { graph } = useWorkspace();
	const tripId = graph.trip.id;
	const latest = useRef(graph);
	latest.current = graph;
	const qc = useQueryClient();
	const move = useMoveItem(tripId);
	const stays = useSetDayStays(tripId);
	const dates = useTripMutation(
		(v: { startDate: string; endDate: string; followRoute?: boolean }) =>
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
	const staysAsync = stays.mutateAsync;
	const datesAsync = dates.mutateAsync;
	const write = useCallback(
		async (list: readonly StayRange[]) => {
			if (list.length) await staysAsync({ stays: [...list] });
		},
		[staysAsync],
	);
	// The trip as the server has it now (after the writes before).
	const fresh = useCallback(
		async () =>
			indexGraph(
				await qc.fetchQuery({ ...tripGraphQuery(tripId), staleTime: 0 }),
			),
		[qc, tripId],
	);
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
				await write(plan.stays);
				return true;
			}),
		[run, moveAsync, write],
	);
	/** No dates yet: they come from the day you arrive and the nights (`followRoute`: the end follows the route). */
	const applyWithDates = useCallback(
		(
			startDate: string,
			tripDays: number,
			entries: readonly SplitEntry[],
			followRoute = false,
		) =>
			run(async () => {
				const endDate = addDays(startDate, tripDays - 1);
				const v = followRoute
					? { startDate, endDate, followRoute }
					: { startDate, endDate };
				// A suggestion: the dates wait for an editor, so the nights can't follow.
				if (isProposed(await datesAsync(v))) return false;
				const next = await fresh();
				const plan = applyPlan(
					next,
					layoutNights(entries, next.days.length),
					next.days.map(() => null),
				);
				await write(plan.stays);
				return true;
			}),
		[run, datesAsync, fresh, write],
	);
	/**
	 * The route saved as it changes: its nights laid on the days; a trip whose
	 * end follows its route first grows to hold them. Nothing when a place got
	 * onto a day meanwhile (that change waits for Apply). Never busy: the rows
	 * stay usable while it saves.
	 */
	const save = useCallback(
		async (entries: readonly SplitEntry[], followRoute: boolean) => {
			try {
				// The server's trip with the saves before (never the suggestions shown).
				let ix = indexGraph(
					qc.getQueryData<TripGraph>(tripKeys.graph(tripId)) ?? latest.current,
				);
				const first = ix.days[0]?.date;
				if (!first || hasPlacesOnDays(ix)) return false;
				const need = entries.reduce((s, e) => s + e.days, 0);
				if (followRoute && need > nightsIn(ix.days.length)) {
					const endDate = addDays(first, need);
					const v = { startDate: first, endDate, followRoute };
					if (isProposed(await datesAsync(v))) return false;
					ix = await fresh();
				}
				const next = layoutNights(entries, ix.days.length);
				await write(applyPlan(ix, next, next).stays);
				return true;
			} catch {
				// The failed write said why (the mutations' toast) and rolled back.
				return false;
			}
		},
		[qc, tripId, fresh, datesAsync, write],
	);
	/** A trip whose end follows its route, ended on `endDate` (its unplaced nights go). */
	const endOn = useCallback(
		(startDate: string, endDate: string) =>
			run(
				async () =>
					!isProposed(
						await datesAsync({ startDate, endDate, followRoute: true }),
					),
			),
		[run, datesAsync],
	);
	return { apply, applyWithDates, save, endOn, busy };
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

/** "4 nights not placed yet" (and `end`, when the trip can end sooner), or (none left, editors) how to free one. */
function UnusedLine({
	unused,
	canEdit,
	end = null,
}: {
	unused: number;
	canEdit: boolean;
	end?: ReactNode;
}) {
	if (!unused && !canEdit) return null;
	return (
		<p data-testid={T.splitUnused} className="text-sm text-muted-foreground">
			{unused ? unusedText(unused) : NO_FREE_DAY}
			{unused && end ? <> · {end}</> : null}
		</p>
	);
}

type SplitDraft = {
	/** − / + per city. */
	days?: Record<string, number>;
	/** The stops in the order you set. */
	order?: string[];
	/** No dates yet: the day you arrive. */
	start?: string | null;
};

/** Your changes to the suggestion while they wait (suggesting, or no dates yet), per trip: kept while the page is open. */
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

/** With no dates, the nights you set make the trip: no cap but this. */
const MAX_NIGHTS = 120;
/** The nights a city added on its own starts with (within what's free). */
const ADDED_NIGHTS = 3;

/**
 * The cities just picked in "Where to first?" / "Where next?" once the route
 * has them (each once): `onAdd` places them.
 */
function useRouteAdds(info: DaySplitInfo, onAdd: (ids: string[]) => void) {
	const waiting = useUi((s) => s.routeAdds);
	const take = useUi((s) => s.takeRouteAdds);
	const add = useRef(onAdd);
	add.current = onAdd;
	useEffect(() => {
		if (!waiting.length) return;
		const known = new Set(info.cities.map((c) => c.id));
		const ids = take((id) => known.has(id));
		if (ids.length) add.current(ids);
	}, [waiting, info.cities, take]);
}

/**
 * Saves the route as you change it: the latest change only, one save at a
 * time, so quick − / + taps become one save (and one line in the trip's
 * activity). `saving` while one runs.
 */
function useRouteSaver(save: (entries: SplitEntry[]) => Promise<boolean>) {
	const fn = useRef(save);
	fn.current = save;
	const state = useRef<{ next: SplitEntry[] | null; running: boolean }>({
		next: null,
		running: false,
	});
	const [saving, setSaving] = useState(false);
	const queue = useCallback((entries: SplitEntry[]) => {
		const s = state.current;
		s.next = entries;
		if (s.running) return;
		s.running = true;
		setSaving(true);
		void (async () => {
			while (s.next) {
				const list = s.next;
				s.next = null;
				await fn.current(list);
			}
			s.running = false;
			setSaving(false);
		})();
	}, []);
	return { queue, saving };
}

/** "+ Where next?": a city at the end of the route (a country asks for its city). */
function WhereNext() {
	const openAddPlace = useUi((s) => s.openAddPlace);
	return (
		<Button
			variant="outline"
			size="sm"
			data-testid={T.whereNext}
			className="self-start"
			onClick={() => openAddPlace({ mode: "first", next: true })}
		>
			<Plus />
			Where next?
		</Button>
	);
}

/** No city yet: the route starts here, or with places saved first. */
function RouteStart() {
	const { nav } = useWorkspace();
	const openAddPlace = useUi((s) => s.openAddPlace);
	return (
		<section
			data-testid={T.routeStart}
			data-cursor-anchor="sec:split"
			className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-4 sm:p-5"
		>
			<h2 className="font-display text-lg font-semibold">Where to first?</h2>
			<p className="max-w-prose text-sm text-muted-foreground">
				Add the cities you'll sleep in, in the order you travel, and the nights
				in each. Your days follow, and you can change it any time.
			</p>
			<Button
				data-testid={T.routeStartSearch}
				onClick={() => openAddPlace({ mode: "first" })}
			>
				<Search />
				Find a city or country
			</Button>
			<p className="max-w-prose text-sm text-muted-foreground">
				Not sure yet?{" "}
				<button
					type="button"
					onClick={() => nav.openPlaces({ scopeId: null })}
					className="cursor-pointer font-medium text-foreground underline underline-offset-2"
				>
					Save places first
				</button>{" "}
				and Yonder suggests a route from what everyone likes.
			</p>
		</section>
	);
}

/** The rows with nights, as a split to put on the days. */
const entriesOf = (split: DaySplit): SplitEntry[] =>
	split.rows
		.filter((r) => r.days > 0)
		.map((r) => ({ cityId: r.id, days: r.days }));

/**
 * The first split: the suggestion with − / + and your order on top, "Where
 * next?" and "Put it on the days". Saving as you go (`live`), any change
 * puts it on the days and opens Cities & nights. With no dates: "When do you
 * arrive?" first, and that day with the nights you set make the trip's dates
 * (saving as you go, as soon as it's picked; while suggesting, with the
 * button).
 */
function SplitSuggestion({
	info,
	canEdit,
	live,
	apply,
}: {
	info: DaySplitInfo;
	canEdit: boolean;
	live: boolean;
	apply: Apply;
}) {
	const { ix, graph, nav, access } = useWorkspace();
	const tripId = graph.trip.id;
	const askSplit = useUi((s) => s.askSplit);
	const [draft, update] = useSplitDraft(tripId);
	const dated = ix.days.length > 0;
	const nights = nightsIn(ix.days.length);
	const suggestion = useMemo(() => {
		if (dated) return suggestSplit(ix, info.cities, nights);
		// No dates: what each city needs, with room for more.
		const need = info.cities.reduce((s, c) => s + c.need, 0);
		return { ...suggestSplit(ix, info.cities, need), tripDays: MAX_NIGHTS };
	}, [ix, info.cities, dated, nights]);
	const splitOf = useCallback(
		(d: SplitDraft) =>
			withOrder(withOverrides(suggestion, d.days ?? {}), d.order),
		[suggestion],
	);
	const split = useMemo(() => splitOf(draft), [splitOf, draft]);
	const done = () => splitDrafts.delete(tripId);
	const put = async (s: DaySplit) => {
		const list = entriesOf(s);
		const next = layoutNights(list, ix.days.length);
		if (list.length && (await apply.apply(applyPlan(ix, next, info.current))))
			done();
	};
	// Saving as you go: a change puts the route on the days, then Cities & nights shows it.
	const change = (patch: SplitDraft) => {
		update(patch);
		if (!live || !dated) return;
		const list = entriesOf(splitOf({ ...draft, ...patch }));
		if (!list.length) return;
		askSplit(true);
		void apply.save(list, false).then((ok) => ok && done());
	};
	// A city picked in "Where next?": after the stops with nights, with a few.
	useRouteAdds(info, (ids) => {
		let free = split.unused;
		const days = { ...draft.days };
		for (const id of ids) {
			if (split.rows.find((r) => r.id === id)?.days) continue;
			const n = Math.min(ADDED_NIGHTS, free);
			days[id] = n;
			free -= n;
		}
		const rest = split.rows.filter((r) => !ids.includes(r.id));
		const order = [
			...rest.filter((r) => r.days > 0).map((r) => r.id),
			...ids,
			...rest.filter((r) => r.days === 0).map((r) => r.id),
		];
		change({ days, order });
	});
	const rows = useMemo<SplitRowView[]>(
		() => split.rows.map((r) => ({ ...r, key: r.id })),
		[split.rows],
	);
	useRouteOnMap(rows);
	const rateLine = leftToRateText(info.left);
	const entries = entriesOf(split);
	const used = entries.reduce((s, e) => s + e.days, 0);
	const suggesting = access.mode === "suggest";
	// No dates, saving as you go: the day you arrive puts the route on the days.
	const arrive = live && !dated;
	const onArrive = (v: string | null) => {
		update({ start: v });
		if (!v || !arrive) return;
		askSplit(true);
		void apply
			.applyWithDates(v, used + 1, entries, true)
			.then((ok) => ok && done());
	};
	const use = async () => {
		if (dated) await put(split);
		else if (draft.start) {
			if (await apply.applyWithDates(draft.start, used + 1, entries)) done();
		}
	};
	const shortlisted = info.cities.some((c) => c.shortlisted > 0);
	// Each city's dates: the trip's, or (no dates yet) from the day you arrive.
	const start = draft.start ?? null;
	const dates = useMemo(
		() =>
			dated
				? ix.days.map((d) => d.date)
				: start
					? Array.from({ length: used + 1 }, (_, i) => addDays(start, i))
					: [],
		[dated, ix.days, start, used],
	);
	const first = dates[0];
	const last = dates.at(-1);
	const total = dated ? nights : used;
	return (
		<section
			data-testid={T.split}
			data-unused={dated ? split.unused : 0}
			data-cursor-anchor="sec:split"
			className="flex flex-col gap-3"
		>
			<header className="flex flex-col gap-1">
				<div className="flex flex-wrap items-baseline justify-between gap-x-3">
					<h2 className="font-display text-lg font-semibold">
						How long in each city?
					</h2>
					{total ? (
						<span className="text-sm text-muted-foreground tnum">
							{nightWord(total)}
							{first && last ? `, ${dayRange(first, last)}` : ""}
						</span>
					) : null}
				</div>
				<p className="max-w-prose text-sm text-muted-foreground">
					{shortlisted
						? canEdit
							? live && dated
								? "Based on your shortlist. Change the nights or the order, or put it on the days as it is."
								: "Based on your shortlist. Change the nights, reorder the stops, then put them on the days."
							: "Based on your shortlist."
						: "Where you'll sleep, in the order you travel. Every day of a stay is a day to plan, the days you travel too."}
				</p>
			</header>
			{canEdit && arrive ? (
				<div
					data-testid={T.arrive}
					className="flex flex-col gap-1.5 rounded-lg bg-muted/60 px-3 py-2.5"
				>
					<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
						<span className="text-sm font-medium">When do you arrive?</span>
						<div className="w-44">
							<DateInput
								full
								label="When do you arrive?"
								value={start}
								onChange={onArrive}
								disabled={apply.busy}
								testId={T.start}
							/>
						</div>
					</div>
					<p className="text-xs text-muted-foreground">
						A rough date is fine. The route is saved once it has one, and the
						trip ends when the route does.
					</p>
				</div>
			) : null}
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
			{dated && split.need > nights ? (
				<p data-testid={T.splitOver} className="text-sm text-warning">
					{overText(split.need, nights)}
				</p>
			) : null}
			<SplitRows
				info={info}
				rows={rows}
				dates={dates}
				unused={split.unused}
				busy={apply.busy}
				onStep={
					canEdit
						? (i, delta) => {
								const id = split.rows[i]?.id;
								const o = id
									? stepCity(split, draft.days ?? {}, id, delta)
									: null;
								if (o) change({ days: o });
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
								if (order) change({ order });
							}
						: null
				}
			/>
			{dated ? <UnusedLine unused={split.unused} canEdit={canEdit} /> : null}
			{canEdit ? <WhereNext /> : null}
			{canEdit && !dated && suggesting ? (
				<p
					data-testid={T.suggestNote}
					className="max-w-prose text-sm text-muted-foreground"
				>
					You're suggesting, so this suggests the dates only. Once they're
					accepted, come back here to put the nights on the days.
				</p>
			) : null}
			{canEdit && !arrive ? (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					{dated ? null : (
						<div className="flex items-center gap-2">
							<span className="text-sm whitespace-nowrap">You arrive on</span>
							<div className="w-44">
								<DateInput
									full
									value={start}
									onChange={(v) => update({ start: v })}
									testId={T.start}
								/>
							</div>
						</div>
					)}
					<Button
						data-testid={T.splitUse}
						disabled={apply.busy || !entries.length || (!dated && !start)}
						onClick={() => void use()}
					>
						{!dated && suggesting
							? "Suggest these dates"
							: "Put it on the days"}
					</Button>
				</div>
			) : null}
		</section>
	);
}

type KeyedEntry = SplitEntry & { key: string };

/** The stops with nights, as the days hold them (no keys). */
const nightsOf = (list: readonly KeyedEntry[]): SplitEntry[] =>
	list.filter((e) => e.days > 0).map(({ cityId, days }) => ({ cityId, days }));

/** Keys that stay put as rows move: a city can come back (`tokyo:2`). */
function keyEntries(list: readonly SplitEntry[]): KeyedEntry[] {
	const seen = new Map<string, number>();
	return list.map((e) => {
		const n = (seen.get(e.cityId) ?? 0) + 1;
		seen.set(e.cityId, n);
		return { ...e, key: `${e.cityId}:${n}` };
	});
}

/**
 * Cities & nights: the runs, then the cities with no nights. Saving as you
 * go (`live`, no place on a day yet): each change is saved as it's made, and
 * a trip whose end follows its route (`openEnded`) grows to hold more nights
 * and can end sooner. Else Apply, which first says which places leave their
 * day.
 */
function ChangePanel({
	info,
	initial,
	apply,
	live,
	openEnded,
	onClose,
}: {
	info: DaySplitInfo;
	initial: readonly SplitEntry[];
	apply: Apply;
	live: boolean;
	openEnded: boolean;
	onClose: () => void;
}) {
	const { ix, graph } = useWorkspace();
	const qc = useQueryClient();
	const nights = nightsIn(ix.days.length);
	const budget = openEnded ? MAX_NIGHTS : nights;
	const busy = apply.busy;
	// The runs, then the cities with no nights: `list`'s first (in its order), then the rest.
	const withRest = useCallback(
		(runs: readonly SplitEntry[], list: readonly SplitEntry[] = []) => {
			const on = new Set(runs.map((e) => e.cityId));
			const zero = list
				.filter((e) => e.days === 0 && !on.has(e.cityId))
				.map((e) => e.cityId);
			const rest = suggestSplit(ix, info.cities, nights)
				.rows.map((r) => r.id)
				.filter((id) => !on.has(id) && !zero.includes(id));
			return keyEntries([
				...runs,
				...[...zero, ...rest].map((cityId) => ({ cityId, days: 0 })),
			]);
		},
		[ix, info.cities, nights],
	);
	const [entries, setEntries] = useState<KeyedEntry[]>(() => withRest(initial));
	const saver = useRouteSaver((list) => apply.save(list, openEnded));
	const [saved, setSaved] = useState(false);
	// Saving as you go: a change made elsewhere, or a save that didn't take,
	// shows the days as they are; once the page has the trip the cache has
	// (a save reaches the page a moment after it lands).
	const initialKey = JSON.stringify(initial);
	useEffect(() => {
		if (!live || saver.saving) return;
		if (qc.getQueryData(tripKeys.graph(graph.trip.id)) !== graph) return;
		setEntries((list) =>
			JSON.stringify(nightsOf(list)) === initialKey
				? list
				: withRest(JSON.parse(initialKey) as SplitEntry[], list),
		);
	}, [live, saver.saving, initialKey, withRest, qc, graph]);
	const [confirm, setConfirm] = useState(false);
	const edit = (n: KeyedEntry[] | null) => {
		if (!n) return;
		setEntries(n);
		if (!live) return setConfirm(false);
		const list = nightsOf(n);
		if (JSON.stringify(list) === JSON.stringify(nightsOf(entries))) return;
		setSaved(true);
		saver.queue(list);
	};
	const used = entries.reduce((s, e) => s + e.days, 0);
	const unused = Math.max(0, nights - used);
	// A city picked in "Where next?": after the last stop with nights, with a
	// few (a city already on the route comes back for another stay).
	useRouteAdds(info, (ids) => {
		let free = Math.max(0, budget - used);
		const out = entries.filter((e) => e.days > 0 || !ids.includes(e.cityId));
		const at = out.findLastIndex((e) => e.days > 0) + 1;
		const fresh = ids.map((cityId) => {
			const days = Math.min(ADDED_NIGHTS, free);
			free -= days;
			const n = entries.filter((e) => e.cityId === cityId).length + 1;
			return { cityId, days, key: `${cityId}:${n}` };
		});
		out.splice(at, 0, ...fresh);
		edit(out);
	});
	const byId = useMemo(
		() => new Map(info.cities.map((c) => [c.id, c])),
		[info.cities],
	);
	const next = useMemo(
		() =>
			layoutNights(
				entries.filter((e) => e.days > 0),
				ix.days.length,
			),
		[entries, ix.days.length],
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
	// Each stop's dates run on past the trip's end while it grows to hold them.
	const first = ix.days[0]?.date ?? null;
	const span = Math.max(ix.days.length, used + 1);
	const dates = useMemo(
		() =>
			first ? Array.from({ length: span }, (_, i) => addDays(first, i)) : [],
		[first, span],
	);
	const run = async () => {
		if (await apply.apply(plan)) onClose();
	};
	if (live) {
		const total = Math.max(nights, used);
		const last = dates[total];
		// Nights left over in a trip that ends with its route: it can end sooner,
		// when the days that would go hold nothing (a flight home stays put).
		const empty = ix.days
			.slice(used + 1)
			.every((d) => !ix.itemsByDay.get(d.id)?.length);
		const end =
			openEnded && unused && used && first && empty
				? addDays(first, used)
				: null;
		return (
			<section
				data-testid={T.split}
				data-live=""
				data-unused={unused}
				data-cursor-anchor="sec:split.change"
				className="flex flex-col gap-3"
			>
				<header className="flex flex-col gap-1">
					<div className="flex flex-wrap items-baseline justify-between gap-x-3">
						<h2 className="font-display text-lg font-semibold">
							How long in each city?
						</h2>
						{total && first && last ? (
							<span className="text-sm text-muted-foreground tnum">
								{nightWord(total)}, {dayRange(first, last)}
							</span>
						) : null}
					</div>
					<p className="max-w-prose text-sm text-muted-foreground">
						Where you'll sleep, in the order you travel. Every day of a stay is
						a day to plan, the days you travel too.
						{openEnded ? " The trip ends when the route does." : null}
					</p>
				</header>
				<SplitRows
					info={info}
					rows={rows}
					dates={dates}
					unused={budget - used}
					busy={busy}
					onStep={(i, delta) => edit(stepEntry(entries, i, delta, budget))}
					onMove={(from, to) => edit(moveAt(entries, from, to))}
				/>
				<UnusedLine
					unused={unused}
					canEdit={!openEnded}
					end={
						end && first ? (
							<button
								type="button"
								data-testid={T.endTrip}
								disabled={busy || saver.saving}
								onClick={() => void apply.endOn(first, end)}
								className="cursor-pointer font-medium text-foreground underline underline-offset-2 disabled:cursor-default disabled:opacity-50"
							>
								End the trip on {formatDayDate(end)}
							</button>
						) : null
					}
				/>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<WhereNext />
					<span
						role="status"
						data-testid={T.saveState}
						className="ml-auto text-xs text-muted-foreground"
					>
						{saver.saving ? "Saving…" : saved ? "Saved" : null}
					</span>
					<Button size="sm" data-testid={T.done} onClick={onClose}>
						Done
					</Button>
				</div>
			</section>
		);
	}
	return (
		<div
			data-cursor-anchor="sec:split.change"
			className="flex flex-col gap-3 rounded-xl bg-muted/50 p-3 sm:p-4"
		>
			{/* D05: what this is, and how far along. */}
			<p className="flex flex-wrap items-baseline justify-between gap-x-3 text-meta text-muted-foreground">
				<span>
					The order you travel in and the nights in each. Your days follow from
					this.
				</span>
				{nights ? (
					<span className="font-medium text-foreground tnum">
						{Math.min(used, nights)} of {nights} nights placed
					</span>
				) : null}
			</p>
			<SplitRows
				info={info}
				rows={rows}
				unused={unused}
				busy={busy}
				onStep={(i, delta) => edit(stepEntry(entries, i, delta, nights))}
				onMove={(from, to) => edit(moveAt(entries, from, to))}
			/>
			<UnusedLine unused={unused} canEdit />
			<WhereNext />
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
 * "Cities & nights" open (One Yonder D05: the Plan's second view), travelling
 * with my view (its edits don't). The Plan owns it: the view replaces the days.
 */
export function useSplitOpen(): [boolean, (open: boolean) => void] {
	const { access } = useWorkspace();
	return useFollowState("plan.split.change", false, bool, {
		enabled: access.canEdit,
	});
}

/**
 * The top of the Plan: its `header` row (with Days | Cities & nights once
 * days have cities, the view under it), then "How long in each city?" while
 * no day has a city (with no dates too). `fallback` when the trip has no
 * city yet and you can't add one. Always for the whole trip.
 */
export function PlanSplit({
	header,
	banner,
	fallback = null,
	open,
	onOpenChange,
	className,
}: {
	/** The header row; given the Days | Cities & nights switch when there is one. */
	header?: (views: ReactNode) => ReactNode;
	/** Between the header row and the panel. */
	banner?: ReactNode;
	fallback?: ReactNode;
	/** Cities & nights (`useSplitOpen`); null with a day in view (no switch). */
	open: boolean | null;
	onOpenChange: (open: boolean) => void;
	className?: string;
}) {
	const info = useDaySplit();
	const { access, ix } = useWorkspace();
	const apply = useApplySplit();
	const cities = info.cities.length > 0;
	const line = cities && info.hasDays;
	const views = line && access.canEdit && open !== null;
	// Until a place is on a day, each change is saved as it's made (never while suggesting).
	const live = access.canEdit && access.mode !== "suggest" && !info.planned;
	// Nothing to switch to any more (the last city went): back to the days.
	useEffect(() => {
		if (open && !views) onOpenChange(false);
	}, [open, views, onOpenChange]);
	// A place just went onto a day: the route was being built, now the days
	// are (its changes were saved as they were made): back to them.
	const wasPlanned = useRef(info.planned);
	useEffect(() => {
		if (info.planned && !wasPlanned.current && open) onOpenChange(false);
		wasPlanned.current = info.planned;
	}, [info.planned, open, onOpenChange]);
	// A city just added to the route, or the checklist: Cities & nights, once the route has a night.
	const splitAsked = useUi((s) => s.splitAsked);
	const askSplit = useUi((s) => s.askSplit);
	useEffect(() => {
		if (!splitAsked || !views) return;
		askSplit(false);
		onOpenChange(true);
	}, [splitAsked, views, askSplit, onOpenChange]);
	const current = useMemo(
		() => nightRunsOf(info.current).entries,
		[info.current],
	);
	const switcher = views ? (
		<Segmented
			size="sm"
			label="Plan view"
			value={open ? "nights" : "days"}
			onValueChange={(v) => onOpenChange(v === "nights")}
			options={[
				{ value: "days", label: "Days" },
				{ value: "nights", label: "Cities & nights", testId: T.splitChange },
			]}
		/>
	) : null;
	return (
		<>
			{header ? (
				<div className="flex min-h-10 flex-wrap items-center gap-2 px-4 py-1.5">
					{header(switcher)}
				</div>
			) : null}
			{banner}
			{!cities ? (
				access.canEdit ? (
					<div className={cn("px-4 pb-4", className)}>
						<RouteStart />
					</div>
				) : (
					fallback
				)
			) : line ? (
				open && views ? (
					<div className={cn("px-4 pb-4", className)}>
						<ChangePanel
							key={live ? "live" : "apply"}
							info={info}
							initial={current}
							apply={apply}
							live={live}
							openEnded={live && ix.settings.datesFollowRoute}
							onClose={() => onOpenChange(false)}
						/>
					</div>
				) : null
			) : (
				<div className={cn("px-4 pb-4", className)}>
					<SplitSuggestion
						info={info}
						canEdit={access.canEdit}
						live={live}
						apply={apply}
					/>
				</div>
			)}
		</>
	);
}
