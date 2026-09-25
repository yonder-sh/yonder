/**
 * The current workspace's suggest mode, outside React (EXTENSIONS §2.3): the
 * global server-function middleware in `src/start.ts` reads it to send
 * `x-yonder-mode: suggest` next to `x-tab-id`. `useUi().setSuggesting` writes
 * it (and mirrors it to `localStorage yonder:suggest:<tripId>`). Only the gate
 * reads the header, and it can only downgrade edit → propose.
 */
let state: { tripId: string | null; suggesting: boolean } = {
	tripId: null,
	suggesting: false,
};

export function setSuggestMode(tripId: string | null, suggesting: boolean) {
	state = { tripId, suggesting: Boolean(tripId) && suggesting };
}

/** `"suggest"` while the current trip is in suggest mode, else null. */
export function suggestModeHeader(): "suggest" | null {
	return state.suggesting ? "suggest" : null;
}

const storageKey = (tripId: string) => `yonder:suggest:${tripId}`;

/** The remembered suggest mode of a trip (false when storage is unavailable). */
export function readSuggesting(tripId: string): boolean {
	try {
		return globalThis.localStorage?.getItem(storageKey(tripId)) === "1";
	} catch {
		return false;
	}
}

export function writeSuggesting(tripId: string, on: boolean): void {
	try {
		if (on) globalThis.localStorage?.setItem(storageKey(tripId), "1");
		else globalThis.localStorage?.removeItem(storageKey(tripId));
	} catch {
		// Private mode / blocked storage: the mode just isn't remembered.
	}
}
