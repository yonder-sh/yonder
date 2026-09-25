/**
 * `requireTripViewer` (QA LINK-04/05, HOME-6): a returning guest whose
 * remembered link was turned off or replaced lands on /join's "This link no
 * longer works." view, never the account sign-in page. QA COLLAB-R2-06: when
 * someone else signs in on the page, the previous identity's cache goes.
 */
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	session: vi.fn(),
	redeem: vi.fn(),
	signInAnon: vi.fn(),
	deleteAnon: vi.fn(),
	removePersisted: vi.fn(async () => {}),
	resetCollab: vi.fn(),
	homeCleanup: vi.fn(async () => {}),
}));

vi.mock("./session.functions", () => ({ getSessionFn: m.session }));
vi.mock("./share.functions", () => ({ redeemShareLink: m.redeem }));
vi.mock("./auth-client", () => ({
	authClient: {
		signIn: { anonymous: m.signInAnon },
		deleteAnonymousUser: m.deleteAnon,
	},
}));

vi.mock("@/lib/query/persister", () => ({
	queryPersister: {
		removeQueries: m.removePersisted,
		persistQueryByKey: vi.fn(async () => {}),
		retrieveQuery: vi.fn(async () => undefined),
	},
}));
vi.mock("@/lib/realtime/collab-client", () => ({
	resetCollabClient: m.resetCollab,
}));
vi.mock("@/features/offline/app-lifecycle", () => ({
	homeSignOutCleanup: m.homeCleanup,
}));

import { sessionKey } from "@/lib/query/keys";
import { grantFor, saveGrant } from "./grants";
import { requireAccountViewer, requireTripViewer } from "./guards";
import { onSignOut } from "./sign-out";
import type { Viewer } from "./viewer";

async function redirectOf(p: Promise<unknown>): Promise<string | null> {
	try {
		await p;
		return null;
	} catch (e) {
		const r = e as { options?: { href?: string }; href?: string };
		return r.options?.href ?? r.href ?? String(e);
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	window.localStorage.clear();
	m.signInAnon.mockResolvedValue({ error: null });
	m.deleteAnon.mockResolvedValue({});
});

describe("requireTripViewer", () => {
	it("a dead remembered link goes to /join (no longer works) and is forgotten", async () => {
		saveGrant("asia-2027", "qa-share-token-viewer-asia-2027");
		expect(grantFor("asia-2027")).not.toBeNull();
		m.session.mockResolvedValue(null);
		m.redeem.mockRejectedValue(new Error("NOT_FOUND: link"));
		expect(
			await redirectOf(requireTripViewer("asia-2027", "/t/asia-2027")),
		).toBe("/join");
		expect(grantFor("asia-2027")).toBeNull();
		expect(m.deleteAnon).toHaveBeenCalled();
	});

	it("no session and no link still goes to sign-in", async () => {
		m.session.mockResolvedValue(null);
		expect(
			await redirectOf(requireTripViewer("asia-2027", "/t/asia-2027")),
		).toMatch(/^\/login\?next=/);
	});
});

describe("identity change (QA COLLAB-R2-06)", () => {
	const person = (id: string, name: string, anon = false): Viewer => ({
		id,
		email: anon ? null : `${id}@asia2027.test`,
		name,
		firstName: anon ? "" : (name.split(" ")[0] ?? ""),
		lastName: anon ? "" : (name.split(" ")[1] ?? ""),
		image: null,
		isAnonymous: anon,
		named: true,
	});
	const guest = person("anon-ibis", "Guest Ibis", true);
	const eve = person("u-eve", "Eve Outsider");
	const graphKey = ["trip", "t-asia", "graph"] as const;

	it("a link guest who signs in drops the guest's cached trip data", async () => {
		const qc = new QueryClient();
		m.session.mockResolvedValue(guest);
		await requireTripViewer("asia-2027", "/t/asia-2027", { queryClient: qc });
		qc.setQueryData(graphKey, { me: { userId: guest.id, isGuest: true } });
		qc.setQueryData(["me", "trips"], []);
		// Back from /login as Eve (the anonymous user was merged and deleted).
		m.session.mockResolvedValue(eve);
		const r = await requireTripViewer("asia-2027", "/t/asia-2027", {
			queryClient: qc,
		});
		expect(r.viewer.id).toBe("u-eve");
		expect(qc.getQueryData(graphKey)).toBeUndefined();
		expect(qc.getQueryData(["me", "trips"])).toBeUndefined();
		expect(qc.getQueryData(sessionKey)).toEqual(eve);
		expect(m.removePersisted).toHaveBeenCalledTimes(1);
		expect(m.resetCollab).toHaveBeenCalledTimes(1);
	});

	it("a fresh page load as someone else wipes the previous person's data (SEC-R3-03)", async () => {
		const cleanup = vi.fn();
		const off = onSignOut(cleanup);
		// Dennis used this device; his session ended without a sign-out.
		const dennisPage = new QueryClient();
		m.session.mockResolvedValue(person("u-dennis", "Dennis Tester"));
		await requireAccountViewer("/", { queryClient: dennisPage });
		expect(m.removePersisted).not.toHaveBeenCalled();
		// A new page load (an empty QueryClient) where Eve signs in.
		const evePage = new QueryClient();
		m.session.mockResolvedValue(eve);
		await requireAccountViewer("/", { queryClient: evePage });
		expect(m.removePersisted).toHaveBeenCalledTimes(1);
		expect(cleanup).toHaveBeenCalledTimes(1);
		// WP-Home's caches (the SW `pages` cache with /share) even before it mounts.
		expect(m.homeCleanup).toHaveBeenCalledTimes(1);
		// Eve again on the next load: nothing to wipe.
		await requireAccountViewer("/", { queryClient: new QueryClient() });
		expect(m.removePersisted).toHaveBeenCalledTimes(1);
		off();
	});

	it("the same person (a reload, a re-sign-in, the dashboard) keeps the cache", async () => {
		const qc = new QueryClient();
		m.session.mockResolvedValue(eve);
		await requireTripViewer("asia-2027", "/t/asia-2027", { queryClient: qc });
		qc.setQueryData(graphKey, { me: { userId: eve.id } });
		await requireAccountViewer("/", { queryClient: qc });
		// The session lapsed in between, then the same account came back.
		m.session.mockResolvedValueOnce(null);
		await requireTripViewer("asia-2027", "/t/asia-2027", {
			queryClient: qc,
		}).catch(() => undefined);
		await requireTripViewer("asia-2027", "/t/asia-2027", { queryClient: qc });
		expect(qc.getQueryData(graphKey)).toEqual({ me: { userId: eve.id } });
		expect(m.removePersisted).not.toHaveBeenCalled();
		expect(m.resetCollab).not.toHaveBeenCalled();
	});
});
