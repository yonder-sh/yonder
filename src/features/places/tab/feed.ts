/**
 * The Rate feed's order and session (docs/PLACES.md §1b). Pure.
 *
 * **Order** (owner, 2026-09-24): shuffled in short city runs — 3–5 places
 * from one city, then another city — each run shuffled so likes and dislikes
 * mix, while nearby places stay comparable. The shuffle is stable per person
 * (seeded by their member id): every place gets its own hashed random key,
 * so the same set gives the same order and a place added later doesn't
 * reshuffle the rest of a city. Places with media are slightly favoured.
 * Orders: Mixed (default) · By city · Random.
 *
 * **Session**: everything you rated or skipped since opening the feed stays
 * above you; skipped places come back at the end ("You skipped 3"); a
 * milestone card drops in every 10 ratings; the end is "You're all caught up".
 */
import type { Priority } from "@/lib/schemas/enums";

export const FEED_ORDERS = ["mixed", "city", "random"] as const;
export type FeedOrder = (typeof FEED_ORDERS)[number];

export const FEED_ORDER_LABEL: Record<FeedOrder, string> = {
	mixed: "Mixed",
	city: "By city",
	random: "Random",
};

/** A milestone card every this many ratings. */
export const MILESTONE_EVERY = 10;

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/** FNV-1a, 32 bit. */
export function hashSeed(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** A small seeded PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A stable uniform number in (0, 1) for `seed` + `id`. */
function unit(seed: string, id: string): number {
	return (hashSeed(`${seed}:${id}`) + 0.5) / 4294967296;
}

/**
 * The weighted random key (Efraimidis–Spirakis `u^(1/w)`, larger first):
 * media-rich places slightly favoured (weight up to 1.5).
 */
function key(seed: string, p: FeedPlace): number {
	const w = 1 + 0.25 * Math.min(Math.max(p.media, 0), 2);
	return unit(seed, p.id) ** (1 / w);
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

export type FeedPlace = {
	id: string;
	/** The run key: the place's city (or the nearest level above). */
	city: string;
	/** Photos, videos and embeds. */
	media: number;
	/** Outline position (By city orders cities by it). */
	outline: number;
};

export type FeedEntry = {
	id: string;
	city: string;
	/** 0-based run number, the position in it and its length ("2 of 4"). */
	run: number;
	pos: number;
	len: number;
};

export function feedOrder(
	places: readonly FeedPlace[],
	opts: { seed: string; order?: FeedOrder; runMin?: number; runMax?: number },
): FeedEntry[] {
	const seed = opts.seed;
	const order = opts.order ?? "mixed";
	const runMin = opts.runMin ?? 3;
	const runMax = Math.max(runMin, opts.runMax ?? 5);
	const byKey = (a: FeedPlace, b: FeedPlace) =>
		key(seed, b) - key(seed, a) || a.id.localeCompare(b.id);

	if (order === "random") {
		const all = [...places].sort(byKey);
		return all.map((p, i) => ({
			id: p.id,
			city: p.city,
			run: i,
			pos: 0,
			len: 1,
		}));
	}

	const cities = new Map<string, FeedPlace[]>();
	for (const p of places) {
		const list = cities.get(p.city);
		if (list) list.push(p);
		else cities.set(p.city, [p]);
	}
	for (const list of cities.values()) list.sort(byKey);

	const out: FeedEntry[] = [];
	const push = (city: string, xs: FeedPlace[], run: number) => {
		for (const [pos, p] of xs.entries())
			out.push({ id: p.id, city, run, pos, len: xs.length });
	};

	if (order === "city") {
		const names = [...cities.keys()].sort(
			(a, b) =>
				Math.min(...(cities.get(a) ?? []).map((p) => p.outline)) -
				Math.min(...(cities.get(b) ?? []).map((p) => p.outline)),
		);
		for (const [run, c] of names.entries()) push(c, cities.get(c) ?? [], run);
		return out;
	}

	// Mixed: short runs, a different city each time while others remain.
	const rand = mulberry32(hashSeed(`${seed}:runs`));
	const names = [...cities.keys()].sort(
		(a, b) => hashSeed(`${seed}:${a}`) - hashSeed(`${seed}:${b}`),
	);
	const left = new Map(names.map((c) => [c, [...(cities.get(c) ?? [])]]));
	let last: string | null = null;
	for (let run = 0; ; run++) {
		const open = names.filter((c) => (left.get(c)?.length ?? 0) > 0);
		if (!open.length) break;
		const pickFrom = open.length > 1 ? open.filter((c) => c !== last) : open;
		const city = pickFrom[Math.floor(rand() * pickFrom.length)] as string;
		const rest = left.get(city) ?? [];
		let n = runMin + Math.floor(rand() * (runMax - runMin + 1));
		// Never leave a stub shorter than a run behind (a city with fewer
		// places than that is one short run).
		const leftover = rest.length - n;
		if (leftover > 0 && leftover < runMin)
			n =
				rest.length <= runMax
					? rest.length
					: Math.max(runMin, rest.length - runMin);
		push(city, rest.splice(0, n), run);
		last = city;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type FeedSession = {
	/** The pile when the feed opened (unrated by me), then places added since. */
	pile: string[];
	/** First ratings this session, in order (a change doesn't count again). */
	rated: string[];
	/** Milestone n (1, 2, …) → the card key it drops in after. */
	milestones: { n: number; after: string }[];
	/** Frozen when the end of the pile is reached: the skipped places, round 2. */
	skipped: string[] | null;
};

export type FeedItem =
	| { kind: "place"; key: string; id: string; round: 1 | 2 }
	| { kind: "milestone"; key: string; n: number }
	| { kind: "skipped"; key: string; count: number }
	| { kind: "end"; key: string };

export function startSession(pile: readonly string[]): FeedSession {
	return { pile: [...pile], rated: [], milestones: [], skipped: null };
}

/** New places (added by someone while the feed is open) join the pile's end. */
export function joinPile(s: FeedSession, ids: readonly string[]): FeedSession {
	const have = new Set(s.pile);
	const fresh = ids.filter((id) => !have.has(id));
	return fresh.length ? { ...s, pile: [...s.pile, ...fresh] } : s;
}

/** A rating on the card `cardKey`: every MILESTONE_EVERY first ratings, a milestone after it. */
export function recordRating(
	s: FeedSession,
	id: string,
	cardKey: string,
): FeedSession {
	if (s.rated.includes(id)) return s;
	const rated = [...s.rated, id];
	const milestones =
		rated.length % MILESTONE_EVERY === 0
			? [...s.milestones, { n: rated.length / MILESTONE_EVERY, after: cardKey }]
			: s.milestones;
	return { ...s, rated, milestones };
}

/**
 * The end of the pile was reached: the places passed without a rating come
 * back once, after a "You skipped N" card. Only the first time.
 */
export function reachEnd(
	s: FeedSession,
	isRated: (id: string) => boolean,
): FeedSession {
	if (s.skipped !== null) return s;
	return { ...s, skipped: s.pile.filter((id) => !isRated(id)) };
}

/** The cards, top to bottom. */
export function feedItems(s: FeedSession): FeedItem[] {
	const out: FeedItem[] = [];
	const after = new Map(s.milestones.map((m) => [m.after, m]));
	const add = (item: FeedItem) => {
		out.push(item);
		const m = after.get(item.key);
		if (m) out.push({ kind: "milestone", key: `m${m.n}`, n: m.n });
	};
	for (const id of s.pile) add({ kind: "place", key: id, id, round: 1 });
	if (s.skipped?.length) {
		out.push({ kind: "skipped", key: "skipped", count: s.skipped.length });
		for (const id of s.skipped)
			add({ kind: "place", key: `${id}#2`, id, round: 2 });
	}
	out.push({ kind: "end", key: "end" });
	return out;
}

/** Places still waiting for my rating ("N left"). */
export function leftCount(
	s: FeedSession,
	isRated: (id: string) => boolean,
): number {
	return s.pile.filter((id) => !isRated(id)).length;
}

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

/** A match: the same rating, or both keen (Must / Really want). */
export function isMatch(a: Priority, b: Priority): boolean {
	const keen = (p: Priority) => p === "must" || p === "really_want";
	return a === b || (keen(a) && keen(b));
}

/** The members whose rating matches mine on this place. */
export function matchesOf(
	ratings: Readonly<Record<string, Priority>>,
	me: string,
	others: readonly string[],
): string[] {
	const mine = ratings[me];
	if (!mine) return [];
	return others.filter((m) => {
		const theirs = ratings[m];
		return m !== me && !!theirs && isMatch(mine, theirs);
	});
}
