/**
 * The zoom gesture's pin merge and split (DESIGN §11: 600 ms, `--ease-zoom`):
 * when the lens or scope changes, each new pin starts where the pins it
 * replaces were — at its old ancestor (split: Tokyo → its areas) or at the
 * centre of its old descendants (merge: the areas → Tokyo) — and slides to its
 * own spot while the camera fits. Edges fade in over the same time. Reduced
 * motion: no slide, just the new pins.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { PinView } from "./map-data";

export const MOTION_MS = 600;

/** cubic-bezier(.22, 1, .36, 1), approximated (ease-out, no overshoot). */
export const easeZoom = (t: number) => 1 - (1 - t) ** 4;

type Origin = Map<string, [number, number]>;

/** Where each new pin comes from, given the pins it replaces (pure). */
export function pinOrigins(
	ix: GraphIndex,
	prev: readonly PinView[],
	next: readonly PinView[],
): Origin {
	const before = new Map(prev.map((p) => [p.repId, p]));
	const out: Origin = new Map();
	for (const p of next) {
		if (before.has(p.repId)) continue; // stays put
		// Split: the nearest ancestor that had a pin.
		const path = ix.path(p.repId);
		let origin: PinView | undefined;
		for (let i = path.length - 2; i >= 0 && !origin; i--)
			origin = before.get(path[i]?.id ?? "");
		if (origin) {
			out.set(p.repId, [origin.lng, origin.lat]);
			continue;
		}
		// Merge: the centre of the old pins inside it.
		const kids = prev.filter((o) => ix.isWithin(o.repId, p.repId));
		if (kids.length) {
			const lng = kids.reduce((s, k) => s + k.lng, 0) / kids.length;
			const lat = kids.reduce((s, k) => s + k.lat, 0) / kids.length;
			out.set(p.repId, [lng, lat]);
		}
	}
	return out;
}

const reduced = () =>
	typeof window !== "undefined" &&
	window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Animated pins for a `key` (scope + lens): returns the pins at their current
 * interpolated spots and the progress 0…1 (1 when idle).
 */
export function usePinMotion(
	ix: GraphIndex,
	pins: readonly PinView[],
	key: string,
): { pins: readonly PinView[]; progress: number } {
	// The pins as last committed: the "before" of the next gesture.
	const committed = useRef<{ key: string; pins: readonly PinView[] } | null>(
		null,
	);
	// Computed during render, so the first frame already starts at the origins.
	// Only a new scope/lens starts a gesture; data edits never animate.
	// biome-ignore lint/correctness/useExhaustiveDependencies: pins and ix are read when the key changes, not tracked
	const gesture = useMemo(() => {
		const prev = committed.current;
		if (!prev || prev.key === key || reduced()) return null;
		const origins = pinOrigins(ix, prev.pins, pins);
		return origins.size ? { origins, t0: performance.now() } : null;
	}, [key]);
	useEffect(() => {
		committed.current = { key, pins };
	});

	const [, setFrame] = useState(0);
	useEffect(() => {
		if (!gesture) return;
		let raf = 0;
		const tick = () => {
			setFrame((n) => n + 1);
			if (performance.now() - gesture.t0 < MOTION_MS)
				raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [gesture]);

	const t = gesture
		? Math.min(1, (performance.now() - gesture.t0) / MOTION_MS)
		: 1;
	const e = easeZoom(t);
	const moved =
		gesture && t < 1
			? pins.map((p) => {
					const o = gesture.origins.get(p.repId);
					if (!o) return p;
					return {
						...p,
						lng: o[0] + (p.lng - o[0]) * e,
						lat: o[1] + (p.lat - o[1]) * e,
					};
				})
			: pins;
	return { pins: moved, progress: e };
}
