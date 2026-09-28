/**
 * "Use my location" (One Yonder phase 5): opt-in, on this device only. The
 * browser's position feeds Today's "Looks like you're at …?" and its ideas
 * nearby; it is never sent to the server or stored. The switch lasts while
 * the app is open.
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import type { LngLat } from "@/lib/engine/geo";

const useLocating = create<{ on: boolean; set: (on: boolean) => void }>(
	(set) => ({ on: false, set: (on) => set({ on }) }),
);

export interface MyLocation {
	on: boolean;
	here: LngLat | null;
	/** "Location is off for this site" and the like. */
	problem: string | null;
	/** Whether this browser can locate at all. */
	supported: boolean;
	toggle(): void;
}

export function useMyLocation(): MyLocation {
	const on = useLocating((s) => s.on);
	const set = useLocating((s) => s.set);
	const [here, setHere] = useState<LngLat | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const supported = typeof navigator !== "undefined" && !!navigator.geolocation;
	useEffect(() => {
		if (!on || !supported) {
			setHere(null);
			return;
		}
		setProblem(null);
		const id = navigator.geolocation.watchPosition(
			(p) => setHere([p.coords.longitude, p.coords.latitude]),
			(e) =>
				setProblem(
					e.code === e.PERMISSION_DENIED
						? "Location is off for this site"
						: "Can't find where you are",
				),
			{ enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
		);
		return () => navigator.geolocation.clearWatch(id);
	}, [on, supported]);
	return { on, here, problem, supported, toggle: () => set(!on) };
}
