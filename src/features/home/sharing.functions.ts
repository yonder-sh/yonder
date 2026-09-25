/**
 * WP-Home sharing and membership (SPEC §13.6). Signatures are final.
 *
 * The trip link (FB-13 and the 2026-09-25 redesign: the trip's address IS
 * the link, like Google Drive, with a role, on/off and reset; the cores are
 * `src/server/sharing.server.ts`): `getSharing`, `setShareLink`,
 * `resetShareLink`, `extendShareLink`, `removeGuest`; and `addPlaceholder`
 * (ADDENDUM §8; every package's pickers need it). The membership functions
 * (invite, placeholders, roles, remove, promote, leave, claim) are WP-Home's,
 * on the cores in `./server/people.server.ts` and F's
 * `@/server/members.server`; `removeMember` and `leaveTrip` go through
 * `retireMember`, never a DELETE. People join by email invite or through the
 * trip link; a placeholder is tied to a person by an editor ("Link an
 * email…" / "Same person as…") or by "This is me" (FB-14: there are no
 * per-person join links).
 * Authorization comes from MUTATION_POLICY (`requireDirect`).
 * `openTripByLink`, `tripLinkOpen` and `renameGuest` live in
 * `src/lib/auth/share.functions.ts`.
 * Keys: sharing and graph, plus `out.access(userIds)` for revocations.
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/db.server";
import {
	can,
	roleLabel,
	type ShareRole,
	type TripRole,
} from "@/lib/auth/roles";
import { SHARE_ROLE_VALUES } from "@/lib/schemas/enums";
import { PlaceholderName } from "@/lib/schemas/people";
import { logActivity } from "@/server/activity.server";
import { getTripAccess, requireTripRole } from "@/server/authz/access.server";
import {
	withAccount,
	withNamedUser,
	withUser,
} from "@/server/authz/middleware";
import { fail, withStatus } from "@/server/authz/session.server";
import { rateLimitPer } from "@/server/cache.server";
import {
	changeMemberRole,
	claimPlaceholderRow,
	createPlaceholder,
	mergeMember,
	retireMember,
} from "@/server/members.server";
import { tripOf } from "@/server/perms.server";
import { requireDirect } from "@/server/proposals/proposable.server";
import { actorOf } from "@/server/proposals/types";
import {
	extendLink,
	loadSharing,
	removeGuestGrants,
	resetLink,
	setLinkEnabled,
	tripUrl,
} from "@/server/sharing.server";
import { mutationMeta, withTripTx } from "@/server/tx.server";
import { nameMatchesPerson } from "./claim-match";
import { sendInvite } from "./server/invite-email.server";
import {
	capRole,
	dropLinkGrants,
	inviteCore,
	linkPlaceholderToEmail,
	lockMember,
	promoteGuestCore,
} from "./server/people.server";

export type SharingDto = {
	/**
	 * The trip's address, `https://yonder.sh/t/<slug>`: the one link for
	 * everyone. Members open it as members; anyone else only while the link
	 * is on.
	 */
	url: string;
	members: {
		id: string;
		userId: string | null;
		status: "active" | "invited" | "placeholder";
		role: TripRole;
		name: string;
		/** Owner only. */
		email?: string;
		color: number;
	}[];
	/**
	 * The trip's one link (FB-13), on or off; null when none was made yet.
	 * Owner only (`manageShareLinks`, QA LINK-03): everyone else gets null, so
	 * guests and members never learn whether it exists or how often it's used.
	 */
	link: {
		/** Everyone who came in through the link has this role. */
		role: ShareRole;
		enabled: boolean;
		lastUsedAt: string | null;
		useCount: number;
		/** When the link stops working (SECURITY §2); null = never. */
		expiresAt: string | null;
		/** When this link was made (a reset makes a new one; QA SHARE-08). */
		createdAt: string | null;
	} | null;
	guests: {
		userId: string;
		name: string;
		color: number;
		role: ShareRole;
		signedIn: boolean;
		lastSeenAt: string;
	}[];
};

const TripId = z.object({ tripId: z.uuid() });
/** "Can view" / "Can suggest" / "Can edit" (EXTENSIONS §1.4). */
const Role = z.enum(SHARE_ROLE_VALUES);

/** The trip of a live member row (404 for unknown ids, like every row helper). */
async function tripOfMember(memberId: string): Promise<string> {
	const tripId = await tripOf("trip_members", memberId);
	if (!tripId) return fail("NOT_FOUND", "member");
	return tripId;
}

