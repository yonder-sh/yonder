/**
 * All of a place's media on a rate card (ADDENDUM §10): photos and videos in a
 * hero viewer with a thumbnail strip, TikTok / Reels / YouTube embeds that
 * play inline (built from the allowlisted provider + a parsed id, in a
 * sandboxed iframe, SECURITY §13), guide links with their previews, and PDFs
 * that open in WP-Media's in-app viewer (pages, Download, "Hide from
 * guests"; ADDENDUM §9). Google photos (when the place is linked to Google) come through
 * the photo proxy with their attributions. An area or city with no photos or
 * videos of its own (Shinjuku) shows those of the places inside it, each
 * labelled with its place. With nothing visual at all, the hero is the
 * location map (or an empty state) with "Add photo" and "Add link".
 *
 * Reads WP-Media's `listTripMedia` (F-filtered: guests never get `members`
 * media or receipts).
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import {
	ChevronRight,
	ExternalLink,
	FileText,
	Film,
	ImagePlus,
	Link2,
	MapPin,
	PlayCircle,
} from "lucide-react";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { ThumbhashImage } from "@/components/common/thumbhash-image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { PdfViewer } from "@/features/media/components/pdf-viewer";
import type { MediaDto } from "@/features/media/media.functions";
import {
	IMAGE_TYPES,
	UPLOAD_EDIT_ONLY_REASON,
	VIDEO_TYPES,
} from "@/features/media/media-kinds";
import { tripMediaQuery } from "@/features/media/queries";
import { useMediaActions } from "@/features/media/use-media-actions";
import { useMediaSurface } from "@/features/media/use-media-surface";
import { can } from "@/lib/auth/roles";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphNode } from "@/lib/engine/types";
import { humanError } from "@/lib/errors";
import { mediaUrl } from "@/lib/media-url";
import { capabilitiesQuery } from "@/lib/query/trip-queries";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { getPlacePhotos, type PlacePhoto } from "../places.functions";
import { PLACES_TESTID } from "../testids";
import { MiniMap } from "../ui/mini-map";

// ---------------------------------------------------------------------------
// Embeds: allowlisted providers, parsed ids only.
// ---------------------------------------------------------------------------

const YT_ID = /^[\w-]{11}$/;
const TT_ID = /^\d{5,25}$/;
const IG_CODE = /^[\w-]{5,40}$/;
const YT_URL =
	/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/;
const TT_URL = /tiktok\.com\/(?:@[\w.-]+\/video|embed\/v2|player\/v1)\/(\d+)/;
const IG_URL = /instagram\.com\/(?:[\w.]+\/)?(reel|reels|p|tv)\/([\w-]+)/;

export type Embed = {
	provider: "youtube" | "tiktok" | "instagram";
	src: string;
	aspect: "9/16" | "16/9";
	href: string;
};

export function embedOf(
	m: Pick<MediaDto, "provider" | "embedId" | "url">,
): Embed | null {
	const url = m.url ?? "";
	const p = (m.provider ?? "").toLowerCase();
	if (p === "youtube" || YT_URL.test(url)) {
		const id =
			m.embedId && YT_ID.test(m.embedId) ? m.embedId : YT_URL.exec(url)?.[1];
		if (!id) return null;
		const short = /\/shorts\//.test(url);
		return {
			provider: "youtube",
			src: `https://www.youtube-nocookie.com/embed/${id}?playsinline=1&rel=0`,
			aspect: short ? "9/16" : "16/9",
			href: `https://www.youtube.com/watch?v=${id}`,
		};
	}
	if (p === "tiktok" || /tiktok\.com/.test(url)) {
		const id =
			m.embedId && TT_ID.test(m.embedId) ? m.embedId : TT_URL.exec(url)?.[1];
		if (!id) return null;
		return {
			provider: "tiktok",
			src: `https://www.tiktok.com/player/v1/${id}?music_info=0&description=0&rel=0`,
			aspect: "9/16",
			href: url || `https://www.tiktok.com/video/${id}`,
		};
	}
	if (p === "instagram" || /instagram\.com/.test(url)) {
		const m2 = IG_URL.exec(url);
		const code = m.embedId && IG_CODE.test(m.embedId) ? m.embedId : m2?.[2];
		if (!code) return null;
		const type = m2?.[1] === "p" ? "p" : m2?.[1] === "tv" ? "tv" : "reel";
		return {
			provider: "instagram",
			src: `https://www.instagram.com/${type}/${code}/embed/`,
			aspect: "9/16",
			href: `https://www.instagram.com/${type}/${code}/`,
		};
	}
	return null;
}

// ---------------------------------------------------------------------------

/** The place's own media and its visits' media, in position order. */
export function mediaOfNode(
	all: readonly MediaDto[],
	ix: GraphIndex,
	nodeId: string,
): MediaDto[] {
	return all.filter((m) => {
		if (m.status === "failed") return false;
		const t = m.target;
		if (t.kind === "node") return t.nodeId === nodeId;
		if (t.kind === "item") return ix.item(t.itemId)?.nodeId === nodeId;
		return false;
	});
}

