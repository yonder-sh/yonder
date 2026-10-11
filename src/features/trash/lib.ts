/** Trash's wording (pure). */
import { TRASH_DAYS, type TrashItem } from "./types";

const DAY = 86_400_000;

/** Whole days until the purge takes it (0 = today). */
export function daysLeft(trashedAt: number, now = Date.now()): number {
	return Math.max(0, Math.ceil((trashedAt + TRASH_DAYS * DAY - now) / DAY));
}

export function daysLeftLabel(trashedAt: number, now = Date.now()): string {
	const n = daysLeft(trashedAt, now);
	return n === 0 ? "Deleted today" : n === 1 ? "1 day left" : `${n} days left`;
}

/** Where Restore puts it, for the tile and the toast. */
export function restoreLabel(
	it: Pick<TrashItem, "restoreTo" | "restoreName">,
): string {
	switch (it.restoreTo) {
		case "here":
			return "Back where it was";
		case "place":
			return `To ${it.restoreName ?? "its place"}`;
		case "trip":
			return `To ${it.restoreName ?? "the trip"}'s media`;
		case "saved":
			return "To Saved";
		default:
			return "Can't be restored: its trip is gone";
	}
}
