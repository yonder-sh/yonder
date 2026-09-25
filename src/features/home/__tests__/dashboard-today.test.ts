/**
 * DASH-03's server "today" never fails the dashboard: a malformed or unknown
 * `yonder-tz` cookie falls back to the server's date. Before, a bad percent-
 * escape made `decodeURIComponent` throw inside `dashboardToday`: a 500 for
 * that visitor on every visit (the cookie lives a year).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const cookie = vi.hoisted(() => ({
	value: undefined as string | undefined,
	throws: false,
}));

vi.mock("@tanstack/react-start", () => import("@/test/start-mock"));
vi.mock("@tanstack/react-start/server", () => ({
	getCookie: () => {
		if (cookie.throws) throw new Error("no request");
		return cookie.value;
	},
}));
vi.mock("@/db/db.server", () => ({ db: {} }));
vi.mock("@/server/authz/middleware", () => ({ withAccount: {} }));
vi.mock("@/server/authz/access.server", () => ({ getTripAccess: vi.fn() }));
vi.mock("@/server/authz/session.server", () => ({ fail: vi.fn() }));
vi.mock("@/server/cache.server", () => ({ rateLimitPer: vi.fn() }));
vi.mock("../server/dashboard.server", () => ({
	loadMyDeadlines: vi.fn(),
	loadMyTrips: vi.fn(),
}));
vi.mock("../server/duplicate.server", () => ({ duplicateTripCore: vi.fn() }));

import { todayIn } from "@/lib/format";
import { dashboardToday } from "../dashboard.functions";
import { knownZone, zoneFromCookie } from "../today";

const call = dashboardToday as unknown as () => Promise<string>;

beforeEach(() => {
	cookie.value = undefined;
	cookie.throws = false;
});

describe("zoneFromCookie", () => {
	it("reads a zone, encoded or not", () => {
		expect(zoneFromCookie("Asia%2FTokyo")).toBe("Asia/Tokyo");
		expect(zoneFromCookie("America/Toronto")).toBe("America/Toronto");
	});

	it("falls back (undefined) on anything malformed or unknown", () => {
		for (const bad of [
			"%E0%A4%A", // a truncated percent-escape: decodeURIComponent throws
			"%",
			"Mars/Olympus_Mons",
			"Asia%2FTokyo%ZZ",
			"x".repeat(300),
			"",
			null,
			undefined,
		])
			expect(zoneFromCookie(bad), String(bad)).toBeUndefined();
	});

	it("agrees with knownZone", () => {
		expect(knownZone("Europe/Istanbul")).toBe("Europe/Istanbul");
		expect(knownZone("Nowhere/Land")).toBeUndefined();
	});
});

describe("dashboardToday (the SSR `/dashboard` loader)", () => {
	it("uses the viewer's zone from the cookie", async () => {
		cookie.value = "America%2FLos_Angeles";
		expect(await call()).toBe(todayIn("America/Los_Angeles"));
	});

	it("never throws on a malformed cookie: the server's date instead of a 500", async () => {
		for (const bad of ["%E0%A4%A", "%", "Mars/Olympus_Mons", "a%2", "%C0%80"]) {
			cookie.value = bad;
			await expect(call(), bad).resolves.toBe(todayIn());
		}
	});

	it("uses the server's date with no cookie or outside a request", async () => {
		expect(await call()).toBe(todayIn());
		cookie.throws = true;
		expect(await call()).toBe(todayIn());
	});
});
