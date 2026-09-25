/**
 * FB-22 map follow: followers mirror the leader's camera (centre, zoom,
 * bearing, pitch, globe), fitting the VIEW rather than the zoom number.
 *
 * - Everyone publishes their camera on the trip's channel awareness (`cam`,
 *   view-protocol.ts): throttled to ~8 Hz while the map moves, and on move
 *   end. `c` is the lng/lat at the centre of the part of the map they can
 *   see (not under the inspector or the phone's sheet) and `w`×`h` its size.
 * - A follower eases to it: the same centre, placed at the centre of ITS
 *   visible part, with the zoom adjusted by log2 of the ratio of the two
 *   visible sizes (`followZoom`), so it sees at least what the leader sees.
 *   Updates come straight from the awareness (no React render per update).
 * - The follower moving the map themselves (drag, wheel, pinch, the zoom
 *   buttons) pauses map-following only; "Back to Dennis's view" resumes it.
 *   While map-following is on, the follower's own automatic fits stand back
 *   (`isCameraFollowing()`), and the live-cursor Follow doesn't pan the map.
 */
import type { Map as MaplibreMap } from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { Awareness } from "y-protocols/awareness";
import { create } from "zustand";
import {
	AwarenessCam,
	type AwarenessCam as Cam,
	followZoom,
	roundCam,
	sameCam,
} from "@/lib/realtime/view-protocol";
import { setCameraFollowing } from "@/lib/workspace/map-projector";

/** The leader sends at most this often while the map moves (ms). */
export const CAM_SEND_MS = 125;
/** A follower's ease per update (ms): a little longer than the send gap. */
const FOLLOW_EASE_MS = 320;

export type Insets = {
	top: number;
	right: number;
	bottom: number;
	left: number;
};

type CamFollowState = {
	/** The person whose camera I mirror (they publish one), or null. */
	leader: { id: string; name: string } | null;
	/** I moved the map myself: map-following waits for "Back to …". */
	paused: boolean;
	/** The leader's projection (globe) while I mirror it, else null. */
	leaderGlobe: boolean | null;
	setLeader(
		l: { id: string; name: string } | null,
		globe: boolean | null,
	): void;
	pause(): void;
	resume(): void;
};

export const useCamFollow = create<CamFollowState>()((set, get) => ({
	leader: null,
	paused: false,
	leaderGlobe: null,
	setLeader: (leader, leaderGlobe) => {
		const s = get();
		if (
			s.leader?.id === leader?.id &&
			s.leader?.name === leader?.name &&
			s.leaderGlobe === leaderGlobe
		)
			return;
		// A new leader (or none) starts unpaused.
		set({
			leader,
			leaderGlobe,
			paused: s.leader?.id === leader?.id ? s.paused : false,
		});
	},
	pause: () => {
		if (get().leader && !get().paused) set({ paused: true });
	},
	resume: () => set({ paused: false }),
}));

/** True while my map mirrors someone's camera (my own fits stand back). */
export function isCameraFollowing(): boolean {
	const s = useCamFollow.getState();
	return !!s.leader && !s.paused;
}

/** I moved the map myself (the zoom buttons, Fit): pause map-following. */
export function pauseCameraFollow(): void {
	useCamFollow.getState().pause();
}

/** Where a camera's visible part is inside the map box. */
export function visibleBox(
	W: number,
	H: number,
	inset: Insets,
): { cx: number; cy: number; w: number; h: number } {
	const l = Math.max(0, Math.min(inset.left, W * 0.6));
	const r = Math.max(0, Math.min(inset.right, W * 0.6));
	const t = Math.max(0, Math.min(inset.top, H * 0.6));
	const b = Math.max(0, Math.min(inset.bottom, H * 0.6));
	const w = Math.max(40, W - l - r);
	const h = Math.max(40, H - t - b);
	return { cx: l + w / 2, cy: t + h / 2, w, h };
}

/**
 * The follower's `easeTo` for a leader's camera: centre, zoom (fit the
 * view), bearing, pitch, and the offset that puts the centre in the middle
 * of my visible part (MapLibre measures `offset` from the padded centre).
 */
export function followCamera(
	cam: Cam,
	me: { W: number; H: number; inset: Insets; padding: Insets },
): {
	center: [number, number];
	zoom: number;
	bearing: number;
	pitch: number;
	offset: [number, number];
} {
	const box = visibleBox(me.W, me.H, me.inset);
	const p = me.padding;
	const pcx = p.left + (me.W - p.left - p.right) / 2;
	const pcy = p.top + (me.H - p.top - p.bottom) / 2;
	return {
		center: cam.c,
		zoom: followZoom(cam, { w: box.w, h: box.h }),
		bearing: cam.b,
		pitch: cam.p,
		offset: [box.cx - pcx, box.cy - pcy],
	};
}

function canvasSize(map: MaplibreMap): { W: number; H: number } {
	const cv = map.getCanvas();
	const W = Number.parseFloat(cv.style.width);
	const H = Number.parseFloat(cv.style.height);
	if (W > 0 && H > 0) return { W, H };
	const c = map.getContainer();
	return { W: c.clientWidth, H: c.clientHeight };
}

