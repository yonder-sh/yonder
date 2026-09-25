/**
 * Who a notification goes to (pure). The rules every trigger shares:
 *
 * - never the actor (whoever caused it);
 * - only people with a push subscription;
 * - the per-type switches and the per-trip mute;
 * - visibility: private to-dos notify only their author; link guests only
 *   hear about suggestions (they can't be mentioned, assigned or travel);
 *   money never goes out at all.
 *
 * The audience helpers pick the candidates per trigger, from the trip graph's
 * members; `selectRecipients` applies the shared filters.
 */
import { can, type TripAccess } from "@/lib/auth/roles";
import type { GraphMember } from "@/lib/engine/types";
import type { PushType } from "./types";

export type RecipientPrefs = {
	offTypes: readonly string[];
	mutedTripIds: readonly string[];
};

export type RecipientFilter = {
	type: PushType;
	tripId: string;
	/** Who caused it: never notified about their own change. */
	actorUserIds?: readonly (string | null | undefined)[];
	/** Users with at least one push subscription. */
	subscribed: ReadonlySet<string>;
	/** Stored prefs per user; a user without a row has every type on. */
	prefs: ReadonlyMap<string, RecipientPrefs>;
};

/** Whether a person wants this type from this trip (prefs alone). */
export function wants(
	prefs: RecipientPrefs | undefined,
	type: PushType,
	tripId: string,
): boolean {
	if (!prefs) return true;
	return !prefs.offTypes.includes(type) && !prefs.mutedTripIds.includes(tripId);
}

export function selectRecipients(
	candidates: Iterable<string | null | undefined>,
	f: RecipientFilter,
): string[] {
	const actors = new Set(
		(f.actorUserIds ?? []).filter((a): a is string => !!a),
	);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const u of candidates) {
		if (!u || seen.has(u)) continue;
		seen.add(u);
		if (actors.has(u)) continue;
		if (!f.subscribed.has(u)) continue;
		if (!wants(f.prefs.get(u), f.type, f.tripId)) continue;
		out.push(u);
	}
	return out;
}

/**
 * Active members' user ids: all of them, or those among `memberIds`
 * (placeholders, invites and former members have no account to notify; a
 * merged placeholder's id resolves to the member it became).
 */
export function memberUserIds(
	members: readonly GraphMember[],
	memberIds?: readonly string[],
): string[] {
	const byId = new Map(members.map((m) => [m.id, m]));
	const resolve = (id: string): GraphMember | undefined => {
		let m = byId.get(id);
		for (let hops = 0; m?.mergedIntoId && hops < 5; hops++)
			m = byId.get(m.mergedIntoId);
		return m;
	};
	const picked = memberIds
		? memberIds.map(resolve)
		: members.filter((m) => m.status === "active");
	const out = new Set<string>();
	for (const m of picked)
		if (m?.status === "active" && m.userId) out.add(m.userId);
	return [...out];
}

export type TodoAudienceInput = {
	isPrivate: boolean;
	/** The author's user id. */
	createdBy: string | null;
	/** Member ids. */
	assigneeIds: readonly string[];
};

/** A private to-do's author, while they are still an active member. */
function authorOnly(
	todo: TodoAudienceInput,
	members: readonly GraphMember[],
): string[] {
	if (!todo.createdBy) return [];
	return memberUserIds(members).includes(todo.createdBy)
		? [todo.createdBy]
		: [];
}

/**
 * A booking window (the inbox's `due` rule): a private to-do tells only its
 * author; otherwise its assignees, or every member when nobody is assigned.
 */
export function todoAudience(
	todo: TodoAudienceInput,
	members: readonly GraphMember[],
): string[] {
	if (todo.isPrivate) return authorOnly(todo, members);
	return todo.assigneeIds.length
		? memberUserIds(members, todo.assigneeIds)
		: memberUserIds(members);
}

/** A due reminder: only an ASSIGNED to-do, to its assignees (private: its author). */
export function dueAudience(
	todo: TodoAudienceInput,
	members: readonly GraphMember[],
): string[] {
	if (!todo.assigneeIds.length) return [];
	if (todo.isPrivate) return authorOnly(todo, members);
	return memberUserIds(members, todo.assigneeIds);
}

/** A plan that changed: its assignees (travellers), or everyone when it has none. */
export function planAudience(
	assigneeIds: readonly string[],
	members: readonly GraphMember[],
): string[] {
	return assigneeIds.length
		? memberUserIds(members, assigneeIds)
		: memberUserIds(members);
}

/** Who may review a suggestion (owner, editor, link editor), never its author. */
export function reviewAudience(
	people: readonly {
		userId: string;
		access: Pick<TripAccess, "role" | "isGuest">;
	}[],
	authorUserId: string | null,
): string[] {
	return people
		.filter(
			(p) => p.userId !== authorUserId && can(p.access, "reviewProposals"),
		)
		.map((p) => p.userId);
}
