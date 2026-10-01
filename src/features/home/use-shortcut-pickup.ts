/**
 * The iPhone Shortcut's hand-off (src/server/shortcut.server.ts): the Shortcut
 * sends the shared link to the server, then opens the home-screen app, which
 * iOS starts on its start page. Whenever the app comes to the front, links the
 * Shortcut sent move into this device's share inbox; one sent in the last 2
 * minutes opens the save screen at once. Older ones wait on the dashboard
 * ("2 shared links to save"). The first look after pairing says "connected".
 */
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { putShared } from "@/features/offline/share-store";
import { useHasAccount } from "@/features/push/use-push";
import { takeShortcutShares } from "@/functions/shortcut.functions";
import { thisDevice } from "./SaveFromAppsDialog";

const FLAG = "yonder:shortcut";
const FRESH_MS = 2 * 60_000;
/** The dashboard's "N shared links to save" re-reads on this event. */
export const SHARED_CHANGED = "yonder:shared-changed";

/** This browser set up the Shortcut (Connect in Save from other apps). */
export function markShortcutDevice(): void {
	try {
		localStorage.setItem(FLAG, "1");
	} catch {
		// Private mode: the home-screen check below still covers the app.
	}
}

function usesShortcut(): boolean {
	try {
		if (localStorage.getItem(FLAG)) return true;
	} catch {
		// fall through
	}
	const standalone =
		window.matchMedia?.("(display-mode: standalone)").matches ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true;
	return standalone && thisDevice() === "iphone";
}

/** Mounted once (the root layout). */
export function useShortcutPickup(): void {
	const router = useRouter();
	const hasAccount = useHasAccount();
	useEffect(() => {
		if (!hasAccount) return;
		let busy = false;
		const pickUp = async () => {
			if (busy || document.visibilityState !== "visible" || !usesShortcut())
				return;
			busy = true;
			try {
				const { shares, connected } = await takeShortcutShares();
				if (connected) {
					markShortcutDevice();
					toast.success(`${connected} is connected`, {
						description: "Share from any app and pick Save to Yonder.",
					});
				}
				let fresh: string | null = null;
				for (const s of shares) {
					const id = `shortcut-${s.id}`;
					await putShared({
						id,
						createdAt: s.createdAt,
						title: null,
						text: s.text,
						url: s.url,
						files: [],
					});
					if (Date.now() - s.createdAt < FRESH_MS) fresh = id;
				}
				if (shares.length) window.dispatchEvent(new Event(SHARED_CHANGED));
				if (fresh)
					void router.navigate({
						to: "/share",
						search: { id: fresh } as never,
					});
			} catch {
				// Offline or signed out: the links stay on the server for next time.
			} finally {
				busy = false;
			}
		};
		void pickUp();
		document.addEventListener("visibilitychange", pickUp);
		return () => document.removeEventListener("visibilitychange", pickUp);
	}, [hasAccount, router]);
}
