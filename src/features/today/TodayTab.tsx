/**
 * Today, on the road (One Yonder phase 5, flow 10; boards P15–P18): during
 * the trip it takes the Overview's place (a follower lands on the Overview,
 * flow 11). It follows the plan by the clock until someone taps Done, then
 * your pace (`computeToday`): Now with Done (before the first Done, a quiet
 * line on what it does), Next with when to leave, Directions and the
 * driver's Address, what's at risk with a fix when you run late, the free
 * time and ideas nearby, the rest of the day in time order, and where you
 * sleep tonight. A stop with no place and no start time is Next "whenever
 * you like", with its own Done when nothing is Now. A stop the day moved on
 * from without a Done asks "Still at …?" for a while, so a late Done can
 * still be told. Tapping a stop opens its details.
 * Raters, viewers and link guests see it without buttons.
 *
 * - The first stop of the day, the end of it and a day without stops are
 *   their own simple states.
 * - "Use my location" is opt-in and stays on the device (`useMyLocation`).
 * - Desktop: the same column, centred.
 */
import "@/features/plan/plan.css";
import {
	Check,
	CircleCheck,
	Clock,
	Languages,
	LocateFixed,
	MapPin,
	Navigation,
	Plus,
	TriangleAlert,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { CategoryIcon, TypeGlyph } from "@/components/common/glyphs";
import { Chip, RatingPill, SectionHeader } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { PlaceActionsProvider } from "@/features/places/tab/use-place-actions";
import { cardTone } from "@/features/plan/card-tone";
import { BlockGlyph } from "@/features/plan/ItemCard";
import { PlanActionsProvider } from "@/features/plan/use-plan-actions";
import { plainText } from "@/features/shell/use-trip-go";
import type { LngLat } from "@/lib/engine/geo";
import {
	stopHere,
	type TodayIdea,
	type TodayLeave,
	type TodayRisk,
	type TodayStop,
	type TodayView,
} from "@/lib/engine/today";
import { formatDayDate, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ratingOf } from "@/lib/workspace/filter-match";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { DriverSheet } from "./DriverSheet";
import {
	directionsUrl,
	type TravelBy,
	travelBy,
	travelTo,
} from "./lib/directions";
import {
	fixLabel,
	lateArrival,
	leaveLine,
	moved,
	paceLabel,
	riskLine,
	riskTitle,
	spokenMin,
	travelLine,
	travelWords,
} from "./lib/words";
import { TODAY_TESTID as T } from "./testids";
import { useMyLocation } from "./use-location";
import { type TodayData, useToday } from "./use-today";
import { type TodayActions, useTodayActions } from "./use-today-actions";

/** A Done stays on screen (with its Undo) this long. */
const RECENT_DONE_MS = 30 * 60_000;
/** A row or card that opens details: a visible focus ring, as the kit's buttons. */
const TAP =
	"rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function TodayTab({ phone = false }: { phone?: boolean }) {
	return (
		<PlanActionsProvider>
			<PlaceActionsProvider>
				<TodayPage phone={phone} />
			</PlaceActionsProvider>
		</PlanActionsProvider>
	);
}

type DayState = "empty" | "starting" | "underway" | "ended";

function stateOf(v: TodayView | null): DayState {
	if (!v) return "empty";
	const stops =
		v.done.length +
		v.passed.length +
		v.rest.length +
		(v.current ? 1 : 0) +
		(v.next ? 1 : 0);
	if (!stops) return "empty";
	if (v.ended) return "ended";
	return v.starting ? "starting" : "underway";
}

