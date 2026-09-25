/**
 * docs/OVERVIEW.md §Sharing: "Make a share card" (the Overview's primary
 * action) or "Share" (its toolbar). Opens a dialog with the card, rendered on
 * the server (`GET /t/<slug>/share-card.png?size=story|square`), and a Story /
 * Square toggle:
 *
 * - **Download** saves `<trip-slug>-story.png` (or `-square`);
 * - **Share…** hands the PNG to the system share sheet where the browser can
 *   share files (`navigator.canShare({ files })`: phones, mostly);
 * - **Copy image** puts it on the clipboard where `image/png` is supported.
 *
 * The PNG is fetched once per size while the dialog is open and reused for
 * all three (a share or a copy must start inside the click, with the file in
 * hand). The trip comes from the route (`/t/$trip/…`) unless `slug` is given.
 */
import { useParams } from "@tanstack/react-router";
import { cn } from "cn";
import { Copy, Download, ImageIcon, RotateCw, Share2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SHARE_CARD_TESTID as T } from "./testids";

type Size = "story" | "square";

export interface ShareButtonProps {
	variant?: "primary" | "toolbar";
	className?: string;
	/** The trip's slug; defaults to the `/t/$trip` route's. */
	slug?: string;
}

export function ShareButton(props: ShareButtonProps) {
	return props.slug ? (
		<ShareCardButton {...props} slug={props.slug} />
	) : (
		<RouteShareButton {...props} />
	);
}

function RouteShareButton(props: ShareButtonProps) {
	const params = useParams({ strict: false }) as { trip?: string };
	return params.trip ? <ShareCardButton {...props} slug={params.trip} /> : null;
}

export const shareCardUrl = (slug: string, size: Size) =>
	`/t/${encodeURIComponent(slug)}/share-card.png?size=${size}`;

function ShareCardButton({
	variant = "primary",
	className,
	slug,
}: ShareButtonProps & { slug: string }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button
				type="button"
				data-testid={T.button}
				variant={variant === "primary" ? "default" : "outline"}
				size={variant === "primary" ? "default" : "sm"}
				className={className}
				onClick={() => setOpen(true)}
			>
				{variant === "primary" ? <ImageIcon /> : <Share2 />}
				{variant === "primary" ? "Make a share card" : "Share"}
			</Button>
			{open && (
				<ShareCardDialog slug={slug} open={open} onOpenChange={setOpen} />
			)}
		</>
	);
}

type Card =
	| { state: "loading" }
	| { state: "error" }
	| { state: "ready"; blob: Blob; url: string };

function canCopyPng(): boolean {
	if (typeof navigator === "undefined" || !navigator.clipboard?.write)
		return false;
	if (typeof ClipboardItem === "undefined") return false;
	const supports = (
		ClipboardItem as unknown as { supports?: (t: string) => boolean }
	).supports;
	return supports ? supports("image/png") : true;
}

function canShareFile(file: File): boolean {
	try {
		return (
			typeof navigator !== "undefined" &&
			!!navigator.canShare?.({ files: [file] })
		);
	} catch {
		return false;
	}
}

export function ShareCardDialog({
	slug,
	open,
	onOpenChange,
}: {
	slug: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [size, setSize] = useState<Size>("story");
	const [cards, setCards] = useState<Partial<Record<Size, Card>>>({});
	const urls = useRef<string[]>([]);

	const load = useCallback(
		async (s: Size) => {
			setCards((c) => ({ ...c, [s]: { state: "loading" } }));
			try {
				const res = await fetch(shareCardUrl(slug, s), {
					credentials: "same-origin",
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const blob = await res.blob();
				const url = URL.createObjectURL(blob);
				urls.current.push(url);
				setCards((c) => ({ ...c, [s]: { state: "ready", blob, url } }));
			} catch {
				setCards((c) => ({ ...c, [s]: { state: "error" } }));
			}
		},
		[slug],
	);

	useEffect(() => {
		if (open && !cards[size]) void load(size);
	}, [open, size, cards, load]);

	// Object URLs die with the dialog.
	useEffect(
		() => () => {
			for (const u of urls.current) URL.revokeObjectURL(u);
		},
		[],
	);

	const card = cards[size] ?? { state: "loading" };
	const fileName = `${slug}-${size}.png`;
	const file =
		card.state === "ready"
			? new File([card.blob], fileName, { type: "image/png" })
			: null;
	const shareable = !!file && canShareFile(file);
	const copyable = canCopyPng();

	const download = () => {
		if (card.state !== "ready") return;
		const a = document.createElement("a");
		a.href = card.url;
		a.download = fileName;
		a.rel = "noopener";
		document.body.append(a);
		a.click();
		a.remove();
	};
	const share = async () => {
		if (!file) return;
		try {
			await navigator.share({ files: [file] });
		} catch (e) {
			if ((e as Error)?.name !== "AbortError")
				toast.error("Couldn't open the share sheet.");
		}
	};
	const copy = async () => {
		if (card.state !== "ready") return;
		try {
			await navigator.clipboard.write([
				new ClipboardItem({ "image/png": card.blob }),
			]);
			toast.success("Image copied");
		} catch {
			toast.error("Couldn't copy the image.");
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				data-testid={T.dialog}
				className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
			>
				<DialogHeader>
					<DialogTitle>Share card</DialogTitle>
					<DialogDescription>
						Your route as an image for stories and chats.
					</DialogDescription>
				</DialogHeader>
				<ToggleGroup
					type="single"
					variant="outline"
					size="sm"
					value={size}
					onValueChange={(v) => v && setSize(v as Size)}
					data-testid={T.size}
					className="mx-auto"
					aria-label="Card size"
				>
					<ToggleGroupItem value="story">Story</ToggleGroupItem>
					<ToggleGroupItem value="square">Square</ToggleGroupItem>
				</ToggleGroup>
				<div
					className={cn(
						"relative mx-auto w-full overflow-hidden rounded-lg bg-black",
						size === "story"
							? "aspect-[9/16] max-w-[min(100%,calc((100dvh-18rem)*9/16))]"
							: "aspect-square max-w-[min(100%,calc(100dvh-18rem))]",
					)}
				>
					{card.state === "ready" && (
						<img
							data-testid={T.preview}
							src={card.url}
							alt={`Share card (${size})`}
							className="absolute inset-0 size-full object-contain"
						/>
					)}
					{card.state === "loading" && (
						<div
							data-testid={T.loading}
							className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-neutral-400"
						>
							<Spinner className="size-6" />
							Drawing your route…
						</div>
					)}
					{card.state === "error" && (
						<div
							data-testid={T.error}
							role="alert"
							className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm text-neutral-300"
						>
							Couldn't make the card. Check your connection and try again.
							<Button
								type="button"
								size="sm"
								variant="secondary"
								data-testid={T.retry}
								onClick={() => void load(size)}
							>
								<RotateCw />
								Try again
							</Button>
						</div>
					)}
				</div>
				<DialogFooter className="gap-2 sm:justify-center">
					{shareable && (
						<Button
							type="button"
							data-testid={T.share}
							onClick={() => void share()}
						>
							<Share2 />
							Share…
						</Button>
					)}
					<Button
						type="button"
						variant={shareable ? "outline" : "default"}
						data-testid={T.download}
						disabled={card.state !== "ready"}
						onClick={download}
					>
						<Download />
						Download
					</Button>
					{copyable && (
						<Button
							type="button"
							variant="outline"
							data-testid={T.copy}
							disabled={card.state !== "ready"}
							onClick={() => void copy()}
						>
							<Copy />
							Copy image
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
