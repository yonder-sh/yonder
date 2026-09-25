/**
 * E6 digest lines (EXTENSIONS §9), WP-Shell. Pure: `buildDigest(rows, ix, {
 * meUserId })` → lines grouped by actor for the activity view that the
 * one-line banner ("12 changes since you last looked") links to.
 *
 * Collapsing rules:
 * - the same verb family in one city is one line: "added 3 places in Kyoto:
 *   Fushimi Inari, Nishiki Market +1" (places, stops, photos, to-dos);
 * - of several moves of one thing, only the newest is kept;
 * - created-then-deleted (both in the digest) is dropped;
 * - suggestions → "suggested 4 changes"; to-dos → "added 5 to-dos";
 *   media → "added 6 photos to Tokyo";
 * - at most 6 lines per actor, then "+8 more";
 * - names are the current ones when the entity is live, else the summary's;
 * - my own rows never appear.
 *
 * `rows` come newest first (as `getDigest` returns them); lines keep that order.
 */
import type { DigestRow } from "@/functions/activity.functions";
import type { GraphIndex } from "./graph-index";

export type DigestLine = {
	actorUserId: string | null;
	actorName: string;
	text: string;
	/** Entities the line refers to (select + flash). */
	refs: { kind: "node" | "item" | "leg" | "day"; id: string }[];
};

export type DigestGroup = {
	actorUserId: string | null;
	actorName: string;
	lines: DigestLine[];
	more: number;
};

/** Lines per actor before "+N more". */
export const DIGEST_LINES_PER_ACTOR = 6;
/** Names listed in a collapsed line before "+N". */
const NAMES_SHOWN = 2;

type Ref = DigestLine["refs"][number];

/** A collapsible family: rows with the same key become one line. */
type Family = {
	key: string;
	rows: DigestRow[];
	/** The newest row (lines sort by it). */
	first: number;
};

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/** The nearest city (else region, else country) of a node, for "in Kyoto". */
function placeOf(ix: GraphIndex, nodeId: string | null): string | null {
	if (!nodeId || !ix.node(nodeId)) return null;
	const path = ix.path(nodeId);
	for (const type of ["city", "region", "country"] as const) {
		for (let i = path.length - 1; i >= 0; i--) {
			const n = path[i];
			if (n?.type === type && n.id !== nodeId) return n.name;
		}
	}
	return null;
}

function nodeOfRow(ix: GraphIndex, r: DigestRow): string | null {
	if (r.nodeId) return r.nodeId;
	if (r.itemId) return ix.item(r.itemId)?.nodeId ?? null;
	return null;
}

function refsOf(r: DigestRow): Ref[] {
	const out: Ref[] = [];
	if (r.nodeId) out.push({ kind: "node", id: r.nodeId });
	if (r.itemId) out.push({ kind: "item", id: r.itemId });
	if (r.legId) out.push({ kind: "leg", id: r.legId });
	if (r.dayId) out.push({ kind: "day", id: r.dayId });
	return out;
}

/** The current name of a row's entity, else what the summary said. */
function nameOf(ix: GraphIndex, r: DigestRow): string {
	if (r.itemId) {
		const it = ix.item(r.itemId);
		if (it) return it.title ?? ix.node(it.nodeId)?.name ?? "a stop";
	}
	if (r.nodeId) {
		const n = ix.node(r.nodeId);
		if (n) return n.name;
	}
	if (r.meta?.name) return r.meta.name;
	return r.summary.replace(/^(added|deleted|moved|scheduled)\s+/i, "");
}

/** Which family a row collapses into (null = its own line). */
function familyKey(ix: GraphIndex, r: DigestRow): string | null {
	const where = placeOf(ix, nodeOfRow(ix, r)) ?? "";
	switch (r.verb) {
		case "node.create":
			return `places|${where}`;
		case "item.create":
		case "item.schedule":
			return `stops|${where}`;
		case "media.add":
			return `media|${where}`;
		case "list.create":
			return "todos";
		case "list.done":
			return "done";
		case "proposal.create":
			return "proposals";
		default:
			return null;
	}
}