/** The F cores throw bare AppErrors (they also run in auth hooks): give them their status. */
async function mapped<T>(p: Promise<T>): Promise<T> {
	try {
		return await p;
	} catch (e) {
		throw e instanceof Error ? withStatus(e) : e;
	}
}

/** SECURITY §10: people writes (invites, links, claims) per user per hour. */
export const PEOPLE_WRITES_PER_HOUR = 60;

/** SECURITY §10: link creations/resets per owner per hour. */
export const SHARE_LINK_WRITES_PER_HOUR = 20;

/**
 * FB-13: role changes and switching the link off mint no token, so they
 * don't spend the creation budget above (an owner trying roles would hit it);
 * this looser cap only keeps anyone from flooding guests with re-checks.
 */
export const SHARE_LINK_EDITS_PER_HOUR = 120;

/**
 * Members, the link and guests. Emails, the link and guests are for the owner
 * only (§11.3; QA LINK-03: nobody else sees whether a link exists or its use).
 */
export const getSharing = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(TripId.strict())
	.handler(async ({ data, context }): Promise<SharingDto> => {
		const access = await requireTripRole(data.tripId, "viewer", context.user);
		const owner = access.role === "owner" && !access.isGuest;
		const linkManager = owner && can(access, "manageShareLinks");
		const rows = await loadSharing(db, data.tripId);
		const l = linkManager ? rows.link : null;
		const iso = (d: Date | string | null) =>
			d ? new Date(d).toISOString() : null;
		return {
			url: tripUrl(rows.slug),
			members: rows.members.map((m) => ({
				id: m.id,
				userId: m.userId,
				status: m.status,
				role: m.role,
				name: m.name,
				...(owner && m.email ? { email: m.email } : {}),
				color: m.color,
			})),
			link: l
				? {
						role: l.role,
						enabled: l.enabled,
						lastUsedAt: iso(l.lastUsedAt),
						useCount: l.useCount,
						expiresAt: iso(l.expiresAt),
						createdAt: iso(l.createdAt),
					}
				: null,
			guests: owner
				? rows.guests.map((g) => ({
						userId: g.userId,
						name: g.name,
						color: g.color,
						role: g.role,
						signedIn: g.signedIn,
						lastSeenAt: new Date(g.lastSeenAt).toISOString(),
					}))
				: [],
		};
	});

/**
 * Owner only (`manageMembers`). An existing account becomes an active member
 * at once; an unknown address a pending invite that `claimInvites` activates
 * at sign-up. Emails the invitee AFTER commit (§11.2 flow 5). CONFLICT when
 * they're already on the trip or invited, or it's the caller (QA SHARE-07).
 */
export const inviteMember = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(TripId.extend({ email: z.email().max(254), role: Role }).strict())
	.handler(
		async ({
			data,
			context,
		}): Promise<{ memberId: string; status: "active" | "invited" }> => {
			const access = await requireDirect(
				"inviteMember",
				data.tripId,
				context.user,
			);
			await rateLimitPer(
				`people:${context.user.id}`,
				PEOPLE_WRITES_PER_HOUR,
				3600,
			);
			const r = await withTripTx(
				data.tripId,
				async (tx, out) => {
					const res = await inviteCore(tx, out, {
						tripId: data.tripId,
						email: data.email,
						role: data.role,
						inviter: { id: context.user.id, email: context.user.email },
					});
					// Never the address: every member (and guest) reads the activity.
					await logActivity(tx, out, {
						tripId: data.tripId,
						actor: actorOf(context.user),
						verb: "person.invite",
						summary: res.name
							? `added ${res.name} to the trip`
							: "invited someone by email",
						meta: {
							memberId: res.memberId,
							...(res.name ? { name: res.name } : {}),
						},
					});
					const trip = await tx.execute(
						sql`select name, slug from trips where id = ${data.tripId}`,
					);
					return {
						...res,
						trip: trip.rows[0] as { name: string; slug: string },
					};
				},
				mutationMeta(access, context.user),
			);
			await sendInvite({
				to: r.email,
				inviter: context.user.name,
				tripName: r.trip.name,
				slug: r.trip.slug,
				roleLabel: roleLabel(data.role),
			});
			return { memberId: r.memberId, status: r.status };
		},
	);

/**
 * ADDENDUM §10: assign a placeholder to an invite email (auto-claims on
 * sign-up) or merge it into an existing member (`toMemberId`, same trip).
 */
