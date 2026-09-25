/**
 * `landingViewer`, the landing page's guard (`/`): everyone sees the landing
 * (an account's links lead to the dashboard), only an installed app's
 * `?source=pwa` start forwards there, and a failed session lookup never
 * breaks the public page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ session: vi.fn() }));

vi.mock("./session.functions", () => ({ getSessionFn: m.session }));
vi.mock("./share.functions", () => ({ redeemShareLink: vi.fn() }));
vi.mock("./auth-client", () => ({ authClient: {} }));
vi.mock("@/lib/query/persister", () => ({ queryPersister: {} }));

import { landingViewer } from "./guards";
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

/** The redirect's href, else whether the page renders signed in. */
async function outcome(
	p: Promise<{ signedIn: boolean }>,
): Promise<string | boolean> {
	try {
		return (await p).signedIn;
	} catch (e) {
		const r = e as { options?: { href?: string }; href?: string };
		if (r.options?.href ?? r.href) return (r.options?.href ?? r.href) as string;
		throw e;
	}
}

beforeEach(() => vi.clearAllMocks());

describe("landingViewer (the landing page)", () => {
	it("shows the landing when signed out", async () => {
		m.session.mockResolvedValue(null);
		expect(await outcome(landingViewer())).toBe(false);
	});

	it("shows the landing to a link guest (no account yet)", async () => {
		m.session.mockResolvedValue(viewer({ isAnonymous: true, email: null }));
		expect(await outcome(landingViewer())).toBe(false);
	});

	it("shows an account the landing too, signed in", async () => {
		m.session.mockResolvedValue(viewer());
		expect(await outcome(landingViewer())).toBe(true);
	});

	it("sends an older install's /?source=pwa start to the dashboard", async () => {
		m.session.mockResolvedValue(viewer());
		expect(await outcome(landingViewer("?source=pwa"))).toBe(
			"/dashboard?source=pwa",
		);
		m.session.mockResolvedValue(null);
		expect(await outcome(landingViewer("?source=pwa"))).toBe(false);
	});

	it("still shows the landing when the session can't be read", async () => {
		m.session.mockRejectedValue(new Error("ECONNREFUSED"));
		expect(await outcome(landingViewer())).toBe(false);
	});
});
