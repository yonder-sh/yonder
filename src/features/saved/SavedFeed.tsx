/**
 * Saved as a feed, like Rate's (`places/tab/RateFeed.tsx`): one saved link
 * per screen, you just scroll. Narrow (phones): its media full-screen under a
 * thin bar (the reel or TikTok plays, the next one loads ahead), then one
 * swipe up its details with the save controls at the bottom, in the thumb
 * zone. Wide: the media beside the details, ↑/↓ to move.
 *
 * - Save files it into a trip (the share page's controls, `Saver`) and moves
 *   on to the next after a beat, with "Saved to Kyoto ideas · Japan 2027";
 *   Delete removes it from Saved (with Undo); scrolling past keeps it.
 * - Shared photos and videos are one item: their slides swipe sideways (as
 *   a place's photos do in Rate); a video plays when it's on screen.
 * - Saved and deleted ones stay in this session's feed (scroll back up to see
 *   them); the grid drops them.
 * - The end: "That's everything you saved", back to the grid.
 */
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronUp, ExternalLink, Trash2, X } from "lucide-react";
import { useReducedMotion } from "motion/react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { ThumbhashImage } from "@/components/common/thumbhash-image";
import { Button } from "@/components/ui/button";
import { type SaveResult, Saver } from "@/features/home/Saver";
import { canonicalLink } from "@/features/media/embeds";
import {
	EmbedPlayer,
	Fitted,
	FittedImg,
	useCardInView,
	useCoarsePointer,
} from "@/features/media/feed-player";
import { embedOf } from "@/features/places/rate/PlaceMedia";
import { MiniMap } from "@/features/places/ui/mini-map";
import { useBreakpoint } from "@/features/shell/use-breakpoint";
import { meKeys } from "@/lib/query/keys";
import { cn } from "@/lib/utils";
import { feedPile, savedKind, sourceLabel, tileLine, toEntry } from "./lib";
import { SavedPlaceholder, SourceMark, savedFileUrl } from "./SavedTile";
import { attachSavedFiles, markSavedAdded } from "./saved.functions";
import { SAVED_TESTID } from "./testids";
import type { SavedFile, SavedLink } from "./types";
import { useDeleteSaved } from "./use-delete-saved";

/** How long a saved card stays before the feed moves on. */
const ADVANCE_MS = 1100;

type Done = { kind: "saved"; text: string } | { kind: "deleted" };

/** A field, menu or dialog with the focus keeps its keys. */
function ownsKeys(t: EventTarget | null): boolean {
	const el = t as HTMLElement | null;
	if (!el?.tagName) return false;
	if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
		return true;
	return !!el.closest(
		"[role=dialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper]",
	);
}

/** "Saved to Kyoto ideas · Japan 2027" (the trip once). */
export function confirmation(r: Pick<SaveResult, "text" | "tripName">) {
	return r.text.includes(r.tripName) ? r.text : `${r.text} · ${r.tripName}`;
}

function SavedMedia({
	link,
	active,
	near,
	ahead,
	className,
}: {
	link: SavedLink;
	/** In view: the video plays. */
	active: boolean;
	/** In view or next to it (worth loading). */
	near: boolean;
	/** Next up: its reel or TikTok loads now, paused. */
	ahead: boolean;
	className?: string;
}) {
	const embed = useMemo(
		() =>
			link.provider
				? embedOf({
						provider: link.provider,
						embedId: link.embedId,
						url: link.url,
					})
				: null,
		[link.provider, link.embedId, link.url],
	);
	const line = tileLine(link);
	let body: React.ReactNode = null;
	if (!near) body = null;
	else if (link.files.length)
		return (
			<SavedSlides
				files={link.files}
				title={line}
				active={active}
				className={className}
			/>
		);
	else if (embed && (active || ahead))
		body = <EmbedPlayer embed={embed} title={line} play={active} />;
	else if (link.image) body = <FittedImg src={link.image} alt={line} />;
	else if (savedKind(link) === "maps" && link.place)
		body = (
			<MiniMap
				lat={link.place.lat}
				lng={link.place.lng}
				zoom={15}
				type="place"
				category={null}
				interactive={false}
				className="size-full"
				label={`Map of ${link.place.name}`}
			/>
		);
	else body = <SavedPlaceholder link={link} className="size-full" />;
	return (
		<div className={cn("relative overflow-hidden bg-black", className)}>
			{body}
		</div>
	);
}

