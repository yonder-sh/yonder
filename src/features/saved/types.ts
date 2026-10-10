/** Saved links as the app sees them (isomorphic: types only). */
import type { SavedPlace } from "@/db/schema/saved";

export type { SavedPlace };

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
	createdAt: number;
};
