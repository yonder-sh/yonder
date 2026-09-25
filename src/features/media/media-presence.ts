/**
 * FB-21c: what my media viewer publishes (the open item and an uploaded
 * video's play / pause / seek) and how a follower's video keeps in step.
 * See `media-follow.tsx` for the whole picture.
 */
import { useEffect, useRef } from "react";
import type { Awareness } from "y-protocols/awareness";
import { useTripAwareness } from "@/lib/realtime/presence";
import {
	AwarenessMedia,
	expectedVideoTime,
	type MediaPlay,
	videoOff,
} from "@/lib/realtime/view-protocol";

/** The current slide's video in the lightbox (null when it isn't a video). */
export function currentLightboxVideo(): HTMLVideoElement | null {
	return document.querySelector<HTMLVideoElement>(
		".yonder-lightbox .yarl__slide_current video",
	);
}

/** Publishes the media I have open (`null` = nothing), while mounted. */
export function usePublishMedia(
	open: { id: string; k: "lb" | "pdf"; hidden: boolean } | null,
): void {
	const { awareness } = useTripAwareness();
	const key = open ? `${open.k}|${open.id}|${open.hidden ? 1 : 0}` : null;
	useEffect(() => {
		if (!awareness || !key) return;
		const [k, id, hidden] = key.split("|");
		const mine = ++publishN;
		awareness.setLocalStateField("media", {
			id,
			k,
			p: null,
			v: hidden === "1" ? "members" : "all",
		});
		return () => {
			// A new item (or a remount) replaces it right away; closing clears it.
			queueMicrotask(() => {
				if (publishN === mine) awareness.setLocalStateField("media", null);
			});
		};
	}, [awareness, key]);
}

/** Increases with every item published (a later one owns the field). */
let publishN = 0;

let playN = 0;

/** The leader's video events on the lightbox's current slide → `media.p`. */
export function useVideoEvents(enabled: boolean): void {
	const { awareness } = useTripAwareness();
	useEffect(() => {
		if (!awareness || !enabled) return;
		const on = (e: Event) => {
			const v = e.target;
			if (!(v instanceof HTMLVideoElement)) return;
			if (!v.closest(".yonder-lightbox .yarl__slide_current")) return;
			publishPlay(awareness, v);
		};
		const types = ["play", "pause", "seeked"] as const;
		for (const t of types) document.addEventListener(t, on, true);
		return () => {
			for (const t of types) document.removeEventListener(t, on, true);
		};
	}, [awareness, enabled]);
}

function publishPlay(awareness: Awareness, v: HTMLVideoElement): void {
	const cur = (awareness.getLocalState() as { media?: unknown } | null)?.media;
	const parsed = AwarenessMedia.safeParse(cur);
	if (!parsed.success || parsed.data.k !== "lb") return;
	playN += 1;
	const p: MediaPlay = {
		s: v.paused ? "pause" : "play",
		t: Math.round(Math.max(0, v.currentTime) * 100) / 100,
		n: playN,
	};
	awareness.setLocalStateField("media", { ...parsed.data, p });
}

/**
 * A follower's video follows the leader's play state: on each new event,
 * and every second while it plays, it seeks when more than VIDEO_DRIFT_S
 * off and plays / pauses to match (muted when unmuted autoplay is refused).
 */
export function useVideoFollow(itemId: string | null, play: MediaPlay | null) {
	const n = play?.n ?? null;
	const latest = useRef(play);
	latest.current = play;
	useEffect(() => {
		const p = latest.current;
		if (!itemId || !p || n === null) return;
		const got = performance.now();
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const sync = (attempt: number) => {
			if (stopped) return;
			const v = currentLightboxVideo();
			if (!v) {
				// The slide is still mounting: look again shortly.
				if (attempt < 40) timer = setTimeout(() => sync(attempt + 1), 150);
				return;
			}
			const want = expectedVideoTime(p, (performance.now() - got) / 1000);
			if (videoOff(v.currentTime, want)) {
				try {
					v.currentTime = want;
				} catch {
					// not seekable yet (metadata loading): the next tick retries
				}
			}
			if (p.s === "play" && v.paused) {
				v.play().catch(() => {
					v.muted = true;
					v.play().catch(() => {});
				});
			} else if (p.s === "pause" && !v.paused) v.pause();
			if (p.s === "play") timer = setTimeout(() => sync(0), 1_000);
		};
		sync(0);
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	}, [itemId, n]);
}
