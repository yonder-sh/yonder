/**
 * The collab server's probe endpoints on its HTTP port (Kubernetes): `GET
 * /health` answers 200 while its check (Redis in `collab/server.ts`) passes
 * and 503 when it fails or hangs past HEALTH_TIMEOUT_MS; `GET /healthz` is a
 * plain liveness 200. Needs Redis (the relay subscribes on start).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CollabServer } from "../app";
import type { CollabDb } from "../db";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 30_000 });

const hex = randomBytes(4).toString("hex");
let collab: CollabServer;
let health: () => Promise<boolean> = async () => true;

beforeAll(async () => {
	const { startCollabServer } = await import("../app");
	collab = await startCollabServer({
		port: 0,
		// No document is opened here, so no database is touched.
		db: {} as CollabDb,
		lookupSession: async () => null,
		originAllowed: () => true,
		redis: {
			url: process.env.REDIS_URL ?? "redis://localhost:6379",
			tripPattern: `yonder-healthtest-${hex}:trip:*`,
			hocuspocusPrefix: `yonder-healthtest-${hex}:hp`,
			name: `health-${hex}`,
		},
		health: () => health(),
		quiet: true,
		log: () => {},
	});
});

afterAll(async () => {
	await collab?.stop();
});

const get = (path: string) =>
	fetch(`http://127.0.0.1:${collab.port}${path}`, { cache: "no-store" });

describe("collab probes", () => {
	it("GET /health is 200 while the check passes", async () => {
		health = async () => true;
		const res = await get("/health");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("GET /health is 503 when the check fails, throws or hangs", async () => {
		health = async () => false;
		expect((await get("/health")).status).toBe(503);
		health = async () => {
			throw new Error("ECONNREFUSED");
		};
		expect((await get("/health?probe=1")).status).toBe(503);
		health = () => new Promise<boolean>(() => {});
		const t0 = Date.now();
		expect((await get("/health")).status).toBe(503);
		expect(Date.now() - t0).toBeLessThan(5_000);
	});

	it("GET /healthz stays a plain 200", async () => {
		health = async () => false;
		const res = await get("/healthz");
		expect(res.status).toBe(200);
	});
});
