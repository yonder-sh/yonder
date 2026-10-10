/**
 * Shares waiting on this device (`yonder-share`: shared offline, or the
 * server couldn't be reached) go up to Saved once the app is online with an
 * account: on start, when it comes back online or to the front, and when
 * one is added. Their device id makes a retried upload save once. Photos
 * and videos stay on the device (the share page saves them to a trip).
 */
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { SHARED_CHANGED } from "@/features/home/use-shortcut-pickup";
import { deleteShared, listShared } from "@/features/offline/share-store";
import { useHasAccount } from "@/features/push/use-push";
import { errorCode } from "@/lib/errors";
import { meKeys } from "@/lib/query/keys";
import { saveSharedLink } from "./saved.functions";

/** Mounted once (the root layout). */
export function useSharedUpload(): void {
	const router = useRouter();
	const hasAccount = useHasAccount();
	useEffect(() => {
		if (!hasAccount) return;
		let busy = false;
		const upload = async () => {
			// The share page sends its own entry (and reads it first).
			if (
				busy ||
				!navigator.onLine ||
				document.visibilityState !== "visible" ||
				window.location.pathname === "/share"
			)
				return;
			busy = true;
			let sent = 0;
			try {
				for (const e of await listShared()) {
					if (e.files.length || (!e.url && !e.text)) continue;
					try {
						await saveSharedLink({
							data: {
								url: e.url,
								text: e.text,
								title: e.title,
								clientId: e.id,
							},
						});
					} catch (err) {
						// Nothing it could ever save: drop it; anything else waits.
						if (errorCode(err) !== "VALIDATION") continue;
					}
					await deleteShared(e.id);
					sent++;
				}
			} finally {
				busy = false;
			}
			if (sent) {
				window.dispatchEvent(new Event(SHARED_CHANGED));
				void router.options.context.queryClient.invalidateQueries({
					queryKey: meKeys.saved,
				});
			}
		};
		void upload();
		window.addEventListener("online", upload);
		document.addEventListener("visibilitychange", upload);
		window.addEventListener(SHARED_CHANGED, upload);
		return () => {
			window.removeEventListener("online", upload);
			document.removeEventListener("visibilitychange", upload);
			window.removeEventListener(SHARED_CHANGED, upload);
		};
	}, [hasAccount, router]);
}
