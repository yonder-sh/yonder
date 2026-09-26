/**
 * Follow doesn't fight the follower: scrolling a list myself pauses the
 * scroll-following, dragging the phone sheet myself pauses the sheet's (the
 * map camera has its own pause, `camera-follow.ts`). The rest of Follow goes
 * on. "Resume" (the follow bar, the map's "Back to …" chip, an edge arrow),
 * the leader going somewhere else, or a new leader brings it all back.
 */
import { create } from "zustand";
import { useCamFollow } from "@/features/map/camera-follow";

type FollowPause = {
	scroll: boolean;
	sheet: boolean;
	pauseScroll(): void;
	pauseSheet(): void;
	/** Everything follows again (the camera too). */
	resume(): void;
};

export const useFollowPause = create<FollowPause>()((set, get) => ({
	scroll: false,
	sheet: false,
	pauseScroll: () => {
		if (!get().scroll) set({ scroll: true });
	},
	pauseSheet: () => {
		if (!get().sheet) set({ sheet: true });
	},
	resume: () => {
		if (get().scroll || get().sheet) set({ scroll: false, sheet: false });
		useCamFollow.getState().resume();
	},
}));

export function isScrollFollowPaused(): boolean {
	return useFollowPause.getState().scroll;
}
