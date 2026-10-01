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
import { Check, ChevronDown, Copy, Smartphone } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Chip } from "@/components/kit";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { cn } from "@/lib/utils";
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
	const [open, setOpen] = useState(here);
	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className="rounded-xl border"
		>
			<CollapsibleTrigger className="flex h-11 w-full items-center gap-2 px-3 text-left text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
				<ChevronDown
					className={cn(
						"size-4 shrink-0 text-muted-foreground transition-transform",
						!open && "-rotate-90",
					)}
				/>
				<span className="flex-1">{title}</span>
				{here ? <Chip>This device</Chip> : null}
			</CollapsibleTrigger>
			<CollapsibleContent className="grid gap-3 px-3 pb-3 text-sm">
				{children}
			</CollapsibleContent>
		</Collapsible>
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
						description: "Now run Save to Yonder once in Shortcuts.",
					});
			})
			.catch(() =>
				toast.error("Couldn't copy the setup code. Tap again in a moment."),
			);
	};
	const now = Date.now();
	return (
		<>
			{devices.length ? (
				<ul className="grid gap-1" data-testid={HOME_TESTID.shortcutDevices}>
					{devices.map((d) => (
						<li
							key={d.id}
							className="flex items-center gap-2 rounded-lg bg-muted/50 py-1 pr-1 pl-3"
						>
							<Smartphone className="size-4 shrink-0 text-muted-foreground" />
							<span className="min-w-0 flex-1 truncate">
								{d.label}
								<span className="text-muted-foreground">
									{" · "}
									{d.lastUsedAt ? timeAgo(d.lastUsedAt, now) : "not used yet"}
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
			<ol className="grid gap-2">
				<Step n={1}>
					<Button
						size="sm"
						onClick={() =>
							copy(() => window.open(icloudUrl, "_blank", "noopener"))
						}
						data-testid={HOME_TESTID.shortcutAdd}
					>
						Add the Shortcut
					</Button>
				</Step>
				<Step n={2}>
					<Button
						size="sm"
						variant="outline"
						onClick={() => copy()}
						data-testid={HOME_TESTID.shortcutReconnect}
					>
						Copy setup code
					</Button>
					<span className="text-muted-foreground">
						then run it once in Shortcuts
					</span>
				</Step>
			</ol>
			<p className="text-muted-foreground">
				Then share from any app and pick <b>Save to Yonder</b>.
			</p>
		</>
	);
}

function Step({ n, children }: { n: number; children: ReactNode }) {
	return (
		<li className="flex flex-wrap items-center gap-2">
			<span className="flex size-5 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
				{n}
			</span>
			{children}
		</li>
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
					<ol className="grid list-decimal gap-1 pl-5">
						<li>
							In Shortcuts, make <b>Save to Yonder</b> with{" "}
							<b>Show in Share Sheet</b> on.
						</li>
						<li>
							Add <b>URL Encode</b>, then <b>Open URLs</b> with this address
							followed by <b>URL Encoded Text</b>:
						</li>
					</ol>
					<div className="flex items-center gap-2 rounded-lg bg-muted/50 py-1 pr-1 pl-3">
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
				</>
			)}
		</Way>
	);
	const android = (
		<Way key="android" title="Android" here={device === "android"}>
			<p>
				Add Yonder to your Home screen from the browser menu. It then shows up
				when you tap Share in any app.
			</p>
		</Way>
	);
	const computer = (
		<Way key="computer" title="On a computer" here={device === "computer"}>
			<p>Copy the link and paste it into Search (⌘K).</p>
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
						Send a reel, a TikTok or any link straight to a trip.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-2">{ways}</div>
			</DialogContent>
		</Dialog>
	);
}