/** A saved photo or video, fitted; a video plays (muted, looping) while it's the one in view. */
function FileSlide({
	f,
	play,
	title,
}: {
	f: SavedFile;
	play: boolean;
	title: string;
}) {
	if (f.kind === "video")
		return play ? (
			<Fitted
				backdrop={
					f.hasPoster ? <img src={savedFileUrl(f, "poster")} alt="" /> : null
				}
			>
				<video
					autoPlay
					muted
					loop
					playsInline
					preload="metadata"
					{...(f.hasPoster ? { poster: savedFileUrl(f, "poster") } : {})}
					src={savedFileUrl(f, "original")}
					className="size-full object-contain"
				/>
			</Fitted>
		) : f.hasPoster ? (
			<FittedImg src={savedFileUrl(f, "poster")} alt="" />
		) : (
			<div className="size-full bg-black" />
		);
	const src = savedFileUrl(f, f.hasThumb ? "display" : "original");
	return (
		<Fitted
			backdrop={
				<img src={savedFileUrl(f, f.hasThumb ? "thumb" : "original")} alt="" />
			}
		>
			<ThumbhashImage
				hash={f.thumbhash}
				src={src}
				alt={title}
				className="size-full [&_img]:object-contain"
			/>
		</Fitted>
	);
}

/**
 * A share's photos and videos side by side in a track that scrolls sideways
 * (a native swipe), with dots, like a place's photos in Rate's feed; with a
 * mouse, clicks on the sides and ← / → step through them.
 */
function SavedSlides({
	files,
	title,
	active,
	className,
}: {
	files: readonly SavedFile[];
	title: string;
	active: boolean;
	className?: string;
}) {
	const n = files.length;
	const [at, setAt] = useState(0);
	const track = useRef<HTMLDivElement>(null);
	const reduce = useReducedMotion();
	const coarse = useCoarsePointer();
	const go = useCallback((d: 1 | -1) => setAt((i) => (i + d + n) % n), [n]);
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
	// The track shows the current slide (keys, clicks)…
	useEffect(() => {
		const el = track.current;
		if (!el?.clientWidth) return;
		const x = at * el.clientWidth;
		if (Math.abs(el.scrollLeft - x) > 1)
			el.scrollTo({ left: x, behavior: reduce ? "auto" : "smooth" });
	}, [at, reduce]);
	// …and where a swipe settles is the current slide.
	const settle = useRef(0);
	const onScroll = () => {
		window.clearTimeout(settle.current);
		settle.current = window.setTimeout(() => {
			const el = track.current;
			if (!el?.clientWidth) return;
			const j = Math.round(el.scrollLeft / el.clientWidth);
			if (j !== at && j >= 0 && j < n) setAt(j);
		}, 90);
	};
	useEffect(() => () => window.clearTimeout(settle.current), []);
	return (
		<div
			data-testid={SAVED_TESTID.slides}
			data-slide={at}
			className={cn("relative overflow-hidden bg-black", className)}
		>
			<div
				ref={track}
				onScroll={onScroll}
				className="flex size-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none]"
			>
				{files.map((f, j) => (
					<div
						key={f.id}
						data-testid={SAVED_TESTID.slide}
						className="relative size-full shrink-0 snap-center snap-always"
					>
						{Math.abs(j - at) <= 1 ? (
							<FileSlide f={f} play={active && j === at} title={title} />
						) : null}
					</div>
				))}
			</div>
			{n > 1 && !coarse ? (
				<>
					<button
						type="button"
						aria-label="Previous photo"
						onClick={() => go(-1)}
						className="absolute inset-y-0 left-0 z-[1] w-1/4 cursor-pointer outline-none"
					/>
					<button
						type="button"
						aria-label="Next photo"
						onClick={() => go(1)}
						className="absolute inset-y-0 right-0 z-[1] w-1/4 cursor-pointer outline-none"
					/>
				</>
			) : null}
			{n > 1 ? (
				<div
					role="img"
					aria-label={`Photo ${at + 1} of ${n}`}
					className="pointer-events-none absolute inset-x-0 bottom-3 z-[3] flex justify-center gap-1.5"
				>
					{files.map((f, j) => (
						<span
							key={f.id}
							className={cn(
								"size-1.5 rounded-full shadow-[0_0_3px_rgb(0_0_0/.5)] transition-colors",
								j === at ? "bg-white" : "bg-white/45",
							)}
						/>
					))}
				</div>
			) : null}
		</div>
	);
}

