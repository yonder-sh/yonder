/**
 * A place's Places parts in its panel (docs/PLACES.md §2), the same on every
 * tab (the shell's `InspectorBody` lays them out):
 *
 * - `PlacePanelProvider`: the place's row in the Places data (status, score,
 *   ratings) and the place actions, for the parts below; none when the place
 *   is outside the scope (the panel then goes without them);
 * - header: status and score chips with the reason; Pin / Unpin, Add to
 *   day…, Drop / Bring back, Google Maps;
 * - everyone's ratings with their comments (unrated counts as Sure), yours
 *   editable (keys 1–6 while the panel has focus);
 * - where it fits (the days you're in that city, or none yet) and nearby
 *   ideas with distances; time needed with where it comes from.
 */

import { useQuery } from "@tanstack/react-query";
import { distance } from "@turf/distance";
import { point } from "@turf/helpers";
import { cn } from "cn";
import {
	CalendarPlus,
	CircleSlash,
	ExternalLink,
	MessageSquare,
	Pencil,
	Pin,
	PinOff,
	Undo2,
} from "lucide-react";
import {
	createContext,
	type KeyboardEvent,
	type ReactNode,
	useContext,
	useMemo,
	useState,
} from "react";
import { toast } from "sonner";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { MarkdownText } from "@/components/common/markdown-text";
import { MemberAvatar } from "@/components/common/member";
import { Button } from "@/components/ui/button";
import type { GraphMember, GraphNode } from "@/lib/engine/types";
import { humanError } from "@/lib/errors";
import {
	formatDateRange,
	formatDayDate,
	formatDistance,
	formatDuration,
} from "@/lib/format";
import { activityQuery } from "@/lib/query/trip-queries";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { googleMapsLink } from "../lib/providers";
import { priorityForKey, ratingsCount } from "../lib/rate";
import { useSetPriority } from "../mutations";
import { PLACES_TESTID } from "../testids";
import { mayRate, RatingCommentEditor } from "../ui/member-ratings";
import { PriorityBadge, PriorityPicker } from "../ui/priority";
import { SchedulePicker } from "../ui/schedule-picker";
import { rowReason } from "./bar";
import { formatDayNumbers, type PlaceRow } from "./model";
import { ownsKeys } from "./PlacesTable";
import { RatingButtons } from "./RatingButtons";
import { RATING_TESTID } from "./rating-testids";
import { formatScore, RATING_WEIGHT } from "./score";
import { TimeNeededEditor, TimeNeededLabel } from "./TimeNeeded";
import { PLACES_TAB_TESTID } from "./testids";
import { ScoreChip, SectionLabel, SplitMark, StatusChip } from "./ui";
import {
	PlaceActionsProvider,
	usePlaceActions,
	usePlaceActionsOptional,
} from "./use-place-actions";
import { type PlacesData, usePlaces } from "./use-places";

/** Other places within walking distance, nearest first ("Kiyomizu-dera 0.8 km"). */
export function nearbyOf(
	row: PlaceRow,
	rows: readonly PlaceRow[],
	opts: { maxKm?: number; limit?: number; walkKmh?: number } = {},
): { row: PlaceRow; km: number; walkMin: number }[] {
	const { lat, lng } = row.node;
	if (lat === null || lng === null) return [];
	const here = point([lng, lat]);
	const max = opts.maxKm ?? 2.5;
	const kmh = opts.walkKmh ?? 4.5;
	const out: { row: PlaceRow; km: number; walkMin: number }[] = [];
	for (const r of rows) {
		if (r.id === row.id || r.status === "dropped") continue;
		if (r.node.lat === null || r.node.lng === null) continue;
		const km = distance(here, point([r.node.lng, r.node.lat]));
		// Streets aren't straight: about a quarter more than the crow flies.
		if (km <= max)
			out.push({
				row: r,
				km,
				walkMin: Math.max(1, Math.round((km * 1.25 * 60) / kmh)),
			});
	}
	return out.sort((a, b) => a.km - b.km).slice(0, opts.limit ?? 3);
}

