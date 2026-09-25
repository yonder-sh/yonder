/**
 * Share links and guests (SPEC §11.2–§11.4, §13.6; SECURITY §2; owner
 * feedback FB-13). Tokens are stored hashed (`token_hash`) with a sealed copy
 * for the owner (`token_sealed`, opened with BETTER_AUTH_SECRET) —
 * `src/db/share-token.server.ts`.
 *
 * ONE link per trip, like Google Docs: a role (Can view / Can rate / Can
 * suggest / Can edit), on/off and "Reset link". The role lives on the link row and access
 * is resolved from it on every request, so changing it changes every guest
 * who came in through it at once (their sockets re-check; a downgrade to
 * viewer or rater withdraws their open suggestions). The migration
 * `*_single_trip_link` folded older per-role links into one; every write
 * here also retires any other live row of the trip, so the owner never has a
 * link they can't see. (Test fixtures may still seed a second live row.)
 *
 * Every change that removes access runs `out.access(grant holders)` so collab
 * closes those sockets, withdraws the holders' open proposals, and emits
 * `sharing` + `graph`.
 *
 * Links expire (SECURITY §2): editor, suggester and rater links after 30
 * days, view links after 90; a role change never leaves a link valid for longer than a
 * new link of that role. Turning the link OFF is a revocation, not a pause:
 * its grants are deleted, so turning it back on never restores anyone
 * without the link.
 */
import { sql } from "drizzle-orm";
import type { Tx } from "@/db/db.server";
import { shareLinks } from "@/db/schema";
import {
	newShareToken,
	openShareToken,
	shareTokenColumns,
} from "@/db/share-token.server";
import { can, type ShareRole, type TripRole } from "@/lib/auth/roles";
import { shareLinkUrl } from "@/lib/auth/share-link";
import { fail } from "./authz/session.server";
import { getEnv } from "./env.server";
import type { SqlExec } from "./graph.server";
import type { TxOutbox } from "./live/outbox.server";
import { withdrawAuthorProposals } from "./proposals/withdraw.server";

/** Days until a new or extended link expires, per role (SECURITY §2). */
export const LINK_TTL_DAYS: Record<ShareRole, number> = {
	editor: 30,
	suggester: 30,
	// A rate link makes signed-in joiners members (`redeemShareToken`).
	rater: 30,
	viewer: 90,
};

/** The role a brand-new link gets when none is asked for (the safest). */
export const DEFAULT_LINK_ROLE: ShareRole = "viewer";

/** `now + LINK_TTL_DAYS[role]`. */
export function linkExpiry(role: ShareRole, now = new Date()): Date {
	return new Date(now.getTime() + LINK_TTL_DAYS[role] * 86_400_000);
}

function secret(): string | undefined {
	return process.env.BETTER_AUTH_SECRET || undefined;
}

/** The absolute `/join#t=<token>` URL of a sealed token, or null when it can't be opened. */
export function linkUrl(tokenSealed: string | null): string | null {
	const s = secret();
	if (!tokenSealed || !s) return null;
	const token = openShareToken(tokenSealed, s);
	return token ? shareLinkUrl(getEnv().APP_URL, token) : null;
}

type LiveLink = {
	id: string;
	role: ShareRole;
	enabled: boolean;
	expired: boolean;
};

/** Newest first: "the" link is the newest live row (the only one after the migration). */
async function liveLinks(tx: SqlExec, tripId: string): Promise<LiveLink[]> {
	const res = await tx.execute(sql`
		select id::text as id, role::text as role, enabled,
		       (expires_at is not null and expires_at <= now()) as expired
		  from share_links
		 where trip_id = ${tripId} and revoked_at is null
		 order by created_at desc, id desc`);
	return res.rows as LiveLink[];
}

/**
 * Deletes every grant of a link and announces it: collab closes the holders'
 * sockets (`out.access`) and their open proposals are withdrawn.
 */
async function revokeGrants(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	linkId: string,
): Promise<string[]> {
	const res = await tx.execute(sql`
		delete from share_grants where share_link_id = ${linkId}
		returning user_id as "userId"`);
	const holders = (res.rows as { userId: string }[]).map((r) => r.userId);
	if (holders.length) {
		out.access(holders);
		await withdrawAuthorProposals(tx, out, tripId, holders);
	}
	return holders;
}

