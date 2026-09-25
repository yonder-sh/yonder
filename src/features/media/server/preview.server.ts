/**
 * Link previews (SPEC §15.3): oEmbed for YouTube and TikTok, OpenGraph for
 * the web, nothing for Instagram (its oEmbed needs a Meta token; the card is
 * branded). Every request — pages, oEmbed JSON, images, favicons — goes
 * through the SSRF-safe fetch, and every image is re-hosted by the caller:
 * the page never loads a remote image URL. Metadata is cached 24 h per URL.
 */
import { createHash } from "node:crypto";
import { cacheGet, cacheSet } from "@/server/cache.server";
import { classifyUrl } from "../embeds";
import { decodeEntities } from "./entities";
import { type SafeFetcher, safeFetch } from "./safe-fetch.server";

export type LinkMeta = {
	title: string | null;
	description: string | null;
	siteName: string | null;
	author: string | null;
	/** TikTok short links resolve to an id here. */
	embedId: string | null;
	/** Absolute URL of the preview image to re-host, if any. */
	imageUrl: string | null;
	/** Absolute URL of the favicon to re-host, if any. */
	faviconUrl: string | null;
	/** Where the page ended up after redirects (web links). */
	finalUrl: string | null;
	ok: boolean;
};

const EMPTY: LinkMeta = {
	title: null,
	description: null,
	siteName: null,
	author: null,
	embedId: null,
	imageUrl: null,
	faviconUrl: null,
	finalUrl: null,
	ok: false,
};

/**
 * Plain, clamped text: character references decoded once (VIS-16), no
 * control characters, collapsed whitespace.
 */
