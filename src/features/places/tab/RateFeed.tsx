/**
 * Rate as an endless feed (docs/PLACES.md §1b): one place per screen, you
 * just scroll. Phone first (full-bleed media, six big buttons in the thumb
 * zone), the same feed on desktop (media beside the details, keys 1–6 and
 * ↑/↓).
 *
 * - Nothing says next or skip, and a rating doesn't move the feed: scrolling
 *   past a place without rating it skips it; skipped places come back at the
 *   end ("You skipped 3").
 * - Others' ratings stay hidden until you rate, then show right on the card:
 *   their avatars pop onto the buttons they picked and a "Match with Dennis ·
 *   score +6" / "Split" tag appears. "Peek" shows them before you rate.
 * - Scroll back up: everything rated or skipped this session is above you,
 *   with your pick; tap another button to change it.
 * - A milestone card every 10 ratings; "You're all caught up" at the end.
 * - The order: short shuffled city runs, stable per person (`feed.ts`).
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import {
	ArrowDown,
	Check,
	Eye,
	MapPin,
	MessageSquare,
	Scale,
	Sparkles,
	UserPlus,
	X,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import {
	type HTMLAttributeReferrerPolicy,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { MemberAvatar } from "@/components/common/member";
import { ThumbhashImage } from "@/components/common/thumbhash-image";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { noteFor, tripNotesQuery } from "@/features/notes/queries";
import { useNotePreview } from "@/features/notes/use-note-preview";
import { useBreakpoint } from "@/features/shell/use-breakpoint";
import { formatDuration } from "@/lib/format";
import { mediaUrl } from "@/lib/media-url";
import type { FlatValue } from "@/lib/realtime/view-protocol";
import { useMirror } from "@/lib/realtime/view-ui";
import type { Priority } from "@/lib/schemas/enums";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { commentVisibleText, priorityForKey } from "../lib/rate";
import { type Slide, usePlaceMedia } from "../rate/PlaceMedia";
import { PLACES_TESTID } from "../testids";
import { RatingCommentEditor } from "../ui/member-ratings";
import { MiniMap } from "../ui/mini-map";
import {
	FEED_ORDER_LABEL,
	FEED_ORDERS,
	type FeedEntry,
	type FeedOrder,
	type FeedSession,
	feedItems,
	feedOrder,
	isMatch,
	joinPile,
	leftCount,
	matchesOf,
	reachEnd,
	recordRating,
	startSession,
} from "./feed";
import type { PlaceRow } from "./model";
import { fitsText } from "./PlaceDetails";
import { CoverPlaceholder } from "./PlacesBoard";
import { categoryLabel, ownsKeys } from "./PlacesTable";
import { RatingButtons } from "./RatingButtons";
import { formatScore } from "./score";
import { PLACES_TAB_TESTID } from "./testids";
import { ScoreChip } from "./ui";
import { usePlaceActions } from "./use-place-actions";
import { lastReviewView, type PlacesData } from "./use-places";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: FlatValue): v is string =>
	typeof v === "string" && UUID_RE.test(v);

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/** Autoplay (muted) for the provider players, only while the card is in view. */
function autoplaySrc(src: string, provider: string): string {
	const join = src.includes("?") ? "&" : "?";
	if (provider === "youtube") return `${src}${join}autoplay=1&mute=1&loop=1`;
	if (provider === "tiktok") return `${src}${join}autoplay=1&loop=1`;
	return src;
}

/**
 * Media fits whole (never cropped); the space around it is a blurred copy of
 * the same picture, like stories and reels do for non-portrait media.
 */
function Fitted({
	backdrop,
	children,
}: {
	backdrop: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="relative size-full overflow-hidden bg-black">
			<div
				aria-hidden
				className="absolute inset-0 scale-110 opacity-60 blur-2xl [&_img]:size-full [&_img]:object-cover"
			>
				{backdrop}
			</div>
			<div className="relative size-full">{children}</div>
		</div>
	);
}

function FittedImg({
	src,
	alt,
	referrerPolicy,
}: {
	src: string;
	alt: string;
	referrerPolicy?: HTMLAttributeReferrerPolicy;
}) {
	return (
		<Fitted backdrop={<img src={src} alt="" referrerPolicy={referrerPolicy} />}>
			<img
				src={src}
				alt={alt}
				referrerPolicy={referrerPolicy}
				className="size-full object-contain"
			/>
		</Fitted>
	);
}