export const linkPlaceholder = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(
		z.union([
			z.object({ memberId: z.uuid(), email: z.email() }).strict(),
			z.object({ memberId: z.uuid(), toMemberId: z.uuid() }).strict(),
		]),
	)
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const tripId = await tripOfMember(data.memberId);
		const access = await requireDirect("linkPlaceholder", tripId, context.user);
		await rateLimitPer(
			`people:${context.user.id}`,
			PEOPLE_WRITES_PER_HOUR,
			3600,
		);
		const r = await withTripTx(
			tripId,
			async (tx, out) => {
				const ph = await lockMember(tx, tripId, data.memberId);
				if (ph.status !== "placeholder")
					return fail(
						"CONFLICT",
						"Only a person without an account can be linked.",
					);
				if ("toMemberId" in data) {
					const into = await lockMember(tx, tripId, data.toMemberId);
					await mapped(mergeMember(tx, out, tripId, ph.id, into.id));
					await logActivity(tx, out, {
						tripId,
						actor: actorOf(context.user),
						verb: "person.merge",
						summary: `linked ${ph.name} to ${into.name}`,
						meta: { memberId: into.id, name: ph.name },
					});
					return { invite: null };
				}
				const res = await mapped(
					linkPlaceholderToEmail(tx, out, {
						tripId,
						placeholder: ph,
						email: data.email,
						linkerRole: access.role,
					}),
				);
				await logActivity(tx, out, {
					tripId,
					actor: actorOf(context.user),
					verb: "person.merge",
					summary: `linked ${ph.name} to an email`,
					meta: {
						memberId: res.kind === "merged" ? res.intoId : ph.id,
						name: ph.name,
					},
				});
				if (res.kind === "merged") return { invite: null };
				const trip = await tx.execute(
					sql`select name, slug, (select role::text from trip_members where id = ${ph.id}) as role
					      from trips where id = ${tripId}`,
				);
				const t = trip.rows[0] as {
					name: string;
					slug: string;
					role: TripRole;
				};
				return {
					invite: {
						to: data.email.trim().toLowerCase(),
						tripName: t.name,
						slug: t.slug,
						role: t.role,
					},
				};
			},
			mutationMeta(access, context.user),
		);
		if (r.invite)
			await sendInvite({
				to: r.invite.to,
				inviter: context.user.name,
				tripName: r.invite.tripName,
				slug: r.invite.slug,
				roleLabel: roleLabel(r.invite.role),
			});
		return { ok: true };
	});

/**
 * ADDENDUM §8 free-text people: typing a name that isn't a member yet in ANY
 * people picker (assignees, mentions, splits, payers, budgets) creates a
 * placeholder, or returns the live placeholder/invite with that name.
 * Implemented by F (every package's pickers need it); `{ direct: 'addPeople' }`:
 * members but viewers, never a link guest. Keys: graph, sharing.
 */
export const addPlaceholder = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(TripId.extend({ displayName: PlaceholderName }).strict())
	.handler(
		async ({
			data,
			context,
		}): Promise<{ memberId: string; created: boolean }> => {
			const access = await requireDirect(
				"addPlaceholder",
				data.tripId,
				context.user,
			);
			await rateLimitPer(`addPeople:${context.user.id}`, 60, 3600);
			return withTripTx(
				data.tripId,
				async (tx, out) => {
					const r = await createPlaceholder(
						tx,
						out,
						data.tripId,
						data.displayName,
					);
					if (r.created)
						await logActivity(tx, out, {
							tripId: data.tripId,
							actor: actorOf(context.user),
							verb: "person.add",
							summary: `added ${data.displayName} to the trip`,
							meta: { memberId: r.memberId, name: data.displayName },
						});
					return r;
				},
				mutationMeta(access, context.user),
			);
		},
	);

export const updateMemberRole = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(z.object({ memberId: z.uuid(), role: Role }).strict())
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const tripId = await tripOfMember(data.memberId);
		const access = await requireDirect(
			"updateMemberRole",
			tripId,
			context.user,
		);
		return withTripTx(
			tripId,
			async (tx, out) => {
				const m = await lockMember(tx, tripId, data.memberId);
				if (m.role === "owner")
					return fail("CONFLICT", "The owner's role can't be changed.");
				// F core: their open sockets re-check access (SHARE-04, no sign-in
				// needed); a downgrade to viewer withdraws their open suggestions.
				const r = await mapped(
					changeMemberRole(tx, out, tripId, m.id, data.role),
				);
				// The role the owner picks is the role they get: an old link grant
				// (role = max of membership and grants, §11.3) must not keep a
				// "Can view" member editing (SHARE-04).
				if (m.userId) await dropLinkGrants(tx, out, tripId, m.userId);
				if (r.from !== r.to && m.status !== "placeholder")
					await logActivity(tx, out, {
						tripId,
						actor: actorOf(context.user),
						verb: "person.role",
						summary: `set ${m.name} to ${roleLabel(data.role)}`,
						meta: { memberId: m.id, name: m.name },
					});
				return { ok: true as const };
			},
			mutationMeta(access, context.user),
		);
	});

