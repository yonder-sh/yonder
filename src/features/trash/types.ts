/** Trash (owner, 2026-10-11): an account's deleted uploads, kept 30 days (`./server/trash.server.ts`). */

/** Days a file stays in Trash before the purge deletes it for good. */
export const TRASH_DAYS = 30;

/**
 * Where Restore puts it: `here` back where it was, `place` onto the deleted
 * stop's place, `trip` the trip's own media, `saved` into Saved.
 */
export type RestoreTarget = "here" | "place" | "trip" | "saved";

export type TrashItem = {
	/** `a:<attachmentId>` (a trip's file) or `s:<savedLinkId>` (a Saved share). */
	id: string;
	kind: "photo" | "video" | "pdf";
	name: string | null;
	/** Where it was: "Japan 2027 · Fushimi Inari", or "Saved". */
	from: string;
	sizeBytes: number;
	/** Files in it (a Saved share can hold several). */
	count: number;
	thumb: string | null;
	thumbhash: string | null;
	/** When it went to Trash (ms). */
	trashedAt: number;
	/** Null: it can't come back (a PDF whose trip is gone). */
	restoreTo: RestoreTarget | null;
	/** The place's or the trip's name for `place` / `trip`. */
	restoreName: string | null;
};

/** A restored item and how Undo puts it back in Trash: its new id (null: nothing to undo, it was in Saved already) and old clock. */
export type Restored = {
	id: string | null;
	to: RestoreTarget;
	trashedAt: number;
};
