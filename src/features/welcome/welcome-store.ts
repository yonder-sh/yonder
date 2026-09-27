/**
 * The welcome's open state, and whether it has settled for this trip open.
 * One prompt per visit (owner, 2026-09-27): when the welcome showed, the
 * notifications card and the suggester's hint wait for the next visit.
 */
import { create } from "zustand";

export type WelcomeState = {
	open: boolean;
	/** `pending` until we know whether it shows; `done` once closed or skipped. */
	status: "pending" | "open" | "done";
	/** It showed on this visit to this trip. */
	showed: boolean;
	/** "How this trip works" (the trip menu). */
	show(): void;
	setStatus(s: WelcomeState["status"]): void;
	close(): void;
};

export const useWelcome = create<WelcomeState>((set) => ({
	open: false,
	status: "pending",
	showed: false,
	show: () => set({ open: true, status: "open", showed: true }),
	setStatus: (status) =>
		set((s) => ({
			status,
			open: status === "open",
			showed: status === "pending" ? false : s.showed || status === "open",
		})),
	close: () => set({ open: false, status: "done" }),
}));
