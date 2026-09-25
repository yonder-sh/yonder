/**
 * The SSRF-safe fetch (SPEC §15.4, SECURITY §6; spikes/media preview.mjs).
 * The ONLY file in the app that imports `undici` (SPEC §0 rule 14).
 *
 * - Only http/https, ports 80/443, no userinfo; IP literals are checked here
 *   because the connect-time `lookup` is skipped for them.
 * - DNS is checked at connect time (`guardedLookup`): every resolved address
 *   must be public unicast, so a rebinding second answer can't reach
 *   127.0.0.1 or the metadata address.
 * - Redirects are followed by hand, at most 3, re-checking every hop.
 * - `undici.request` doesn't decompress: bodies are decoded by
 *   `content-encoding` here and `maxBytes` is enforced on the DECODED bytes
 *   (decompression bombs).
 * - Never the bare `undici.fetch`, never a call without our `dispatcher`.
 * - Node's global `fetch`: importing undici 8 re-registers Node's own fetch
 *   dispatcher (the legacy `undici.globalDispatcher.1` slot) as a wrapper
 *   around an undici 8 Agent that negotiates HTTP/2, and on that path the
 *   response loses `Content-Encoding`, so every gzip/br answer from an h2
 *   host (OSRM, the jsDelivr FX API, Open-Meteo, Photon…) reached
 *   `res.json()` still compressed. The one `setGlobalDispatcher` below pins
 *   the global to an HTTP/1.1 Agent, whose path decodes correctly (found at
 *   integration; `safe-fetch.test.ts` checks the pin).
 */
import dns from "node:dns";
import net from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";
import ipaddr from "ipaddr.js";
import { Agent, request, setGlobalDispatcher } from "undici";

/** See the module comment: Node's global fetch over HTTP/1.1 only. */
export const NODE_FETCH_DISPATCHER = new Agent({ allowH2: false });
setGlobalDispatcher(NODE_FETCH_DISPATCHER);

export class UnsafeUrlError extends Error {
	constructor(readonly reason: string) {
		super(`unsafe url: ${reason}`);
		this.name = "UnsafeUrlError";
	}
}

const bad = (reason: string) => new UnsafeUrlError(reason);

/** Decides which addresses may be dialled (tests widen it to one loopback server). */
export type AddressPolicy = (address: string) => boolean;

/** Public unicast only (IPv4-mapped IPv6 unwrapped first). */
export const publicOnly: AddressPolicy = (address) => {
	try {
		let a = ipaddr.parse(address);
		if (a.kind() === "ipv6" && (a as ipaddr.IPv6).isIPv4MappedAddress())
			a = (a as ipaddr.IPv6).toIPv4Address();
		return a.range() === "unicast";
	} catch {
		return false;
	}
};

/** Scheme, userinfo, port and IP-literal checks for one hop. */
export function assertPublicUrl(
	u: URL,
	policy: AddressPolicy = publicOnly,
	allowPorts: readonly string[] = ["", "80", "443"],
): void {
	if (u.protocol !== "http:" && u.protocol !== "https:") throw bad("scheme");
	if (u.username || u.password) throw bad("userinfo");
	if (!allowPorts.includes(u.port)) throw bad("port");
	const host = u.hostname.replace(/^\[|\]$/g, "");
	if (!host) throw bad("host");
	// IP literals skip the DNS lookup entirely; WHATWG URL already normalised
	// hex/decimal/short forms (0x7f.1 → 127.0.0.1).
	if (net.isIP(host) && !policy(host)) throw bad("ip");
}

type LookupCb = (
	err: NodeJS.ErrnoException | null,
	address: string | dns.LookupAddress[],
	family?: number,
) => void;

function guardedLookup(policy: AddressPolicy) {
	return (hostname: string, opts: dns.LookupOptions, cb: LookupCb) => {
		dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
			if (err) return cb(err, "");
			const list = addrs as dns.LookupAddress[];
			if (!list.length || list.some((a) => !policy(a.address)))
				return cb(bad("resolved-ip") as NodeJS.ErrnoException, "");
			// Node may call either shape (autoSelectFamily asks for all).
			if (opts?.all) cb(null, list);
			else cb(null, list[0]?.address ?? "", list[0]?.family);
		});
	};
}

export type SafeFetchOptions = {
	/** Decoded-body cap (default 3 MB). */
	maxBytes?: number;
	accept?: string;
	/** Every hop's host must be one of these (short-link resolution). */
	allowHosts?: readonly string[];
	/** Total time budget in ms (default 10 s). */
	timeoutMs?: number;
	maxRedirects?: number;
};