function familyText(ix: GraphIndex, f: Family): string {
	const [kind, where = ""] = f.key.split("|");
	const n = f.rows.length;
	const names = () => {
		const seen: string[] = [];
		for (const r of f.rows) {
			const name = nameOf(ix, r);
			if (!seen.includes(name)) seen.push(name);
		}
		const shown = seen.slice(0, NAMES_SHOWN).join(", ");
		return seen.length > NAMES_SHOWN
			? `${shown} +${seen.length - NAMES_SHOWN}`
			: shown;
	};
	const inWhere = where ? ` in ${where}` : "";
	switch (kind) {
		case "places":
			return n === 1
				? (f.rows[0]?.summary ?? "added a place")
				: `added ${plural(n, "place")}${inWhere}: ${names()}`;
		case "stops":
			return n === 1
				? (f.rows[0]?.summary ?? "added a stop")
				: `added ${plural(n, "stop")}${inWhere}: ${names()}`;
		case "media": {
			const count = f.rows.reduce((s, r) => s + (r.meta?.count ?? 1), 0);
			return `added ${plural(count, "photo or link", "photos and links")}${where ? ` to ${where}` : ""}`;
		}
		case "todos":
			return `added ${plural(n, "to-do")}`;
		case "done":
			return `checked off ${plural(n, "to-do")}`;
		case "proposals":
			return `suggested ${plural(n, "change")}`;
		default:
			return f.rows[0]?.summary ?? "";
	}
}

/** The entity a move / create / delete row is about (for the dedupe rules). */
function entityKey(r: DigestRow): string | null {
	if (r.verb.startsWith("item.") && r.itemId) return `item:${r.itemId}`;
	if (r.verb.startsWith("node.") && r.nodeId) return `node:${r.nodeId}`;
	return null;
}

const isCreate = (v: string) => v === "node.create" || v === "item.create";
const isDelete = (v: string) => v === "node.delete" || v === "item.delete";
const isMove = (v: string) =>
	v === "node.move" || v === "item.move" || v === "day.move";

/** Drops created-then-deleted pairs and all but the newest move of each entity. */
function prune(rows: readonly DigestRow[]): DigestRow[] {
	const created = new Set<string>();
	const deleted = new Set<string>();
	for (const r of rows) {
		const k = entityKey(r);
		if (!k) continue;
		if (isCreate(r.verb)) created.add(k);
		if (isDelete(r.verb)) deleted.add(k);
	}
	const gone = new Set([...created].filter((k) => deleted.has(k)));
	const moved = new Set<string>();
	const out: DigestRow[] = [];
	// Newest first: the first move of an entity seen is the newest one.
	for (const r of rows) {
		const k =
			entityKey(r) ??
			(r.verb === "day.move" && r.dayId ? `day:${r.dayId}` : null);
		if (k && gone.has(k)) continue;
		if (k && isMove(r.verb)) {
			if (moved.has(k)) continue;
			moved.add(k);
		}
		out.push(r);
	}
	return out;
}

export function buildDigest(
	rows: readonly DigestRow[],
	ix: GraphIndex,
	opts: { meUserId: string },
): DigestGroup[] {
	const byActor = new Map<
		string,
		{ actorUserId: string | null; actorName: string; rows: DigestRow[] }
	>();
	for (const r of rows) {
		if (r.actorUserId !== null && r.actorUserId === opts.meUserId) continue;
		const key = r.actorUserId ?? `name:${r.actorName}`;
		let a = byActor.get(key);
		if (!a) {
			a = { actorUserId: r.actorUserId, actorName: r.actorName, rows: [] };
			byActor.set(key, a);
		}
		a.rows.push(r);
	}
	const groups: DigestGroup[] = [];
	for (const a of byActor.values()) {
		const kept = prune(a.rows);
		// Build lines in newest-first order: families collapse onto their newest row.
		const slots: ({ family: Family } | { row: DigestRow; at: number })[] = [];
		const families = new Map<string, Family>();
		kept.forEach((r, i) => {
			const fk = familyKey(ix, r);
			if (!fk) {
				slots.push({ row: r, at: i });
				return;
			}
			let f = families.get(fk);
			if (!f) {
				f = { key: fk, rows: [], first: i };
				families.set(fk, f);
				slots.push({ family: f });
			}
			f.rows.push(r);
		});
		const lines: DigestLine[] = slots.map((s) =>
			"family" in s
				? {
						actorUserId: a.actorUserId,
						actorName: a.actorName,
						text: familyText(ix, s.family),
						refs: s.family.rows.flatMap(refsOf),
					}
				: {
						actorUserId: a.actorUserId,
						actorName: a.actorName,
						text: s.row.summary,
						refs: refsOf(s.row),
					},
		);
		if (!lines.length) continue;
		groups.push({
			actorUserId: a.actorUserId,
			actorName: a.actorName,
			lines: lines.slice(0, DIGEST_LINES_PER_ACTOR),
			more: Math.max(0, lines.length - DIGEST_LINES_PER_ACTOR),
		});
	}
	return groups;
}

/** "12 changes since you last looked" (the banner's count: rows by others). */
export function digestCount(
	rows: readonly DigestRow[],
	opts: { meUserId: string },
): number {
	return rows.filter(
		(r) => r.actorUserId === null || r.actorUserId !== opts.meUserId,
	).length;
}