/** At most this many slides borrowed from the places inside an area. */
export const INSIDE_MAX = 12;

/**
 * The photos, videos and embeds of the places inside `nodeId` (not its
 * own), for an area or city that has none of its own (Shinjuku): each with
 * the place it belongs to, one per place in outline order, then the next
 * round, at most `INSIDE_MAX`. Places dropped below the node lend nothing.
 */
export function mediaInside(
	all: readonly MediaDto[],
	ix: GraphIndex,
	nodeId: string,
): { m: MediaDto; from: GraphNode }[] {
	const byPlace = new Map<string, MediaDto[]>();
	const scopeDropped = ix.isDropped(nodeId);
	for (const m of all) {
		if (m.status === "failed") continue;
		const visual =
			m.kind === "photo" ||
			m.kind === "video" ||
			((m.kind === "embed" || m.kind === "link") && embedOf(m) !== null);
		if (!visual) continue;
		const t = m.target;
		const owner =
			t.kind === "node"
				? t.nodeId
				: t.kind === "item"
					? ix.item(t.itemId)?.nodeId
					: undefined;
		if (!owner || owner === nodeId || !ix.isWithin(owner, nodeId)) continue;
		if (!scopeDropped && ix.isDropped(owner)) continue;
		const list = byPlace.get(owner);
		if (list) list.push(m);
		else byPlace.set(owner, [m]);
	}
	const owners = [...byPlace.keys()].sort(
		(a, b) => ix.outlineIndex(a) - ix.outlineIndex(b),
	);
	const out: { m: MediaDto; from: GraphNode }[] = [];
	for (let round = 0; out.length < INSIDE_MAX; round++) {
		let any = false;
		for (const id of owners) {
			const m = byPlace.get(id)?.[round];
			const from = ix.node(id);
			if (!m || !from) continue;
			any = true;
			out.push({ m, from });
			if (out.length >= INSIDE_MAX) break;
		}
		if (!any) break;
	}
	return out;
}

/** Where a borrowed slide comes from ("Golden Gai"), for an area's card. */
type From = { from?: { id: string; name: string } };

export type Slide = From &
	(
		| { kind: "photo"; m: MediaDto }
		| { kind: "video"; m: MediaDto }
		| { kind: "embed"; m: MediaDto; embed: Embed }
		| { kind: "google"; photo: PlacePhoto; nodeId: string }
	);

function slideOf(m: MediaDto, from?: GraphNode): Slide | null {
	const src = from ? { from: { id: from.id, name: from.name } } : {};
	if (m.kind === "photo") return { kind: "photo", m, ...src };
	if (m.kind === "video") return { kind: "video", m, ...src };
	if (m.kind === "embed" || m.kind === "link") {
		const e = embedOf(m);
		if (e) return { kind: "embed", m, embed: e, ...src };
	}
	return null;
}

function slideKey(s: Slide): string {
	return s.kind === "google" ? `g${s.photo.idx}` : s.m.id;
}

