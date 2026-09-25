/**
 * The in-app card that asks for notifications (Web Push; on by default,
 * opt-out). It appears the first time a signed-in person opens a trip on a
 * device, a moment after the workspace settles, never as a browser prompt on
 * load: the browser asks only after "Turn on notifications".
 *
 * - Push-capable browser, not decided yet → "Turn on notifications" / "Not now".
 * - iPhone/iPad Safari in a tab → how to add Yonder to the Home Screen (iOS
 *   delivers push only to installed web apps, 16.4+).
 * - Already allowed → no card; the device quietly stays registered.
 *
 * Either answer hides it on this device; the account's notification
 * settings can turn it on later.
 */
import { useQueryClient } from "@tanstack/react-query";
import { BellRing, Share, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	enablePush,
	markPromptSeen,
	permission,
	promptSeen,
	pushEnv,
	syncPushSubscription,
} from "./push-client";
import { PUSH_TESTID } from "./testids";
import { pushSettingsKey, useHasAccount, usePushSettings } from "./use-push";

const SHOW_AFTER_MS = 1200;

export function PushPromptCard() {
	const { mode } = useWorkspace();
	const live = mode === "live";
	const account = useHasAccount(live);
	const settings = usePushSettings(live && account);
	const publicKey = settings.data?.publicKey ?? null;
	const qc = useQueryClient();
	const [show, setShow] = useState<"ask" | "ios" | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!publicKey) return;
		void syncPushSubscription(publicKey);
		const env = pushEnv();
		if (promptSeen() || env === "unsupported") return;
		if (env === "supported" && permission() !== "default") return;
		const t = setTimeout(
			() => setShow(env === "ios-install" ? "ios" : "ask"),
			SHOW_AFTER_MS,
		);
		return () => clearTimeout(t);
	}, [publicKey]);

	if (!show || !publicKey) return null;

	const close = () => {
		markPromptSeen();
		setShow(null);
	};
	const turnOn = async () => {
		setBusy(true);
		try {
			const r = await enablePush(publicKey);
			if (r === "on") toast.success("Notifications are on");
			else if (r === "denied")
				toast("Notifications are blocked", {
					description: "Allow them for Yonder in your browser's settings.",
				});
			else if (r === "unavailable")
				toast("Notifications aren't available in this browser");
			await qc.invalidateQueries({ queryKey: pushSettingsKey });
			if (r !== "dismissed") close();
		} catch {
			toast.error("Couldn't turn on notifications. Try again later.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<section
			data-testid={PUSH_TESTID.card}
			data-kind={show}
			aria-label="Notifications"
			className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-50 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg md:inset-x-auto md:top-[calc(var(--topbar-h)+0.75rem)] md:right-4 md:bottom-auto md:w-[22rem]"
		>
			<button
				type="button"
				aria-label="Close"
				onClick={close}
				className="absolute top-2.5 right-2.5 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
			>
				<X className="size-4" />
			</button>
			<div className="flex gap-3 pr-5">
				<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
					{show === "ios" ? (
						<Share className="size-4" />
					) : (
						<BellRing className="size-4" />
					)}
				</span>
				<div className="grid gap-1">
					<h2 className="text-sm font-semibold">
						{show === "ios"
							? "Get notifications on this iPhone"
							: "Stay in the loop"}
					</h2>
					<p className="text-[13px] text-muted-foreground">
						{show === "ios" ? (
							<>
								Add Yonder to your Home Screen first: tap{" "}
								<span className="font-medium text-foreground">Share</span>, then{" "}
								<span className="font-medium text-foreground">
									Add to Home Screen
								</span>
								, and open it from there.
							</>
						) : (
							"Booking windows, mentions, suggestions and changes to your plans, on this device. Pick what you get in Notifications."
						)}
					</p>
				</div>
			</div>
			<div className="mt-3 flex justify-end gap-2">
				{show === "ios" ? (
					<Button
						size="sm"
						variant="outline"
						onClick={close}
						data-testid={PUSH_TESTID.cardDismiss}
					>
						Got it
					</Button>
				) : (
					<>
						<Button
							size="sm"
							variant="ghost"
							onClick={close}
							data-testid={PUSH_TESTID.cardDismiss}
						>
							Not now
						</Button>
						<Button
							size="sm"
							onClick={() => void turnOn()}
							disabled={busy}
							data-testid={PUSH_TESTID.cardEnable}
						>
							Turn on notifications
						</Button>
					</>
				)}
			</div>
		</section>
	);
}
