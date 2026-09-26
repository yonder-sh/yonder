/**
 * The lightbox (SPEC §15.5, DESIGN §7.2): yet-another-react-lightbox with the
 * Video, Zoom, Thumbnails and Captions plugins, a 92 % black backdrop, and a
 * custom `embed` slide for TikTok, Reels and YouTube. The toolbar carries
 * "Hide from guests" (members), Download and Delete. Lazy-loaded by the gallery.
 */
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/thumbnails.css";
import "yet-another-react-lightbox/plugins/captions.css";
import { Download, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import Lightbox, { type Slide } from "yet-another-react-lightbox";
import Captions from "yet-another-react-lightbox/plugins/captions";
import Thumbnails from "yet-another-react-lightbox/plugins/thumbnails";
import Video from "yet-another-react-lightbox/plugins/video";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import { useEditGuard } from "@/components/common/edit-guard";
import { MarkdownText } from "@/components/common/markdown-text";
import { mediaUrl } from "@/lib/media-url";
import type { MediaPlay } from "@/lib/realtime/view-protocol";
import {
	usePublishMedia,
	useVideoEvents,
	useVideoFollow,
} from "../media-presence";
import { MEDIA_TESTID } from "../testids";
import type { MediaDto } from "../types";
import { EmbedFrame } from "./embed-frame";
import { ProviderMark } from "./provider-glyph";
import { useEscapeOwner } from "./use-escape-owner";
import { VisibilityButton } from "./visibility-button";

declare module "yet-another-react-lightbox" {
	interface SlideEmbed extends GenericSlide {
		type: "embed";
		item: MediaDto;
	}
	interface SlideTypes {
		embed: SlideEmbed;
	}
}

function toSlide(item: MediaDto, source?: string): Slide {
	const description =
		item.caption || source ? (
			<span className="block space-y-0.5">
				{item.caption ? <MarkdownText md={item.caption} inline /> : null}
				{source ? (
					<span className="block text-xs opacity-70">{source}</span>
				) : null}
			</span>
		) : undefined;
	if (item.kind === "embed")
		return { type: "embed", item, description } as Slide;
	if (item.kind === "video")
		return {
			type: "video",
			poster: item.hasThumb ? mediaUrl(item.id, "poster") : undefined,
			width: item.width ?? undefined,
			height: item.height ?? undefined,
			sources: [
				{ src: mediaUrl(item.id, "original"), type: item.mime ?? "video/mp4" },
			],
			description,
		} as Slide;
	return {
		src: item.hasThumb
			? mediaUrl(item.id, "display")
			: mediaUrl(item.id, "original"),
		width: item.width ?? undefined,
		height: item.height ?? undefined,
		alt: item.caption ?? "Photo",
		srcSet:
			item.hasThumb && item.width && item.height
				? [
						{
							src: mediaUrl(item.id, "thumb"),
							width: Math.min(480, item.width),
							height: Math.round(
								Math.min(480, item.width) * (item.height / item.width),
							),
						},
					]
				: undefined,
		description,
	} as Slide;
}

export default function MediaLightbox({
	items,
	sources,
	index,
	onClose,
	onVisibility,
	onDelete,
	follow,
}: {
	items: MediaDto[];
	/** id → "Shibuya › Shibuya Sky" (rollup source line). */
	sources?: Record<string, string>;
	index: number;
	onClose: () => void;
	/** Omitted (a followed viewer): no "Hide from guests" toggle. */
	onVisibility?: (id: string, next: MediaDto["visibility"]) => void;
	/** Omitted (a followed viewer): no Delete. The next item shows; none left, it closes. */
	onDelete?: (item: MediaDto) => void;
	/**
	 * FB-21c: this lightbox mirrors someone I follow: it shows their item
	 * (next / previous with them) and keeps their video in step.
	 */
	follow?: { id: string; play: MediaPlay | null };
}) {
	const slides = useMemo(
		() => items.map((i) => toSlide(i, sources?.[i.id])),
		[items, sources],
	);
	// Follow the open item by id: a live refetch (a preview job finishing,
	// someone else's upload) re-creates the slides, and yarl re-reads `index`
	// whenever `slides` change — a fixed start index would jump back.
	const [currentId, setCurrentId] = useState(items[index]?.id ?? null);
	const followed = follow ? items.findIndex((i) => i.id === follow.id) : -1;
	const found =
		followed >= 0 ? followed : items.findIndex((i) => i.id === currentId);
	const current =
		found >= 0 ? found : Math.min(index, Math.max(0, items.length - 1));
	useEscapeOwner(onClose);
	const edit = useEditGuard();
	const item = items[current];
	const remove = (m: MediaDto) => {
		const next = items[current + 1] ?? items[current - 1];
		if (next) setCurrentId(next.id);
		else onClose();
		onDelete?.(m);
	};
	// FB-21c: what I show travels (followers open it); my video's play /
	// pause / seek too, unless I am the one following.
	usePublishMedia(
		item
			? {
					id: item.id,
					k: "lb",
					hidden:
						item.visibility !== "everyone" || item.target.kind === "expense",
				}
			: null,
	);
	useVideoEvents(!follow);
	useVideoFollow(follow?.id ?? null, follow?.play ?? null);
	return (
		<div data-testid={MEDIA_TESTID.lightbox}>
			<Lightbox
				open
				className="yonder-lightbox"
				close={onClose}
				index={current}
				slides={slides}
				plugins={[Captions, Thumbnails, Video, Zoom]}
				on={{ view: ({ index: i }) => setCurrentId(items[i]?.id ?? null) }}
				carousel={{ finite: items.length <= 1, preload: 1 }}
				controller={{ closeOnBackdropClick: true }}
				captions={{ descriptionTextAlign: "center", descriptionMaxLines: 3 }}
				thumbnails={{
					border: 0,
					borderRadius: 8,
					padding: 0,
					gap: 8,
					width: 72,
					height: 48,
					showToggle: true,
				}}
				video={{ controls: true, playsInline: true, preload: "metadata" }}
				zoom={{ maxZoomPixelRatio: 2 }}
				styles={{
					root: {
						"--yarl__portal_zindex": 60,
						"--yarl__color_backdrop": "rgba(0, 0, 0, 0.92)",
						"--yarl__thumbnails_container_background_color":
							"rgba(0, 0, 0, 0.92)",
					},
				}}
				toolbar={{
					buttons: [
						item && onVisibility ? (
							<span key="visibility" className="flex h-12 items-center">
								<VisibilityButton
									item={item}
									variant="toolbar"
									onToggle={(next) => onVisibility(item.id, next)}
								/>
							</span>
						) : null,
						item && (item.kind === "photo" || item.kind === "video") ? (
							<a
								key="download"
								href={`${mediaUrl(item.id, "original")}?download=1`}
								download
								aria-label="Download"
								className="yarl__button"
							>
								<Download className="yarl__icon" strokeWidth={1.5} />
							</a>
						) : null,
						item && onDelete ? (
							<button
								key="delete"
								type="button"
								data-testid={MEDIA_TESTID.lightboxDelete}
								aria-label="Delete"
								title={edit.disabled ? (edit.reason ?? undefined) : "Delete"}
								disabled={edit.disabled}
								onClick={() => remove(item)}
								className="yarl__button disabled:opacity-40"
							>
								<Trash2 className="yarl__icon" strokeWidth={1.5} />
							</button>
						) : null,
						"close",
					],
				}}
				render={{
					// Only the current slide loads a third-party player (no preloaded iframes).
					slide: ({ slide, offset }) =>
						slide.type === "embed" ? (
							offset === 0 ? (
								<EmbedFrame
									item={(slide as { item: MediaDto }).item}
									maxHeight="72vh"
								/>
							) : (
								<span className="text-sm text-white/60">
									{(slide as { item: MediaDto }).item.title ?? "Video"}
								</span>
							)
						) : undefined,
					thumbnail: ({ slide }) =>
						slide.type === "embed" ? (
							(slide as { item: MediaDto }).item.hasImage ? (
								<img
									src={mediaUrl((slide as { item: MediaDto }).item.id, "image")}
									alt=""
									className="size-full object-cover"
								/>
							) : (
								<span className="grid size-full place-items-center bg-white/5 text-white/70">
									<ProviderMark
										provider={(slide as { item: MediaDto }).item.provider}
										className="size-5"
									/>
								</span>
							)
						) : undefined,
				}}
			/>
		</div>
	);
}
