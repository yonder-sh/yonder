/**
 * A place's details (docs/PLACES.md §2): everything needed to decide, in the
 * drawer docked beside the table or board, the map view's side panel and
 * the phone's details sheet.
 *
 * - header: name, local name, where, category; status and score chips;
 *   Pin / Unpin, Add to day…, Drop / Bring back, Google Maps;
 * - media strip (photos open the lightbox, PDFs the in-app viewer, both
 *   with Delete; an area with no photos of its own shows its places',
 *   labelled; Add photo / link; a link's trash deletes it);
 * - everyone's ratings with their comments (unrated counts as Sure), yours
 *   editable (keys 1–6 while the drawer has focus);
 * - time needed; where it fits (the days you're in that city, or none yet)
 *   and nearby ideas with distances;
 * - the shared note and your private note (the Notes block).
 */

import { useQuery } from "@tanstack/react-query";
import { distance } from "@turf/distance";
import { point } from "@turf/helpers";
import { cn } from "cn";
import {
	CalendarPlus,
	CircleSlash,
	ExternalLink,
	MapPin,
	MessageSquare,
	Pencil,
	Pin,
	PinOff,
	Trash2,
	Undo2,
	X,
} from "lucide-react";
import { lazy, type ReactNode, Suspense, useMemo, useState } from "react";
import { toast } from "sonner";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { MarkdownText } from "@/components/common/markdown-text";
import { MemberAvatar } from "@/components/common/member";
import { ThumbhashImage } from "@/components/common/thumbhash-image";
import { Button } from "@/components/ui/button";
import { PdfViewer } from "@/features/media/components/pdf-viewer";
import { useMediaActions } from "@/features/media/use-media-actions";
import { NoteBlock } from "@/features/notes/NoteBlock";
import { NODE_TYPES } from "@/lib/domain/taxonomy";
import type { GraphMember } from "@/lib/engine/types";
import { humanError } from "@/lib/errors";
import {
	formatDateRange,
	formatDayDate,
	formatDistance,
	formatDuration,
} from "@/lib/format";
import { mediaUrl } from "@/lib/media-url";
import { activityQuery } from "@/lib/query/trip-queries";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { googleMapsLink } from "../lib/providers";
import { priorityForKey, ratingsCount } from "../lib/rate";
import {
	AddPhotoOrLink,
	PdfRow,
	type Slide,
	usePlaceMedia,
} from "../rate/PlaceMedia";
import { PLACES_TESTID } from "../testids";
import { CategorySelect } from "../ui/category-select";
import { mayRate, RatingCommentEditor } from "../ui/member-ratings";
import { PriorityBadge } from "../ui/priority";
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
import { usePlaceActions } from "./use-place-actions";
import type { PlacesData } from "./use-places";

const MediaLightbox = lazy(
	() => import("@/features/media/components/media-lightbox"),
);

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

function TileImage({ s }: { s: Slide }) {
	if (s.kind === "google")
		return (
			<img
				src={`/api/places/photo/n?nodeId=${encodeURIComponent(s.nodeId)}&idx=${s.photo.idx}&w=400`}
				alt=""
				referrerPolicy="no-referrer"
				className="size-full object-cover"
			/>
		);
	if (s.m.hasThumb || s.m.hasImage)
		return (
			<ThumbhashImage
				hash={s.m.thumbhash}
				src={mediaUrl(s.m.id, s.m.hasThumb ? "thumb" : "image")}
				alt={s.m.caption ?? ""}
				className="size-full"
			/>
		);
	return (
		<span className="grid size-full place-items-center text-xs text-muted-foreground">
			{s.kind === "embed" ? s.embed.provider : s.kind}
		</span>
	);
}

/** Whose photo it is, when an area borrows its places' photos (Shinjuku). */
function FromChip({ s }: { s: Slide }) {
	if (!s.from) return null;
	return (
		<span
			data-testid={PLACES_TESTID.rateMediaFrom}
			className="pointer-events-none absolute bottom-1 left-1 inline-flex max-w-[calc(100%-0.5rem)] items-center gap-0.5 rounded-full bg-black/55 px-1.5 py-px text-[10px] font-medium text-white backdrop-blur-sm"
		>
			<MapPin className="size-2.5 shrink-0" strokeWidth={2} />
			<span className="truncate">{s.from.name}</span>
		</span>
	);
}

