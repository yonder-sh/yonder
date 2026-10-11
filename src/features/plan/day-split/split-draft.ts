/**
 * How long in each city: the changes waiting on this device, per trip
 * (`yonder.splitDraft.<tripId>`). Import-light, so Saved's "Plan a trip
 * from these" can start a new trip's route here.
 */
export type SplitDraft = {
	/** − / + per city. */
	days?: Record<string, number>;
	/** The stops in the order you set. */
	order?: string[];
	/** No dates yet: the day you arrive. */
	start?: string | null;
	/** "Suggest them now": the nights before everyone has rated. */
	early?: boolean;
};

/** Your changes to the suggestion while they wait (suggesting, or no dates yet), per trip, also kept on this device. */
export const splitDrafts = new Map<string, SplitDraft>();

const draftKey = (tripId: string) => `yonder.splitDraft.${tripId}`;

/** This device's copy, so leaving before picking a date keeps the nights. */
export function storedDraft(tripId: string): SplitDraft | undefined {
	try {
		const raw = localStorage.getItem(draftKey(tripId));
		return raw ? (JSON.parse(raw) as SplitDraft) : undefined;
	} catch {
		return undefined;
	}
}

export function storeDraft(tripId: string, draft: SplitDraft | null) {
	if (draft) splitDrafts.set(tripId, draft);
	else splitDrafts.delete(tripId);
	try {
		if (draft) localStorage.setItem(draftKey(tripId), JSON.stringify(draft));
		else localStorage.removeItem(draftKey(tripId));
	} catch {
		// Private mode or blocked storage: kept while the page is open.
	}
}

/** A new trip's route from elsewhere (Saved): these cities in this order, the nights suggested now. */
export function startRoute(tripId: string, cityIds: readonly string[]) {
	storeDraft(tripId, { order: [...cityIds], early: true });
}
