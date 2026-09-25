/**
 * FB-21c: the media viewer follows.
 *
 * - The leader: every lightbox / PDF viewer publishes the item it shows
 *   (`usePublishMedia`, the channel awareness `media` field) and, for an
 *   uploaded video, each play / pause / seek (`useVideoEvents`).
 * - A follower (or everyone in a Spotlight): `FollowedMedia`, mounted once by
 *   the workspace, opens the same item in its own lightbox (the item's
 *   neighbours from the same place), moves with next / previous, closes with
 *   it, and keeps an uploaded video in step (`useVideoFollow`: play / pause,
 *   and a seek when it drifts more than VIDEO_DRIFT_S; autoplay falls back to
 *   muted when the browser refuses sound). TikTok / Reels / YouTube embeds
 *   can't be driven: followers just open the same one.
 * Only items the follower has themselves are opened (a "Hide from guests"
 * item never reaches a guest: the server strips it, and their media list
 * doesn't have it).
 */
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { AwarenessMedia } from "@/lib/realtime/view-protocol";
import { useFollowedPeer } from "@/lib/realtime/view-ui";
import { inLightbox } from "./components/lightbox-kinds";
import { PdfViewer } from "./components/pdf-viewer";
import { sameTarget, useTripMedia } from "./queries";
import type { MediaDto } from "./types";

const MediaLightbox = lazy(() => import("./components/media-lightbox"));

/**
 * The followed person's open media on my screen (see the file comment).
 * Closing it myself keeps it closed until they open something else.
 */
export function FollowedMedia() {
	const peer = useFollowedPeer();
	const raw = peer?.media;
	const json = raw ? JSON.stringify(raw) : null;
	const media = useMemo(() => {
		if (!json) return null;
		const r = AwarenessMedia.safeParse(JSON.parse(json));
		return r.success ? r.data : null;
	}, [json]);
	const { data } = useTripMedia();
	const [closed, setClosed] = useState<string | null>(null);
	const openKey = media ? `${media.k}:${media.id}` : null;
	useEffect(() => {
		// They opened something else (or closed it): my own close is spent.
		if (closed && closed !== openKey) setClosed(null);
	}, [openKey, closed]);
	const item = media ? data.find((i) => i.id === media.id) : undefined;
	const items = useMemo(
		() =>
			item
				? data.filter(
						(i: MediaDto) => inLightbox(i) && sameTarget(i.target, item.target),
					)
				: [],
		[data, item],
	);
	if (!media || !item || closed === openKey) return null;
	if (media.k === "pdf")
		return item.kind === "pdf" ? (
			<PdfViewer item={item} onClose={() => setClosed(openKey)} />
		) : null;
	const index = items.findIndex((i) => i.id === item.id);
	if (index < 0) return null;
	return (
		<Suspense fallback={null}>
			<MediaLightbox
				items={items}
				index={index}
				follow={{ id: item.id, play: media.p ?? null }}
				onClose={() => setClosed(openKey)}
			/>
		</Suspense>
	);
}