/** Revokes live rows (their URLs stop working) and removes everyone who came in through them. */
async function retire(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	links: readonly LiveLink[],
): Promise<void> {
	for (const l of links) {
		await tx.execute(
			sql`update share_links set revoked_at = now(), enabled = false where id = ${l.id}`,
		);
		await revokeGrants(tx, out, tripId, l.id);
	}
}

/**
 * The trip's one link, after retiring any other live row (a pre-migration or
 * fixture leftover): the owner only ever sees, and so only ever shares, one.
 */
async function theLink(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
): Promise<LiveLink | null> {
	const [link, ...others] = await liveLinks(tx, tripId);
	if (others.length) await retire(tx, out, tripId, others);
	return link ?? null;
}

async function createLink(
	tx: Tx,
	tripId: string,
	role: ShareRole,
	userId: string,
): Promise<{ id: string; token: string }> {
	const token = newShareToken();
	const [row] = await tx
		.insert(shareLinks)
		.values({
			tripId,
			role,
			createdBy: userId,
			expiresAt: linkExpiry(role),
			...shareTokenColumns(token, secret()),
		})
		.returning({ id: shareLinks.id });
	if (!row) throw new Error("createLink: insert returned no row");
	return { id: row.id, token };
}

/**
 * The link's role. Every guest who came in through it has the new role on
 * their next request (access is read from the link); their sockets re-check
 * now (`out.access`), and a downgrade to viewer or rater withdraws their
 * open suggestions, like a member's. The expiry never ends up later than a new
 * link of that role would get (a view link turned into an edit link expires
 * within 30 days).
 */
async function applyRole(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	link: LiveLink,
	role: ShareRole,
): Promise<void> {
	if (link.role === role) return;
	const cap = linkExpiry(role);
	await tx.execute(sql`
		update share_links
		   set role = ${role},
		       expires_at = least(coalesce(expires_at, ${cap}), ${cap})
		 where id = ${link.id}`);
	const res = await tx.execute(sql`
		select user_id as "userId" from share_grants where share_link_id = ${link.id}`);
	const holders = (res.rows as { userId: string }[]).map((r) => r.userId);
	if (!holders.length) return;
	out.access(holders);
	if (!can({ role, isGuest: true }, "propose"))
		await withdrawAuthorProposals(
			tx,
			out,
			tripId,
			holders,
			role === "viewer"
				? "the link became view-only"
				: "the link can only rate now",
		);
}

/**
 * The trip link's switch and role (FB-13). ON creates the link if there is
 * none (with `role`, else viewer), renews an expired one's expiry, and
 * applies `role` when given. OFF revokes (`role` is ignored): its grants are
 * deleted and their sockets closed, so turning it on again restores nobody
 * without the link. `enabled: null` changes only the role (NOT_FOUND without
 * a link).
 */
export async function setLinkEnabled(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	role: ShareRole | null,
	enabled: boolean | null,
	userId: string,
): Promise<void> {
	const link = await theLink(tx, out, tripId);
	if (!link) {
		if (enabled === null) return fail("NOT_FOUND", "link");
		if (enabled)
			await createLink(tx, tripId, role ?? DEFAULT_LINK_ROLE, userId);
	} else if (enabled === false) {
		if (link.enabled)
			await tx.execute(
				sql`update share_links set enabled = false where id = ${link.id}`,
			);
		await revokeGrants(tx, out, tripId, link.id);
	} else {
		if (role) await applyRole(tx, out, tripId, link, role);
		if (enabled && (!link.enabled || link.expired)) {
			const now = role ?? link.role;
			await tx.execute(sql`
				update share_links set enabled = true,
				       expires_at = case when expires_at is null or expires_at <= now()
				                         then ${linkExpiry(now)} else expires_at end
				 where id = ${link.id}`);
		}
	}
	out.emit({ keys: ["sharing", "graph"] });
}

/** "Extend": the link expires LINK_TTL_DAYS (of its role) from now. */
export async function extendLink(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
): Promise<string> {
	const link = await theLink(tx, out, tripId);
	if (!link) return fail("NOT_FOUND", "link");
	const expiresAt = linkExpiry(link.role);
	await tx.execute(
		sql`update share_links set expires_at = ${expiresAt} where id = ${link.id}`,
	);
	out.emit({ keys: ["sharing"] });
	return expiresAt.toISOString();
}