export const removeMember = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(z.object({ memberId: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const tripId = await tripOfMember(data.memberId);
		const access = await requireDirect("removeMember", tripId, context.user);
		return withTripTx(
			tripId,
			async (tx, out) => {
				const m = await lockMember(tx, tripId, data.memberId);
				if (m.role === "owner")
					return fail("CONFLICT", "The owner can't be removed.");
				await mapped(retireMember(tx, out, tripId, m.id));
				// A member who also held a link grant keeps no side door (SHARE-05).
				if (m.userId)
					await tx.execute(sql`
						delete from share_grants where trip_id = ${tripId} and user_id = ${m.userId}`);
				await logActivity(tx, out, {
					tripId,
					actor: actorOf(context.user),
					verb: "person.remove",
					summary: `removed ${m.name} from the trip`,
					meta: { memberId: m.id, name: m.name },
				});
				return { ok: true as const };
			},
			mutationMeta(access, context.user),
		);
	});

/**
 * The trip link's switch and role (FB-13, like Google Drive). `enabled: true`
 * creates the link if there is none (with `role`, else "Can view") and gives
 * a tail-less (seeded) address its random tail; `role` alone changes it for
 * everyone who came in through it (their open sockets re-check; "Can view"
 * withdraws their open suggestions). OFF revokes: its guests' grants are
 * deleted and their sockets closed at once; turning it on again restores
 * nobody (they open the address again).
 */
export const setShareLink = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(
		TripId.extend({ role: Role.optional(), enabled: z.boolean().optional() })
			.strict()
			.refine((d) => d.role !== undefined || d.enabled !== undefined, {
				message: "role or enabled",
			}),
	)
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const access = await requireDirect(
			"setShareLink",
			data.tripId,
			context.user,
		);
		// Turning it on may create the link (and a new address); the rest never does.
		if (data.enabled === true)
			await rateLimitPer(
				`shareLink:${context.user.id}`,
				SHARE_LINK_WRITES_PER_HOUR,
				3600,
			);
		else
			await rateLimitPer(
				`shareLinkEdit:${context.user.id}`,
				SHARE_LINK_EDITS_PER_HOUR,
				3600,
			);
		return withTripTx(
			data.tripId,
			async (tx, out) => {
				await setLinkEnabled(
					tx,
					out,
					data.tripId,
					data.role ?? null,
					data.enabled ?? null,
					context.user.id,
				);
				return { ok: true as const };
			},
			mutationMeta(access, context.user),
		);
	});

/**
 * "Reset link": the trip gets a new address tail, so the old address stops
 * working for everyone, and its link guests lose access at once; a new link
 * with the same role (or `role`), on or off as before, replaces it.
 */
export const resetShareLink = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(TripId.extend({ role: Role.optional() }).strict())
	.handler(
		async ({ data, context }): Promise<{ url: string; slug: string }> => {
			const access = await requireDirect(
				"resetShareLink",
				data.tripId,
				context.user,
			);
			await rateLimitPer(
				`shareLink:${context.user.id}`,
				SHARE_LINK_WRITES_PER_HOUR,
				3600,
			);
			return withTripTx(
				data.tripId,
				async (tx, out) => {
					const slug = await resetLink(
						tx,
						out,
						data.tripId,
						data.role ?? null,
						context.user.id,
					);
					return { url: tripUrl(slug), slug };
				},
				mutationMeta(access, context.user),
			);
		},
	);

/** "Extend": the link works for another 30 (edit/suggest) or 90 (view) days. */
export const extendShareLink = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(TripId.strict())
	.handler(async ({ data, context }): Promise<{ expiresAt: string }> => {
		const access = await requireDirect(
			"extendShareLink",
			data.tripId,
			context.user,
		);
		return withTripTx(
			data.tripId,
			async (tx, out) => ({
				expiresAt: await extendLink(tx, out, data.tripId),
			}),
			mutationMeta(access, context.user),
		);
	});

/** Removes a guest's grants on this trip; their sockets close at once. */
export const removeGuest = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(TripId.extend({ userId: z.string().min(1).max(255) }).strict())
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const access = await requireDirect(
			"removeGuest",
			data.tripId,
			context.user,
		);
		return withTripTx(
			data.tripId,
			async (tx, out) => {
				await removeGuestGrants(tx, out, data.tripId, data.userId);
				return { ok: true as const };
			},
			mutationMeta(access, context.user),
		);
	});