function TodayPage({ phone }: { phone: boolean }) {
	const { ix, nav } = useWorkspace();
	const loc = useMyLocation();
	const data = useToday(loc.here);
	const act = useTodayActions();
	const [driver, setDriver] = useState<{ nodeId: string; by: TravelBy } | null>(
		null,
	);
	const { view } = data;
	const state = stateOf(view);
	const openAddress = (s: TodayStop) =>
		s.nodeId && setDriver({ nodeId: s.nodeId, by: travelTo(s) });
	return (
		<div
			data-testid={T.page}
			data-state={state}
			className={cn(
				"mx-auto flex w-full max-w-xl flex-col gap-4 px-4",
				phone ? "pt-5 pb-28" : "pt-8 pb-12",
			)}
		>
			<Header data={data} state={state} />
			<p aria-live="polite" className="sr-only">
				{spoken(view)}
			</p>
			{view && state !== "empty" ? (
				<Day
					view={view}
					state={state}
					act={act}
					here={loc.here}
					onAddress={openAddress}
				/>
			) : (
				<div
					data-testid={T.empty}
					className="flex flex-col items-center gap-4 rounded-2xl border bg-card px-6 py-10 text-center"
				>
					<p className="font-display text-lg font-medium">
						Nothing planned for today.
					</p>
					<Button
						data-testid={T.openPlan}
						onClick={() => {
							const date = view?.date;
							if (date) nav.setDays({ from: date, to: date });
							else nav.setTab("plan");
						}}
					>
						Open the Plan
					</Button>
				</div>
			)}
			{view?.tonight ? <Tonight view={view} /> : null}
			<div className="flex flex-wrap items-center justify-between gap-2 pt-2">
				{loc.supported ? (
					<Button
						variant="ghost"
						size="sm"
						aria-pressed={loc.on}
						data-testid={T.locate}
						onClick={loc.toggle}
						className="-ml-2 text-muted-foreground"
					>
						<LocateFixed />
						{loc.on ? "Using your location · Stop" : "Use my location"}
					</Button>
				) : (
					<span />
				)}
				<Button
					variant="link"
					size="sm"
					data-testid={T.overviewLink}
					onClick={() => nav.setTab("overview")}
					className="text-muted-foreground"
				>
					Trip overview
				</Button>
			</div>
			{loc.on && loc.problem ? (
				<p className="-mt-3 text-meta text-muted-foreground">{loc.problem}</p>
			) : null}
			<DriverSheet
				node={driver ? (ix.node(driver.nodeId) ?? null) : null}
				by={driver?.by ?? "walking"}
				onClose={() => setDriver(null)}
			/>
		</div>
	);
}

/** The live region's words: they change with Now, Next and the pace's kind, not every minute. */
function spoken(v: TodayView | null): string {
	if (!v) return "";
	return [
		v.current ? `Now: ${v.current.name}.` : null,
		v.next ? `Next: ${v.next.name}.` : null,
		v.pace?.kind === "behind"
			? "Running late."
			: v.pace?.kind === "ahead"
				? "Running early."
				: null,
	]
		.filter(Boolean)
		.join(" ");
}

// ---- header ---------------------------------------------------------------------

function Header({ data, state }: { data: TodayData; state: DayState }) {
	const { view } = data;
	const line = [
		data.dayNumber ? `Day ${data.dayNumber} of ${data.days}` : null,
		view ? formatDayDate(view.date) : null,
		data.city,
	]
		.filter(Boolean)
		.join(" · ");
	const pace = view?.pace;
	return (
		<header data-testid={T.header} className="flex items-start gap-3">
			<div className="min-w-0 flex-1">
				<h1 className="font-display text-3xl leading-tight font-bold">Today</h1>
				<p className="text-body text-muted-foreground tnum">{line}</p>
			</div>
			{pace && (state === "underway" || pace.kind !== "on_time") ? (
				<Chip
					size="lg"
					icon={Clock}
					tone={
						pace.kind === "behind"
							? "warn"
							: pace.kind === "ahead"
								? "good"
								: "neutral"
					}
					data-testid={T.pace}
					data-pace={pace.kind}
					className="mt-1.5 tnum"
				>
					{paceLabel(pace)}
				</Chip>
			) : null}
		</header>
	);
}

// ---- the day ---------------------------------------------------------------------

