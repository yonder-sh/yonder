/**
 * Account → Save from other apps (owner, 2026-09-27): how to send a reel, a
 * TikTok or any link to Yonder from each device. The installed app is in
 * Android's share sheet already; on a computer, paste into ⌘K. iPhone has no
 * web share target: where the server offers the "Save to Yonder" Shortcut
 * (SHORTCUT_ICLOUD_URL), "Add the Shortcut" copies a one-time setup code and
 * opens it, and running it once connects the phone (src/server/shortcut.server.ts);
 * otherwise a two-action Shortcut opens `/share?url=` in Safari. This
 * device's way comes first.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Smartphone } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Chip } from "@/components/kit";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { timeAgo } from "@/features/shell/inbox-model";
import {
	getShortcutSetup,
	removeShortcutDevice,
	startShortcutPairing,
} from "@/functions/shortcut.functions";
import { HOME_TESTID } from "./testids";
import { markShortcutDevice } from "./use-shortcut-pickup";

type Device = "iphone" | "android" | "computer";

export function thisDevice(): Device {
	if (typeof navigator === "undefined") return "computer";
	const ua = navigator.userAgent;
	if (/iPad|iPhone|iPod/.test(ua)) return "iphone";
	// iPadOS reports a Mac; touch gives it away.
	if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return "iphone";
	if (/Android/.test(ua)) return "android";
	return "computer";
}

/** What the Shortcut opens, followed by the shared link (URL-encoded). */
export function shortcutAddress(origin: string): string {
	return `${origin}/share?url=`;
}

function Way({
	title,
	here,
	children,
}: {
	title: string;
	here: boolean;
	children: ReactNode;
}) {
	return (
		<section className="grid gap-2">
			<h3 className="flex items-center gap-2 text-sm font-semibold">
				{title}
				{here ? <Chip>This device</Chip> : null}
			</h3>
			{children}
		</section>
	);
}

const setupKey = ["me", "shortcut"] as const;

/**
 * Copies a fresh setup code. The code is fetched inside the tap (a promised
 * ClipboardItem), so Safari still counts it as the tap's copy.
 */
function copySetupCode(): Promise<void> {
	const code = startShortcutPairing().then((r) => r.code);
	if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write)
		return navigator.clipboard.write([
			new ClipboardItem({
				"text/plain": code.then((c) => new Blob([c], { type: "text/plain" })),
			}),
		]);
	return code.then((c) => navigator.clipboard.writeText(c));
}

/** The Shortcut that connects with a setup code (this server offers it). */
function ShortcutSetup({ icloudUrl }: { icloudUrl: string }) {
	const qc = useQueryClient();
	const setup = useQuery({
		queryKey: setupKey,
		queryFn: () => getShortcutSetup(),
	});
	const remove = useMutation({
		mutationFn: (id: string) => removeShortcutDevice({ data: { id } }),
		onSuccess: () => {
			toast("Phone disconnected");
			void qc.invalidateQueries({ queryKey: setupKey });
		},
		onError: () => toast.error("Couldn't disconnect it. Try again."),
	});
	const devices = setup.data?.devices ?? [];
	const copy = (then?: () => void) => {
		markShortcutDevice();
		const done = copySetupCode();
		then?.(); // in the same tap, or Safari blocks the new window
		void done
			.then(() => {
				if (!then)
					toast("Setup code copied", {
						description: "Now open Shortcuts and tap Save to Yonder once.",
					});
			})
			.catch(() =>
				toast.error("Couldn't copy the setup code. Tap again in a moment."),
			);
	};
	const now = Date.now();
	return (
		<>
			<ol className="grid list-decimal gap-1.5 pl-5 text-sm text-foreground/85">
				<li>
					Tap <b>Add the Shortcut</b>, then <b>Add Shortcut</b>.
				</li>
				<li>
					In Shortcuts, tap <b>Save to Yonder</b> once, within 5 minutes. It
					connects this phone and comes back here.
				</li>
			</ol>
			<p className="text-sm text-muted-foreground">
				Already have the Shortcut, or the code ran out? Tap Copy setup code,
				then run Save to Yonder once.
			</p>
			<div className="flex flex-wrap gap-2">
				<Button
					onClick={() =>
						copy(() => window.open(icloudUrl, "_blank", "noopener"))
					}
					data-testid={HOME_TESTID.shortcutAdd}
				>
					Add the Shortcut
				</Button>
				<Button
					variant="outline"
					onClick={() => copy()}
					data-testid={HOME_TESTID.shortcutReconnect}
				>
					Copy setup code
				</Button>
			</div>
			{devices.length ? (
				<ul className="grid gap-1" data-testid={HOME_TESTID.shortcutDevices}>
					{devices.map((d) => (
						<li
							key={d.id}
							className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
						>
							<Smartphone className="size-4 shrink-0 text-muted-foreground" />
							<span className="min-w-0 flex-1 truncate">
								{d.label}
								<span className="text-muted-foreground">
									{" · "}
									{d.lastUsedAt
										? `Last used ${timeAgo(d.lastUsedAt, now)}`
										: "Not used yet"}
								</span>
							</span>
							<Button
								size="sm"
								variant="ghost"
								disabled={remove.isPending}
								onClick={() => remove.mutate(d.id)}
							>
								Disconnect
							</Button>
						</li>
					))}
				</ul>
			) : null}
			<p className="text-sm text-muted-foreground">
				Then in Instagram or TikTok, tap Share, then Share to… (or More), and
				pick Save to Yonder. Yonder opens on the link, ready to save.
			</p>
		</>
	);
}

