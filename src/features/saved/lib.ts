/** Saved: what a tile says (pure; unit-tested). */
import {
	classifyShare,
	cleanShareName,
	isMapsUrl,
	type ShareKind,
} from "@/features/home/share-classify";
import { displayHost, providerLabel } from "@/features/media/embeds";
import type { SharedEntry } from "@/features/offline/share-store";
import type { SavedLink } from "./types";

export type SavedKind = ShareKind;

type Files = { files?: readonly { kind: string }[] };

export function savedKind(
	l: Pick<SavedLink, "url" | "text"> & Files,
): SavedKind {
	return l.files?.length
		? "media"
		: classifyShare({ url: l.url, text: l.text, files: [] });
}

/** "3 photos", "a video", "2 photos and a video". */
export function filesLabel(files: readonly { kind: string }[]): string {
	const videos = files.filter((f) => f.kind === "video").length;
	const photos = files.length - videos;
	const part = (n: number, one: string) =>
		n === 1 ? `1 ${one}` : `${n} ${one}s`;
	return [
		photos ? part(photos, "photo") : null,
		videos ? part(videos, "video") : null,
	]
		.filter(Boolean)
		.join(" and ");
}

/** The tile's badge: "Photos", "Video", "TikTok", "Instagram", "YouTube", "Maps", else the site. */
export function sourceLabel(
	l: Pick<SavedLink, "url" | "text" | "provider" | "siteName"> & Files,
): string {
	if (l.files?.length)
		return l.files.every((f) => f.kind === "video") ? "Video" : "Photos";
	if (l.provider) return providerLabel(l.provider);
	if (l.url) {
		try {
			if (isMapsUrl(new URL(l.url))) return "Maps";
		} catch {
			// not a URL
		}
		return l.siteName || displayHost(l.url) || "Link";
	}
	return "Note";
}

/** The tile's one line: the place, else the words shared with it, else the caption or title. */
export function tileLine(
	l: Pick<
		SavedLink,
		"url" | "text" | "title" | "previewTitle" | "description" | "place"
	> &
		Files,
): string {
	if (l.files?.length)
		return cleanShareName(l.title, l.text) || filesLabel(l.files);
	return (
		l.place?.name ||
		cleanShareName(l.title, l.text) ||
		l.previewTitle ||
		l.description ||
		(l.url ? displayHost(l.url) : "") ||
		(l.text ?? "")
	);
}

/** The feed's order: the tile you opened first, then the rest as the grid has them. */
export function feedPile(
	ids: readonly string[],
	open: string | null,
): string[] {
	return open && ids.includes(open)
		? [open, ...ids.filter((id) => id !== open)]
		: [...ids];
}

/** A saved link as the save controls read a share (its words name the idea). */
export function toEntry(l: SavedLink): SharedEntry {
	return {
		id: l.id,
		createdAt: l.createdAt,
		title: l.title ?? (l.text ? null : l.previewTitle),
		text: l.text,
		url: l.url,
		files: [],
	};
}