function Day({
	view,
	state,
	act,
	here,
	onAddress,
}: {
	view: TodayView;
	state: DayState;
	act: TodayActions;
	here: LngLat | null;
	onAddress: (s: TodayStop) => void;
}) {
	const { ix } = useWorkspace();
	const [notHere, setNotHere] = useState<string | null>(null);
	// "No" to "Still at …?" stops the question for the rest of the day, on this device.
	const [quiet, setQuiet] = useState(() => quietToday(view.dayId));
	const ask = act.mayMarkDone && !quiet ? view.checkIn : null;
	// Before the day's first Done: say once, quietly, what Done does.
	const hint = act.mayMarkDone && !view.done.length && !ask;
	const recent = [...view.done]
		.filter((d) => d.doneAt !== null && view.now - d.doneAt < RECENT_DONE_MS)
		.sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0))
		.at(-1);
	// "Looks like you're at Bic Camera?": Yes marks the Now stop Done as you
	// left it (the walk there ago), so the stop you're at is Now at once.
	const at =
		here && view.current && act.mayMarkDone ? stopHere(ix, view, here) : null;
	const left = (cur: TodayStop, to: TodayStop) =>
		to === view.next
			? Math.max(cur.start, view.now - to.travelMin * 60_000)
			: view.now;
	// A floating Next has no time to list.
	const later = [view.next?.floating ? null : view.next, ...view.rest].filter(
		(s): s is TodayStop => s !== null,
	);
	return (
		<>
			{at && at.itemId !== notHere && view.current ? (
				<HereBanner
					stop={at}
					act={act}
					onYes={() =>
						view.current &&
						act.done(view.current.itemId, left(view.current, at))
					}
					onNo={() => setNotHere(at.itemId)}
				/>
			) : null}
			{recent ? <DoneRow stop={recent} act={act} /> : null}
			{ask ? (
				<CheckIn
					stop={ask}
					act={act}
					onNo={() => {
						setQuiet(true);
						keepQuiet(view.dayId);
					}}
				/>
			) : null}
			{state === "ended" ? <Ended view={view} /> : null}
			{view.current ? <NowRow stop={view.current} act={act} /> : null}
			{hint && view.current ? <DoneHint /> : null}
			{view.next ? (
				<NextCard
					stop={view.next}
					first={state === "starting"}
					now={view.now}
					leave={view.leave}
					act={act}
					ownDone={!view.current}
					onAddress={onAddress}
				/>
			) : null}
			{hint && !view.current && view.next?.floating ? <DoneHint /> : null}
			{view.risks.map((r) => (
				<RiskCard
					key={`${r.itemId}:${r.departure?.legId ?? ""}`}
					risk={r}
					act={act}
				/>
			))}
			{view.free ? <Free view={view} act={act} /> : null}
			{later.length ? <Rest stops={later} /> : null}
		</>
	);
}

/** A stop's glyph in its family colour, as on the Plan (`plan.css`). */
function StopGlyph({
	nodeId,
	name,
	size = "md",
}: {
	nodeId: string | null;
	name: string;
	size?: "sm" | "md" | "lg";
}) {
	const { ix } = useWorkspace();
	const node = nodeId ? ix.node(nodeId) : undefined;
	return (
		<span data-family={cardTone(node)} className="plan-card shrink-0">
			<span
				aria-hidden
				className={cn(
					"plan-icon flex items-center justify-center rounded-full",
					size === "sm" ? "size-8" : size === "md" ? "size-10" : "size-12",
				)}
			>
				{!node ? (
					<BlockGlyph title={name} />
				) : node.type === "place" && node.category ? (
					<CategoryIcon
						category={node.category}
						className={size === "lg" ? "size-6" : "size-4"}
					/>
				) : (
					<TypeGlyph
						type={node.type}
						tinted={false}
						className="size-4 text-current"
					/>
				)}
			</span>
		</span>
	);
}

const time = (ms: number, tz: string) => formatTime(ms, tz);

function HereBanner({
	stop,
	act,
	onYes,
	onNo,
}: {
	stop: TodayStop;
	act: TodayActions;
	onYes: () => void;
	onNo: () => void;
}) {
	return (
		<div
			data-testid={T.here}
			data-item={stop.itemId}
			role="status"
			className="flex items-center gap-3 rounded-2xl border bg-accent px-4 py-3 text-accent-foreground"
		>
			<MapPin className="size-5 shrink-0" strokeWidth={1.75} aria-hidden />
			<span className="min-w-0 flex-1 text-body">
				Looks like you're at {stop.name}?
			</span>
			<Button variant="ghost" size="sm" onClick={onNo}>
				Not yet
			</Button>
			<Button
				size="sm"
				data-testid={T.hereYes}
				disabled={act.offline}
				onClick={onYes}
			>
				Yes
			</Button>
		</div>
	);
}

