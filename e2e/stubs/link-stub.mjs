// The internet as the server's link fetches see it in e2e, served by
// services-stub.mjs at GET /__link?u=<url>: the app's SSRF-safe fetch and the
// Maps short-link expander send every request here instead of to its host
// (E2E_OUTBOUND_STUB, src/server/outbound-stub.server.ts), and this answers as
// that host would, from e2e/stubs/fixtures/links.json:
//   - YouTube / TikTok oEmbed: `youtube` / `tiktok` entries by video id; any
//     other id is a 400, like the real ones for the specs' fake ids;
//   - TikTok vm./vt. and maps.app.goo.gl short links: `tiktokShort` /
//     `mapsShort` redirects;
//   - Instagram posts: the login wall (the card stays branded);
//   - Google Maps pages: "Google Maps" with a static-map picture;
//   - web pages: `pages` (the real title, description, site and picture),
//     else a page titled after the URL for a known host (`hosts`, and every
//     host in seed/data);
//   - images (i.ytimg.com for known videos, og:image, favicons, anything
//     asked for as image/*): a small PNG in a colour of the URL;
//   - `.example`, `.test`, `.invalid` and one-label hosts: no such host
//     (ENOTFOUND).
// A web page on a host it doesn't know is still a page, but counts as a miss.
import { readdirSync, readFileSync } from "node:fs";
import zlib from "node:zlib";

const esc = (s) =>
	String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let crcTable;
