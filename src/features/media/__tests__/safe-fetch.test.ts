/**
 * The SSRF guard (SPEC §15.4, SECURITY §6) and the global-fetch regression
 * (SPEC §0 rule 14). Local servers stand in for the internet: the test
 * fetcher may dial exactly 127.0.0.1 on the test port, nothing else.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertPublicUrl,
	createSafeFetch,
	publicOnly,
	safeFetch,
	UnsafeUrlError,
} from "../server/safe-fetch.server";

let server: Server;
let port = 0;
let base = "";

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		switch (url.pathname) {
			case "/json-gzip": {
				const body = zlib.gzipSync(JSON.stringify({ ok: true, n: 42 }));
				res.writeHead(200, {
					"content-type": "application/json",
					"content-encoding": "gzip",
				});
				res.end(body);
				return;
			}
			case "/html-br": {
				const body = zlib.brotliCompressSync("<html><title>Hi</title></html>");
				res.writeHead(200, {
					"content-type": "text/html",
					"content-encoding": "br",
				});
				res.end(body);
				return;
			}
			case "/bomb": {
				// 20 MB of zeros → ~20 KB gzipped: the cap applies to the DECODED size.
				const body = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024));
				res.writeHead(200, {
					"content-type": "text/plain",
					"content-encoding": "gzip",
				});
				res.end(body);
				return;
			}
			case "/to-private":
				res.writeHead(302, { location: "http://10.0.0.1/secret" });
				res.end();
				return;
			case "/to-metadata":
				res.writeHead(301, {
					location: "http://169.254.169.254/latest/meta-data/",
				});
				res.end();
				return;
			case "/loop": {
				const n = Number(url.searchParams.get("n") ?? 0);
				res.writeHead(302, { location: `/loop?n=${n + 1}` });
				res.end();
				return;
			}
			case "/hop":
				res.writeHead(302, { location: "/final" });
				res.end();
				return;
			case "/final":
				res.writeHead(200, { "content-type": "text/plain" });
				res.end("made it");
				return;
			default:
				res.writeHead(404);
				res.end();
		}
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	port = (server.address() as AddressInfo).port;
	base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
	await new Promise((r) => server.close(r));
});

/** Allows the loopback test server only; every other private address stays blocked. */
const local = () =>
	createSafeFetch(
		(a) => a === "127.0.0.1" || publicOnly(a),
		["", "80", "443", String(port)],
	);

describe("assertPublicUrl", () => {
	it.each([
		["http://169.254.169.254/latest/meta-data/", "ip"],
		["http://[::ffff:169.254.169.254]/", "ip"],
		["http://0x7f.1/", "ip"],
		["http://127.1/", "ip"],
		["http://2130706433/", "ip"],
		["http://10.0.0.1/", "ip"],
		["http://[::1]/", "ip"],
		["http://0.0.0.0/", "ip"],
		["http://100.64.0.1/", "ip"],
		["http://user:pw@example.com/", "userinfo"],
		["http://example.com:8080/", "port"],
		["http://example.com:22/", "port"],
		["file:///etc/passwd", "scheme"],
		["gopher://example.com/", "scheme"],
	])("%s is refused (%s)", (raw, reason) => {
		expect(() => assertPublicUrl(new URL(raw))).toThrowError(
			expect.objectContaining({ reason }),
		);
	});

	it("allows ordinary public URLs", () => {
		expect(() =>
			assertPublicUrl(new URL("https://www.japan-guide.com/e/e2172.html")),
		).not.toThrow();
		expect(() =>
			assertPublicUrl(new URL("http://93.184.216.34/")),
		).not.toThrow();
	});
});

describe("safeFetch", () => {
	it("refuses localhost at DNS time (the lookup sees 127.0.0.1)", async () => {
		await expect(
			safeFetch(`http://localhost:${port}/final`),
		).rejects.toBeInstanceOf(UnsafeUrlError);
		await expect(safeFetch("http://localhost/")).rejects.toBeInstanceOf(
			UnsafeUrlError,
		);
	});

	it("refuses a redirect to a private address or the metadata service", async () => {
		const f = local();
		await expect(f(`${base}/to-private`)).rejects.toMatchObject({
			reason: "ip",
		});
		await expect(f(`${base}/to-metadata`)).rejects.toMatchObject({
			reason: "ip",
		});
	});

	it("follows at most 3 redirects, re-checking each hop", async () => {
		const f = local();
		const ok = await f(`${base}/hop`);
		expect(ok.body.toString()).toBe("made it");
		expect(ok.finalUrl).toBe(`${base}/final`);
		await expect(f(`${base}/loop`)).rejects.toThrow(/too many redirects/);
	});

	it("decodes gzip and brotli, and caps the decoded size", async () => {
		const f = local();
		const j = await f(`${base}/json-gzip`);
		expect(JSON.parse(j.body.toString())).toEqual({ ok: true, n: 42 });
		const h = await f(`${base}/html-br`);
		expect(h.body.toString()).toContain("<title>Hi</title>");
		await expect(f(`${base}/bomb`, { maxBytes: 1024 * 1024 })).rejects.toThrow(
			/too large/,
		);
	});

	it("keeps allowHosts on every hop", async () => {
		const f = local();
		await expect(
			f(`${base}/hop`, { allowHosts: ["www.tiktok.com"] }),
		).rejects.toMatchObject({
			reason: "host-not-allowed",
		});
	});

	it("leaves Node's global fetch working (the undici 8 regression, SPEC §15.4)", async () => {
		await import("open-graph-scraper");
		const r = await globalThis.fetch(`${base}/json-gzip`);
		expect(await r.json()).toEqual({ ok: true, n: 42 });
	});

	it("pins Node's global fetch to the HTTP/1.1 agent (h2 answers lost Content-Encoding)", async () => {
		const { NODE_FETCH_DISPATCHER } = await import(
			"../server/safe-fetch.server"
		);
		const { getGlobalDispatcher } = await import("undici");
		expect(getGlobalDispatcher()).toBe(NODE_FETCH_DISPATCHER);
	});
});
