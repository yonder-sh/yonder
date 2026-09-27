/**
 * Account → Save from other apps (owner, 2026-09-27): how to send a reel, a
 * TikTok or any link to Yonder from each device. The installed app is in
 * Android's share sheet already; iPhone has no web share target, so a
 * two-action Shortcut opens `/share?url=` with the shared link; on a
 * computer, paste into ⌘K. This device's way comes first.
 */
import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { HOME_TESTID } from "./testids";

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
				{here ? (
					<span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
						This device
					</span>
				) : null}
			</h3>
			{children}
		</section>
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
				Then in Instagram or TikTok, tap Share, then Share to… (or More), and
				pick Save to Yonder. The first time, sign in to Yonder in Safari.
			</p>
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