/**
 * "Reset link": the old URL stops working and everyone who came in through it
 * is removed; a new link (same role unless `role` is given, switched on)
 * replaces it. Returns the new URL.
 */
export async function resetLink(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	role: ShareRole | null,
	userId: string,
): Promise<string> {
	const links = await liveLinks(tx, tripId);
	await retire(tx, out, tripId, links);
	const { token } = await createLink(
		tx,
		tripId,
		role ?? links[0]?.role ?? DEFAULT_LINK_ROLE,
		userId,
	);
	out.emit({ keys: ["sharing", "graph"] });
	return shareLinkUrl(getEnv().APP_URL, token);
}

/** Removes a guest's grants on this trip (they keep nothing; a member row is untouched). */
export async function removeGuestGrants(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	userId: string,
): Promise<number> {
	const res = await tx.execute(sql`
		delete from share_grants where trip_id = ${tripId} and user_id = ${userId} returning 1`);
	if (res.rows.length) {
		out.access([userId]);
		await withdrawAuthorProposals(tx, out, tripId, [userId]);
	}
	out.emit({ keys: ["sharing", "graph"] });
	return res.rows.length;
}

export type SharingRows = {
	members: {
		id: string;
		userId: string | null;
		status: "active" | "invited" | "placeholder";
		role: TripRole;
		name: string;
		email: string | null;
		color: number;
	}[];
	/** The trip's one link (FB-13), on or off; null when none was ever made. */
	link: {
		role: ShareRole;
		enabled: boolean;
		tokenSealed: string | null;
		tokenPrefix: string;
		lastUsedAt: Date | null;
		useCount: number;
		expiresAt: Date | null;
		createdAt: Date | null;
	} | null;
	guests: {
		userId: string;
		name: string;
		color: number;
		role: ShareRole;
		signedIn: boolean;
		lastSeenAt: Date;
	}[];
};

/** Everything the Share dialog shows (the caller strips owner-only fields). */
export async function loadSharing(
	exec: SqlExec,
	tripId: string,
): Promise<SharingRows> {
	const members = await exec.execute(sql`
		select m.id::text as id, m.user_id as "userId", m.status::text as status, m.role::text as role,
		       coalesce(u.name, m.display_name, split_part(m.email, '@', 1), 'Someone') as name,
		       coalesce(u.email, m.email) as email, m.color
		  from trip_members m left join "user" u on u.id = m.user_id
		 where m.trip_id = ${tripId} and m.status::text <> 'removed'
		 order by (m.role = 'owner') desc, m.created_at, m.id`);
	const links = await exec.execute(sql`
		select role::text as role, enabled, token_sealed as "tokenSealed", token_prefix as "tokenPrefix",
		       last_used_at as "lastUsedAt", use_count as "useCount", expires_at as "expiresAt",
		       created_at as "createdAt"
		  from share_links where trip_id = ${tripId} and revoked_at is null
		 order by created_at desc, id desc
		 limit 1`);
	const guests = await exec.execute(sql`
		select g.user_id as "userId", u.name, g.color, max(l.role::text) as role,
		       not coalesce(u.is_anonymous, false) as "signedIn", max(g.last_seen_at) as "lastSeenAt"
		  from share_grants g
		  join share_links l on l.id = g.share_link_id and l.revoked_at is null
		  join "user" u on u.id = g.user_id
		 where g.trip_id = ${tripId}
		   and not exists (select 1 from trip_members m where m.trip_id = g.trip_id and m.user_id = g.user_id and m.status = 'active')
		 group by g.user_id, u.name, g.color, u.is_anonymous
		 order by max(g.last_seen_at) desc`);
	const link = links.rows[0] as NonNullable<SharingRows["link"]> | undefined;
	return {
		members: (members.rows as SharingRows["members"]).map((m) => ({
			...m,
			color: Number(m.color),
		})),
		link: link ? { ...link, useCount: Number(link.useCount) } : null,
		guests: (guests.rows as SharingRows["guests"]).map((g) => ({
			...g,
			color: Number(g.color),
		})),
	};
}