function DoneRow({ stop, act }: { stop: TodayStop; act: TodayActions }) {
	return (
		<div
			data-testid={T.doneRow}
			data-item={stop.itemId}
			className="flex min-h-12 items-center gap-3 rounded-2xl border px-4 py-1.5"
		>
			<CircleCheck
				className="size-5 shrink-0 text-good"
				strokeWidth={1.75}
				aria-hidden
			/>
			<span className="min-w-0 flex-1 truncate text-body text-muted-foreground tnum">
				{stop.name} · done {time(stop.doneAt ?? stop.end, stop.tz)}
			</span>
			{act.mayMarkDone ? (
				<Button
					variant="link"
					data-testid={T.undo}
					disabled={act.offline}
					onClick={() => act.undo(stop.itemId)}
					className="px-1 text-body font-semibold"
				>
					Undo
				</Button>
			) : null}
		</div>
	);
}

/** "Still at Yodobashi Camera?": Done marks it now (you left late); No leaves the day on the plan. */
function CheckIn({
	stop,
	act,
	onNo,
}: {
	stop: TodayStop;
	act: TodayActions;
	onNo: () => void;
}) {
	return (
		<div
			data-testid={T.checkIn}
			data-item={stop.itemId}
			role="status"
			className="flex min-h-12 items-center gap-3 rounded-2xl border px-4 py-1.5"
		>
			<Clock
				className="size-5 shrink-0 text-muted-foreground"
				strokeWidth={1.75}
				aria-hidden
			/>
			<span className="min-w-0 flex-1 text-body">Still at {stop.name}?</span>
			<Button variant="ghost" size="sm" onClick={onNo}>
				No
			</Button>
			<Button
				variant="outline"
				size="sm"
				data-testid={T.done}
				disabled={act.offline}
				onClick={() => act.done(stop.itemId)}
			>
				<Check />
				Done
			</Button>
		</div>
	);
}

function DoneHint() {
	return (
		<p
			data-testid={T.hint}
			className="-mt-2 px-4 text-meta text-muted-foreground"
		>
			Tap Done when you leave: the rest of today follows your pace.
		</p>
	);
}

function NowRow({ stop, act }: { stop: TodayStop; act: TodayActions }) {
	const { nav } = useWorkspace();
	return (
		<section
			data-testid={T.now}
			data-item={stop.itemId}
			aria-label="Now"
			className="flex items-center gap-3 rounded-2xl border bg-card px-4 py-3"
		>
			<span aria-hidden className="size-2.5 shrink-0 rounded-full bg-good" />
			<button
				type="button"
				onClick={() => nav.select({ kind: "item", id: stop.itemId })}
				className={cn("min-w-0 flex-1 text-left", TAP)}
			>
				<span className="block text-meta font-semibold text-good tnum">
					Now · since {time(Math.max(stop.start, stop.arrive), stop.tz)}
				</span>
				<span className="block truncate text-lg font-semibold">
					{stop.name}
				</span>
			</button>
			{act.mayMarkDone ? (
				<Button
					variant="outline"
					size="lg"
					data-testid={T.done}
					disabled={act.offline}
					onClick={() => act.done(stop.itemId)}
				>
					<Check />
					Done
				</Button>
			) : null}
		</section>
	);
}

