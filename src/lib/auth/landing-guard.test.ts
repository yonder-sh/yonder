/**
 * `redirectSignedInToDashboard`, the landing page's guard (`/`): accounts go
 * to the dashboard, everyone else sees the landing, and a failed session
 * lookup never breaks the public page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ session: vi.fn() }));

vi.mock("./session.functions", () => ({ getSessionFn: m.session }));
vi.mock("./share.functions", () => ({ redeemShareLink: vi.fn() }));
vi.mock("./auth-client", () => ({ authClient: {} }));
vi.mock("@/lib/query/persister", () => ({ queryPersister: {} }));

import { redirectSignedInToDashboard } from "./guards";
import type { Viewer } from "./viewer";

const viewer = (over: Partial<Viewer> = {}): Viewer => ({
	id: "u1",
	email: "sam@example.com",
	name: "Sam Rivera",
	firstName: "Sam",
	lastName: "Rivera",
	image: null,
	isAnonymous: false,
	named: true,
	...over,
});

/** The redirect's href, or null when the guard lets the page render. */
async function outcome(p: Promise<void>): Promise<string | null> {
	try {
		await p;
		return null;
	} catch (e) {
		const r = e as { options?: { href?: string }; href?: string };
		if (r.options?.href ?? r.href) return (r.options?.href ?? r.href) as string;
		throw e;
	}
}

beforeEach(() => vi.clearAllMocks());

describe("redirectSignedInToDashboard (the landing page)", () => {
	it("shows the landing when signed out", async () => {
		m.session.mockResolvedValue(null);
		expect(await outcome(redirectSignedInToDashboard())).toBeNull();
	});

	it("shows the landing to a link guest (no account yet)", async () => {
		m.session.mockResolvedValue(viewer({ isAnonymous: true, email: null }));
		expect(await outcome(redirectSignedInToDashboard())).toBeNull();
	});

	it("sends an account to the dashboard", async () => {
		m.session.mockResolvedValue(viewer());
		expect(await outcome(redirectSignedInToDashboard())).toBe("/dashboard");
	});

	it("keeps the query (an older install's /?source=pwa)", async () => {
		m.session.mockResolvedValue(viewer());
		expect(await outcome(redirectSignedInToDashboard("?source=pwa"))).toBe(
			"/dashboard?source=pwa",
		);
	});

	it("sends an account without names to the dashboard too (its guard asks for them)", async () => {
		m.session.mockResolvedValue(viewer({ named: false, lastName: "" }));
		expect(await outcome(redirectSignedInToDashboard())).toBe("/dashboard");
	});

	it("still shows the landing when the session can't be read", async () => {
		m.session.mockRejectedValue(new Error("ECONNREFUSED"));
		expect(await outcome(redirectSignedInToDashboard())).toBeNull();
	});
});