function MediaStrip({ row }: { row: PlaceRow }) {
	const { graph, access } = useWorkspace();
	const { slides, links, pdfs, borrowed } = usePlaceMedia(row.node);
	const actions = useMediaActions(graph.trip.id);
	const edit = useEditGuard();
	const canDelete = access.mode !== "read";
	const [open, setOpen] = useState<number | null>(null);
	// The open PDF by id, so "Hide from guests" shows its new state at once.
	const [pdfId, setPdfId] = useState<string | null>(null);
	const pdf = pdfId ? pdfs.find((m) => m.id === pdfId) : undefined;
	const visual = slides.filter((s) => s.kind === "photo" || s.kind === "video");
	const items = visual.flatMap((s) => ("m" in s ? [s.m] : []));
	const tiles = slides.slice(0, 5);
	return (
		<section className="grid gap-2">
			<SectionLabel>
				Media ·{" "}
				<span className="font-mono tnum">
					{slides.length + links.length + pdfs.length}
				</span>
			</SectionLabel>
			{/* An area with no photos of its own (Shinjuku) shows its places', labelled. */}
			{borrowed ? (
				<p className="text-xs text-muted-foreground">
					Photos from places in {row.node.name}.
				</p>
			) : null}
			{tiles.length ? (
				<div className="grid grid-cols-3 gap-1.5">
					{tiles.map((s, i) => {
						const key = s.kind === "google" ? `g${s.photo.idx}` : s.m.id;
						const idx =
							s.kind === "photo" || s.kind === "video"
								? items.findIndex((m) => m.id === s.m.id)
								: -1;
						return idx >= 0 ? (
							<button
								key={key}
								type="button"
								onClick={() => setOpen(idx)}
								aria-label={`Open ${s.kind} ${i + 1}`}
								className="relative aspect-[4/3] cursor-pointer overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								<TileImage s={s} />
								<FromChip s={s} />
							</button>
						) : (
							<a
								key={key}
								href={s.kind === "embed" ? s.embed.href : undefined}
								target="_blank"
								rel="noopener noreferrer"
								className="relative aspect-[4/3] overflow-hidden rounded-lg bg-muted"
							>
								<TileImage s={s} />
								<FromChip s={s} />
							</a>
						);
					})}
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					No photos or videos yet.
				</p>
			)}
			{links.length ? (
				<ul className="grid gap-1 text-[13px]">
					{links.slice(0, 4).map((m) => (
						<li
							key={m.id}
							className="group/link flex min-w-0 items-center gap-1"
						>
							<a
								href={m.url ?? undefined}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex min-w-0 items-center gap-1.5 text-primary hover:underline"
							>
								<ExternalLink className="size-3 shrink-0" />
								<span className="truncate">
									{m.title ?? m.siteName ?? m.url}
								</span>
							</a>
							{canDelete ? (
								<button
									type="button"
									aria-label={`Delete link ${m.title ?? m.siteName ?? m.url ?? ""}`.trim()}
									title={
										edit.disabled ? (edit.reason ?? undefined) : "Delete link"
									}
									disabled={edit.disabled}
									onClick={() => actions.deleteItem(m)}
									className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground opacity-0 outline-none group-hover/link:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed [@media(hover:none)]:opacity-100"
								>
									<Trash2 className="size-3.5" />
								</button>
							) : null}
						</li>
					))}
				</ul>
			) : null}
			{pdfs.length ? (
				<ul className="grid gap-1.5">
					{pdfs.map((m) => (
						<li key={m.id}>
							<PdfRow m={m} onOpen={() => setPdfId(m.id)} />
						</li>
					))}
				</ul>
			) : null}
			<AddPhotoOrLink node={row.node} />
			{pdf ? (
				<PdfViewer
					item={pdf}
					onClose={() => setPdfId(null)}
					onVisibility={(visibility) =>
						actions.visibility.mutate(
							{ id: pdf.id, visibility },
							{ onError: (e) => toast.error(humanError(e)) },
						)
					}
					onDelete={canDelete ? () => actions.deleteItem(pdf) : undefined}
				/>
			) : null}
			{open !== null ? (
				<Suspense fallback={null}>
					<MediaLightbox
						items={items}
						index={open}
						onClose={() => setOpen(null)}
						onVisibility={(id, visibility) =>
							actions.visibility.mutate(
								{ id, visibility },
								{ onError: (e) => toast.error(humanError(e)) },
							)
						}
						onDelete={canDelete ? actions.deleteItem : undefined}
					/>
				</Suspense>
			) : null}
		</section>
	);
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

function RatingRow({ row, member }: { row: PlaceRow; member: GraphMember }) {
	const { access } = useWorkspace();
	const act = usePlaceActions();
	const setShareOpen = useUi((s) => s.setShareOpen);
	const [editing, setEditing] = useState(false);
	const p = row.node.priorities[member.id] ?? null;
	const comment = row.node.ratingComments[member.id];
	const mine = member.id === access.memberId;
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
						<PriorityBadge priority={p} />
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

export function PlaceDetails({
	row,
	data,
	onClose,
	top,
	className,
}: {
	row: PlaceRow;
	data: PlacesData;
	onClose?: () => void;
	/** A bar above the header (the map panel's "← All places"). */
	top?: ReactNode;
	className?: string;
}) {
	const { ix, schedule } = useWorkspace();
	const act = usePlaceActions();
	const node = row.node;
	const mine = act.me ? (node.priorities[act.me] ?? null) : null;
	const nearby = useMemo(
		() => nearbyOf(row, data.rows, { walkKmh: ix.settings.walkSpeedKmh }),
		[row, data.rows, ix.settings.walkSpeedKmh],
	);
	const path = ix
		.path(node.id)
		.slice(0, -1)
		.map((n) => n.name)
		.join(" › ");
	const mapsHref = googleMapsLink({
		name: node.name,
		lat: node.lat,
		lng: node.lng,
		googlePlaceId: node.googlePlaceId,
		googleMapsUri: node.details.googleMapsUri,
	});
	// Everyone who rates: a left-out person's rating still shows, dimmed.
	const members = [...data.allRaters].sort(
		(a, b) => Number(b.id === act.me) - Number(a.id === act.me),
	);
	const pinnedBy = usePinnedBy(node.id, row.info.pinned);
	const reason = rowReason(row, data.bar, pinnedBy);
	const pinLabel =
		row.status === "shortlist"
			? row.info.pinned
				? "Unpin"
				: "Take off shortlist"
			: row.info.unpinned
				? "Back on shortlist"
				: "Pin to shortlist";
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: its rating buttons are the keyboard entry; 1–6 are a shortcut
		<div
			data-testid={PLACES_TAB_TESTID.drawer}
			data-place={node.id}
			className={cn("flex min-h-0 flex-col outline-none", className)}
			// Keys 1–6 rate this place while the drawer has focus.
			onKeyDown={(e) => {
				if (ownsKeys(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
				const p = priorityForKey(e.key);
				if (p) {
					e.preventDefault();
					act.rate(node.id, p);
				}
			}}
			tabIndex={-1}
			data-cursor-anchor={`insp:n.${node.id}`}
		>
			{top}
			<div className="min-h-0 flex-1 overflow-y-auto">
				<header className="grid gap-2 border-b px-4 pt-4 pb-3">
					<div className="flex items-start gap-2">
						<div className="min-w-0 flex-1">
							<h2 className="font-display text-[22px] leading-7 font-semibold text-balance">
								{node.name}
							</h2>
							{node.localName ? (
								<p className="text-sm text-muted-foreground" lang="ja">
									{node.localName}
								</p>
							) : null}
							<div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground">
								{path ? <span>{path}</span> : null}
								{path ? <span aria-hidden>·</span> : null}
								{node.type === "place" ? (
									<CategorySelect
										node={node}
										className="-ml-1.5 h-6 text-[13px] text-muted-foreground"
									/>
								) : (
									<span>{NODE_TYPES[node.type].label}</span>
								)}
							</div>
						</div>
						{onClose ? (
							<Button
								variant="ghost"
								size="icon"
								className="size-8 shrink-0"
								aria-label="Close"
								onClick={onClose}
								data-testid={PLACES_TAB_TESTID.drawerClose}
							>
								<X className="size-4" />
							</Button>
						) : null}
					</div>
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
					<div className="flex flex-wrap items-center gap-1.5 pt-1">
						{row.status !== "scheduled" ? (
							<EditGuard>
								<Button
									variant="outline"
									size="sm"
									data-testid={PLACES_TAB_TESTID.pinButton}
									onClick={() => act.togglePin(row, data.threshold)}
									title="S"
								>
									{row.status === "shortlist" ? <PinOff /> : <Pin />}
									{pinLabel}
								</Button>
							</EditGuard>
						) : null}
						{ix.days.length ? (
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
						{mapsHref ? (
							<Button variant="ghost" size="sm" asChild>
								<a href={mapsHref} target="_blank" rel="noopener noreferrer">
									<ExternalLink />
									Google Maps
								</a>
							</Button>
						) : null}
					</div>
				</header>
				<div className="grid gap-5 px-4 pt-4 pb-6">
					<MediaStrip row={row} />
					<section className="grid gap-2">
						<SectionLabel>Ratings</SectionLabel>
						<ul className="grid">
							{members.map((m) => (
								<RatingRow key={m.id} row={row} member={m} />
							))}
						</ul>
						{act.me ? (
							<div
								className="grid gap-1.5"
								data-testid={PLACES_TAB_TESTID.myRating}
							>
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
									onRate={(p) => act.rate(node.id, p)}
								/>
							</div>
						) : null}
						<p className="text-xs text-muted-foreground">
							Score = sum of ratings (Must +3 … Nah −2; unrated counts as Sure,
							0).
						</p>
					</section>
					<section className="grid gap-1.5">
						<SectionLabel>Time needed</SectionLabel>
						<div className="flex flex-wrap items-center gap-2">
							{act.canEdit ? (
								<TimeNeededEditor
									row={row}
									onSet={(m) => act.setTime(row, m)}
									className="h-8 border px-2"
								/>
							) : (
								<TimeNeededLabel row={row} />
							)}
							<span className="text-xs text-muted-foreground">
								{row.timeSource === "planned"
									? "from its planned stop"
									: row.timeSource === "set"
										? "the place's estimate"
										: "Set it here or in the table."}
							</span>
						</div>
					</section>
					<section
						className="grid gap-1.5"
						data-testid={PLACES_TAB_TESTID.fits}
					>
						<SectionLabel>Where it fits</SectionLabel>
						<p className="rounded-lg bg-muted/60 px-3 py-2 text-sm leading-relaxed">
							{fitsText(row, ix)}
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
					<section className="grid gap-1.5">
						<SectionLabel>Notes</SectionLabel>
						<NoteBlock
							target={{ kind: "node", nodeId: node.id }}
							label={`Notes for ${node.name}`}
						/>
					</section>
				</div>
			</div>
		</div>
	);
}