function NextCard({
	stop,
	first,
	now,
	leave,
	act,
	ownDone,
	onAddress,
}: {
	stop: TodayStop;
	/** The day's first stop (nothing started yet). */
	first: boolean;
	now: number;
	/** The next fixed stop: a floating stop's card says when to leave for it. */
	leave: TodayLeave | null;
	act: TodayActions;
	/** Nothing is Now: a floating stop gets its own Done (with a Now stop, that one's Done comes first). */
	ownDone: boolean;
	onAddress: (s: TodayStop) => void;
}) {
	const { ix, nav } = useWorkspace();
	const item = ix.item(stop.itemId);
	const coord = stop.nodeId ? ix.coordOf(stop.nodeId) : null;
	const at = time(stop.start, stop.tz);
	const label = stop.floating
		? `${first ? "First stop" : "Next"} · ${stop.name}, whenever you like`
		: first
			? `First stop · ${at}`
			: stop.fixed
				? `Next · ${at}${stop.booked ? ", booked" : ""}`
				: `Next · about ${at}`;
	const travel = travelLine(stop);
	const leaveBy =
		travel === null
			? null
			: stop.leaveBy > now
				? `Leave by ${time(stop.leaveBy, stop.departure?.tz ?? stop.tz)}`
				: "Leave now";
	const note = item?.note ? plainText(item.note).split("\n")[0] : null;
	// "No place yet · your note: near Shinjuku" (P18).
	const line = (
		stop.floating
			? ["No place yet", note ? `your note: ${note}` : null]
			: [leaveBy, travel, note]
	)
		.filter(Boolean)
		.join(" · ");
	return (
		<section
			data-testid={T.next}
			data-item={stop.itemId}
			aria-label="Next"
			className="rounded-2xl border border-glow bg-card p-4 ring-4 ring-glow/15"
		>
			<div className="flex items-center gap-2">
				<span aria-hidden className="size-2.5 shrink-0 rounded-full bg-glow" />
				<span className="min-w-0 flex-1 truncate text-meta font-semibold text-glow-foreground tnum dark:text-glow">
					{label}
				</span>
				{moved(stop) && !stop.floating ? (
					<span className="shrink-0 text-meta text-muted-foreground line-through tnum">
						planned {time(stop.plannedStart, stop.tz)}
					</span>
				) : null}
			</div>
			<div className="mt-3 flex items-center gap-3">
				<button
					type="button"
					onClick={() => nav.select({ kind: "item", id: stop.itemId })}
					className={cn(
						"flex min-w-0 flex-1 items-center gap-3 text-left",
						TAP,
					)}
				>
					<StopGlyph nodeId={stop.nodeId} name={stop.name} size="lg" />
					<span className="min-w-0 flex-1">
						<span className="block truncate font-display text-2xl font-semibold">
							{stop.name}
						</span>
						{line ? (
							<span className="line-clamp-2 text-body text-muted-foreground tnum">
								{line}
							</span>
						) : null}
					</span>
				</button>
				{stop.floating && ownDone && act.mayMarkDone ? (
					<Button
						variant="outline"
						size="lg"
						data-testid={T.done}
						disabled={act.offline}
						onClick={() => act.done(stop.itemId)}
					>
						<Check />
						Done
					</Button>
				) : null}
			</div>
			{stop.floating && leave ? (
				<p
					data-testid={T.leave}
					className="mt-3 flex items-start gap-2 text-body tnum"
				>
					<Clock
						className="mt-0.5 size-4 shrink-0 text-muted-foreground"
						strokeWidth={1.75}
						aria-hidden
					/>
					{leaveLine(leave, now)}
				</p>
			) : null}
			{coord && stop.nodeId ? (
				<div className="mt-4 flex gap-3">
					<Button asChild size="xl" className="flex-1">
						<a
							href={directionsUrl(coord, travelTo(stop))}
							target="_blank"
							rel="noopener noreferrer"
							data-testid={T.directions}
						>
							<Navigation />
							Directions
						</a>
					</Button>
					<Button
						variant="outline"
						size="xl"
						data-testid={T.address}
						onClick={() => onAddress(stop)}
					>
						<Languages />
						Address
					</Button>
				</div>
			) : null}
		</section>
	);
}

function RiskCard({ risk, act }: { risk: TodayRisk; act: TodayActions }) {
	const { ix } = useWorkspace();
	return (
		<section
			data-testid={T.risk}
			data-item={risk.itemId}
			className="rounded-2xl border border-warning-hairline bg-warning-wash p-4"
		>
			<div className="flex gap-3">
				<TriangleAlert
					className="mt-0.5 size-5 shrink-0 text-warning"
					strokeWidth={1.75}
					aria-hidden
				/>
				<div className="min-w-0">
					<p className="text-body font-semibold tnum">{riskTitle(risk)}</p>
					<p className="text-sm text-muted-foreground tnum">{riskLine(risk)}</p>
				</div>
			</div>
			{act.mayChange && risk.fixes.length ? (
				<div className="mt-3 flex flex-wrap gap-2 pl-8">
					{risk.fixes.map((f) => (
						<Button
							key={f.kind}
							variant={f.kind === "shorten" ? "outline" : "ghost"}
							size="lg"
							data-testid={T.fix}
							data-kind={f.kind}
							disabled={act.offline}
							onClick={() =>
								f.kind === "shorten"
									? act.shorten(f.itemId, f.toMin)
									: act.skip(f.itemId)
							}
						>
							{fixLabel(f, !!ix.item(f.itemId)?.nodeId)}
						</Button>
					))}
				</div>
			) : null}
		</section>
	);
}