export function SaveFromAppsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [copied, setCopied] = useState(false);
	const device = thisDevice();
	const setup = useQuery({
		queryKey: setupKey,
		queryFn: () => getShortcutSetup(),
		enabled: open,
	});
	const icloudUrl = setup.data?.icloudUrl ?? null;
	const address = shortcutAddress(
		typeof window === "undefined" ? "" : window.location.origin,
	);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(address);
			setCopied(true);
			toast("Address copied");
		} catch {
			toast.error("Couldn't copy. Select the address and copy it instead.");
		}
	};
	const iphone = (
		<Way key="iphone" title="iPhone and iPad" here={device === "iphone"}>
			{icloudUrl ? (
				<ShortcutSetup icloudUrl={icloudUrl} />
			) : (
				<>
					<ol className="grid list-decimal gap-1.5 pl-5 text-sm text-foreground/85">
						<li>
							Open Shortcuts and tap <b>+</b> for a new shortcut. Name it{" "}
							<b>Save to Yonder</b>.
						</li>
						<li>
							Open its details (ⓘ) and turn on <b>Show in Share Sheet</b>.
						</li>
						<li>
							Add the action <b>URL Encode</b>. It encodes the Shortcut Input.
						</li>
						<li>
							Add the action <b>Open URLs</b>. Set the address to the one below,
							followed by <b>URL Encoded Text</b>.
						</li>
					</ol>
					<div className="flex items-center gap-2 rounded-lg border bg-muted/50 py-1.5 pr-1.5 pl-3">
						<code
							className="min-w-0 flex-1 truncate font-mono text-xs"
							data-testid={HOME_TESTID.saveFromAppsAddress}
						>
							{address}
						</code>
						<Button
							size="sm"
							variant="outline"
							onClick={() => void copy()}
							data-testid={HOME_TESTID.saveFromAppsCopy}
						>
							{copied ? <Check /> : <Copy />} Copy
						</Button>
					</div>
					<p className="text-sm text-muted-foreground">
						Then in Instagram or TikTok, tap Share, then Share to… (or More),
						and pick Save to Yonder. The first time, sign in to Yonder in
						Safari.
					</p>
				</>
			)}
		</Way>
	);
	const android = (
		<Way key="android" title="Android" here={device === "android"}>
			<p className="text-sm text-foreground/85">
				Install Yonder from your browser's menu (Add to Home screen). It then
				shows up when you tap Share in Instagram, TikTok, Maps or any app.
			</p>
		</Way>
	);
	const computer = (
		<Way key="computer" title="On a computer" here={device === "computer"}>
			<p className="text-sm text-foreground/85">
				Copy the link and paste it into Search (⌘K). Yonder offers to add it to
				the place you have open, or to save it as a new idea.
			</p>
		</Way>
	);
	const ways =
		device === "android"
			? [android, iphone, computer]
			: device === "computer"
				? [computer, iphone, android]
				: [iphone, android, computer];
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-h-[90svh] overflow-y-auto sm:max-w-md"
				data-testid={HOME_TESTID.saveFromAppsDialog}
			>
				<DialogHeader>
					<DialogTitle>Save from other apps</DialogTitle>
					<DialogDescription>
						Send a reel, a TikTok, a Maps place or any link straight to a trip.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-5">{ways}</div>
			</DialogContent>
		</Dialog>
	);
}