function SlideView({ s, title }: { s: Slide; title: string }) {
	switch (s.kind) {
		case "photo":
			return (
				<ThumbhashImage
					hash={s.m.thumbhash}
					src={mediaUrl(s.m.id, "display")}
					alt={s.m.caption ?? title}
					className="size-full [&_img]:object-contain"
				/>
			);
		case "video":
			return (
				// biome-ignore lint/a11y/useMediaCaption: user uploads carry no caption track.
				<video
					key={s.m.id}
					controls
					playsInline
					preload="metadata"
					poster={mediaUrl(s.m.id, "poster")}
					src={mediaUrl(s.m.id, "original")}
					className="size-full bg-black object-contain"
				/>
			);
		case "embed":
			return (
				<div className="grid size-full place-items-center bg-black/90">
					<iframe
						key={s.m.id}
						title={s.m.title ?? `${s.embed.provider} video`}
						src={s.embed.src}
						loading="lazy"
						sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
						allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
						referrerPolicy="strict-origin-when-cross-origin"
						className={cn(
							"h-full max-w-full border-0",
							s.embed.aspect === "9/16"
								? "aspect-[9/16]"
								: "aspect-video w-full",
						)}
					/>
				</div>
			);
		case "google":
			return (
				<figure className="relative size-full">
					<img
						src={`/api/places/photo/n?nodeId=${encodeURIComponent(s.nodeId)}&idx=${s.photo.idx}&w=1200`}
						alt={title}
						referrerPolicy="no-referrer"
						className="size-full object-contain"
					/>
					{s.photo.attributions.length ? (
						<figcaption className="absolute right-2 bottom-2 rounded bg-black/55 px-1.5 py-0.5 text-[11px] text-white">
							{s.photo.attributions.map((a) => a.name).join(", ")}
						</figcaption>
					) : null}
				</figure>
			);
	}
}

function Thumb({
	s,
	active,
	onClick,
}: {
	s: Slide;
	active: boolean;
	onClick: () => void;
}) {
	const kind =
		s.kind === "google"
			? "Google photo"
			: s.kind === "embed"
				? `${s.embed.provider} video`
				: s.kind;
	const label = s.from ? `${kind} of ${s.from.name}` : kind;
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={`Show ${label}`}
			aria-pressed={active}
			className={cn(
				"relative size-14 shrink-0 overflow-hidden rounded-lg bg-muted ring-offset-2 ring-offset-card transition-shadow",
				active ? "ring-2 ring-primary" : "opacity-80 hover:opacity-100",
			)}
		>
			{s.kind === "photo" ? (
				<ThumbhashImage
					hash={s.m.thumbhash}
					src={mediaUrl(s.m.id, "thumb")}
					alt=""
					className="size-full"
				/>
			) : s.kind === "video" ? (
				<>
					<img
						src={mediaUrl(s.m.id, "poster")}
						alt=""
						className="size-full object-cover"
					/>
					<Film className="absolute right-1 bottom-1 size-3.5 text-white drop-shadow" />
				</>
			) : s.kind === "google" ? (
				<img
					src={`/api/places/photo/n?nodeId=${encodeURIComponent(s.nodeId)}&idx=${s.photo.idx}&w=160`}
					alt=""
					referrerPolicy="no-referrer"
					className="size-full object-cover"
				/>
			) : (
				<span className="grid size-full place-items-center bg-foreground/85 text-background">
					{extras(s.m).hasImage !== false ? (
						<HideOnError
							src={mediaUrl(s.m.id, "image")}
							className="absolute inset-0 size-full object-cover"
						/>
					) : null}
					<PlayCircle
						className="relative size-5 drop-shadow"
						strokeWidth={1.5}
					/>
					<span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent pt-2 pb-0.5 text-center text-[9px] font-medium tracking-wide text-white uppercase">
						{s.embed.provider}
					</span>
				</span>
			)}
		</button>
	);
}

function hostOf(url: string | null): string {
	try {
		return url ? new URL(url).hostname.replace(/^www\./, "") : "";
	} catch {
		return "";
	}
}

/**
 * Fields WP-Media's list adds (`hasImage`, `description`, …). Read defensively:
 * where they are absent the variant is tried and hidden when it fails.
 */
type MediaExtras = {
	hasThumb?: boolean;
	hasImage?: boolean;
	hasFavicon?: boolean;
	description?: string | null;
	pageCount?: number | null;
};
const extras = (m: MediaDto) => m as MediaDto & MediaExtras;