/** Where it's from and what it says: the source, the line, the caption or address. */
function Details({ link, wide }: { link: SavedLink; wide: boolean }) {
	const kind = savedKind(link);
	const line = tileLine(link);
	const open = canonicalLink(
		link.provider,
		link.embedId,
		link.url,
		link.igType,
	);
	// The caption, the page's description or the words shared: whichever the line isn't.
	const more =
		kind === "maps"
			? (link.place?.address ?? null)
			: ([link.previewTitle, link.description, link.text].find(
					(t) => t && t !== line,
				) ?? null);
	return (
		<div className="grid gap-2">
			<span className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
				<SourceMark link={link} className="size-3.5 shrink-0" />
				<span className="truncate">
					{sourceLabel(link)}
					{link.author ? ` · ${link.author.replace(/^@?/, "@")}` : ""}
				</span>
			</span>
			{wide ? (
				<h2 className="font-display text-2xl leading-tight font-semibold">
					{line}
				</h2>
			) : null}
			{more ? (
				<p className="line-clamp-4 text-sm text-muted-foreground">{more}</p>
			) : null}
			{open ? (
				<a
					href={open}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex w-fit items-center gap-1 text-meta text-primary hover:underline"
				>
					<ExternalLink className="size-3.5" />
					Open in {kind === "maps" ? "Maps" : sourceLabel(link)}
				</a>
			) : null}
		</div>
	);
}

function SavedCard({
	link,
	active,
	near,
	ahead,
	controls,
	done,
	wide,
	fromShare,
	onSaved,
	onDelete,
	onLater,
}: {
	link: SavedLink;
	active: boolean;
	near: boolean;
	ahead: boolean;
	/** The save controls are mounted (seen once, kept: the card never changes size above you). */
	controls: boolean;
	done: Done | undefined;
	wide: boolean;
	fromShare: boolean;
	onSaved: (r: SaveResult) => void;
	onDelete: () => void;
	onLater: () => void;
}) {
	const info = useRef<HTMLDivElement>(null);
	const reduce = useReducedMotion();
	const line = tileLine(link);
	const actions = (
		<>
			<Button
				type="button"
				variant="ghost"
				data-testid={SAVED_TESTID.delete}
				onClick={onDelete}
			>
				<Trash2 />
				Delete
			</Button>
			{fromShare ? (
				<Button
					type="button"
					variant="ghost"
					data-testid={SAVED_TESTID.later}
					onClick={onLater}
				>
					Later
				</Button>
			) : null}
		</>
	);
	const saver =
		done?.kind === "deleted" ? (
			<p className="rounded-xl bg-muted/60 p-3 text-sm text-muted-foreground">
				Deleted from Saved.
			</p>
		) : controls ? (
			<Saver
				entry={toEntry(link)}
				place={link.place}
				nearTrips={link.nearTrips}
				media={
					link.files.length
						? {
								count: link.files.length,
								attach: (tripId, nodeId) =>
									attachSavedFiles({
										data: { savedId: link.id, tripId, nodeId },
									}),
							}
						: undefined
				}
				actions={actions}
				onSaved={onSaved}
			/>
		) : (
			<div className="h-72" />
		);
	return (
		<article
			data-testid={SAVED_TESTID.card}
			data-key={link.id}
			data-saved={link.id}
			data-active={active || undefined}
			data-done={done?.kind}
			aria-label={line}
			className={cn(
				"relative w-full shrink-0",
				wide && "h-full snap-start snap-always overflow-hidden",
			)}
		>
			{wide ? (
				<div className="grid h-full grid-cols-[minmax(0,1fr)_400px] gap-5 p-5 pt-16">
					<SavedMedia
						link={link}
						active={active}
						near={near}
						ahead={ahead}
						className="h-full rounded-2xl"
					/>
					<div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-1">
						<Details link={link} wide />
						<div data-testid={SAVED_TESTID.info} className="mt-auto">
							{saver}
						</div>
					</div>
				</div>
			) : (
				// Narrow: the media full-screen (a thin bar at its foot), then, one
				// swipe up, the details with the save controls last, in the thumb zone.
				<>
					<div
						className="flex h-[100cqh] snap-start snap-always flex-col bg-black pt-[calc(max(12px,env(safe-area-inset-top))+32px)]"
						data-testid={SAVED_TESTID.stage}
					>
						<SavedMedia
							link={link}
							active={active}
							near={near}
							ahead={ahead}
							className="min-h-0 w-full flex-1"
						/>
						<button
							type="button"
							data-testid={SAVED_TESTID.bar}
							onClick={() =>
								info.current?.scrollIntoView({
									behavior: reduce ? "auto" : "smooth",
									block: "end",
								})
							}
							className="flex shrink-0 cursor-pointer items-center gap-3 px-4 pt-2.5 pb-[max(12px,env(safe-area-inset-bottom))] text-left"
						>
							<span className="min-w-0 flex-1">
								<span className="block truncate font-display text-lg leading-tight font-semibold text-white">
									{line}
								</span>
								<span className="block truncate text-xs text-white/70">
									{sourceLabel(link)}
								</span>
							</span>
							{done?.kind === "saved" ? (
								<span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-white px-2.5 text-xs font-medium text-black">
									<Check className="size-3.5" />
									Saved
								</span>
							) : (
								<span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-white/15 px-2.5 text-xs font-medium text-white backdrop-blur-sm">
									<ChevronUp className="size-3.5" />
									Save
								</span>
							)}
						</button>
					</div>
					<div
						ref={info}
						data-testid={SAVED_TESTID.info}
						className="flex snap-end snap-always flex-col gap-4 border-t bg-background px-4 pt-5 pb-[max(18px,env(safe-area-inset-bottom))]"
					>
						<Details link={link} wide={false} />
						{saver}
					</div>
				</>
			)}
		</article>
	);
}

