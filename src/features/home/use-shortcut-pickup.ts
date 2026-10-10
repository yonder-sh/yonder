/**
 * The iPhone Shortcut's hand-off (src/server/shortcut.server.ts): the Shortcut
 * saves the shared link into Saved, then opens the home-screen app, which iOS
 * starts on its start page. Whenever the app comes to the front, a link saved
 * in the last 2 minutes opens in the Saved feed at once (one tap to save it
 * to a trip, or Later). Older ones wait in Saved. The first look after
 * pairing says "connected".
 */
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { useHasAccount } from "@/features/push/use-push";
import { takeShortcutShares } from "@/functions/shortcut.functions";
import { meKeys } from "@/lib/query/keys";
import { thisDevice } from "./SaveFromAppsDialog";

const FLAG = "yonder:shortcut";
/** Shares kept on this device changed (Saved and the dashboard re-read them). */
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
				const { fresh, connected } = await takeShortcutShares();
				if (connected) {
					markShortcutDevice();
					toast.success(`${connected} is connected`, {
						description: "Share from any app and pick Save to Yonder.",
					});
				}
				if (fresh) {
					void router.options.context.queryClient.invalidateQueries({
						queryKey: meKeys.saved,
					});
					void router.navigate({
						to: "/saved",
						search: { open: fresh, from: "share" },
					});
				}
			} catch {
				// Offline or signed out: the link waits in Saved.
			} finally {
				busy = false;
			}
		};
		void pickUp();
		document.addEventListener("visibilitychange", pickUp);
		return () => document.removeEventListener("visibilitychange", pickUp);
	}, [hasAccount, router]);
}