function HideOnError({ src, className }: { src: string; className?: string }) {
	const [failed, setFailed] = useState(false);
	if (failed) return null;
	return (
		<img
			src={src}
			alt=""
			loading="lazy"
			onError={() => setFailed(true)}
			className={className}
		/>
	);
}

/** A guide link with its preview: image, site, title and description. */
function LinkPreview({ m }: { m: MediaDto }) {
	const x = extras(m);
	const host = hostOf(m.url);
	return (
		<a
			href={m.url ?? "#"}
			target="_blank"
			rel="noopener noreferrer nofollow"
			className="group flex min-w-0 items-stretch gap-3 overflow-hidden rounded-lg border bg-card p-2 text-[13px] transition-colors hover:bg-accent/60"
		>
			{x.hasImage !== false ? (
				<span className="relative hidden w-24 shrink-0 overflow-hidden rounded-md bg-muted sm:block">
					<Link2
						className="absolute inset-0 m-auto size-4 text-muted-foreground/60"
						strokeWidth={1.5}
						aria-hidden
					/>
					<HideOnError
						src={mediaUrl(m.id, "image")}
						className="absolute inset-0 size-full bg-muted object-cover"
					/>
				</span>
			) : null}
			<span className="grid min-w-0 flex-1 content-center gap-0.5 py-0.5">
				<span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
					{x.hasFavicon !== false ? (
						<HideOnError
							src={mediaUrl(m.id, "favicon")}
							className="size-3.5 shrink-0 rounded-sm"
						/>
					) : null}
					<span className="truncate">{m.siteName ?? host}</span>
				</span>
				<span className="truncate font-medium text-foreground">
					{m.title ?? host}
				</span>
				{x.description ? (
					<span className="line-clamp-2 text-xs leading-4 text-muted-foreground">
						{x.description}
					</span>
				) : null}
			</span>
			<ExternalLink className="mt-0.5 size-3.5 shrink-0 self-start text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
		</a>
	);
}

/** A PDF (guide, menu, map): its first page when rendered; it opens in the in-app viewer. */
/** A PDF row (opens WP-Media's in-app viewer): the rate card and the Places drawer. */
export function PdfRow({ m, onOpen }: { m: MediaDto; onOpen: () => void }) {
	const x = extras(m);
	const pages = x.pageCount ?? null;
	return (
		<button
			type="button"
			onClick={onOpen}
			data-testid={PLACES_TESTID.ratePdf}
			aria-haspopup="dialog"
			className="group flex w-full min-w-0 items-center gap-3 rounded-lg border bg-card p-2 text-left text-[13px] transition-colors hover:bg-accent/60"
		>
			<span className="relative grid h-12 w-9 shrink-0 place-items-center overflow-hidden rounded-[4px] border bg-background">
				<FileText className="size-4 text-muted-foreground" strokeWidth={1.5} />
				{x.hasThumb !== false ? (
					<HideOnError
						src={mediaUrl(m.id, "thumb")}
						className="absolute inset-0 size-full bg-background object-cover object-top"
					/>
				) : null}
			</span>
			<span className="grid min-w-0 flex-1 gap-0.5">
				<span className="truncate font-medium">
					{m.title ?? m.caption ?? "PDF"}
				</span>
				<span className="text-xs text-muted-foreground">
					PDF{pages ? ` · ${pages} ${pages === 1 ? "page" : "pages"}` : ""}
				</span>
			</span>
			<ChevronRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
		</button>
	);
}

const PHOTO_ACCEPT = [
	...IMAGE_TYPES,
	...VIDEO_TYPES,
	".heic",
	".heif",
	"image/heic",
	"image/heif",
].join(",");

/**
 * "Add photo" (upload, WP-Media's pipeline) and "Add link" (a guide, a
 * TikTok, a YouTube video) for this node, right on the card. Hidden for
 * people who can't add anything (viewers); disabled with the reason when
 * editing is blocked (offline, suggest mode for uploads).
 */
