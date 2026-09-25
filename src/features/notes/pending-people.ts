/**
 * ADDENDUM §8 free-text people in a saved field (QA PLAN-R2-08). In a
 * `MentionInput` (a comment, a list row, an item note) choosing "Add “Zed”
 * as a new person" doesn't create anyone yet: the chip gets a PENDING id (a
 * client UUID, so the token is well formed) and the placeholder is created
 * only when a save carries that id. `useTripMutation` runs every mutation's
 * variables through `createPendingPeople` (before its optimistic update) and
 * `swapPendingPeople` (the ids the server sees), so cancelling the comment
 * or edit leaves nobody behind on the trip.
 *
 * The live note editor still creates the person at once: a note saves as you
 * type. Framework-free; the registry lives for the page (a pending id keeps
 * pointing at the person it became, so an open field and a retry agree).
 */
import type { QueryClient } from "@tanstack/react-query";
import { MENTION_TOKEN_RE } from "@/lib/notes/mentions";
import { tripKeys } from "@/lib/query/keys";

type Pending = {
	tripId: string;
	name: string;
	/** The real member id, once created. */
	memberId: string | null;
	/** Creation failed: saves write the plain name instead of a chip. */
	failed: boolean;
	creating: Promise<void> | null;
};

const byId = new Map<string, Pending>();
const byName = new Map<string, string>();

const nameKey = (tripId: string, name: string) =>
	`${tripId}\n${name.trim().toLowerCase()}`;

function newUuid(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto)
		return crypto.randomUUID();
	// Old browsers: RFC 4122 v4 from Math.random (only ever a local placeholder id).
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
	});
}

/** The pending id for a new person on `tripId` (the same one for the same name). */
export function pendingPersonId(tripId: string, name: string): string {
	const key = nameKey(tripId, name);
	const known = byName.get(key);
	const p = known ? byId.get(known) : undefined;
	if (known && p && !p.failed) return known;
	const id = newUuid();
	byId.set(id, {
		tripId,
		name: name.trim(),
		memberId: null,
		failed: false,
		creating: null,
	});
	byName.set(key, id);
	return id;
}

/** What a pending id stands for (null for any other id). */
export function pendingPerson(
	id: string,
): { name: string; memberId: string | null } | null {
	const p = byId.get(id.toLowerCase());
	return p ? { name: p.name, memberId: p.memberId } : null;
}

/** Pending ids that occur in any string inside `vars` (plain objects and arrays). */
function pendingIn(vars: unknown): Set<string> {
	const found = new Set<string>();
	if (!byId.size) return found;
	const visit = (v: unknown, depth: number) => {
		if (depth > 12 || v == null) return;
		if (typeof v === "string") {
			if (!v.includes("mention:")) return;
			for (const m of v.matchAll(new RegExp(MENTION_TOKEN_RE.source, "gi"))) {
				const id = (m[2] ?? "").toLowerCase();
				if (byId.has(id)) found.add(id);
			}
			return;
		}
		if (Array.isArray(v)) {
			for (const x of v) visit(x, depth + 1);
			return;
		}
		if (isPlainObject(v)) for (const x of Object.values(v)) visit(x, depth + 1);
	};
	visit(vars, 0);
	return found;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (typeof v !== "object" || v === null) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

export type CreatePerson = (tripId: string, name: string) => Promise<string>;

const defaultCreate: CreatePerson = async (tripId, displayName) => {
	const { addPlaceholder } = await import("@/features/home/sharing.functions");
	return (await addPlaceholder({ data: { tripId, displayName } })).memberId;
};

/**
 * Creates the people that `vars` mention by a pending id and that don't exist
 * yet (once per id; concurrent saves share the call), then refetches the
 * trip's graph so the new chip shows its person. Never throws: a failure
 * makes `swapPendingPeople` write the plain name. No-op while offline (the
 * save itself is refused then) or when nothing is pending.
 */
export async function createPendingPeople(
	vars: unknown,
	qc: QueryClient | null,
	create: CreatePerson = defaultCreate,
): Promise<void> {
	const ids = pendingIn(vars);
	if (!ids.size) return;
	if (typeof navigator !== "undefined" && navigator.onLine === false) return;
	const trips = new Set<string>();
	await Promise.all(
		[...ids].map((id) => {
			const p = byId.get(id);
			if (!p || p.memberId || p.failed) return undefined;
			trips.add(p.tripId);
			p.creating ??= create(p.tripId, p.name).then(
				(memberId) => {
					p.memberId = memberId.toLowerCase();
					p.creating = null;
				},
				() => {
					p.failed = true;
					p.creating = null;
				},
			);
			return p.creating;
		}),
	);
	if (!qc) return;
	for (const tripId of trips) {
		void qc.invalidateQueries({ queryKey: tripKeys.sharing(tripId) });
		await qc
			.refetchQueries({ queryKey: tripKeys.graph(tripId), exact: true })
			.catch(() => undefined);
	}
}

/**
 * `vars` with every created pending id replaced by the real member id, and
 * the chip of one that wasn't created (a failure) written as its plain name.
 * Call after `createPendingPeople`. The same object when nothing is pending.
 */
export function swapPendingPeople<T>(vars: T): T {
	if (!pendingIn(vars).size) return vars;
	const swap = (s: string) =>
		s.replace(
			new RegExp(MENTION_TOKEN_RE.source, "gi"),
			(token, label: string, id: string) => {
				const p = byId.get(id.toLowerCase());
				if (!p) return token;
				if (p.memberId) return token.replace(id, p.memberId);
				// Never an id the server doesn't know: the name, as typed.
				return `@${label.replace(/\\(.)/g, "$1")}`;
			},
		);
	const walk = (v: unknown, depth: number): unknown => {
		if (depth > 12 || v == null) return v;
		if (typeof v === "string") return v.includes("mention:") ? swap(v) : v;
		if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
		if (isPlainObject(v))
			return Object.fromEntries(
				Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1)]),
			);
		return v;
	};
	return walk(vars, 0) as T;
}

/** Tests only. */
export function resetPendingPeople(): void {
	byId.clear();
	byName.clear();
}
