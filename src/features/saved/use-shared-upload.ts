/**
 * Shares waiting on this device (`yonder-share`: shared offline, or the
 * server couldn't be reached) go up to Saved once the app is online with an
 * account: on start, when it comes back online or to the front, and when
 * one is added. Their device id makes a retried upload save once. Photos
 * and videos the share page didn't finish carry on where they stopped, with
 * their progress in a toast.
 */
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { SHARED_CHANGED } from "@/features/home/use-shortcut-pickup";
import { deleteShared, listShared } from "@/features/offline/share-store";
import { useHasAccount } from "@/features/push/use-push";
import { errorCode, humanError } from "@/lib/errors";
import { meKeys } from "@/lib/query/keys";
import { saveSharedLink } from "./saved.functions";
import { uploadingLabel, uploadShare } from "./upload-shared";

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
					if (e.files.length) {
						const label = uploadingLabel(e.files);
						const t = toast.loading(label);
						try {
							const id = await uploadShare(e, (p) =>
								toast.loading(label, {
									id: t,
									description: `${Math.round(p.fraction * 100)}%`,
								}),
							);
							await deleteShared(e.id);
							sent++;
							toast.success("Your photos are in Saved", {
								id: t,
								description: undefined,
								action: {
									label: "Open",
									onClick: () =>
										void router.navigate({
											to: "/saved",
											search: { open: id },
										}),
								},
							});
						} catch (err) {
							// A file it can never take: drop it; anything else waits.
							if (errorCode(err) === "VALIDATION") await deleteShared(e.id);
							toast.error(
								errorCode(err) === "VALIDATION"
									? "One of the shared files couldn't be saved."
									: errorCode(err) === "STORAGE_QUOTA"
										? humanError(err)
										: "The upload stopped. Yonder carries on next time.",
								{ id: t, description: undefined },
							);
						}
						continue;
					}
					if (!e.url && !e.text) continue;
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