/** "Where it fits": the place's day(s), or the days you're in its city. */
export function fitsText(
	row: PlaceRow,
	ix: {
		day(
			id: string | null | undefined,
		): { id: string; date: string } | undefined;
		dayNumber(id: string): number;
	},
): string {
	const days = [
		...new Set(row.occurrences.map((it) => it.dayId).filter(Boolean)),
	] as string[];
	if (days.length) {
		const first = ix.day(days[0]);
		const parts = [
			`Scheduled on ${formatDayNumbers(days.map((d) => ix.dayNumber(d)))}`,
			first ? formatDayDate(first.date) : null,
			row.timeSource === "planned" && row.timeMin !== null
				? `${formatDuration(row.timeMin)} planned`
				: null,
		];
		return parts.filter(Boolean).join(" · ");
	}
	const city = row.city?.name ?? "this area";
	if (!row.cityDayIds.length) return `No days in ${city} yet.`;
	const dates = row.cityDayIds
		.map((id) => ix.day(id)?.date)
		.filter((d): d is string => !!d)
		.sort();
	const nums = formatDayNumbers(row.cityDayIds.map((d) => ix.dayNumber(d)));
	return `You're in ${city} ${formatDateRange(dates[0], dates.at(-1))} (${nums}). Not on a day yet.`;
}

/** Who pinned the place last, from its activity (null while unknown). */
function usePinnedBy(nodeId: string, pinned: boolean): string | null {
	const { graph, mode } = useWorkspace();
	const q = useQuery({
		...activityQuery(graph.trip.id, { nodeId }),
		enabled: pinned && mode === "live",
	});
	if (!pinned) return null;
	const entry = q.data?.find((a) => a.summary.startsWith("pinned "));
	return entry ? entry.actorName.split(/\s+/)[0] || null : null;
}

/**
 * A member's rating, its weight and comment. Where you may set it (yours, or
 * a placeholder's as an editor) the badge is a picker.
 */