function SlideFill({
	s,
	active,
	title,
}: {
	s: Slide;
	active: boolean;
	title: string;
}) {
	switch (s.kind) {
		case "photo":
			return (
				<Fitted
					backdrop={
						<ThumbhashImage
							hash={s.m.thumbhash}
							src={mediaUrl(s.m.id, "display")}
							alt=""
							className="size-full"
						/>
					}
				>
					<ThumbhashImage
						hash={s.m.thumbhash}
						src={mediaUrl(s.m.id, "display")}
						alt={s.m.caption ?? title}
						className="size-full [&_img]:object-contain"
					/>
				</Fitted>
			);
		case "video":
			return active ? (
				<Fitted backdrop={<img src={mediaUrl(s.m.id, "poster")} alt="" />}>
					<video
						key={s.m.id}
						autoPlay
						muted
						loop
						playsInline
						preload="metadata"
						poster={mediaUrl(s.m.id, "poster")}
						src={mediaUrl(s.m.id, "original")}
						className="size-full object-contain"
					/>
				</Fitted>
			) : (
				<FittedImg src={mediaUrl(s.m.id, "poster")} alt="" />
			);
		case "embed":
			return active ? (
				<div className="grid size-full place-items-center bg-black">
					<iframe
						key={s.m.id}
						title={s.m.title ?? `${s.embed.provider} video`}
						src={autoplaySrc(s.embed.src, s.embed.provider)}
						sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
						allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
						referrerPolicy="strict-origin-when-cross-origin"
						className={cn(
							"h-full max-w-full border-0",
							s.embed.aspect === "9/16"
								? "aspect-[9/16]"
								: "aspect-video w-full",
						)}
					/>
				</div>
			) : s.m.hasImage ? (
				<FittedImg src={mediaUrl(s.m.id, "image")} alt="" />
			) : (
				<div className="size-full bg-neutral-900" />
			);
		case "google":
			return (
				<FittedImg
					src={`/api/places/photo/n?nodeId=${encodeURIComponent(s.nodeId)}&idx=${s.photo.idx}&w=1200`}
					alt={title}
					referrerPolicy="no-referrer"
				/>
			);
	}
}

