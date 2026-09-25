/**
 * E8 (EXTENSIONS §10): what was shared, and a clean default name for a new
 * idea. Pure (unit-tested). `resolveSharedLink` (WP-Places) resolves Maps
 * links on the server when available; `parseMapsUrl` here covers the forms
 * that carry coordinates or a name themselves, so a one-tap save works
 * offline of any provider.
 */

export type ShareKind = "maps" | "social" | "web" | "media" | "text";

const MAPS_HOSTS =
	/(^|\.)(maps\.google\.[a-z.]+|google\.[a-z.]+|goo\.gl|maps\.app\.goo\.gl)$/i;
const SOCIAL_HOSTS =
	/(^|\.)(tiktok\.com|instagram\.com|youtube\.com|youtu\.be|vm\.tiktok\.com)$/i;

export function isMapsUrl(u: URL): boolean {
	if (!MAPS_HOSTS.test(u.hostname)) return false;
	if (/^(maps\.app\.goo\.gl|goo\.gl)$/i.test(u.hostname))
		return u.hostname !== "goo.gl" || u.pathname.startsWith("/maps");
	return u.hostname.startsWith("maps.") || u.pathname.startsWith("/maps");
}

export function classifyShare(entry: {
	url: string | null;
	text: string | null;
	files: unknown[];
}): ShareKind {
	if (entry.files.length) return "media";
	const url = entry.url ?? firstUrl(entry.text);
	if (url) {
		try {
			const u = new URL(url);
			if (isMapsUrl(u)) return "maps";
			if (SOCIAL_HOSTS.test(u.hostname)) return "social";
			return "web";
		} catch {
			// fall through
		}
	}
	return "text";
}

const URL_RE = /https?:\/\/[^\s<>"']+/i;

export function firstUrl(text: string | null | undefined): string | null {
	const m = text?.match(URL_RE);
	return m ? m[0].replace(/[).,;!?]+$/, "") : null;
}

/**
 * A new idea's name: the title (or text) without URLs, hashtags, @handles and
 * emoji, whitespace collapsed, at most 60 characters (cut at a word).
 */
export function cleanShareName(
	title: string | null | undefined,
	text: string | null | undefined,
): string {
	const pick = (s: string | null | undefined) =>
		(s ?? "")
			.replace(/https?:\/\/\S+/gi, " ")
			.replace(/(^|\s)[#＃][\p{L}\p{N}_]+/gu, " ")
			.replace(/(^|\s)@[\w.]+/g, " ")
			.replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️/gu, "")
			.replace(/\s*[|·•–—-]\s*(TikTok|Instagram|YouTube|Google Maps)\s*$/i, "")
			.replace(/\s+/g, " ")
			.trim();
	let name = pick(title) || pick(text);
	if (name.length > 60) {
		const cut = name.slice(0, 60);
		const space = cut.lastIndexOf(" ");
		name = (space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "");
	}
	return name;
}

export type MapsHint = {
	name: string | null;
	lat: number | null;
	lng: number | null;
};

const inRange = (lat: number, lng: number) =>
	Number.isFinite(lat) &&
	Number.isFinite(lng) &&
	Math.abs(lat) <= 90 &&
	Math.abs(lng) <= 180;

/** Name and coordinates straight from a Maps URL (`/place/<name>/@lat,lng`, `!3d!4d`, `?q=`). */
export function parseMapsUrl(raw: string): MapsHint {
	const out: MapsHint = { name: null, lat: null, lng: null };
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return out;
	}
	const place = u.pathname.match(/\/place\/([^/]+)/);
	if (place?.[1])
		out.name = decodeURIComponent(place[1].replace(/\+/g, " ")).trim() || null;
	const d = raw.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
	const at = u.pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
	const q = u.searchParams.get("q") ?? u.searchParams.get("query");
	const qll = q?.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
	const pair = d ?? at ?? qll;
	if (pair?.[1] && pair[2]) {
		const lat = Number(pair[1]);
		const lng = Number(pair[2]);
		if (inRange(lat, lng)) {
			out.lat = lat;
			out.lng = lng;
		}
	}
	if (!out.name && q && !qll) out.name = q.trim().slice(0, 200) || null;
	return out;
}

/** Great-circle metres between two points. */
export function metres(
	a: { lat: number; lng: number },
	b: { lat: number; lng: number },
): number {
	const R = 6_371_000;
	const r = Math.PI / 180;
	const dLat = (b.lat - a.lat) * r;
	const dLng = (b.lng - a.lng) * r;
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
}

export const normName = (s: string) =>
	s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

// ---------------------------------------------------------------------------
// WP-Places' `resolveSharedLink` answer, read defensively (it is another
// package's DTO: anything unexpected falls back to `parseMapsUrl`).
// ---------------------------------------------------------------------------

const PARENT_TYPES = ["country", "region", "city", "area"] as const;
type ParentType = (typeof PARENT_TYPES)[number];

