/**
 * The welcome's open state, and whether it has settled for this trip open
 * (the notifications card waits for it, so the two never show together).
 */
import { create } from "zustand";

export type WelcomeState = {
	open: boolean;
	/** `pending` until we know whether it shows; `done` once closed or skipped. */
	status: "pending" | "open" | "done";
	/** "How this trip works" (the trip menu). */
	show(): void;
	setStatus(s: WelcomeState["status"]): void;
	close(): void;
};

export const useWelcome = create<WelcomeState>((set) => ({
	open: false,
	status: "pending",
	show: () => set({ open: true, status: "open" }),
	setStatus: (status) => set({ status, open: status === "open" }),
	close: () => set({ open: false, status: "done" }),
}));