export type SafeResponse = {
	status: number;
	headers: Record<string, string>;
	finalUrl: string;
	contentType: string;
	body: Buffer;
};

const USER_AGENT =
	"Mozilla/5.0 (compatible; YonderBot/1.0; +https://github.com/yonder-trips)";

export type SafeFetcher = (
	url: string,
	o?: SafeFetchOptions,
) => Promise<SafeResponse>;

/**
 * Builds a fetcher. `createSafeFetch()` (the default export `safeFetch`) only
 * dials public addresses; tests pass a policy and ports for a local server.
 */
export function createSafeFetch(
	policy: AddressPolicy = publicOnly,
	allowPorts: readonly string[] = ["", "80", "443"],
): SafeFetcher {
	const agent = new Agent({
		connect: { lookup: guardedLookup(policy), timeout: 5_000 },
		headersTimeout: 8_000,
		bodyTimeout: 8_000,
	});
	return async (raw, o = {}) => {
		const maxBytes = o.maxBytes ?? 3 * 1024 * 1024;
		const maxRedirects = o.maxRedirects ?? 3;
		const deadline = AbortSignal.timeout(o.timeoutMs ?? 10_000);
		let u: URL;
		try {
			u = new URL(raw);
		} catch {
			throw bad("parse");
		}
		for (let hop = 0; hop <= maxRedirects; hop++) {
			assertPublicUrl(u, policy, allowPorts);
			if (o.allowHosts && !o.allowHosts.includes(u.hostname.toLowerCase()))
				throw bad("host-not-allowed");
			let res: Awaited<ReturnType<typeof request>>;
			try {
				res = await request(u, {
					dispatcher: agent,
					method: "GET",
					signal: deadline,
					headers: {
						"user-agent": USER_AGENT,
						accept: o.accept ?? "*/*",
						"accept-encoding": "gzip, deflate, br",
						"accept-language": "en",
					},
				});
			} catch (e) {
				const cause = (e as { cause?: unknown }).cause;
				if (e instanceof UnsafeUrlError) throw e;
				if (cause instanceof UnsafeUrlError) throw cause;
				throw new Error(
					`fetch failed: ${(e as { code?: string }).code ?? "network"}`,
				);
			}
			const headers: Record<string, string> = {};
			for (const [k, v] of Object.entries(res.headers))
				if (v !== undefined)
					headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
			if (res.statusCode >= 300 && res.statusCode < 400 && headers.location) {
				await res.body.dump();
				try {
					u = new URL(headers.location, u); // re-checked at the top of the loop
				} catch {
					throw bad("redirect");
				}
				continue;
			}
			const declared = Number(headers["content-length"] ?? 0);
			const encoding = (headers["content-encoding"] ?? "").toLowerCase().trim();
			if (!encoding && declared > maxBytes) {
				await res.body.dump();
				throw new Error("too large");
			}
			const body = await readDecoded(res.body, encoding, maxBytes);
			return {
				status: res.statusCode,
				headers,
				finalUrl: u.href,
				contentType: (headers["content-type"] ?? "").toLowerCase(),
				body,
			};
		}
		throw new Error("too many redirects");
	};
}

async function readDecoded(
	body: Readable & { destroy(): void },
	encoding: string,
	maxBytes: number,
): Promise<Buffer> {
	let stream: Readable = body;
	if (encoding === "gzip" || encoding === "x-gzip")
		stream = body.pipe(zlib.createGunzip());
	else if (encoding === "deflate") stream = body.pipe(zlib.createInflate());
	else if (encoding === "br") stream = body.pipe(zlib.createBrotliDecompress());
	else if (encoding && encoding !== "identity") {
		body.destroy();
		throw new Error("unsupported encoding");
	}
	const chunks: Buffer[] = [];
	let n = 0;
	try {
		for await (const c of stream) {
			const buf = c as Buffer;
			n += buf.length;
			if (n > maxBytes) {
				body.destroy();
				stream.destroy();
				throw new Error("too large");
			}
			chunks.push(buf);
		}
	} catch (e) {
		body.destroy();
		throw e instanceof Error && e.message === "too large"
			? e
			: new Error("bad body");
	}
	return Buffer.concat(chunks);
}

/** The production fetcher: public addresses on ports 80/443 only. */
export const safeFetch: SafeFetcher = createSafeFetch();
