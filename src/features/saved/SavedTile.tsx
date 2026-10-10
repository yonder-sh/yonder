/**
 * One Saved tile, like Instagram's and TikTok's saved grids: a tall (9:16)
 * picture (the re-hosted preview, else a calm card by kind), the source in a
 * small badge, one line under a soft shade.
 */
import { MapPin, StickyNote } from "lucide-react";
import { ThumbhashImage } from "@/components/common/thumbhash-image";
import { Spinner } from "@/components/ui/spinner";
import { ProviderMark } from "@/features/media/components/provider-glyph";
import { cn } from "@/lib/utils";
import { savedKind, sourceLabel, tileLine } from "./lib";
import { SAVED_TESTID } from "./testids";
import type { SavedLink } from "./types";

/** The source's mark: the provider's, a pin for Maps, the site's favicon, else a globe. */
export function SourceMark({
	link,
	className,
}: {
	link: SavedLink;
	className?: string;
}) {
	const kind = savedKind(link);
	if (kind === "maps")
		return <MapPin className={cn("size-3.5", className)} aria-hidden />;
	if (kind === "text")
		return <StickyNote className={cn("size-3.5", className)} aria-hidden />;
	if (!link.provider && link.favicon)
		return (
			<img
				src={link.favicon}
				alt=""
				className={cn("size-3.5 rounded-sm", className)}
			/>
		);
	return <ProviderMark provider={link.provider} className={className} />;
}

/** No picture: a quiet card with the kind's mark (and a note's own words). */
export function SavedPlaceholder({
	link,
	className,
}: {
	link: SavedLink;
	className?: string;
}) {
	const kind = savedKind(link);
	return (
		<span
			data-placeholder={kind}
			className={cn(
				"grid place-items-center bg-gradient-to-b from-muted to-accent/60 p-3 text-center",
				className,
			)}
		>
			{kind === "text" ? (
				<span className="line-clamp-6 font-display text-sm leading-snug text-foreground/80">
					{link.text}
				</span>
			) : (
				<SourceMark link={link} className="size-9 text-foreground/25" />
			)}
		</span>
	);
}

export function SavedTile({
	link,
	onOpen,
}: {
	link: SavedLink;
	onOpen: () => void;
}) {
	const line = tileLine(link);
	const source = sourceLabel(link);
	return (
		<button
			type="button"
			data-testid={SAVED_TESTID.tile}
			data-saved={link.id}
			data-status={link.status}
			onClick={onOpen}
			aria-label={`${source}: ${line}`}
			className="group relative aspect-[9/16] w-full cursor-pointer overflow-hidden bg-muted text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
		>
			{link.image ? (
				<ThumbhashImage
					hash={link.thumbhash}
					src={link.image}
					alt=""
					className="absolute inset-0 size-full [&_img]:size-full [&_img]:object-cover"
				/>
			) : (
				<SavedPlaceholder link={link} className="absolute inset-0 size-full" />
			)}
			<span
				data-testid={SAVED_TESTID.tileBadge}
				className="absolute top-1.5 left-1.5 inline-flex h-5 max-w-[calc(100%-0.75rem)] items-center gap-1 rounded-full bg-black/60 px-1.5 text-2xs font-medium text-white backdrop-blur-sm"
			>
				<SourceMark link={link} className="size-3 shrink-0" />
				<span className="truncate">{source}</span>
			</span>
			{link.status === "pending" ? (
				<Spinner className="absolute top-2 right-2 size-3.5 text-white drop-shadow" />
			) : null}
			<span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/35 to-transparent px-2 pt-8 pb-2">
				<span
					data-testid={SAVED_TESTID.tileLine}
					className="line-clamp-2 text-xs leading-snug font-medium text-white"
				>
					{line}
				</span>
			</span>
		</button>
	);
}