export type SharedPreview = {
	name: string;
	lat: number;
	lng: number;
	localName?: string;
	address?: string;
	countryCode?: string;
	category?: string;
	googlePlaceId?: string;
	osmRef?: string;
	/** Where it files: the existing chain (root first) and ancestors to create. */
	filing: { existing: string[]; create: { type: ParentType; name: string }[] };
};

export type SharedResolution = {
	preview: SharedPreview | null;
	existing: { nodeId: string; name: string; where: string | null } | null;
	/** What the link named when it couldn't be found (the search prefill). */
	query: string | null;
};

const str = (v: unknown, max = 300): string | undefined =>
	typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

export function readResolution(raw: unknown): SharedResolution | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	let preview: SharedPreview | null = null;
	const p = r.preview as Record<string, unknown> | null | undefined;
	if (p && typeof p === "object") {
		const name = str(p.name, 200);
		const lat = Number(p.lat);
		const lng = Number(p.lng);
		if (name && inRange(lat, lng)) {
			const f = (p.filing ?? {}) as Record<string, unknown>;
			const existing = Array.isArray(f.existing)
				? f.existing.filter((x): x is string => typeof x === "string")
				: [];
			const create = Array.isArray(f.create)
				? f.create.flatMap((c) => {
						const t = (c as { type?: unknown })?.type;
						const n = str((c as { name?: unknown })?.name, 200);
						return PARENT_TYPES.includes(t as ParentType) && n
							? [{ type: t as ParentType, name: n }]
							: [];
					})
				: [];
			const cc = str(p.countryCode, 2)?.toUpperCase();
			preview = {
				name,
				lat,
				lng,
				filing: { existing, create },
				...(str(p.localName, 200) ? { localName: str(p.localName, 200) } : {}),
				...(str(p.address, 500) ? { address: str(p.address, 500) } : {}),
				...(cc && /^[A-Z]{2}$/.test(cc) ? { countryCode: cc } : {}),
				...(str(p.category, 40) ? { category: str(p.category, 40) } : {}),
				...(p.provider === "google" && str(p.ref)
					? { googlePlaceId: str(p.ref) }
					: {}),
				...(str(p.osmRef, 40) ? { osmRef: str(p.osmRef, 40) } : {}),
			};
		}
	}
	const e = r.existing as Record<string, unknown> | undefined;
	const nodeId = str(e?.nodeId, 64);
	const crumb = str(e?.crumb, 500);
	return {
		preview,
		existing:
			nodeId && str(e?.name)
				? {
						nodeId,
						name: str(e?.name) as string,
						where: crumb ? (crumb.split(" › ").pop() ?? null) : null,
					}
				: null,
		query: str(r.query, 200) ?? null,
	};
}

type TreeNode = {
	id: string;
	parentId: string | null;
	type: string;
	name: string;
	lat: number | null;
	lng: number | null;
};

/** Where a new idea goes: an existing parent (null = top level) plus ancestors to create. */
export type ParentPlan = {
	parentId: string | null;
	create: { type: ParentType; name: string }[];
};

/** The nearest city within 40 km (the default parent of a located idea). */
export function nearestCity<N extends TreeNode>(
	nodes: readonly N[],
	at: { lat: number; lng: number },
): N | null {
	let best: N | null = null;
	let bestM = 40_000;
	for (const n of nodes)
		if (n.type === "city" && n.lat != null && n.lng != null) {
			const m = metres(at, { lat: n.lat, lng: n.lng });
			if (m < bestM) {
				bestM = m;
				best = n;
			}
		}
	return best;
}

/**
 * EXTENSIONS §10 "New idea (parent: the resolved place's filing suggestion,
 * else the trip root)": the filing's deepest existing node plus the ancestors
 * it would create; without one, the nearest city of the link's coordinates;
 * else the top level.
 */
export function autoParent(
	nodes: readonly TreeNode[],
	at: { lat: number; lng: number } | null,
	filing: SharedPreview["filing"] | null,
): ParentPlan {
	const ids = new Set(nodes.map((n) => n.id));
	if (filing && (filing.existing.length || filing.create.length)) {
		const deepest = filing.existing.at(-1) ?? null;
		if (deepest === null || ids.has(deepest))
			return { parentId: deepest, create: filing.create };
	}
	if (at) {
		const city = nearestCity(nodes, at);
		if (city) return { parentId: city.id, create: [] };
	}
	return { parentId: null, create: [] };
}

/** "Japan › Kyoto" (+ " › Arashiyama (new)") for the parent chip. */
export function parentLabel(
	nodes: readonly TreeNode[],
	plan: ParentPlan,
	rootName: string,
): string {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const names: string[] = [];
	let cur = plan.parentId ? byId.get(plan.parentId) : undefined;
	for (let guard = 0; cur && guard < 16; guard++) {
		names.unshift(cur.name);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	const tail = names.slice(-2);
	for (const c of plan.create) tail.push(`${c.name} (new)`);
	return tail.length ? tail.join(" › ") : rootName;
}
