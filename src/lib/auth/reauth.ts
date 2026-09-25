import { create } from "zustand";

/**
 * QA ERR-07: when a save answers UNAUTHORIZED (the session expired or was
 * revoked mid-edit), the app asks the person to sign in again in place
 * (`<ReauthDialog/>`, mounted once in the root) instead of dropping them on
 * /login. The failed saves wait here and run again once the SAME account is
 * back, so nothing typed is lost.
 */
type ReauthState = {
	open: boolean;
	pending: (() => void)[];
	request(retry?: () => void): void;
	/** Closes the prompt and hands back the waiting saves (run them or drop them). */
	finish(): (() => void)[];
};

/** At most this many failed saves wait for the new session. */
const MAX_PENDING = 20;

export const useReauth = create<ReauthState>((set, get) => ({
	open: false,
	pending: [],
	request: (retry) =>
		set((s) => ({
			open: true,
			pending: retry ? [...s.pending, retry].slice(-MAX_PENDING) : s.pending,
		})),
	finish: () => {
		const { pending } = get();
		set({ open: false, pending: [] });
		return pending;
	},
}));

export function requestReauth(retry?: () => void): void {
	useReauth.getState().request(retry);
}
