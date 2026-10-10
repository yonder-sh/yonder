/**
 * The full-screen feeds' media (the Rate feed, Saved): a provider player
 * that plays while its card is in view and loads paused while it's next up,
 * and media fitted whole over a blurred copy of itself, like stories.
 */
import {
	type HTMLAttributeReferrerPolicy,
	type ReactNode,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { cn } from "@/lib/utils";
import { EMBED_SANDBOX } from "./embeds";

/** What a player needs: an allowlisted provider's `src` (`embedSrc`, `embedOf`). */
export type FeedEmbed = {
	provider: string;
	src: string;
	aspect: "9/16" | "16/9";
};

/** Autoplay (muted) for the provider players, only while the card is in view. */
function autoplaySrc(src: string, provider: string): string {
	const join = src.includes("?") ? "&" : "?";
	if (provider === "youtube") return `${src}${join}autoplay=1&mute=1&loop=1`;
	if (provider === "tiktok") return `${src}${join}autoplay=1&loop=1`;
	return src;
}

/** Loaded ahead, paused: YouTube and TikTok take a "play" message later. */
function aheadSrc(src: string, provider: string): string {
	const join = src.includes("?") ? "&" : "?";
	if (provider === "youtube") return `${src}${join}enablejsapi=1&mute=1&loop=1`;
	if (provider === "tiktok") return `${src}${join}loop=1`;
	return src;
}

const PLAYER_ORIGIN: Record<string, string> = {
	youtube: "https://www.youtube-nocookie.com",
	tiktok: "https://www.tiktok.com",
};

/** Starts a player loaded ahead (muted: browsers only start sound on a tap). */
function startPlayer(frame: HTMLIFrameElement | null, provider: string) {
	const win = frame?.contentWindow;
	const origin = PLAYER_ORIGIN[provider];
	if (!win || !origin) return;
	if (provider === "tiktok") {
		win.postMessage({ type: "mute", "x-tiktok-player": true }, origin);
		win.postMessage({ type: "play", "x-tiktok-player": true }, origin);
	} else
		win.postMessage(
			JSON.stringify({ event: "command", func: "playVideo", args: [] }),
			origin,
		);
}

/**
 * A reel, TikTok or YouTube video. The next card's loads while you're on
 * this one (paused), so it's ready when you get there: YouTube and TikTok
 * start then, Instagram (which never starts by itself) takes one tap.
 */
export function EmbedPlayer({
	embed,
	title,
	play,
}: {
	embed: FeedEmbed;
	title: string | null;
	play: boolean;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const provider = embed.provider;
	// Fixed when it mounts: another address would load the player again.
	const [ahead] = useState(!play);
	const [src] = useState(() =>
		ahead ? aheadSrc(embed.src, provider) : autoplaySrc(embed.src, provider),
	);
	useEffect(() => {
		if (!play || !ahead) return;
		const start = () => startPlayer(frame.current, provider);
		start();
		// The player may still be starting up: again shortly, and when TikTok says it's ready.
		const timers = [300, 1000].map((ms) => window.setTimeout(start, ms));
		const onMessage = (e: MessageEvent) => {
			if (e.source !== frame.current?.contentWindow) return;
			const d = e.data as { type?: string } | null;
			if (d && typeof d === "object" && d.type === "onPlayerReady") start();
		};
		window.addEventListener("message", onMessage);
		return () => {
			for (const t of timers) window.clearTimeout(t);
			window.removeEventListener("message", onMessage);
		};
	}, [play, ahead, provider]);
	return (
		<div className="grid size-full place-items-center bg-black">
			<iframe
				ref={frame}
				title={title ?? `${provider} video`}
				src={src}
				sandbox={EMBED_SANDBOX}
				allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
				referrerPolicy="strict-origin-when-cross-origin"
				data-ahead={ahead || undefined}
				className={cn(
					"h-full max-w-full border-0",
					embed.aspect === "9/16" ? "aspect-[9/16]" : "aspect-video w-full",
				)}
			/>
		</div>
	);
}

/**
 * Media fits whole (never cropped); the space around it is a blurred copy of
 * the same picture, like stories and reels do for non-portrait media.
 */
export function Fitted({
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

export function FittedImg({
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

const COARSE = "(pointer: coarse)";

/** A touch screen (no mouse): sideways swipes change the photo, not taps. */
export function useCoarsePointer(): boolean {
	return useSyncExternalStore(
		(cb) => {
			const m = window.matchMedia?.(COARSE);
			m?.addEventListener("change", cb);
			return () => m?.removeEventListener("change", cb);
		},
		() => window.matchMedia?.(COARSE).matches ?? false,
		() => false,
	);
}

/**
 * Which card of a snap-scrolling feed is in view: the one under the middle
 * of `root` (a narrow card is taller than it: its media, then its details),
 * read on every scroll frame and resize, so a card moving or a scroll cut
 * short by another never leaves the wrong one current. Cards are `root`'s
 * children with `data-key`; `deps` re-measures when they change.
 */
export function useCardInView(
	root: React.RefObject<HTMLElement | null>,
	onCard: (key: string) => void,
	deps: unknown,
): void {
	const cb = useRef(onCard);
	cb.current = onCard;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `deps` re-renders the cards to measure
	useEffect(() => {
		const el = root.current;
		if (!el) return;
		let raf = 0;
		const pick = () => {
			raf = 0;
			const r = el.getBoundingClientRect();
			const mid = r.top + r.height / 2;
			for (const c of el.querySelectorAll<HTMLElement>(":scope > [data-key]")) {
				const b = c.getBoundingClientRect();
				if (b.top <= mid && b.bottom > mid) {
					const k = c.dataset.key;
					if (k) cb.current(k);
					return;
				}
			}
		};
		const later = () => {
			if (!raf) raf = requestAnimationFrame(pick);
		};
		pick();
		el.addEventListener("scroll", later, { passive: true });
		const ro = new ResizeObserver(later);
		ro.observe(el);
		return () => {
			el.removeEventListener("scroll", later);
			ro.disconnect();
			cancelAnimationFrame(raf);
		};
	}, [root, deps]);
}