function Free({ view, act }: { view: TodayView; act: TodayActions }) {
	const free = view.free;
	if (!free) return null;
	// The idea goes after the stop you're at, else before the next fixed one.
	const anchor = view.current
		? { afterItemId: view.current.itemId }
		: view.next && !view.next.fixed
			? { afterItemId: view.next.itemId }
			: view.next
				? { beforeItemId: view.next.itemId }
				: {};
	return (
		<section data-testid={T.free} className="grid gap-1">
			<SectionHeader
				as="h2"
				action={
					view.ideas.length ? (
						<span className="text-meta text-muted-foreground">
							from your ideas nearby
						</span>
					) : null
				}
				className="border-b pb-1"
			>
				<span className="tnum">
					{spokenMin(free.minutes)} free before {time(free.before, free.tz)}
				</span>
			</SectionHeader>
			{/* A floating Next says when to leave in its own card. */}
			{view.next?.floating && view.leave ? null : (
				<p
					data-testid={T.leave}
					className="flex items-start gap-2 py-1 text-sm text-muted-foreground tnum"
				>
					<Clock
						className="mt-0.5 size-4 shrink-0"
						strokeWidth={1.75}
						aria-hidden
					/>
					{leaveLine(free, view.now)}
				</p>
			)}
			{view.ideas.length ? (
				<ul className="divide-y">
					{view.ideas.map((i) => (
						<IdeaRow
							key={i.nodeId}
							idea={i}
							act={act}
							onAdd={() =>
								act.add({ id: i.nodeId, name: i.name }, view.dayId, anchor)
							}
						/>
					))}
				</ul>
			) : null}
		</section>
	);
}

function IdeaRow({
	idea,
	act,
	onAdd,
}: {
	idea: TodayIdea;
	act: TodayActions;
	onAdd: () => void;
}) {
	const { ix, nav } = useWorkspace();
	const node = ix.node(idea.nodeId);
	const top = node ? ratingOf(node, "max") : null;
	const meta = [`${spokenMin(idea.walkMin)} walk`, idea.hours]
		.filter(Boolean)
		.join(" · ");
	return (
		<li
			data-testid={T.idea}
			data-node={idea.nodeId}
			className="flex items-center gap-3 py-3"
		>
			<button
				type="button"
				onClick={() => nav.select({ kind: "node", id: idea.nodeId })}
				className={cn("flex min-w-0 flex-1 items-center gap-3 text-left", TAP)}
			>
				<StopGlyph nodeId={idea.nodeId} name={idea.name} />
				<span className="grid min-w-0 flex-1 gap-0.5">
					<span className="truncate text-body font-semibold">{idea.name}</span>
					<span className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
						{top ? <RatingPill level={top} size="sm" /> : null}
						<span className="truncate tnum">{meta}</span>
					</span>
				</span>
			</button>
			{act.mayChange ? (
				<Button
					variant="outline"
					size="lg"
					data-testid={T.ideaAdd}
					disabled={act.offline}
					onClick={onAdd}
				>
					<Plus />
					Add
				</Button>
			) : null}
		</li>
	);
}

