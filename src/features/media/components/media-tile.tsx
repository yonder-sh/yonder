/**
 * One gallery tile (DESIGN §7.2): photos and videos as thumbhash-backed
 * images, social posts as 9:16 posters with the provider mark, guides as link
 * cards, PDFs as their first page (or the document icon). Hover (or, on touch,
 * always) shows the ⋯ menu and the "Hide from guests" lock; a hidden tile
 * keeps a quiet lock mark for members. The caption is one muted line under
 * the tile, with the source ("Shibuya › Shibuya Sky") in rollups.
 */
import { cn } from "cn";
import { AlertCircle, FileText, Lock, Play } from "lucide-react";
import type { ReactNode } from "react";
import { MarkdownText } from "@/components/common/markdown-text";
import { ThumbhashImage } from "@/components/common/thumbhash-image";
import { Spinner } from "@/components/ui/spinner";
import { mediaUrl } from "@/lib/media-url";
import { TESTID } from "@/lib/testids";
import { canonicalLink, displayHost, providerLabel } from "../embeds";
import { formatBytes } from "../media-kinds";
import { MEDIA_TESTID } from "../testids";
import type { MediaDto } from "../types";
import { useUploads } from "../upload/uploader";
import { ProviderBadge, ProviderMark } from "./provider-glyph";

