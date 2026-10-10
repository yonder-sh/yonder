/** Saved links as the app sees them (isomorphic: types only). */
import type { SavedPlace } from "@/db/schema/saved";

export type { SavedPlace };

/** A photo or video shared into Saved (`/api/saved-file/<id>/…`). */
export type SavedFile = {
	id: string;
	kind: "photo" | "video";
	mime: string;
	status: "pending" | "processing" | "ready" | "failed";
	width: number | null;
	height: number | null;
	durationSec: number | null;
	thumbhash: string | null;
	/** `thumb` (and a photo's `display`) exist. */
	hasThumb: boolean;
	/** A video's `poster` exists. */
	hasPoster: boolean;
};

export type SavedLink = {
	id: string;
	url: string | null;
	text: string | null;
	/** The title the share sheet sent. */
	title: string | null;
	/** `youtube` | `tiktok` | `instagram`, else null. */
	provider: string | null;
	embedId: string | null;
	igType: string | null;
	status: "pending" | "ready" | "failed";
	/** The preview's title or caption. */
	previewTitle: string | null;
	description: string | null;
	author: string | null;
	siteName: string | null;
	/** `/api/saved/<id>/image` when a picture was re-hosted. */
	image: string | null;
	imageW: number | null;
	imageH: number | null;
	thumbhash: string | null;
	favicon: string | null;
	place: SavedPlace | null;
	/** A Maps place: the trips I can add to with a city, area or place close by, nearest first. */
	nearTrips: string[];
	/** Photos and videos shared (one share, one item): its slides. */
	files: SavedFile[];
	/** Where its first located photo was taken (the trip and area default, like a Maps place). */
	photoSpot: { lat: number; lng: number } | null;
	createdAt: number;
};