function EndCard({ saved, onBack }: { saved: number; onBack: () => void }) {
	return (
		<section
			data-testid={SAVED_TESTID.end}
			data-key="end"
			className="flex h-full w-full shrink-0 snap-start snap-always flex-col justify-center overflow-y-auto bg-background px-6 py-16 text-foreground"
		>
			<div className="mx-auto flex w-full max-w-md flex-col gap-5">
				<span className="grid size-16 place-items-center rounded-full border-[3px] border-good text-good">
					<Check className="size-8" strokeWidth={2.6} />
				</span>
				<div className="flex flex-col gap-1.5">
					<h2 className="font-display text-3xl leading-tight font-semibold">
						That's everything you saved
					</h2>
					<p className="text-body text-muted-foreground">
						{saved ? `${saved} went into your trips. ` : ""}
						New links show up here when you share them to Yonder.
					</p>
				</div>
				<Button
					size="lg"
					className="h-12 rounded-xl"
					data-testid={SAVED_TESTID.endBack}
					onClick={onBack}
				>
					Back to Saved
				</Button>
			</div>
		</section>
	);
}

export function SavedFeed({
	links,
	open,
	fromShare = false,
	onClose,
}: {
	links: readonly SavedLink[];
	/** The tile you opened (the feed starts there). */
	open: string | null;
	/** Opened by a share: Later goes to the grid. */
	fromShare?: boolean;
	onClose: () => void;
}) {
	const qc = useQueryClient();
	const bp = useBreakpoint();
	const phone = bp === "sm";
	const reduce = useReducedMotion();
	const root = useRef<HTMLDivElement>(null);
	// Wide and landscape enough (960px) for the media beside the details.
	const [wide, setWide] = useState(false);
	useLayoutEffect(() => {
		const el = root.current;
		if (!el) return;
		const measure = () =>
			setWide(
				!phone && el.clientWidth >= 960 && el.clientWidth > el.clientHeight,
			);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [phone]);

	// The session: the links as they were when it opened (newer ones join its
	// end); a saved or deleted one keeps its last known self.
	const known = useRef(new Map<string, SavedLink>());
	for (const l of links) known.current.set(l.id, l);
	const [pile, setPile] = useState(() =>
		feedPile(
			links.map((l) => l.id),
			open,
		),
	);
	const linkIds = useMemo(() => links.map((l) => l.id), [links]);
	useEffect(() => {
		setPile((p) => {
			const extra = linkIds.filter((id) => !p.includes(id));
			return extra.length ? [...p, ...extra] : p;
		});
	}, [linkIds]);
	const [done, setDone] = useState<Record<string, Done>>({});
	const items = useMemo(() => [...pile, "end"], [pile]);
	const [current, setCurrent] = useState<string | null>(null);
	useCardInView(root, setCurrent, items);
	const currentIndex = Math.max(0, items.indexOf(current ?? ""));
	// The save controls of cards you've been near stay (never a jump above you).
	const [seen, setSeen] = useState<Set<string>>(() => new Set());
	useEffect(() => {
		const near = items.slice(Math.max(0, currentIndex - 1), currentIndex + 2);
		setSeen((s) =>
			near.every((k) => s.has(k)) ? s : new Set([...s, ...near]),
		);
	}, [items, currentIndex]);

	const scrollToKey = useCallback(
		(key: string) => {
			root.current
				?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
				?.scrollIntoView({
					behavior: reduce ? "auto" : "smooth",
					block: "start",
				});
		},
		[reduce],
	);
	// The card in view (the first until the feed has measured one).
	const currentRef = useRef<string | undefined>(undefined);
	currentRef.current = items[currentIndex];
	// A layout switch (a tablet turned, a window resized) keeps it in view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: on a layout switch only
	useLayoutEffect(() => {
		const key = currentRef.current;
		if (key)
			root.current
				?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
				?.scrollIntoView({ block: "start" });
	}, [wide]);
	const step = useCallback(
		(dir: 1 | -1) => {
			const to =
				items[Math.max(0, Math.min(items.length - 1, currentIndex + dir))];
			if (to && to !== items[currentIndex]) scrollToKey(to);
		},
		[items, currentIndex, scrollToKey],
	);
	// After a save or delete: on to the next, after a beat (only from that card).
	const itemsRef = useRef(items);
	itemsRef.current = items;
	const advance = useRef(0);
	useEffect(() => () => window.clearTimeout(advance.current), []);
	const moveOn = useCallback(
		(id: string) => {
			window.clearTimeout(advance.current);
			advance.current = window.setTimeout(() => {
				if (currentRef.current !== id) return;
				const list = itemsRef.current;
				const next = list[list.indexOf(id) + 1];
				if (next) scrollToKey(next);
			}, ADVANCE_MS);
		},
		[scrollToKey],
	);
	const onSaved = (id: string, r: SaveResult) => {
		const text = confirmation(r);
		setDone((d) => ({ ...d, [id]: { kind: "saved", text } }));
		// At the top: the save controls (the next card's too) stay clear.
		toast.success(text, { duration: 2500, position: "top-center" });
		void markSavedAdded({
			data: { id, tripId: r.tripId, nodeId: r.nodeId },
		})
			.catch(() => {})
			.finally(() => qc.invalidateQueries({ queryKey: meKeys.saved }));
		moveOn(id);
	};
	const deleteSaved = useDeleteSaved();
	const onDelete = async (id: string) => {
		const ok = await deleteSaved([id], {
			onUndone: () =>
				setDone((d) => {
					const { [id]: _gone, ...rest } = d;
					return rest;
				}),
		});
		if (!ok) return;
		setDone((d) => ({ ...d, [id]: { kind: "deleted" } }));
		moveOn(id);
	};

	// ↑ / ↓ (or K / J) move, Esc closes.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey || ownsKeys(e.target)) return;
			if (e.key === "ArrowDown" || e.key === "j") {
				e.preventDefault();
				step(1);
			} else if (e.key === "ArrowUp" || e.key === "k") {
				e.preventDefault();
				step(-1);
			} else if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [step, onClose]);

	const count = pile.length;
	const savedHere = Object.values(done).filter(
		(d) => d.kind === "saved",
	).length;
	const feed = (
		<div
			data-testid={SAVED_TESTID.feed}
			className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
		>
			{/* Wide: on the page, in the theme. Narrow: a dark bar over the media. */}
			<div
				className={cn(
					"pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2.5 px-4 pt-[max(12px,env(safe-area-inset-top))]",
					wide
						? "bg-background pb-3"
						: "dark bg-black/70 pb-2.5 text-white backdrop-blur-md",
				)}
			>
				<span className="font-display text-lg font-semibold">Saved</span>
				<span className="ml-auto shrink-0 text-xs whitespace-nowrap text-muted-foreground tnum">
					{currentIndex < count ? `${currentIndex + 1} of ${count}` : ""}
				</span>
				<Button
					size="icon"
					variant="ghost"
					className={cn("pointer-events-auto size-8", !wide && "text-white")}
					aria-label="Close"
					data-testid={SAVED_TESTID.close}
					onClick={onClose}
				>
					<X />
				</Button>
			</div>
			<div
				ref={root}
				// A size container: a narrow card's media is one screen tall (100cqh).
				className="min-h-0 flex-1 snap-y snap-mandatory overflow-y-auto overscroll-contain [container-type:size] [scrollbar-width:none]"
			>
				{items.map((key, i) => {
					if (key === "end")
						return <EndCard key="end" saved={savedHere} onBack={onClose} />;
					const link = known.current.get(key);
					if (!link) return null;
					return (
						<SavedCard
							key={key}
							link={link}
							active={i === currentIndex}
							near={Math.abs(i - currentIndex) <= 1}
							ahead={i === currentIndex + 1}
							controls={seen.has(key)}
							done={done[key]}
							wide={wide}
							fromShare={fromShare}
							onSaved={(r) => onSaved(key, r)}
							onDelete={() => void onDelete(key)}
							onLater={onClose}
						/>
					);
				})}
			</div>
		</div>
	);
	return createPortal(feed, document.body);
}