export function formatClock(sec: number | null): string | null {
	if (sec === null || !Number.isFinite(sec)) return null;
	const s = Math.round(sec);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = String(s % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

/** The URL a link/embed card opens (never `javascript:`: the server only stores http(s)). */
export function openHref(item: MediaDto): string | null {
	return canonicalLink(item.provider, item.embedId, item.url, item.igType);
}

function Processing() {
	return (
		<span className="absolute inset-0 grid place-items-center">
			<span className="grid size-8 place-items-center rounded-full bg-background/80 shadow-sm">
				<Spinner className="size-4 text-muted-foreground" />
			</span>
		</span>
	);
}

function PhotoLike({ item, alt }: { item: MediaDto; alt: string }) {
	const local = useUploads((s) => s.previews[item.id] ?? null);
	const ready = item.hasThumb;
	const src = ready ? mediaUrl(item.id, "thumb") : local;
	const aspect =
		item.width && item.height ? `${item.width} / ${item.height}` : "4 / 3";
	return (
		<span className="relative block overflow-hidden rounded-lg bg-muted">
			{src ? (
				<ThumbhashImage
					hash={item.thumbhash}
					src={src}
					w={item.width}
					h={item.height}
					alt={alt}
					className="w-full"
				/>
			) : (
				<span
					className="block w-full bg-hatch"
					style={{ aspectRatio: aspect }}
				/>
			)}
			{item.status === "processing" ? <Processing /> : null}
			{item.kind === "video" ? (
				<>
					<span className="pointer-events-none absolute inset-0 grid place-items-center">
						<span className="grid size-10 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm">
							<Play
								className="size-5 translate-x-px"
								fill="currentColor"
								strokeWidth={0}
							/>
						</span>
					</span>
					{formatClock(item.durationSec) ? (
						<span className="absolute right-2 bottom-2 rounded-full bg-black/60 px-1.5 py-0.5 font-mono text-[11px] leading-none text-white tnum">
							{formatClock(item.durationSec)}
						</span>
					) : null}
				</>
			) : null}
		</span>
	);
}

function SocialPoster({ item }: { item: MediaDto }) {
	const aspect = item.aspect ?? (item.provider === "youtube" ? 16 / 9 : 9 / 16);
	const kindWord =
		item.provider === "instagram"
			? item.igType === "p"
				? "Post"
				: "Reel"
			: item.provider === "youtube"
				? aspect < 1
					? "Short"
					: "Video"
				: "TikTok";
	/** Without a title: "YouTube Short", "Instagram reel", "TikTok video". */
	const fallback =
		item.provider === "tiktok"
			? "TikTok video"
			: `${providerLabel(item.provider)} ${item.provider === "youtube" ? kindWord : kindWord.toLowerCase()}`;
	return (
		<span
			className="relative block overflow-hidden rounded-lg bg-muted"
			style={{ aspectRatio: String(aspect) }}
		>
			{item.hasImage ? (
				<ThumbhashImage
					hash={item.thumbhash}
					src={mediaUrl(item.id, "image")}
					alt={item.title ?? `${providerLabel(item.provider)} ${kindWord}`}
					className="absolute inset-0 size-full"
				/>
			) : (
				// No picture (Instagram's login wall; a failed fetch): a calm
				// branded card with the provider's mark.
				<span
					role="img"
					aria-label={item.title ?? fallback}
					className="absolute inset-0 grid place-items-center bg-gradient-to-b from-muted to-accent/60 pb-10"
				>
					{/* Landscape cards already carry the play button and label. */}
					{aspect < 1 ? (
						<ProviderMark
							provider={item.provider}
							className="size-9 text-foreground/25"
						/>
					) : null}
				</span>
			)}
			<ProviderBadge provider={item.provider} />
			<span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pt-8 pb-2">
				<span className="grid size-8 place-items-center rounded-full bg-white/90 text-black">
					<Play
						className="size-4 translate-x-px"
						fill="currentColor"
						strokeWidth={0}
					/>
				</span>
				<span className="mt-1.5 block truncate text-[11px] font-medium text-white">
					{item.author
						? `${kindWord} · ${item.provider === "youtube" ? item.author : `@${item.author.replace(/^@/, "")}`}`
						: (item.title ?? fallback)}
				</span>
			</span>
			{item.status === "processing" && !item.hasImage ? <Processing /> : null}
		</span>
	);
}

function LinkCard({ item }: { item: MediaDto }) {
	const host = displayHost(item.url);
	return (
		<span className="block overflow-hidden rounded-lg border bg-card transition-colors group-hover:border-foreground/20">
			{item.hasImage ? (
				<ThumbhashImage
					hash={item.thumbhash}
					src={mediaUrl(item.id, "image")}
					alt=""
					className="aspect-video w-full"
				/>
			) : null}
			<span className="block space-y-1 p-3">
				<span
					className={cn(
						"flex items-center gap-1.5 text-[11px] text-muted-foreground",
						!item.hasImage &&
							(item.visibility === "members"
								? "pr-7 [@media(hover:none)]:pr-16"
								: "[@media(hover:none)]:pr-8"),
					)}
				>
					{item.hasFavicon ? (
						<img
							src={mediaUrl(item.id, "favicon")}
							alt=""
							width={16}
							height={16}
							className="size-4 rounded-sm"
							loading="lazy"
						/>
					) : (
						<span className="grid size-4 place-items-center rounded-sm bg-muted text-[9px] font-semibold uppercase">
							{host.slice(0, 1)}
						</span>
					)}
					<span className="truncate">{item.siteName ?? host}</span>
					{item.status === "processing" ? (
						<Spinner className="ml-auto size-3" />
					) : null}
				</span>
				<span className="line-clamp-2 block text-sm leading-5 font-medium text-foreground">
					{item.title ?? host}
				</span>
				{item.description ? (
					<span className="line-clamp-2 block text-xs text-muted-foreground">
						{item.description}
					</span>
				) : null}
			</span>
		</span>
	);
}

function PdfTile({ item }: { item: MediaDto }) {
	// The top of the first page, cropped to a calm 4:3 (a page is tall).
	const aspect = "4 / 3";
	const meta = [
		item.pageCount
			? `${item.pageCount} ${item.pageCount === 1 ? "page" : "pages"}`
			: null,
		item.sizeBytes ? formatBytes(item.sizeBytes) : null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<span className="block overflow-hidden rounded-lg border bg-card transition-colors group-hover:border-foreground/20">
			<span
				className="relative block overflow-hidden border-b bg-muted/60"
				style={{ aspectRatio: aspect }}
			>
				{item.hasThumb ? (
					<span className="absolute inset-x-3 top-3 -bottom-2 overflow-hidden rounded-t-sm bg-white shadow-sm ring-1 ring-black/5">
						<ThumbhashImage
							hash={item.thumbhash}
							src={mediaUrl(item.id, "thumb")}
							alt={`First page of ${item.title ?? "the PDF"}`}
							className="absolute inset-0 size-full bg-white [&>img]:object-cover [&>img]:object-top"
						/>
					</span>
				) : (
					<span className="absolute inset-0 grid place-items-center">
						<FileText
							className="size-10 text-muted-foreground/70"
							strokeWidth={1.25}
						/>
					</span>
				)}
				<span className="absolute top-2 left-2 rounded bg-foreground/80 px-1.5 py-0.5 font-mono text-[10px] leading-none font-medium tracking-wide text-background">
					PDF
				</span>
				{item.status === "processing" ? <Processing /> : null}
			</span>
			<span className="block space-y-0.5 px-3 py-2">
				<span className="line-clamp-2 block text-[13px] leading-[18px] font-medium break-words">
					{item.title ?? "Document"}
				</span>
				{meta ? (
					<span className="block text-[11px] text-muted-foreground tnum">
						{meta}
					</span>
				) : null}
			</span>
		</span>
	);
}

function FailedTile({ item }: { item: MediaDto }) {
	return (
		<span className="flex aspect-[4/3] flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/40 p-3 text-center">
			<AlertCircle className="size-5 text-muted-foreground" strokeWidth={1.5} />
			<span className="text-xs text-muted-foreground">
				Couldn't process this{" "}
				{item.kind === "video"
					? "video"
					: item.kind === "pdf"
						? "PDF"
						: "photo"}
				.
			</span>
		</span>
	);
}

export function MediaTile({
	item,
	source,
	onOpen,
	menu,
	lock,
}: {
	item: MediaDto;
	/** "Shibuya › Shibuya Sky" / "This visit · Day 4 · 11:42" in rollups. */
	source?: ReactNode;
	onOpen: () => void;
	/** The ⋯ menu (absent for guests and viewers). */
	menu?: ReactNode;
	/** The lock toggle (members only). */
	lock?: ReactNode;
}) {
	const failed = item.status === "failed";
	const alt =
		item.caption?.replace(/[*_`[\]()#>]/g, "").slice(0, 120) ||
		(item.kind === "video" ? "Video" : "Photo");
	const body = failed ? (
		<FailedTile item={item} />
	) : item.kind === "photo" || item.kind === "video" ? (
		<PhotoLike item={item} alt={alt} />
	) : item.kind === "embed" ? (
		<SocialPoster item={item} />
	) : item.kind === "pdf" ? (
		<PdfTile item={item} />
	) : (
		<LinkCard item={item} />
	);
	const isLink = item.kind === "link" && !failed;
	const href = isLink ? openHref(item) : null;
	const hidden = item.visibility === "members";
	const label =
		item.kind === "link"
			? `Open ${item.title ?? displayHost(item.url)}`
			: item.kind === "pdf"
				? `Open ${item.title ?? "PDF"}`
				: item.kind === "embed"
					? `Play ${providerLabel(item.provider)} ${item.title ?? ""}`.trim()
					: `Open ${alt}`;
	return (
		<figure
			data-testid={TESTID.galleryItem}
			data-id={item.id}
			data-kind={item.kind}
			data-provider={item.provider ?? undefined}
			data-status={item.status}
			data-visibility={item.visibility}
			// FB-17: live cursors anchor to the tile; "Hide from guests" ones never reach guests.
			data-cursor-anchor={`media:${item.id}`}
			data-cursor-vis={hidden ? "members" : undefined}
			className="group relative mb-2 break-inside-avoid"
		>
			{href ? (
				<a
					href={href}
					target="_blank"
					rel="noopener noreferrer nofollow"
					aria-label={label}
					className="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					{body}
				</a>
			) : (
				<button
					type="button"
					onClick={onOpen}
					disabled={failed}
					aria-label={label}
					className="block w-full cursor-pointer rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
				>
					{body}
				</button>
			)}
			{hidden ? (
				<span
					data-testid={MEDIA_TESTID.hiddenChip}
					role="img"
					aria-label="Hidden from guests"
					title="Hidden from guests"
					className={cn(
						"pointer-events-none absolute grid size-6 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-opacity",
						// Links: top-right (the favicon and site name own the top-left);
						// it fades for the hover controls, and sits left of the
						// always-visible ⋯ on touch screens.
						item.kind === "link"
							? "top-2 right-2 [@media(hover:none)]:right-11"
							: "bottom-2 left-2",
						item.kind === "pdf" && "top-2 left-12",
						lock && "group-focus-within:opacity-0 group-hover:opacity-0",
					)}
				>
					<Lock className="size-3" strokeWidth={2} />
				</span>
			) : null}
			{menu || lock ? (
				<div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
					{/* Touch screens: the ⋯ menu carries "Hide from guests" too; one control is calmer. */}
					<span className="contents [@media(hover:none)]:hidden">{lock}</span>
					{menu}
				</div>
			) : null}
			{item.caption || source ? (
				<figcaption className="mt-1 space-y-0.5 px-0.5">
					{item.caption ? (
						<MarkdownText
							md={item.caption}
							inline
							className="line-clamp-1 block text-xs text-muted-foreground"
						/>
					) : null}
					{source ? (
						<span className="block truncate text-[11px] text-muted-foreground/80">
							{source}
						</span>
					) : null}
					{item.license ? (
						<span className="block truncate text-[11px] text-muted-foreground/70">
							© {item.license}
						</span>
					) : null}
				</figcaption>
			) : item.license ? (
				<figcaption className="mt-1 truncate px-0.5 text-[11px] text-muted-foreground/70">
					© {item.license}
				</figcaption>
			) : null}
		</figure>
	);
}