/**
 * ADDENDUM §10 "Placeholders ↔ accounts": a signed-in MEMBER says "This is
 * me"; the placeholder's tags, mentions, splits, payments, balances and
 * budget lines move to their member row (F's `claimPlaceholderRow` merges
 * into their membership; their role stays).
 *
 * Never for link guests (QA A-10, SEC-01, SPEC R25; CONTRACTS §4.9 "never
 * exceed the caller's existing access"): turning a placeholder into their
 * membership would give anyone holding a forwarded link money, booking refs
 * and a membership that outlives the link. A guest becomes a placeholder
 * through an invite email (`linkPlaceholder`) or the owner adding them
 * (`promoteGuest` merges the placeholder with their name). The UI asks
 * first (FB-15): the merge can't be undone.
 *
 * Taking over someone's splits and balances: a member claims only a
 * placeholder with their own full or first name ("Are you Audrey?"); owners
 * and editors (`linkPeople`) may claim any, as they can already merge it
 * with "Same person as…".
 */
export const claimPlaceholder = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(TripId.extend({ memberId: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<{ memberId: string }> => {
		const access = await getTripAccess(data.tripId, context.user);
		if (!access) return fail("NOT_FOUND");
		if (access.isGuest || !access.memberId)
			return fail(
				"FORBIDDEN",
				"Ask the trip owner to add you. What's tagged for you carries over.",
			);
		await rateLimitPer(
			`people:${context.user.id}`,
			PEOPLE_WRITES_PER_HOUR,
			3600,
		);
		// A member merges: their own role stays (this is only the core's fallback).
		const role = capRole(access.role, "editor");
		return withTripTx(
			data.tripId,
			async (tx, out) => {
				const ph = await lockMember(tx, data.tripId, data.memberId);
				if (ph.status !== "placeholder") return fail("NOT_FOUND", "member");
				if (
					!can(access, "linkPeople") &&
					!nameMatchesPerson(ph.name, {
						name: context.user.name,
						firstName: context.user.firstName,
					})
				)
					return fail(
						"FORBIDDEN",
						`Only the owner or an editor can link ${ph.name} to you.`,
					);
				const r = await mapped(
					claimPlaceholderRow(tx, out, {
						tripId: data.tripId,
						memberId: ph.id,
						userId: context.user.id,
						role,
					}),
				);
				await logActivity(tx, out, {
					tripId: data.tripId,
					actor: actorOf(context.user),
					verb: "person.merge",
					summary: `is ${ph.name}`,
					meta: { memberId: r.memberId, name: ph.name },
				});
				return { memberId: r.memberId };
			},
			mutationMeta(access, context.user),
		);
	});

export const promoteGuest = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(
		TripId.extend({ userId: z.string().min(1).max(255), role: Role }).strict(),
	)
	.handler(async ({ data, context }): Promise<{ memberId: string }> => {
		const access = await requireDirect(
			"promoteGuest",
			data.tripId,
			context.user,
		);
		return withTripTx(
			data.tripId,
			async (tx, out) => {
				const r = await mapped(
					promoteGuestCore(tx, out, {
						tripId: data.tripId,
						userId: data.userId,
						role: data.role,
					}),
				);
				await logActivity(tx, out, {
					tripId: data.tripId,
					actor: actorOf(context.user),
					verb: "person.invite",
					summary: `added ${r.name} to the trip`,
					meta: { memberId: r.memberId, name: r.name },
				});
				return { memberId: r.memberId };
			},
			mutationMeta(access, context.user),
		);
	});

export const leaveTrip = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(TripId.strict())
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const access = await requireDirect("leaveTrip", data.tripId, context.user);
		const memberId = access.memberId;
		if (!memberId) return fail("NOT_FOUND");
		return withTripTx(
			data.tripId,
			async (tx, out) => {
				await mapped(retireMember(tx, out, data.tripId, memberId));
				await tx.execute(sql`
					delete from share_grants where trip_id = ${data.tripId} and user_id = ${context.user.id}`);
				out.access([context.user.id]);
				await logActivity(tx, out, {
					tripId: data.tripId,
					actor: actorOf(context.user),
					verb: "person.leave",
					summary: "left the trip",
					meta: { memberId, name: context.user.name },
				});
				return { ok: true as const };
			},
			mutationMeta(access, context.user),
		);
	});