export function FeedMedia({
	row,
	active,
	near,
	wide = false,
	className,
}: {
	row: PlaceRow;
	/** The card in view (videos play, ← / → change the photo). */
	active: boolean;
	/** In view or next to it (worth loading). */
	near: boolean;
	/** Beside the details (desktop), not full-bleed under the feed's header. */
	wide?: boolean;
	className?: string;
}) {
	const { slides } = usePlaceMedia(row.node);
	const n = slides.length;
	const [i, setI] = useState(0);
	const at = Math.min(i, Math.max(n - 1, 0));
	const s = slides[at];
	const node = row.node;
	const go = useCallback(
		(d: 1 | -1) => setI((i) => (Math.min(i, n - 1) + d + n) % n),
		[n],
	);
	// ← / → on the card in view (↑ / ↓ move between places).
	useEffect(() => {
		if (!active || n < 2) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey || ownsKeys(e.target)) return;
			if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
			e.preventDefault();
			go(e.key === "ArrowRight" ? 1 : -1);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [active, n, go]);
	// A sideways swipe changes the photo (the feed itself scrolls up and down).
	const touch = useRef<{ x: number; y: number } | null>(null);
	return (
		<div
			data-testid={PLACES_TESTID.feedMedia}
			data-slide={n ? at : undefined}
			className={cn("relative overflow-hidden bg-neutral-900", className)}
			onTouchStart={(e) => {
				const t = e.touches[0];
				touch.current = t && n > 1 ? { x: t.clientX, y: t.clientY } : null;
			}}
			onTouchEnd={(e) => {
				const a = touch.current;
				const t = e.changedTouches[0];
				touch.current = null;
				if (!a || !t) return;
				const dx = t.clientX - a.x;
				const dy = t.clientY - a.y;
				if (Math.abs(dx) > 40 && Math.abs(dx) > 1.5 * Math.abs(dy))
					go(dx < 0 ? 1 : -1);
			}}
		>
			{!near ? null : s ? (
				<SlideFill s={s} active={active} title={node.name} />
			) : node.lat !== null && node.lng !== null ? (
				<MiniMap
					lat={node.lat}
					lng={node.lng}
					zoom={14}
					type={node.type}
					category={node.category}
					interactive={false}
					className="size-full"
					label={`Map of ${node.name}`}
				/>
			) : (
				<CoverPlaceholder row={row} className="size-full" />
			)}
			{near && n > 1 ? (
				// Like stories: the left third goes back, the rest forward (over a
				// video player only its edges, so its own controls still work).
				<>
					<button
						type="button"
						aria-label="Previous photo"
						onClick={() => go(-1)}
						className={cn(
							"absolute inset-y-0 left-0 z-[1] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-inset",
							s?.kind === "embed" ? "w-[12%]" : "w-1/3",
						)}
					/>
					<button
						type="button"
						aria-label="Next photo"
						onClick={() => go(1)}
						className={cn(
							"absolute inset-y-0 right-0 z-[1] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-inset",
							s?.kind === "embed" ? "w-[12%]" : "w-2/3",
						)}
					/>
				</>
			) : null}
			{n > 1 || (near && s?.from) ? (
				<div
					className={cn(
						"pointer-events-none absolute inset-x-4 z-[3] flex flex-col items-start gap-2",
						wide ? "top-3" : "top-12",
					)}
				>
					{n > 1 ? (
						<div
							data-testid={PLACES_TESTID.rateMediaBars}
							role="img"
							aria-label={`Photo ${at + 1} of ${n}`}
							className="flex w-full gap-1"
						>
							{slides.map((_, j) => (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: one bar per slide, in order
									key={j}
									className={cn(
										"h-[3px] flex-1 rounded-full shadow-[0_0_2px_rgb(0_0_0/.35)] transition-colors",
										j <= at ? "bg-white" : "bg-white/35",
									)}
								/>
							))}
						</div>
					) : null}
					{/* An area with no photos of its own (Shinjuku) shows its places', labelled. */}
					{near && s?.from ? (
						<span
							data-testid={PLACES_TESTID.rateMediaFrom}
							title={`Photo from ${s.from.name}`}
							className="inline-flex h-[22px] max-w-[calc(100%-10rem)] min-w-0 items-center gap-1 rounded-full bg-black/55 px-2 text-[11px] font-medium text-white backdrop-blur-sm"
						>
							<MapPin className="size-3 shrink-0" strokeWidth={2} />
							<span className="truncate">{s.from.name}</span>
						</span>
					) : null}
				</div>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function nameOf(data: PlacesData, id: string, short = true): string {
	const m = data.members.find((x) => x.id === id);
	return (short ? m?.firstName : undefined) ?? m?.name ?? "someone";
}

/** "Match with Dennis · score +6", "Split", "First to rate · +3". */
function revealTag(
	row: PlaceRow,
	data: PlacesData,
	me: string,
): { text: string; tone: "match" | "split" | "plain" } | null {
	const mine = row.node.priorities[me];
	if (!mine) return null;
	const score = formatScore(row.score);
	if (row.split) return { text: `Split · score ${score}`, tone: "split" };
	const others = data.memberIds.filter(
		(m) => m !== me && row.node.priorities[m],
	);
	const matches = matchesOf(row.node.priorities, me, others);
	if (matches.length) {
		const names = matches.map((m) => nameOf(data, m));
		const who =
			names.length > 2
				? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
				: names.join(" and ");
		return { text: `Match with ${who} · score ${score}`, tone: "match" };
	}
	if (!others.length)
		return { text: `First to rate · score ${score}`, tone: "plain" };
	return { text: `Score ${score}`, tone: "plain" };
}

/**
 * Desktop: decide with the same context as the drawer (docs/PLACES.md §1):
 * the shared note, your private note, where it fits.
 */
function CardContext({ row }: { row: PlaceRow }) {
	const { graph, ix, mode } = useWorkspace();
	const notes = useQuery({
		...tripNotesQuery(graph.trip.id),
		enabled: mode === "live",
	}).data;
	const target = { kind: "node" as const, nodeId: row.id };
	const shared = noteFor(notes, target)?.plainText?.trim();
	const mine = graph.me.userId
		? noteFor(notes, target, graph.me.userId)?.plainText?.trim()
		: undefined;
	return (
		<div className="grid gap-4 text-sm">
			<section className="grid gap-1">
				<h3 className="text-[11px] font-semibold tracking-[0.06em] text-neutral-400 uppercase">
					Where it fits
				</h3>
				<p className="text-neutral-200">{fitsText(row, ix)}</p>
			</section>
			{shared ? (
				<section className="grid gap-1">
					<h3 className="text-[11px] font-semibold tracking-[0.06em] text-neutral-400 uppercase">
						Shared note
					</h3>
					<p className="line-clamp-[8] whitespace-pre-line text-neutral-200">
						{shared}
					</p>
				</section>
			) : null}
			{mine ? (
				<section className="grid gap-1">
					<h3 className="text-[11px] font-semibold tracking-[0.06em] text-neutral-400 uppercase">
						Your private note
					</h3>
					<p className="line-clamp-4 whitespace-pre-line text-neutral-300">
						{mine}
					</p>
				</section>
			) : null}
		</div>
	);
}

function PlaceCard({
	row,
	data,
	cardKey,
	active,
	near,
	peeked,
	onPeek,
	onRate,
	phone,
	wide,
}: {
	row: PlaceRow;
	data: PlacesData;
	cardKey: string;
	active: boolean;
	near: boolean;
	peeked: boolean;
	onPeek: () => void;
	onRate: (p: Priority | null) => void;
	phone: boolean;
	/** The feed is wide enough for the media beside the details. */
	wide: boolean;
}) {
	const act = usePlaceActions();
	const me = act.me;
	const node = row.node;
	const mine = me ? (node.priorities[me] ?? null) : null;
	const hook = useNotePreview(
		active ? { kind: "node", nodeId: node.id } : null,
	);
	const { links } = usePlaceMedia(node);
	const line =
		hook ?? links.find((m) => m.title)?.title ?? node.description ?? null;
	const others = data.memberIds.filter((m) => m !== me && node.priorities[m]);
	const shown = !!mine || peeked;
	const reveal = useMemo(() => {
		if (!shown) return null;
		const out: Partial<Record<Priority, string[]>> = {};
		for (const m of others) {
			const p = node.priorities[m];
			if (!p) continue;
			const list = out[p] ?? [];
			list.push(m);
			out[p] = list;
		}
		return out;
	}, [shown, others, node.priorities]);
	const tag = me && mine ? revealTag(row, data, me) : null;
	const [commenting, setCommenting] = useState(false);
	const comment = me ? node.ratingComments[me] : undefined;
	const meta = [
		row.where,
		categoryLabel(row),
		row.timeMin === null
			? "time needed not set"
			: `${formatDuration(row.timeMin)}${row.timeSource === "planned" ? " planned" : ""}`,
	]
		.filter(Boolean)
		.join(" · ");

	const details = (
		<div className="flex flex-col gap-3">
			{tag ? (
				<span
					data-testid={PLACES_TAB_TESTID.feedTag}
					data-tone={tag.tone}
					className={cn(
						"inline-flex h-[30px] w-fit items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold animate-in fade-in-0 zoom-in-95 duration-200 motion-reduce:animate-none",
						tag.tone === "split"
							? "bg-warning text-black"
							: "bg-white text-neutral-900",
					)}
				>
					{tag.tone === "split" ? (
						<Scale className="size-3.5" />
					) : tag.tone === "match" ? (
						<Sparkles className="size-3.5" />
					) : null}
					{tag.text}
				</span>
			) : null}
			{line ? (
				<p className="line-clamp-2 text-sm text-neutral-300">{line}</p>
			) : null}
			<div className="flex flex-col gap-0.5">
				<h2 className="font-display text-[26px] leading-tight font-semibold text-white">
					{node.name}
				</h2>
				<p className="text-[13px] text-neutral-400">{meta}</p>
			</div>
			<RatingButtons
				variant="filled"
				value={mine}
				reveal={reveal}
				disabled={!act.canRate}
				reason={act.rateReason}
				keys={!phone}
				onRate={onRate}
			/>
			<div className="flex min-h-7 flex-wrap items-center gap-2 text-xs text-neutral-400">
				{shown && others.length === 0 && !mine ? (
					<span>Nobody else has rated it yet.</span>
				) : null}
				{mine && !commenting ? (
					comment ? (
						<button
							type="button"
							onClick={() => setCommenting(true)}
							className="inline-flex max-w-full cursor-pointer items-center gap-1 truncate hover:text-white"
						>
							<MessageSquare className="size-3 shrink-0" />
							{/* As it reads: a mention is its "@Name", never its stored token. */}
							<span className="truncate">{commentVisibleText(comment)}</span>
						</button>
					) : act.canRate ? (
						<button
							type="button"
							onClick={() => setCommenting(true)}
							className="inline-flex cursor-pointer items-center gap-1 hover:text-white"
						>
							<MessageSquare className="size-3" />
							Add a comment
						</button>
					) : null
				) : null}
			</div>
			{commenting && mine && me ? (
				<div className="rounded-lg bg-neutral-900 p-2">
					<RatingCommentEditor
						node={node}
						memberId={me}
						priority={mine}
						onDone={() => setCommenting(false)}
						autoFocus
					/>
				</div>
			) : null}
		</div>
	);

	return (
		<article
			data-testid={PLACES_TAB_TESTID.feedCard}
			data-key={cardKey}
			data-place={node.id}
			data-rated={mine ?? undefined}
			data-active={active || undefined}
			aria-label={node.name}
			className="relative h-full w-full shrink-0 snap-start snap-always overflow-hidden"
		>
			{wide ? (
				// Wide: the media beside the details.
				<div className="grid h-full grid-cols-[minmax(0,1fr)_400px] gap-5 p-5 pt-16">
					<FeedMedia
						row={row}
						active={active}
						near={near}
						wide
						className="h-full rounded-2xl"
					/>
					<div className="flex min-h-0 flex-col gap-5 overflow-y-auto rounded-2xl bg-neutral-950 p-5 ring-1 ring-white/10">
						{active ? <CardContext row={row} /> : null}
						<div className="mt-auto">{details}</div>
					</div>
				</div>
			) : (
				// Phone and narrow: full-bleed media, the details over it.
				<div className="absolute inset-0">
					<FeedMedia
						row={row}
						active={active}
						near={near}
						className="size-full"
					/>
					<div className="absolute inset-x-0 bottom-0 z-[2] bg-gradient-to-b from-transparent to-black/90 to-40% px-4 pt-16 pb-[max(18px,env(safe-area-inset-bottom))]">
						{details}
					</div>
				</div>
			)}
			{!mine && !peeked && others.length ? (
				<button
					type="button"
					data-testid={PLACES_TAB_TESTID.feedPeek}
					onClick={onPeek}
					className="absolute top-14 right-4 z-[3] inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-white/25 bg-black/55 px-3 text-xs font-medium text-white backdrop-blur-sm hover:bg-black/70"
				>
					<Eye className="size-3.5" />
					Peek at {others.length} {others.length === 1 ? "rating" : "ratings"}
				</button>
			) : null}
		</article>
	);
}

function Slate({
	children,
	testid,
	cardKey,
}: {
	children: ReactNode;
	testid: string;
	cardKey: string;
}) {
	return (
		<section
			data-testid={testid}
			data-key={cardKey}
			className="flex h-full w-full shrink-0 snap-start snap-always flex-col justify-center overflow-y-auto bg-neutral-950 px-6 py-16 text-white"
		>
			<div className="mx-auto flex w-full max-w-md flex-col gap-5">
				{children}
			</div>
		</section>
	);
}

function Stat({ n, label }: { n: number | string; label: string }) {
	return (
		<div className="flex flex-col gap-1 rounded-2xl bg-neutral-900 p-4">
			<span className="font-display text-3xl font-semibold tnum">{n}</span>
			<span className="text-[13px] text-neutral-400">{label}</span>
		</div>
	);
}

function friendsStats(data: PlacesData, me: string) {
	const rows = data.rows.filter((r) => r.status !== "dropped");
	return data.members
		.filter((m) => m.id !== me)
		.map((m) => {
			let matches = 0;
			const agree: PlaceRow[] = [];
			for (const r of rows) {
				const a = r.node.priorities[me];
				const b = r.node.priorities[m.id];
				if (!a || !b) continue;
				if (isMatch(a, b)) matches += 1;
				const keen = (p: Priority) => p === "must" || p === "really_want";
				if (keen(a) && keen(b)) agree.push(r);
			}
			return { member: m, matches, agree };
		});
}

function MilestoneCard({
	n,
	data,
	session,
	cardKey,
	left,
}: {
	n: number;
	data: PlacesData;
	session: FeedSession;
	cardKey: string;
	left: number;
}) {
	const act = usePlaceActions();
	const me = act.me ?? "";
	const friends = friendsStats(data, me);
	const rising = session.rated
		.map((id) => data.byId.get(id))
		.filter((r): r is PlaceRow => !!r)
		.sort((a, b) => b.score - a.score)
		.slice(0, 3);
	return (
		<Slate testid={PLACES_TAB_TESTID.feedMilestone} cardKey={cardKey}>
			<span className="font-mono text-xs text-neutral-400 tnum">
				{n * 10} rated · {left} left
			</span>
			<h2 className="font-display text-[34px] leading-tight font-semibold">
				10 more done.
				<br />
				Here's how it's going.
			</h2>
			<div className="grid grid-cols-2 gap-2.5">
				{friends.slice(0, 3).map((f) => (
					<Stat
						key={f.member.id}
						n={f.matches}
						label={`${f.matches === 1 ? "match" : "matches"} with ${f.member.firstName ?? f.member.name}`}
					/>
				))}
				<Stat n={data.counts.talk} label="split to talk about" />
			</div>
			{rising.length ? (
				<div className="flex flex-col gap-2">
					<span className="text-xs font-semibold tracking-[0.08em] text-neutral-400 uppercase">
						Rising to the top
					</span>
					{rising.map((r) => (
						<span
							key={r.id}
							className="flex items-center justify-between gap-3 text-[15px]"
						>
							<span className="truncate">{r.name}</span>
							<ScoreChip score={r.score} />
						</span>
					))}
				</div>
			) : null}
			<span className="flex items-center gap-1.5 text-[13px] text-neutral-400">
				<ArrowDown className="size-3.5" />
				Keep scrolling
			</span>
		</Slate>
	);
}

function SkippedCard({ count, cardKey }: { count: number; cardKey: string }) {
	return (
		<Slate testid={PLACES_TAB_TESTID.feedSkipped} cardKey={cardKey}>
			<h2 className="font-display text-[32px] leading-tight font-semibold">
				You skipped {count}.
			</h2>
			<p className="text-[15px] text-neutral-400">
				Rate {count === 1 ? "it" : "them"} now:{" "}
				{count === 1 ? "it's" : "they're"} just below.
			</p>
			<span className="flex items-center gap-1.5 text-[13px] text-neutral-400">
				<ArrowDown className="size-3.5" />
				Keep scrolling
			</span>
		</Slate>
	);
}

function EndCard({
	data,
	cardKey,
	rated,
}: {
	data: PlacesData;
	cardKey: string;
	rated: number;
}) {
	const { scope, graph, nav } = useWorkspace();
	const act = usePlaceActions();
	const setShareOpen = useUi((s) => s.setShareOpen);
	const me = act.me ?? "";
	const friends = friendsStats(data, me).sort((a, b) => b.matches - a.matches);
	const best = friends.find((f) => f.agree.length);
	const where = scope?.name ?? graph.trip.name;
	return (
		<Slate testid={PLACES_TAB_TESTID.feedEnd} cardKey={cardKey}>
			<span className="grid size-16 place-items-center rounded-full border-[3px] border-emerald-400 text-emerald-400">
				<Check className="size-8" strokeWidth={2.6} />
			</span>
			<div className="flex flex-col gap-1.5">
				<h2 className="font-display text-[32px] leading-tight font-semibold">
					You're all caught up
				</h2>
				<p className="text-[15px] text-neutral-400">
					{rated
						? `You've rated all ${rated} ${rated === 1 ? "place" : "places"} here in ${where}.`
						: `Nothing left to rate in ${where}.`}{" "}
					New ones show up here as people add them. Scroll up to see or change
					anything you rated this session.
				</p>
			</div>
			<div className="flex flex-col gap-2.5 rounded-2xl bg-neutral-900 p-4">
				<span className="text-xs font-semibold tracking-[0.08em] text-neutral-400 uppercase">
					The group
				</span>
				{data.progress.map((p) => {
					const noAccount = !p.member.userId;
					return (
						<span
							key={p.member.id}
							className="flex items-center justify-between gap-2 text-[15px]"
						>
							<span className="flex min-w-0 items-center gap-2">
								<MemberAvatar memberId={p.member.id} size={20} ring={false} />
								<span className="truncate">
									{p.member.name}
									{p.member.id === me ? " (you)" : ""}
									{noAccount ? (
										<span className="text-neutral-500"> · no account yet</span>
									) : null}
								</span>
							</span>
							<span className="flex shrink-0 items-center gap-2">
								<span
									className={cn(
										"font-mono text-sm tnum",
										p.rated === p.total
											? "text-emerald-400"
											: "text-neutral-400",
									)}
								>
									{p.rated}/{p.total}
								</span>
								{noAccount ? (
									<Button
										size="xs"
										variant="secondary"
										data-testid={PLACES_TAB_TESTID.feedInvite}
										onClick={() => setShareOpen(true)}
									>
										<UserPlus />
										Invite
									</Button>
								) : null}
							</span>
						</span>
					);
				})}
			</div>
			{best ? (
				<div className="flex flex-col gap-2">
					<span className="text-xs font-semibold tracking-[0.08em] text-neutral-400 uppercase">
						Where you and {best.member.firstName ?? best.member.name} agree
					</span>
					{best.agree
						.sort((a, b) => b.score - a.score)
						.slice(0, 5)
						.map((r) => (
							<span
								key={r.id}
								className="flex items-center justify-between gap-3 text-[15px]"
							>
								<span className="truncate">{r.name}</span>
								<ScoreChip score={r.score} />
							</span>
						))}
				</div>
			) : null}
			<Button
				size="lg"
				className="h-12 rounded-xl"
				data-testid={PLACES_TAB_TESTID.feedShortlist}
				// The flow's next step (owner, 2026-09-25): the shortlist onto days.
				onClick={() =>
					nav.setPlaces({ pv: "schedule", pst: undefined, talk: undefined })
				}
			>
				Next: schedule the shortlist
			</Button>
		</Slate>
	);
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

type FeedState = {
	key: string;
	s: FeedSession;
	runs: Map<string, FeedEntry>;
};

export default function RateFeed({ data }: { data: PlacesData }) {
	const { graph, scope, search, sel, nav, mode } = useWorkspace();
	const act = usePlaceActions();
	const bp = useBreakpoint();
	const phone = bp === "sm";
	const reduce = useReducedMotion();
	const me = act.me;
	const order = data.state.order;
	const root = useRef<HTMLDivElement>(null);
	// Wide enough (768px) for the media beside the details; one layout at a time.
	const [wide, setWide] = useState(false);
	useLayoutEffect(() => {
		const el = root.current;
		if (!el) return;
		const measure = () => setWide(!phone && el.clientWidth >= 768);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [phone]);

	const isRated = useCallback(
		(id: string) => !!me && !!data.byId.get(id)?.node.priorities[me],
		[me, data.byId],
	);
	// The pile: the filtered places I haven't rated (dropped ones never).
	const candidates = useMemo(
		() =>
			data.visible.filter(
				(r) => r.status !== "dropped" && !(me && r.node.priorities[me]),
			),
		[data.visible, me],
	);
	const sessionKey = `${scope?.id ?? ""}|${search.f ?? ""}|${search.pst ?? ""}|${search.talk ?? ""}|${order}|${me ?? ""}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: built once per session key; later changes join its end
	const build = useCallback((): FeedState => {
		const entries = feedOrder(
			candidates.map((r) => ({
				id: r.id,
				city: r.city?.id ?? "none",
				media: r.media,
				outline: 0,
			})),
			{ seed: `${graph.trip.id}:${me ?? graph.me.userId}`, order },
		);
		const ids = entries.map((e) => e.id);
		// A link to one place (the old Rate screen's `n`, a table row) starts there.
		const first = sel?.kind === "node" ? sel.id : null;
		const pile =
			first && data.byId.has(first)
				? [first, ...ids.filter((id) => id !== first)]
				: ids;
		return {
			key: sessionKey,
			s: startSession(pile),
			runs: new Map(entries.map((e) => [e.id, e])),
		};
	}, [sessionKey]);
	const [state, setState] = useState<FeedState>(build);
	const live = state.key === sessionKey ? state : build();
	useEffect(() => {
		if (state.key !== sessionKey) setState(build());
	}, [state.key, sessionKey, build]);
	const session = live.s;

	// New places (added while the feed is open) join the end of the pile.
	const candidateIds = useMemo(() => candidates.map((r) => r.id), [candidates]);
	useEffect(() => {
		setState((st) => {
			if (st.key !== sessionKey) return st;
			const s = joinPile(st.s, candidateIds);
			return s === st.s ? st : { ...st, s };
		});
	}, [candidateIds, sessionKey]);

	const items = useMemo(() => feedItems(session), [session]);
	const [current, setCurrent] = useState<string | null>(null);
	const currentIndex = Math.max(
		0,
		items.findIndex((it) => it.key === current),
	);
	const currentItem = items[currentIndex];
	const currentPlace =
		currentItem?.kind === "place" ? data.byId.get(currentItem.id) : undefined;

	// Which card is in view: the one mostly on screen (observed again when the cards change).
	// biome-ignore lint/correctness/useExhaustiveDependencies: `items` re-renders the cards to observe
	useEffect(() => {
		const el = root.current;
		if (!el) return;
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries)
					if (e.isIntersecting && e.intersectionRatio >= 0.6) {
						const k = (e.target as HTMLElement).dataset.key;
						if (k) setCurrent(k);
					}
			},
			{ root: el, threshold: [0.6] },
		);
		for (const c of el.querySelectorAll<HTMLElement>("[data-key]"))
			io.observe(c);
		return () => io.disconnect();
	}, [items]);

	// The end of the pile: skipped places come back, once.
	useEffect(() => {
		if (currentItem?.kind !== "end" || session.skipped !== null) return;
		setState((st) => ({ ...st, s: reachEnd(st.s, isRated) }));
	}, [currentItem?.kind, session.skipped, isRated]);

	const scrollToKey = useCallback(
		(key: string, smooth = true) => {
			const el = root.current?.querySelector<HTMLElement>(
				`[data-key="${CSS.escape(key)}"]`,
			);
			el?.scrollIntoView({
				behavior: smooth && !reduce ? "smooth" : "auto",
				block: "start",
			});
		},
		[reduce],
	);
	// Quick ↓ ↓ while the first scroll is still moving: step from where it's
	// heading, not from the card still in view.
	const aim = useRef<{ index: number; at: number } | null>(null);
	const step = useCallback(
		(dir: 1 | -1) => {
			const a = aim.current;
			const from =
				a && Date.now() - a.at < 1200 && a.index !== currentIndex
					? a.index
					: currentIndex;
			const to = Math.max(0, Math.min(items.length - 1, from + dir));
			const next = items[to];
			if (!next || to === from) return;
			aim.current = { index: to, at: Date.now() };
			scrollToKey(next.key);
		},
		[items, currentIndex, scrollToKey],
	);

	// Follow (FB-21): the card in view travels; a follower scrolls to it (it
	// joins their feed when they had already rated it).
	const focusPlace = useCallback(
		(id: string) => {
			if (!data.byId.has(id)) return;
			const k = items.find((it) => it.kind === "place" && it.id === id)?.key;
			if (k) {
				scrollToKey(k);
				return;
			}
			setState((st) => {
				const pile = [...st.s.pile];
				const at = current ? pile.indexOf(current) : -1;
				pile.splice(at + 1, 0, id);
				return { ...st, s: { ...st.s, pile } };
			});
			requestAnimationFrame(() => scrollToKey(id));
		},
		[data.byId, items, current, scrollToKey],
	);
	useMirror(
		"places.card",
		currentItem?.kind === "place" ? currentItem.id : undefined,
		focusPlace,
		isUuid,
		mode === "live",
	);

	// Start at the top of the pile (or where a link pointed).
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new session starts at its top
	useLayoutEffect(() => {
		root.current?.scrollTo({ top: 0 });
		setCurrent(null);
	}, [sessionKey]);

	const [peeked, setPeeked] = useState<ReadonlySet<string>>(new Set());
	const rate = useCallback(
		(id: string, key: string, p: Priority | null) => {
			if (!act.rate(id, p)) return;
			if (p) setState((st) => ({ ...st, s: recordRating(st.s, id, key) }));
		},
		[act],
	);

	// Keys: 1–6 rate the card in view, 0 clears, ↑ / ↓ (or K / J) move, P peeks.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			// A field, menu or dialog with the focus keeps its keys.
			if (e.metaKey || e.ctrlKey || e.altKey || ownsKeys(e.target)) return;
			const p = priorityForKey(e.key);
			if (p && currentItem?.kind === "place") {
				e.preventDefault();
				rate(currentItem.id, currentItem.key, p);
			} else if (
				(e.key === "0" || e.key === "Backspace") &&
				currentItem?.kind === "place"
			) {
				e.preventDefault();
				rate(currentItem.id, currentItem.key, null);
			} else if (e.key === "ArrowDown" || e.key === "j") {
				e.preventDefault();
				step(1);
			} else if (e.key === "ArrowUp" || e.key === "k") {
				e.preventDefault();
				step(-1);
			} else if ((e.key === "p" || e.key === "P") && currentItem) {
				e.preventDefault();
				setPeeked((s) => new Set(s).add(currentItem.key));
			}
		};
		// Capture: ahead of the workspace's J / K / Enter shortcuts.
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [currentItem, rate, step]);

	const left = leftCount(session, isRated);
	const run = currentPlace ? live.runs.get(currentPlace.id) : undefined;
	const ratedHere = session.pile.filter(isRated).length;

	const feed = (
		<div
			data-testid={PLACES_TAB_TESTID.feed}
			data-left={left}
			className={cn(
				"dark relative flex min-h-0 flex-1 flex-col bg-black text-white",
				phone && "fixed inset-0 z-[60]",
			)}
		>
			<div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2.5 bg-gradient-to-b from-black/75 to-transparent px-4 pt-[max(12px,env(safe-area-inset-top))] pb-6">
				<span className="font-display text-[17px] font-semibold">Rate</span>
				<span
					className="min-w-0 truncate text-[13px] text-neutral-400"
					data-testid={PLACES_TAB_TESTID.feedRun}
				>
					{currentPlace
						? `Now in ${currentPlace.city?.name ?? "—"}${run && run.len > 1 ? ` · ${run.pos + 1} of ${run.len}` : ""}`
						: currentItem?.kind === "end"
							? "All caught up"
							: ""}
				</span>
				<span className="ml-auto" />
				<span
					className="shrink-0 font-mono text-xs whitespace-nowrap text-neutral-400 tnum"
					data-testid={PLACES_TAB_TESTID.feedLeft}
				>
					{left} left
				</span>
				<div className="pointer-events-auto">
					<Select
						value={order}
						onValueChange={(v) => nav.setPlaces({ po: v as FeedOrder })}
					>
						<SelectTrigger
							size="sm"
							className="h-7 border-white/20 bg-black/40 text-xs text-white"
							aria-label="Order"
							data-testid={PLACES_TAB_TESTID.feedOrder}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{FEED_ORDERS.map((o) => (
								<SelectItem key={o} value={o}>
									{FEED_ORDER_LABEL[o]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				{phone ? (
					<Button
						size="icon"
						variant="ghost"
						className="pointer-events-auto size-8 text-white"
						aria-label="Close the feed"
						onClick={() => nav.setPlaces({ pv: lastReviewView.current })}
					>
						<X />
					</Button>
				) : null}
			</div>
			<div
				ref={root}
				className="min-h-0 flex-1 snap-y snap-mandatory overflow-y-auto overscroll-contain [scrollbar-width:none]"
			>
				{items.map((it, i) => {
					const near = Math.abs(i - currentIndex) <= 1;
					if (it.kind === "place") {
						const row = data.byId.get(it.id);
						if (!row) return null;
						return (
							<PlaceCard
								key={it.key}
								row={row}
								data={data}
								cardKey={it.key}
								active={i === currentIndex}
								near={near}
								peeked={peeked.has(it.key)}
								onPeek={() => setPeeked((s) => new Set(s).add(it.key))}
								onRate={(p) => rate(it.id, it.key, p)}
								phone={phone}
								wide={wide}
							/>
						);
					}
					if (it.kind === "milestone")
						return (
							<MilestoneCard
								key={it.key}
								n={it.n}
								data={data}
								session={session}
								cardKey={it.key}
								left={left}
							/>
						);
					if (it.kind === "skipped")
						return (
							<SkippedCard key={it.key} count={it.count} cardKey={it.key} />
						);
					return (
						<EndCard
							key={it.key}
							data={data}
							cardKey={it.key}
							rated={ratedHere}
						/>
					);
				})}
			</div>
		</div>
	);
	return phone ? createPortal(feed, document.body) : feed;
}