function RatingRow({ row, member }: { row: PlaceRow; member: GraphMember }) {
	const { access, graph } = useWorkspace();
	const act = usePlaceActions();
	const setShareOpen = useUi((s) => s.setShareOpen);
	const [editing, setEditing] = useState(false);
	const p = row.node.priorities[member.id] ?? null;
	const comment = row.node.ratingComments[member.id];
	const mine = member.id === access.memberId;
	const guard = useEditGuard(mine ? "rate" : "propose-ok");
	const set = useSetPriority(graph.trip.id);
	const picker = mayRate(access, member) ? (
		<EditGuard kind={mine ? "rate" : "propose-ok"}>
			<span data-testid={PLACES_TESTID.priorityPicker}>
				<PriorityPicker
					value={p}
					disabled={guard.disabled}
					label={`Change ${mine ? "your" : `${member.name}'s`} rating for ${row.node.name}`}
					onChange={(v) => {
						if (mine) act.rate(row.node.id, v);
						else
							set.mutate(
								{ nodeId: row.node.id, memberId: member.id, priority: v },
								{ onError: (e) => toast.error(humanError(e)) },
							);
					}}
				/>
			</span>
		</EditGuard>
	) : null;
	const canComment = mine
		? act.canRate
		: mayRate(access, member) && act.canEdit;
	const noAccount =
		member.status === "placeholder" || member.status === "invited";
	const counted = ratingsCount(member);
	return (
		<li
			className="grid gap-1 py-1.5"
			data-testid={PLACES_TAB_TESTID.ratingRow}
			data-member={member.id}
			data-counted={counted}
		>
			<div
				className={cn(
					"flex min-w-0 items-center gap-2",
					!counted && "opacity-60",
				)}
				title={
					counted
						? undefined
						: `Not counted: ${member.firstName ?? member.name}'s ratings are left out of the score`
				}
			>
				<MemberAvatar memberId={member.id} size={20} ring={false} />
				<span className="min-w-0 truncate text-sm">
					{mine ? "You" : member.name}
				</span>
				{p ? (
					<>
						{picker ?? <PriorityBadge priority={p} />}
						<span className="font-mono text-xs tnum text-muted-foreground">
							{formatScore(RATING_WEIGHT[p])}
						</span>
						{counted ? null : (
							<span className="text-xs text-muted-foreground">not counted</span>
						)}
					</>
				) : !counted ? (
					<span className="text-xs text-muted-foreground">
						Not rated · not counted
					</span>
				) : (
					<span className="text-xs text-muted-foreground">
						Not rated yet · counts as Sure
						{noAccount && !mine ? (
							<>
								{" · "}
								<button
									type="button"
									className="cursor-pointer text-primary hover:underline"
									onClick={() => setShareOpen(true)}
								>
									invite {member.firstName ?? member.name}
								</button>
							</>
						) : null}
					</span>
				)}
				{!p && picker ? (
					<span className="ml-auto shrink-0">{picker}</span>
				) : null}
				{p && canComment && !comment && !editing ? (
					<button
						type="button"
						onClick={() => setEditing(true)}
						className="ml-auto shrink-0 cursor-pointer text-xs text-muted-foreground hover:text-foreground"
					>
						Add a comment
					</button>
				) : null}
			</div>
			{editing && p ? (
				<div className="pl-7">
					<RatingCommentEditor
						node={row.node}
						memberId={member.id}
						priority={p}
						onDone={() => setEditing(false)}
						autoFocus
					/>
				</div>
			) : comment ? (
				<div className="flex items-start gap-1.5 pl-7 text-[13px] text-muted-foreground">
					<MessageSquare className="mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
					<MarkdownText
						md={comment}
						inline
						className="min-w-0 flex-1 break-words"
					/>
					{canComment ? (
						<button
							type="button"
							className="shrink-0 cursor-pointer rounded p-0.5 hover:bg-accent"
							aria-label="Edit the comment"
							onClick={() => setEditing(true)}
						>
							<Pencil className="size-3" strokeWidth={1.5} />
						</button>
					) : null}
				</div>
			) : null}
		</li>
	);
}

type PlacePanel = { row: PlaceRow; data: PlacesData };

const PlacePanelContext = createContext<PlacePanel | null>(null);

export function PlacePanelProvider({
	nodeId,
	children,
}: {
	nodeId: string;
	children: ReactNode;
}) {
	const data = usePlaces("");
	const row = data.byId.get(nodeId);
	const value = useMemo(() => (row ? { row, data } : null), [row, data]);
	return (
		<PlaceActionsProvider>
			<PlacePanelContext.Provider value={value}>
				{children}
			</PlacePanelContext.Provider>
		</PlaceActionsProvider>
	);
}

/** The open place's row and the Places data, or null (not a place in the scope). */
export function usePlacePanel(): PlacePanel | null {
	return useContext(PlacePanelContext);
}

/** Keys 1–6 rate the open place while its panel has focus. */
export function usePlaceKeys():
	| ((e: KeyboardEvent<HTMLElement>) => void)
	| undefined {
	const panel = usePlacePanel();
	const act = usePlaceActionsOptional();
	if (!panel || !act) return undefined;
	return (e) => {
		if (ownsKeys(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
		const p = priorityForKey(e.key);
		if (p) {
			e.preventDefault();
			act.rate(panel.row.node.id, p);
		}
	};
}

/** Status and score, with why ("2 of 3 say Must"). */
export function PlaceHeadStatus() {
	const panel = usePlacePanel();
	const pinnedBy = usePinnedBy(
		panel?.row.node.id ?? "",
		!!panel?.row.info.pinned,
	);
	if (!panel) return null;
	const { row, data } = panel;
	const reason = rowReason(row, data.bar, pinnedBy);
	return (
		<>
			<div className="flex flex-wrap items-center gap-1.5">
				<StatusChip info={row.info} long reason={reason} />
				<ScoreChip score={row.score} prefix="Score" />
				{row.split ? <SplitMark /> : null}
			</div>
			{reason ? (
				<p
					className="text-[13px] text-muted-foreground"
					data-testid={RATING_TESTID.reason}
				>
					{reason}
				</p>
			) : null}
		</>
	);
}

/** Pin, Add to day…, Drop (a place in the scope) and Google Maps. */
export function PlaceHeadActions({ node }: { node: GraphNode }) {
	const { ix, schedule } = useWorkspace();
	const panel = usePlacePanel();
	const act = usePlaceActionsOptional();
	const mapsHref = googleMapsLink({
		name: node.name,
		lat: node.lat,
		lng: node.lng,
		googlePlaceId: node.googlePlaceId,
		googleMapsUri: node.details.googleMapsUri,
	});
	const row = panel?.row;
	const pinLabel = !row
		? ""
		: row.status === "shortlist"
			? row.info.pinned
				? "Unpin"
				: "Take off shortlist"
			: row.info.unpinned
				? "Back on shortlist"
				: "Pin to shortlist";
	if (!row && !mapsHref) return null;
	return (
		<div className="flex flex-wrap items-center gap-1.5 pt-1">
			{row && act && panel && row.status !== "scheduled" ? (
				<EditGuard>
					<Button
						variant="outline"
						size="sm"
						data-testid={PLACES_TAB_TESTID.pinButton}
						onClick={() => act.togglePin(row, panel.data.threshold)}
						title="S"
					>
						{row.status === "shortlist" ? <PinOff /> : <Pin />}
						{pinLabel}
					</Button>
				</EditGuard>
			) : null}
			{row && act && ix.days.length ? (
				<SchedulePicker
					ix={ix}
					schedule={schedule}
					allowUnscheduled={false}
					onPick={(p) =>
						p.dayId ? void act.addToDay(row, p.dayId, p.label) : undefined
					}
				>
					<Button
						size="sm"
						disabled={!act.canEdit}
						data-testid={PLACES_TAB_TESTID.addToDay}
					>
						<CalendarPlus />
						{row.status === "scheduled" ? "Add again…" : "Add to day…"}
					</Button>
				</SchedulePicker>
			) : null}
			{row && act ? (
				<EditGuard>
					<Button
						variant="ghost"
						size="sm"
						data-testid={PLACES_TAB_TESTID.dropButton}
						onClick={() => act.toggleDropped(row)}
						className="text-muted-foreground"
						title="D"
					>
						{row.droppedByHand ? <Undo2 /> : <CircleSlash />}
						{row.droppedByHand ? "Bring back" : "Drop"}
					</Button>
				</EditGuard>
			) : null}
			{mapsHref ? (
				<Button variant="ghost" size="sm" asChild>
					<a
						href={mapsHref}
						target="_blank"
						rel="noopener noreferrer"
						data-testid={PLACES_TESTID.openInMaps}
					>
						<ExternalLink />
						Google Maps
					</a>
				</Button>
			) : null}
		</div>
	);
}

/** Everyone's ratings, then yours to set. */
export function PlaceRatings() {
	const panel = usePlacePanel();
	const act = usePlaceActions();
	if (!panel) return null;
	const { row, data } = panel;
	const mine = act.me ? (row.node.priorities[act.me] ?? null) : null;
	// Everyone who rates: a left-out person's rating still shows, dimmed.
	const members = [...data.allRaters].sort(
		(a, b) => Number(b.id === act.me) - Number(a.id === act.me),
	);
	return (
		<section className="grid gap-2">
			<SectionLabel>Ratings</SectionLabel>
			<ul className="grid">
				{members.map((m) => (
					<RatingRow key={m.id} row={row} member={m} />
				))}
			</ul>
			{act.me ? (
				<div className="grid gap-1.5" data-testid={PLACES_TAB_TESTID.myRating}>
					<span className="text-xs text-muted-foreground">
						Your rating
						{act.canRate ? (
							<span className="max-md:hidden">
								{" "}
								· keys 1–6 while this is open
							</span>
						) : null}
					</span>
					<RatingButtons
						value={mine}
						disabled={!act.canRate}
						reason={act.rateReason}
						onRate={(p) => act.rate(row.node.id, p)}
					/>
				</div>
			) : null}
			<p className="text-xs text-muted-foreground">
				Score = sum of ratings (Must +3 … Nah −2; unrated counts as Sure, 0).
			</p>
		</section>
	);
}

/** The place's day(s) or its city's days, and ideas within walking distance. */
export function PlaceFits() {
	const { ix } = useWorkspace();
	const panel = usePlacePanel();
	const nearby = useMemo(
		() =>
			panel
				? nearbyOf(panel.row, panel.data.rows, {
						walkKmh: ix.settings.walkSpeedKmh,
					})
				: [],
		[panel, ix.settings.walkSpeedKmh],
	);
	if (!panel) return null;
	return (
		<section className="grid gap-1.5" data-testid={PLACES_TAB_TESTID.fits}>
			<SectionLabel>Where it fits</SectionLabel>
			<p className="rounded-lg bg-muted/60 px-3 py-2 text-sm leading-relaxed">
				{fitsText(panel.row, ix)}
			</p>
			{nearby.length ? (
				<p
					className="text-[13px] text-muted-foreground"
					data-testid={PLACES_TAB_TESTID.nearby}
				>
					{nearby.length} nearby:{" "}
					{nearby.map((n, i) => (
						<span key={n.row.id}>
							{i ? " · " : ""}
							<span className="text-foreground">{n.row.name}</span>{" "}
							<span className="font-mono tnum">
								{formatDistance(n.km * 1000)} · {n.walkMin} min
							</span>
						</span>
					))}
				</p>
			) : null}
		</section>
	);
}

/** Time needed, and where the number comes from (its planned stop, the estimate). */
export function PlaceTimeNeeded() {
	const panel = usePlacePanel();
	const act = usePlaceActions();
	if (!panel) return null;
	const { row } = panel;
	return (
		<span className="flex flex-wrap items-center gap-2">
			{act.canEdit ? (
				<TimeNeededEditor
					row={row}
					onSet={(m) => act.setTime(row, m)}
					className="h-7 border px-2"
				/>
			) : (
				<TimeNeededLabel row={row} />
			)}
			<span className="text-xs text-muted-foreground">
				{row.timeSource === "planned"
					? "from its planned stop"
					: row.timeSource === "set"
						? "the place's estimate"
						: null}
			</span>
		</span>
	);
}