export function cleanText(v: unknown, max: number): string | null {
	if (typeof v !== "string") return null;
	const s = decodeEntities(v)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
		.replace(/[\u0000-\u001f\u007f-\u009f\ufffd]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!s) return null;
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function absolute(u: unknown, base: string): string | null {
	if (typeof u !== "string" || !u.trim()) return null;
	try {
		const r = new URL(u.trim(), base);
		return r.protocol === "http:" || r.protocol === "https:" ? r.href : null;
	} catch {
		return null;
	}
}

async function fetchJson(
	fetcher: SafeFetcher,
	url: string,
): Promise<Record<string, unknown>> {
	const r = await fetcher(url, {
		accept: "application/json",
		maxBytes: 256 * 1024,
	});
	if (r.status !== 200) throw new Error(`upstream ${r.status}`);
	const v = JSON.parse(r.body.toString("utf8")) as unknown;
	if (!v || typeof v !== "object") throw new Error("not json");
	return v as Record<string, unknown>;
}

const TIKTOK_HOSTS = [
	"vm.tiktok.com",
	"vt.tiktok.com",
	"www.tiktok.com",
	"tiktok.com",
	"m.tiktok.com",
];

async function youtube(
	fetcher: SafeFetcher,
	id: string,
	url: string,
): Promise<LinkMeta> {
	const meta: LinkMeta = {
		...EMPTY,
		siteName: "YouTube",
		embedId: id,
		imageUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
		ok: true,
	};
	try {
		const o = await fetchJson(
			fetcher,
			`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
		);
		meta.title = cleanText(o.title, 300);
		meta.author = cleanText(o.author_name, 120);
		meta.imageUrl = absolute(o.thumbnail_url, url) ?? meta.imageUrl;
	} catch {
		// The id is known; the card still works with the thumbnail.
	}
	return meta;
}

async function tiktok(
	fetcher: SafeFetcher,
	embedId: string | null,
	url: string,
): Promise<LinkMeta> {
	let canonical = url;
	let id = embedId;
	if (!id) {
		// vm./vt. short links: follow the redirects on TikTok hosts only.
		const r = await fetcher(url, {
			allowHosts: TIKTOK_HOSTS,
			accept: "text/html",
			maxBytes: 512 * 1024,
		});
		canonical = r.finalUrl;
		const c = classifyUrl(canonical);
		id = c.kind === "embed" && c.provider === "tiktok" ? c.embedId : null;
	}
	const meta: LinkMeta = {
		...EMPTY,
		siteName: "TikTok",
		embedId: id,
		ok: !!id,
	};
	try {
		const o = await fetchJson(
			fetcher,
			`https://www.tiktok.com/oembed?url=${encodeURIComponent(canonical)}`,
		);
		meta.title = cleanText(o.title, 300);
		meta.author = cleanText(o.author_name, 120);
		meta.imageUrl = absolute(o.thumbnail_url, canonical);
		const pid =
			typeof o.embed_product_id === "string" ? o.embed_product_id : null;
		if (!meta.embedId && pid && /^\d{5,30}$/.test(pid)) meta.embedId = pid;
		meta.ok = !!meta.embedId;
	} catch {
		// oEmbed sometimes answers a bot wall; a long URL still has its id.
	}
	return meta;
}

async function web(fetcher: SafeFetcher, url: string): Promise<LinkMeta> {
	const r = await fetcher(url, {
		accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
		maxBytes: 1024 * 1024,
	});
	const host = new URL(r.finalUrl).hostname.replace(/^www\./, "");
	if (r.status >= 400) throw new Error(`upstream ${r.status}`);
	if (r.contentType.includes("application/pdf")) {
		const name = decodeURIComponent(
			new URL(r.finalUrl).pathname.split("/").pop() ?? "",
		);
		return {
			...EMPTY,
			title: cleanText(name, 300),
			siteName: host,
			finalUrl: r.finalUrl,
			faviconUrl: new URL("/favicon.ico", r.finalUrl).href,
			ok: true,
		};
	}
	if (!/text\/html|application\/xhtml/.test(r.contentType))
		throw new Error("not html");
	const { default: ogs } = await import("open-graph-scraper");
	// ogs refuses `{ html, url }` together: pass the HTML only, so it never opens a socket.
	const out = await ogs({ html: r.body.toString("utf8") }).catch(() => null);
	const res = (out && !out.error ? out.result : {}) as Record<
		string,
		unknown
	> & {
		ogImage?: { url?: string }[];
		twitterImage?: { url?: string }[];
	};
	const image = res.ogImage?.[0]?.url ?? res.twitterImage?.[0]?.url;
	return {
		...EMPTY,
		title: cleanText(res.ogTitle ?? res.twitterTitle ?? res.dcTitle, 300),
		description: cleanText(
			res.ogDescription ?? res.twitterDescription ?? res.dcDescription,
			600,
		),
		siteName: cleanText(res.ogSiteName, 120) ?? host,
		author: cleanText(res.author, 120),
		imageUrl: absolute(image, r.finalUrl),
		faviconUrl:
			absolute(res.favicon, r.finalUrl) ??
			new URL("/favicon.ico", r.finalUrl).href,
		finalUrl: r.finalUrl,
		ok: true,
	};
}

export function urlCacheKey(url: string): string {
	return createHash("sha1").update(url).digest("hex");
}

/**
 * The preview metadata for a URL (cached 24 h). Never throws: a failed fetch
 * answers `ok: false` (the card shows its domain only). Errors are never
 * echoed to the client (SECURITY §6).
 */
export async function linkMeta(
	url: string,
	fetcher: SafeFetcher = safeFetch,
	opts: { cache?: boolean } = {},
): Promise<LinkMeta> {
	const cacheKey = urlCacheKey(url);
	if (opts.cache !== false) {
		const hit = await cacheGet<LinkMeta>("link", cacheKey);
		if (hit) return hit;
	}
	const c = classifyUrl(url);
	let meta: LinkMeta;
	try {
		if (c.kind === "embed" && c.provider === "youtube")
			meta = await youtube(fetcher, c.embedId, url);
		else if (c.kind === "embed" && c.provider === "tiktok")
			meta = await tiktok(fetcher, c.embedId, url);
		else if (c.kind === "embed" && c.provider === "instagram")
			meta = {
				...EMPTY,
				siteName: "Instagram",
				author: c.author,
				embedId: c.embedId,
				ok: true,
			};
		else meta = await web(fetcher, url);
	} catch {
		meta = { ...EMPTY, ok: false };
	}
	if (opts.cache !== false)
		await cacheSet(["link", cacheKey], meta, meta.ok ? 24 * 3600 : 3600);
	return meta;
}