export function AddPhotoOrLink({ node }: { node: GraphNode }) {
	const { access } = useWorkspace();
	const surface = useMediaSurface({ kind: "node", nodeId: node.id });
	const upload = useEditGuard("edit-only", UPLOAD_EDIT_ONLY_REASON);
	const link = useEditGuard();
	const input = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!can(access, "edit") && !can(access, "propose")) return null;

	async function submit(e: FormEvent) {
		e.preventDefault();
		let href: string;
		try {
			const u = new URL(url.trim());
			if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
			href = u.href;
		} catch {
			setError("That isn't a web link. Paste one that starts with https://");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			if (await surface.addUrl(href)) {
				setOpen(false);
				setUrl("");
			}
		} catch (err) {
			setError(humanError(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<span className="inline-flex shrink-0 items-center gap-1.5">
			<input
				ref={input}
				type="file"
				multiple
				accept={PHOTO_ACCEPT}
				className="sr-only"
				tabIndex={-1}
				aria-hidden="true"
				data-testid={PLACES_TESTID.rateAddPhotoInput}
				onChange={(e) => {
					if (e.target.files?.length) surface.uploadFiles(e.target.files);
					e.target.value = "";
				}}
			/>
			<Button
				type="button"
				variant="outline"
				size="xs"
				disabled={upload.disabled}
				title={upload.disabled ? (upload.reason ?? undefined) : undefined}
				data-testid={PLACES_TESTID.rateAddPhoto}
				onClick={() => input.current?.click()}
			>
				<ImagePlus /> Add photo
			</Button>
			<Popover
				open={open}
				onOpenChange={(o) => {
					setOpen(o);
					if (!o) setError(null);
				}}
			>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="outline"
						size="xs"
						disabled={link.disabled}
						title={link.disabled ? (link.reason ?? undefined) : undefined}
						data-testid={PLACES_TESTID.rateAddLink}
					>
						<Link2 /> Add link
					</Button>
				</PopoverTrigger>
				<PopoverContent align="end" className="w-80">
					<form onSubmit={submit} className="grid gap-2">
						<label
							htmlFor={`rate-link-${node.id}`}
							className="text-xs font-medium"
						>
							A guide, a menu, a YouTube video, a TikTok or a Reel
						</label>
						<div className="flex gap-2">
							<Input
								id={`rate-link-${node.id}`}
								data-testid={PLACES_TESTID.rateAddLinkInput}
								value={url}
								onChange={(e) => {
									setUrl(e.target.value);
									setError(null);
								}}
								placeholder="https://"
								inputMode="url"
								autoFocus
								aria-invalid={!!error}
								className="h-8"
							/>
							<Button type="submit" size="sm" disabled={busy || !url.trim()}>
								Add
							</Button>
						</div>
						{error ? (
							<p role="alert" className="text-xs text-destructive">
								{error}
							</p>
						) : null}
					</form>
				</PopoverContent>
			</Popover>
		</span>
	);
}

/** The place's slides (photos, videos, embeds, Google photos), guide links and PDFs. */
export function usePlaceMedia(node: GraphNode) {
	const { graph, ix, mode } = useWorkspace();
	const live = mode === "live";
	const media = useQuery({ ...tripMediaQuery(graph.trip.id), enabled: live });
	const caps = useQuery({ ...capabilitiesQuery(), enabled: live }).data;
	const google = useQuery({
		queryKey: ["places", "photos", node.id],
		queryFn: () => getPlacePhotos({ data: { nodeId: node.id } }),
		enabled: live && !!caps?.google && !!node.googlePlaceId,
		staleTime: 30 * 60_000,
	});
	const mine = useMemo(
		() => mediaOfNode(media.data ?? [], ix, node.id),
		[media.data, ix, node.id],
	);
	const own = useMemo<Slide[]>(() => {
		const out: Slide[] = [];
		for (const m of mine) {
			const s = slideOf(m);
			if (s) out.push(s);
		}
		for (const p of google.data ?? [])
			out.push({ kind: "google", photo: p, nodeId: node.id });
		return out;
	}, [mine, google.data, node.id]);
	// Nothing visual of its own: an area shows its places' photos (Shinjuku).
	const inside = useMemo<Slide[]>(() => {
		if (own.length) return [];
		return mediaInside(media.data ?? [], ix, node.id).flatMap(
			({ m, from }) => slideOf(m, from) ?? [],
		);
	}, [own.length, media.data, ix, node.id]);
	const links = mine.filter((m) => m.kind === "link" && !embedOf(m));
	const pdfs = mine.filter((m) => m.kind === "pdf");
	return {
		slides: own.length ? own : inside,
		/** The slides are the places inside's, not the node's own. */
		borrowed: !own.length && inside.length > 0,
		links,
		pdfs,
	};
}

export function PlaceMedia({
	node,
	className,
	heroClassName,
}: {
	node: GraphNode;
	className?: string;
	heroClassName?: string;
}) {
	const { slides, borrowed, links, pdfs } = usePlaceMedia(node);
	const { graph } = useWorkspace();
	const actions = useMediaActions(graph.trip.id);
	// The open PDF by id, so "Hide from guests" shows its new state at once.
	const [pdfId, setPdfId] = useState<string | null>(null);
	const pdf = pdfId ? pdfs.find((m) => m.id === pdfId) : undefined;
	// The selected slide belongs to one node: a new card starts at its first slide.
	const [pickedFor, setPicked] = useState<{ node: string; i: number }>({
		node: node.id,
		i: 0,
	});
	const active = pickedFor.node === node.id ? pickedFor.i : 0;
	const setActive = (i: number) => setPicked({ node: node.id, i });
	const current = slides[Math.min(active, slides.length - 1)];

	return (
		<div
			className={cn("grid min-h-0 gap-3", className)}
			data-testid={PLACES_TESTID.rateMedia}
		>
			<div
				className={cn(
					"relative overflow-hidden rounded-xl border bg-muted/60",
					heroClassName,
				)}
			>
				{current ? (
					<>
						<SlideView s={current} title={current.from?.name ?? node.name} />
						{current.from ? (
							<span
								data-testid={PLACES_TESTID.rateMediaFrom}
								className="pointer-events-none absolute bottom-2 left-2 inline-flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm"
							>
								<MapPin className="size-3 shrink-0" strokeWidth={2} />
								<span className="truncate">{current.from.name}</span>
							</span>
						) : null}
					</>
				) : node.lat !== null && node.lng !== null ? (
					<MiniMap
						lat={node.lat}
						lng={node.lng}
						zoom={15}
						type={node.type}
						category={node.category}
						className="size-full"
						label={`Map of ${node.name}`}
					/>
				) : (
					<div
						data-testid={PLACES_TESTID.rateMediaEmpty}
						className="grid size-full content-center justify-items-center gap-3 p-6 text-center"
					>
						<p className="font-display text-[15px] text-muted-foreground">
							No photos, videos or location for {node.name} yet.
						</p>
						<AddPhotoOrLink node={node} />
					</div>
				)}
			</div>
			{slides.length > 1 ? (
				<div className="flex gap-2 overflow-x-auto pb-1">
					{slides.map((s, i) => (
						<Thumb
							key={slideKey(s)}
							s={s}
							active={s === current}
							onClick={() => setActive(i)}
						/>
					))}
				</div>
			) : null}
			{/* Say whose photos these are, or that there are none, with a way to add one. */}
			{borrowed || (!current && node.lat !== null && node.lng !== null) ? (
				<div
					data-testid={borrowed ? undefined : PLACES_TESTID.rateMediaEmpty}
					className="flex flex-wrap items-center gap-x-3 gap-y-2"
				>
					<p className="min-w-0 flex-1 text-xs text-muted-foreground">
						{borrowed
							? `Photos from places in ${node.name}.`
							: `No photos or videos of ${node.name} yet.`}
					</p>
					<AddPhotoOrLink node={node} />
				</div>
			) : null}
			{links.length || pdfs.length ? (
				<ul className="grid gap-1.5" data-testid={PLACES_TESTID.rateLinks}>
					{links.map((m) => (
						<li key={m.id}>
							<LinkPreview m={m} />
						</li>
					))}
					{pdfs.map((m) => (
						<li key={m.id}>
							<PdfRow m={m} onOpen={() => setPdfId(m.id)} />
						</li>
					))}
				</ul>
			) : null}
			{pdf ? (
				<PdfViewer
					item={pdf}
					onClose={() => setPdfId(null)}
					onVisibility={(visibility) =>
						actions.visibility.mutate({ id: pdf.id, visibility })
					}
				/>
			) : null}
		</div>
	);
}
