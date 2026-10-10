/**
 * Saved as a feed, like Rate's (`places/tab/RateFeed.tsx`): one saved link
 * per screen, you just scroll. Narrow (phones): its media full-screen under a
 * thin bar (the reel or TikTok plays, the next one loads ahead), then one
 * swipe up its details with the save controls at the bottom, in the thumb
 * zone. Wide: the media beside the details, ↑/↓ to move.
 *
 * - Save files it into a trip (the share page's controls, `Saver`) and moves
 *   on to the next after a beat, with "Saved to Kyoto ideas · Japan 2027";
 *   Delete removes it from Saved; scrolling past keeps it.
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
import { Button } from "@/components/ui/button";
import { type SaveResult, Saver } from "@/features/home/Saver";
import { canonicalLink } from "@/features/media/embeds";
import {
	EmbedPlayer,
	FittedImg,
	useCardInView,
} from "@/features/media/feed-player";
import { embedOf } from "@/features/places/rate/PlaceMedia";
import { MiniMap } from "@/features/places/ui/mini-map";
import { useBreakpoint } from "@/features/shell/use-breakpoint";
import { humanError } from "@/lib/errors";
import { meKeys } from "@/lib/query/keys";
import { cn } from "@/lib/utils";
import { feedPile, savedKind, sourceLabel, tileLine, toEntry } from "./lib";
import { SavedPlaceholder, SourceMark } from "./SavedTile";
import { deleteSavedLink, markSavedAdded } from "./saved.functions";
import { SAVED_TESTID } from "./testids";
import type { SavedLink } from "./types";

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
				variant="feed"
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
	const onDelete = async (id: string) => {
		try {
			await deleteSavedLink({ data: { id } });
		} catch (e) {
			toast.error(humanError(e));
			return;
		}
		setDone((d) => ({ ...d, [id]: { kind: "deleted" } }));
		toast("Deleted from Saved", { duration: 2000, position: "top-center" });
		void qc.invalidateQueries({ queryKey: meKeys.saved });
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
