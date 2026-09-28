/**
 * The no-egress guard (scripts/lib/no-egress.mjs) that vitest and the e2e
 * envs run with: nothing leaves this machine, loopback still works.
 */
import dns from "node:dns";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isLoopbackHost } from "../../scripts/lib/no-egress.mjs";
import { takeRefusals } from "./no-network";

afterEach(() => {
	takeRefusals();
});

describe("isLoopbackHost", () => {
	it.each([
		["localhost", true],
		["app.localhost", true],
		["127.0.0.1", true],
		["127.8.9.10", true],
		["::1", true],
		["[::1]", true],
		["::ffff:127.0.0.1", true],
		["0.0.0.0", true],
		[undefined, true],
		["10.0.0.1", false],
		["192.168.1.2", false],
		["93.184.216.34", false],
		["::ffff:8.8.8.8", false],
		["example.com", false],
		["localhost.example.com", false],
	])("%s → %s", (host, want) => {
		expect(isLoopbackHost(host)).toBe(want);
	});
});

describe("the guard", () => {
	it("refuses a connection off this machine, like ECONNREFUSED, and names it", async () => {
		const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
			const s = net.connect(443, "192.0.2.1");
			s.once("error", resolve);
			s.once("connect", () => resolve(new Error("connected")));
		});
		expect(err.code).toBe("ECONNREFUSED");
		expect(err.message).toMatch(
			/no-egress: refused connect to 192\.0\.2\.1:443/,
		);
		expect(takeRefusals()).toMatchObject([
			{ kind: "connect", host: "192.0.2.1", port: 443 },
		]);
	});

	it("refuses fetch before any DNS lookup, and DNS for outside names", async () => {
		await expect(fetch("https://example.org/")).rejects.toThrow();
		await expect(dns.promises.lookup("example.org")).rejects.toMatchObject({
			code: "ENOTFOUND",
		});
		expect(takeRefusals().map((r) => [r.kind, r.host])).toEqual([
			["connect", "example.org"],
			["dns", "example.org"],
		]);
	});

	it("lets loopback through", async () => {
		const server = createServer((_req, res) => res.end("ok"));
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const { port } = server.address() as AddressInfo;
		try {
			expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe(
				"ok",
			);
			expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe(
				"ok",
			);
		} finally {
			await new Promise((r) => server.close(r));
		}
		expect(takeRefusals()).toEqual([]);
	});
});