function reduced(): boolean {
	return (
		typeof matchMedia === "function" &&
		matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

let camN = 0;

/** My camera as it travels. Null when the map can't say (no size yet). */
export function cameraOf(
	map: MaplibreMap,
	inset: Insets,
	globe: boolean,
): Cam | null {
	const { W, H } = canvasSize(map);
	if (!(W > 0 && H > 0)) return null;
	const box = visibleBox(W, H, inset);
	const ll = map.unproject([box.cx, box.cy]);
	if (!Number.isFinite(ll.lng) || !Number.isFinite(ll.lat)) return null;
	const lng = ((((ll.lng + 180) % 360) + 360) % 360) - 180;
	const cam: Cam = {
		c: [lng, Math.max(-90, Math.min(90, ll.lat))],
		z: Math.max(0, Math.min(22, map.getZoom())),
		b: map.getBearing(),
		p: Math.max(0, Math.min(85, map.getPitch())),
		g: globe,
		w: box.w,
		h: box.h,
		n: camN,
	};
	return roundCam(cam);
}

/** The followed user's latest valid camera (their most recently active tab). */
function leaderCam(
	awareness: Awareness,
	userId: string,
): { cam: Cam; name: string } | null {
	let best: { cam: Cam; name: string; at: number } | null = null;
	for (const [clientId, raw] of awareness.getStates()) {
		if (clientId === awareness.clientID) continue;
		const st = raw as {
			user?: { id?: unknown; name?: unknown };
			cam?: unknown;
		};
		if (st.user?.id !== userId) continue;
		const cam = AwarenessCam.safeParse(st.cam);
		if (!cam.success) continue;
		const at = awareness.meta.get(clientId)?.lastUpdated ?? 0;
		if (!best || at >= best.at)
			best = {
				cam: cam.data,
				name: typeof st.user.name === "string" ? st.user.name : "them",
				at,
			};
	}
	return best ? { cam: best.cam, name: best.name } : null;
}

/**
 * MapCanvas' side of FB-22: publishes my camera and mirrors the followed
 * person's (see the file comment). `inset` is what covers my map
 * (inspector, sheet); `globe` my current projection.
 */
export function useCameraFollow(opts: {
	map: MaplibreMap | null;
	awareness: Awareness | null;
	following: string | null;
	inset: Insets;
	globe: boolean;
}): void {
	const { map, awareness, following } = opts;
	const latest = useRef(opts);
	latest.current = opts;

	// ---- send mine ------------------------------------------------------------
	const sendNow = useRef<(() => void) | null>(null);
	useEffect(() => {
		if (!map || !awareness) return;
		let last: Cam | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let lastAt = 0;
		const send = () => {
			timer = null;
			if (document.visibilityState === "hidden") return;
			const cam = cameraOf(map, latest.current.inset, latest.current.globe);
			if (!cam || sameCam(last, cam)) return;
			camN += 1;
			const next = { ...cam, n: camN };
			last = next;
			lastAt = performance.now();
			awareness.setLocalStateField("cam", next);
		};
		const onMove = () => {
			if (timer) return;
			timer = setTimeout(
				send,
				Math.max(0, CAM_SEND_MS - (performance.now() - lastAt)),
			);
		};
		const onEnd = () => {
			if (timer) clearTimeout(timer);
			send();
		};
		map.on("move", onMove);
		map.on("moveend", onEnd);
		map.on("resize", onEnd);
		sendNow.current = onEnd;
		send();
		return () => {
			sendNow.current = null;
			map.off("move", onMove);
			map.off("moveend", onEnd);
			map.off("resize", onEnd);
			if (timer) clearTimeout(timer);
			awareness.setLocalStateField("cam", null);
		};
	}, [map, awareness]);

	// The visible part changed (the inspector opened, the sheet moved): resend
	// mine, and fit the leader's view into what I can see now.
	const reapply = useRef<(() => void) | null>(null);
	const insetKey = JSON.stringify(opts.inset);
	useEffect(() => {
		void insetKey;
		sendNow.current?.();
		reapply.current?.();
	}, [insetKey]);

	// ---- mirror theirs --------------------------------------------------------
	useEffect(() => {
		const store = useCamFollow.getState();
		if (!map || !awareness || !following) {
			store.setLeader(null, null);
			setCameraFollowing(false);
			return;
		}
		let applied = -1;
		const apply = (force = false) => {
			const found = leaderCam(awareness, following);
			const s = useCamFollow.getState();
			if (!found) {
				// They show no map (another screen): mine is mine until they do.
				s.setLeader(null, null);
				setCameraFollowing(false);
				return;
			}
			s.setLeader({ id: following, name: found.name }, found.cam.g);
			setCameraFollowing(true);
			const paused = useCamFollow.getState().paused;
			if (paused || (!force && found.cam.n === applied)) return;
			applied = found.cam.n;
			const { W, H } = canvasSize(map);
			if (!(W > 0 && H > 0)) return;
			const pad = map.getPadding();
			const to = followCamera(found.cam, {
				W,
				H,
				inset: latest.current.inset,
				padding: {
					top: pad.top ?? 0,
					right: pad.right ?? 0,
					bottom: pad.bottom ?? 0,
					left: pad.left ?? 0,
				},
			});
			try {
				map.easeTo(
					{ ...to, duration: reduced() ? 0 : FOLLOW_EASE_MS, essential: true },
					{ yonderFollow: true },
				);
			} catch {
				// A camera that can't be reached keeps the current view.
			}
		};
		const onChange = () => apply();
		awareness.on("change", onChange);
		// Moving the map myself pauses map-following (only a person's move has
		// an `originalEvent`; our own eases carry `yonderFollow`).
		const onStart = (e: {
			originalEvent?: unknown;
			yonderFollow?: unknown;
		}) => {
			if (e.originalEvent && !e.yonderFollow) useCamFollow.getState().pause();
		};
		map.on("movestart", onStart);
		// "Back to …": apply their latest camera at once.
		const unsub = useCamFollow.subscribe((s, prev) => {
			if (prev.paused && !s.paused) apply(true);
		});
		apply(true);
		reapply.current = () => apply(true);
		return () => {
			reapply.current = null;
			awareness.off("change", onChange);
			map.off("movestart", onStart);
			unsub();
			useCamFollow.getState().setLeader(null, null);
			setCameraFollowing(false);
		};
	}, [map, awareness, following]);
}
