/** WP-Lists note and mention queries (SPEC §12.2). */
import { meKeys, tripKeys } from "@/lib/query/keys";
import { persistedQuery } from "@/lib/query/persister";
import type { BundleTarget } from "@/lib/schemas/targets";
import { listMyMentions, type MentionDto } from "./mentions.functions";
import { listTripNotes, type NoteDto } from "./notes.functions";

export const tripNotesQuery = (tripId: string) =>
	persistedQuery({
		queryKey: tripKeys.notes(tripId),
		queryFn: (): Promise<NoteDto[]> => listTripNotes({ data: { tripId } }),
	});

export const myMentionsQuery = () =>
	persistedQuery({
		queryKey: meKeys.mentions,
		queryFn: (): Promise<MentionDto[]> => listMyMentions(),
	});

/** The bundle target a note row hangs on. */
export function noteTarget(n: NoteDto): BundleTarget {
	if (n.nodeId) return { kind: "node", nodeId: n.nodeId };
	if (n.legId) return { kind: "leg", legId: n.legId };
	if (n.itemId) return { kind: "item", itemId: n.itemId };
	if (n.dayId) return { kind: "day", dayId: n.dayId };
	return { kind: "trip" };
}

/**
 * The note row of a bundle target, if one exists: the SHARED note by default,
 * or `ownerUserId`'s private note on it (ADDENDUM §7.2; `listTripNotes` only
 * ever returns the caller's own private notes).
 */
export function noteFor(
	notes: readonly NoteDto[] | undefined,
	target: BundleTarget,
	ownerUserId: string | null = null,
): NoteDto | undefined {
	return notes?.find((n) => {
		if ((n.ownerUserId ?? null) !== ownerUserId) return false;
		switch (target.kind) {
			case "trip":
				return !n.nodeId && !n.legId && !n.itemId && !n.dayId;
			case "node":
				return n.nodeId === target.nodeId;
			case "leg":
				return n.legId === target.legId;
			case "item":
				return n.itemId === target.itemId;
			case "day":
				return n.dayId === target.dayId;
			default:
				return false;
		}
	});
}

/** A note with visible text (empty docs and whitespace don't count). */
export function hasText(n: NoteDto | undefined): boolean {
	return !!n?.plainText?.trim();
}
