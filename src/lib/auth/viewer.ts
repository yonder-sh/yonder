import { hasFullName } from "./names";

/**
 * The signed-in person as the client sees them (the `['session']` query).
 * Guests (Better Auth anonymous users) have no email: theirs is a
 * placeholder on `guest.yonder.invalid` and is never shown.
 */
export interface Viewer {
	id: string;
	email: string | null;
	/** Display name: "First Last" for accounts, "Guest Heron" (or chosen) for guests. */
	name: string;
	firstName: string;
	lastName: string;
	image: string | null;
	isAnonymous: boolean;
	/** Accounts: both names set. Guests: always true (nothing to onboard). */
	named: boolean;
}

export interface ViewerSource {
	id: string;
	email: string;
	name: string;
	image?: string | null;
	firstName?: string | null;
	lastName?: string | null;
	isAnonymous?: boolean | null;
}

export function toViewer(u: ViewerSource): Viewer {
	const isAnonymous = u.isAnonymous === true;
	return {
		id: u.id,
		email: isAnonymous ? null : u.email,
		name: u.name,
		firstName: u.firstName ?? "",
		lastName: u.lastName ?? "",
		image: u.image ?? null,
		isAnonymous,
		named: isAnonymous || hasFullName(u),
	};
}