function crc32(buf) {
	if (zlib.crc32) return zlib.crc32(buf);
	crcTable ??= Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	let c = 0xffffffff;
	for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** A solid RGBA PNG, `w`×`h` (the images every preview, thumbnail and favicon gets). */
export function solidPng(w, h, [r, g, b, a = 255]) {
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(td));
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
	const row = Buffer.alloc(1 + 4 * w);
	for (let x = 0; x < w; x++) row.set([r, g, b, a], 1 + 4 * x);
	const raw = Buffer.concat(Array.from({ length: h }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** A muted colour from a string, so different links get different pictures. */
function colourOf(s) {
	let h = 0;
	for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	const hue = h % 360;
	const [r, g, b] = [0, 8, 4].map((n) => {
		const k = (n + hue / 30) % 12;
		return Math.round(255 * (0.55 - 0.25 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
	});
	return [r, g, b];
}

function page({ title, description, siteName, image, url }) {
	const meta = (p, v) => (v ? `<meta property="${p}" content="${esc(v)}">` : "");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>${meta("og:title", title)}${meta("og:description", description)}${meta("og:site_name", siteName)}${meta("og:image", image)}${meta("og:url", url)}<link rel="icon" href="/favicon.ico"></head><body><h1>${esc(title)}</h1><p>${esc(description ?? "")}</p></body></html>`;
}

/** "e3000.html" → "E3000", "best-tailors-in-hoi-an" → "Best tailors in hoi an". */
function titleOf(u) {
	const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "").replace(/\.[a-z]+$/i, "");
	const words = last.replace(/[-_+]+/g, " ").trim();
	return words ? words[0].toUpperCase() + words.slice(1) : u.hostname.replace(/^www\./, "");
}

/** Every host the seed's data links to (the QA trip's links are refreshed from there). */
function seedHosts(root) {
	const hosts = new Set();
	try {
		const dir = new URL("seed/data/", root);
		for (const f of readdirSync(dir))
			if (f.endsWith(".json"))
				for (const m of readFileSync(new URL(f, dir), "utf8").matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1].toLowerCase());
	} catch {}
	return hosts;
}

const YT_ID = /^[\w-]{11}$/;
function youtubeId(raw) {
	try {
		const u = new URL(raw);
		if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0];
		const v = u.searchParams.get("v");
		if (v) return v;
		return /\/(?:shorts|embed|live)\/([\w-]+)/.exec(u.pathname)?.[1] ?? null;
	} catch {
		return null;
	}
}

export function createLinks({ fixture, root }) {
	const hosts = new Set([...(fixture.hosts ?? []), ...(root ? seedHosts(root) : [])].map((h) => h.toLowerCase()));
	const pages = new Map(Object.entries(fixture.pages ?? {}).map(([k, v]) => [k.replace(/#.*$/, ""), v]));
	const json = (status, body) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const html = (body) => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body });
	const png = (seed, w = 480, h = 270) => ({ status: 200, headers: { "content-type": "image/png" }, body: solidPng(w, h, colourOf(seed)) });
	const redirect = (to) => ({ status: 302, headers: { location: to }, body: "" });
	const notFound = () => ({ status: 404, headers: { "content-type": "text/plain" }, body: "Not Found" });

	/** The answer for a GET of `raw` (as `accept`), and whether the fixture knew it. */
	return function answer(raw, accept = "*/*") {
		let u;
		try {
			u = new URL(raw);
		} catch {
			return { hit: false, key: String(raw), res: { status: 400, headers: {}, body: "bad url" } };
		}
		const host = u.hostname.toLowerCase();
		const key = `${host}${u.pathname}`;
		const hit = (res) => ({ hit: true, key, res });
		// Reserved names and bare labels ("http://x/") never resolve.
		if (/\.(example|test|invalid)$/.test(host) || !host.includes("."))
			return hit({ status: 502, headers: { "x-stub-error": "ENOTFOUND" }, body: "" });

		if (/(^|\.)youtube\.com$/.test(host) && u.pathname === "/oembed") {
			const id = youtubeId(u.searchParams.get("url") ?? "");
			const v = id && fixture.youtube?.[id];
			return hit(
				v
					? json(200, { type: "video", provider_name: "YouTube", title: v.title, author_name: v.author_name, thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` })
					: { status: 400, headers: { "content-type": "text/plain" }, body: "Bad Request" },
			);
		}
		if (host === "i.ytimg.com") {
			const id = u.pathname.split("/")[2] ?? "";
			return hit(YT_ID.test(id) && fixture.youtube?.[id] ? png(id, 480, 360) : notFound());
		}
		if (host === "www.tiktok.com" && u.pathname === "/oembed") {
			const id = /\/video\/(\d+)/.exec(u.searchParams.get("url") ?? "")?.[1];
			const v = id && fixture.tiktok?.[id];
			return hit(
				v
					? json(200, { type: "video", provider_name: "TikTok", title: v.title, author_name: v.author_name, thumbnail_url: `https://p16-sign.tiktokcdn-us.com/stub/${id}.jpeg`, embed_product_id: id })
					: json(400, { code: 400, message: "Something went wrong", status_msg: "Something went wrong" }),
			);
		}
		if (host === "vm.tiktok.com" || host === "vt.tiktok.com") {
			const to = fixture.tiktokShort?.[u.pathname.split("/")[1] ?? ""];
			return to ? hit(redirect(to)) : { hit: false, key, res: notFound() };
		}
		if (host === "maps.app.goo.gl" || (host === "goo.gl" && u.pathname.startsWith("/maps"))) {
			const to = fixture.mapsShort?.[u.pathname.split("/").filter(Boolean).pop() ?? ""];
			return to ? hit(redirect(to)) : { hit: false, key, res: notFound() };
		}
		if (/image\//.test(accept) || /\.(png|jpe?g|gif|webp|ico|avif)$/i.test(u.pathname) || u.pathname.includes("/staticmap"))
			return hit(/favicon|\.ico$/i.test(u.pathname) ? png(host, 32, 32) : png(u.href));
		if (host === "www.instagram.com" || host === "instagram.com")
			return hit(html(page({ title: "Instagram", description: "Create an account or log in to Instagram.", siteName: "Instagram", url: u.href })));
		if (/(^|\.)tiktok\.com$/.test(host))
			return hit(html(page({ title: "TikTok - Make Your Day", siteName: "TikTok", url: u.href })));
		if (/^(www\.)?google\.[a-z.]+$/.test(host) && u.pathname.startsWith("/maps")) {
			const at = /@(-?\d+\.?\d*),(-?\d+\.?\d*)/.exec(u.pathname);
			const image = at ? `https://maps.google.com/maps/api/staticmap?center=${at[1]}%2C${at[2]}&zoom=17&size=256x256` : undefined;
			return hit(html(page({ title: "Google Maps", description: "Find local businesses, view maps and get driving directions in Google Maps.", siteName: "Google Maps", image, url: u.href })));
		}
		const known = pages.get(u.href.replace(/#.*$/, ""));
		if (known) return hit(html(page({ ...known, url: u.href })));
		if (/\.pdf$/i.test(u.pathname))
			return { hit: hosts.has(host), key, res: { status: 200, headers: { "content-type": "application/pdf" }, body: "%PDF-1.4\n%%EOF\n" } };
		const generic = html(page({ title: titleOf(u), siteName: host.replace(/^www\./, ""), image: `${u.origin}/og-image.png`, url: u.href }));
		return { hit: hosts.has(host), key, res: generic };
	};
}

/** The stub's link answers from the fixture (paths from the repo root). */
export function loadLinks(root) {
	return createLinks({ fixture: JSON.parse(readFileSync(new URL("e2e/stubs/fixtures/links.json", root), "utf8")), root });
}