/** In time order; a fixed stop reached late keeps its time and says when you'd arrive. */
function Rest({ stops }: { stops: TodayStop[] }) {
	const { nav } = useWorkspace();
	const retimed = stops.some(moved);
	return (
		<section data-testid={T.rest} className="grid">
			<SectionHeader
				as="h2"
				action={
					retimed ? (
						<span className="text-meta text-muted-foreground">
							re-timed from now
						</span>
					) : null
				}
				className="border-b pb-1"
			>
				Rest of today
			</SectionHeader>
			<ul className="divide-y">
				{stops.map((s) => (
					<li key={s.itemId}>
						<button
							type="button"
							data-testid={T.restRow}
							data-item={s.itemId}
							data-moved={moved(s) || undefined}
							onClick={() => nav.select({ kind: "item", id: s.itemId })}
							className={cn(
								"flex min-h-14 w-full items-center gap-3 py-2 text-left",
								TAP,
							)}
						>
							<span className="w-12 shrink-0 tnum">
								<span className="block text-body font-semibold">
									{time(s.start, s.tz)}
								</span>
								{moved(s) ? (
									<span className="block text-meta text-muted-foreground line-through">
										{time(s.plannedStart, s.tz)}
									</span>
								) : null}
							</span>
							<StopGlyph nodeId={s.nodeId} name={s.name} size="sm" />
							<span className="min-w-0 flex-1">
								<span className="block truncate text-body">{s.name}</span>
								{lateArrival(s) ? (
									<span className="block text-meta text-warning tnum">
										{lateArrival(s)}
									</span>
								) : null}
							</span>
							{s.booked ? (
								<Chip tone="accent" icon={Clock}>
									booked
								</Chip>
							) : null}
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}

function Ended({ view }: { view: TodayView }) {
	const all = view.done.length + view.passed.length;
	const t = view.tomorrow;
	return (
		<section
			data-testid={T.ended}
			className="grid gap-1 rounded-2xl border bg-card px-4 py-4"
		>
			<p className="font-display text-lg font-semibold">Nothing left today</p>
			<p className="text-sm text-muted-foreground tnum">
				{view.done.length} of {all} {all === 1 ? "stop" : "stops"} done
			</p>
			{t ? (
				<p
					data-testid={T.tomorrow}
					className="mt-2 border-t pt-3 text-sm text-muted-foreground tnum"
				>
					<span className="font-semibold text-foreground">
						{formatDayDate(t.date)}:
					</span>{" "}
					{t.name} at {time(t.start, t.tz)}
					{t.leaveBy < t.start ? ` · leave by ${time(t.leaveBy, t.tz)}` : ""}
				</p>
			) : null}
		</section>
	);
}

function Tonight({ view }: { view: TodayView }) {
	const { nav } = useWorkspace();
	const night = view.tonight;
	if (!night) return null;
	// Without the evening's mode: a walk when it's short.
	const far = (night.travelMin ?? 0) > 20;
	const by: TravelBy = night.mode
		? travelBy(night.mode)
		: far
			? "transit"
			: "walking";
	const travel = night.travelMin
		? night.mode
			? travelWords(night.travelMin, night.mode)
			: `${spokenMin(night.travelMin)} ${far ? "away" : "walk"}`
		: null;
	const sub: ReactNode = travel
		? `${travel} from the last stop`
		: "Where you sleep";
	return (
		<section data-testid={T.tonight} className="grid gap-1">
			<SectionHeader as="h2" className="border-b pb-1">
				Tonight
			</SectionHeader>
			<div className="flex items-center gap-3 py-2">
				<button
					type="button"
					onClick={() => nav.select({ kind: "node", id: night.nodeId })}
					className={cn(
						"flex min-w-0 flex-1 items-center gap-3 text-left",
						TAP,
					)}
				>
					<StopGlyph nodeId={night.nodeId} name={night.name} />
					<span className="grid min-w-0 gap-0.5">
						<span className="truncate text-body font-semibold">
							{night.name}
						</span>
						<span className="truncate text-meta text-muted-foreground tnum">
							{sub}
						</span>
					</span>
				</button>
				{night.coord ? (
					<Button asChild variant="outline" size="lg">
						<a
							href={directionsUrl(night.coord, by)}
							target="_blank"
							rel="noopener noreferrer"
							data-testid={T.tonightDirections}
						>
							<Navigation />
							Directions
						</a>
					</Button>
				) : null}
			</div>
		</section>
	);
}

const quietKey = (dayId: string) => `yonder:today-quiet:${dayId}`;

/** Whether "Still at …?" was answered No today on this device. */
function quietToday(dayId: string): boolean {
	try {
		return globalThis.localStorage?.getItem(quietKey(dayId)) === "1";
	} catch {
		return false;
	}
}

function keepQuiet(dayId: string) {
	try {
		globalThis.localStorage?.setItem(quietKey(dayId), "1");
	} catch {
		// Private mode or storage off: quiet for this visit only.
	}
}
