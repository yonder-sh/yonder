/**
 * `peekLink` in the web server (D10): the preview code's undici (the
 * SSRF-safe fetch's and open-graph-scraper's) loads without changing Node's
 * global fetch dispatcher, and that fetch still decodes gzip. No static
 * import here may reach undici.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keepingGlobalFetch } from "../server/peek.server";

const NODE_SLOT = Symbol.for("undici.globalDispatcher.1");
const UNDICI_SLOT = Symbol.for("undici.globalDispatcher.2");
const g = globalThis as unknown as Record<symbol, unknown>;

let server: Server;
let base = "";

beforeAll(async () => {
	server = createServer((_req, res) => {
		res.writeHead(200, {
			"content-type": "application/json",
			"content-encoding": "gzip",
		});
		res.end(zlib.gzipSync(JSON.stringify({ ok: true, n: 42 })));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise((r) => server.close(r));
});

describe("keepingGlobalFetch", () => {
	it("loads undici and puts Node's fetch dispatcher back as it was", async () => {
		const r0 = await fetch(`${base}/`);
		expect(await r0.json()).toEqual({ ok: true, n: 42 });
		const before = g[NODE_SLOT];
		const beforeUndici = g[UNDICI_SLOT];
		expect(before).toBeDefined();
		let during: unknown;
		const m = await keepingGlobalFetch(async () => {
			const [safe] = await Promise.all([
				import("../server/safe-fetch.server"),
				import("open-graph-scraper"),
			]);
			during = g[NODE_SLOT];
			return safe;
		});
		// The imports took the slot over (the worker's HTTP/1.1 pin); it's back.
		expect(during).not.toBe(before);
		expect(g[NODE_SLOT]).toBe(before);
		expect(g[UNDICI_SLOT]).toBe(beforeUndici);
		// The SSRF-safe fetch still works: it passes its own agent.
		expect(typeof m.safeFetch).toBe("function");
		const r = await fetch(`${base}/`);
		expect(await r.json()).toEqual({ ok: true, n: 42 });
	});

	it("puts it back when the import fails too", async () => {
		const before = g[NODE_SLOT];
		await expect(
			keepingGlobalFetch(async () => {
				g[NODE_SLOT] = { dispatch() {} };
				throw new Error("broken module");
			}),
		).rejects.toThrow("broken module");
		expect(g[NODE_SLOT]).toBe(before);
	});
});
