/**
 * Link classification and embed URLs (SPEC §15.3; SECURITY §7 "embeds come
 * from a provider allowlist"). Isomorphic and pure: `addLink` classifies on
 * the server at once, the client builds iframe `src`s from the stored
 * provider + id only (never from a user URL or oEmbed HTML).
 */

export type SocialProvider = "youtube" | "tiktok" | "instagram";
export type InstagramType = "p" | "reel" | "tv";

export type LinkClass =
	| {
			kind: "embed";
			provider: "youtube";
			embedId: string;
			/** Shorts are 9:16, the rest 16:9. */
			short: boolean;
			aspect: number;
	  }
	| {
			kind: "embed";
			provider: "tiktok";
			/** Null for a `vm.`/`vt.` short link until the preview job resolves it. */
			embedId: string | null;
			aspect: number;
	  }
	| {
			kind: "embed";
			provider: "instagram";
			embedId: string;
			igType: InstagramType;
			/** The account in the path, when the URL carries one. */
			author: string | null;
			aspect: number;
	  }
	| { kind: "link"; provider: "web" };

const YT_HOSTS = new Set([
	"youtube.com",
	"www.youtube.com",
	"m.youtube.com",
	"music.youtube.com",
	"youtube-nocookie.com",
	"www.youtube-nocookie.com",
	"youtu.be",
	"www.youtu.be",
]);
const YT_ID = /^[\w-]{11}$/;
const TIKTOK_PATH = /^\/@[\w.-]+\/(?:video|photo)\/(\d{5,30})\/?$/;
const TIKTOK_EMBED_PATH = /^\/(?:embed\/v2|player\/v1)\/(\d{5,30})\/?$/;
const TIKTOK_SHORT_HOSTS = new Set(["vm.tiktok.com", "vt.tiktok.com"]);
const IG_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
const IG_PATH = /^\/(?:([\w.]{1,30})\/)?(p|reel|reels|tv)\/([\w-]{5,64})\/?$/;

function parse(raw: string): URL | null {
	try {
		const u = new URL(raw);
		return u.protocol === "http:" || u.protocol === "https:" ? u : null;
	} catch {
		return null;
	}
}

/** What a URL is: a YouTube/TikTok/Instagram embed, or a plain web link. */
export function classifyUrl(raw: string): LinkClass {
	const u = parse(raw);
	if (!u) return { kind: "link", provider: "web" };
	const host = u.hostname.toLowerCase();

	if (YT_HOSTS.has(host)) {
		let id: string | null = null;
		let short = false;
		if (host.endsWith("youtu.be")) id = u.pathname.split("/")[1] ?? null;
		else if (u.pathname === "/watch") id = u.searchParams.get("v");
		else {
			const m = /^\/(shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname);
			if (m) {
				id = m[2] ?? null;
				short = m[1] === "shorts";
			}
		}
		if (id && YT_ID.test(id))
			return {
				kind: "embed",
				provider: "youtube",
				embedId: id,
				short,
				aspect: short ? 9 / 16 : 16 / 9,
			};
		return { kind: "link", provider: "web" };
	}

	if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
		const m =
			TIKTOK_PATH.exec(u.pathname) ?? TIKTOK_EMBED_PATH.exec(u.pathname);
		if (m?.[1])
			return {
				kind: "embed",
				provider: "tiktok",
				embedId: m[1],
				aspect: 9 / 16,
			};
		if (TIKTOK_SHORT_HOSTS.has(host) || /^\/t\/\w+/.test(u.pathname))
			return {
				kind: "embed",
				provider: "tiktok",
				embedId: null,
				aspect: 9 / 16,
			};
		return { kind: "link", provider: "web" };
	}

	if (IG_HOSTS.has(host)) {
		const m = IG_PATH.exec(u.pathname);
		if (m?.[2] && m[3]) {
			const t = m[2] === "reels" ? "reel" : (m[2] as InstagramType);
			return {
				kind: "embed",
				provider: "instagram",
				embedId: m[3],
				igType: t,
				author: m[1] ?? null,
				aspect: t === "p" ? 4 / 5 : 9 / 16,
			};
		}
		return { kind: "link", provider: "web" };
	}

	return { kind: "link", provider: "web" };
}

/** The canonical link the card opens (tracking params such as `igsh` dropped for Instagram). */
export function canonicalLink(
	provider: string | null,
	embedId: string | null,
	url: string | null,
	igType?: string | null,
): string | null {
	if (provider === "youtube" && embedId)
		return `https://www.youtube.com/watch?v=${encodeURIComponent(embedId)}`;
	if (provider === "instagram" && embedId)
		return `https://www.instagram.com/${igType === "p" || igType === "tv" ? igType : "reel"}/${encodeURIComponent(embedId)}/`;
	return url;
}

/**
 * The iframe `src` for a stored embed, built only from an allowlisted
 * provider and a strictly matched id (SECURITY §7). Null when unknown.
 */
export function embedSrc(
	provider: string | null,
	embedId: string | null,
	opts: { igType?: string | null; autoplay?: boolean } = {},
): string | null {
	if (!embedId) return null;
	if (provider === "youtube" && YT_ID.test(embedId))
		return `https://www.youtube-nocookie.com/embed/${embedId}?playsinline=1&rel=0${opts.autoplay ? "&autoplay=1" : ""}`;
	if (provider === "tiktok" && /^\d{5,30}$/.test(embedId))
		return `https://www.tiktok.com/player/v1/${embedId}?rel=0&description=1&music_info=1${opts.autoplay ? "&autoplay=1" : ""}`;
	if (provider === "instagram" && /^[\w-]{5,64}$/.test(embedId)) {
		const t =
			opts.igType === "p" || opts.igType === "tv" ? opts.igType : "reel";
		return `https://www.instagram.com/${t}/${embedId}/embed/captioned/`;
	}
	return null;
}

/** "YouTube", "TikTok", "Instagram". */
export function providerLabel(provider: string | null): string {
	switch (provider) {
		case "youtube":
			return "YouTube";
		case "tiktok":
			return "TikTok";
		case "instagram":
			return "Instagram";
		default:
			return "Link";
	}
}

/** `www.japan-guide.com` → `japan-guide.com` (card meta line). */
export function displayHost(url: string | null): string {
	const u = url ? parse(url) : null;
	return u ? u.hostname.replace(/^www\./, "") : "";
}
