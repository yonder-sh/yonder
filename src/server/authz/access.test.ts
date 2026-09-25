import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The authorization layer end to end, with the database, the Better Auth
 * session lookup and the Start request context mocked: which HTTP status each
 * failure gets, that access is read from the DB on every call, and that the
 * session is looked up once per request, bypassing the cookie cache.
 */
const mocks = vi.hoisted(() => ({
	execute: vi.fn(),
	getSession: vi.fn(),
	setResponseStatus: vi.fn(),
	request: { current: new Request("http://localhost/_serverFn/x") },
}));

vi.mock("@/db/db.server", () => ({ db: { execute: mocks.execute } }));
vi.mock("@/server/auth.server", () => ({
	auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("@tanstack/react-start/server", () => ({
	getRequest: () => mocks.request.current,
	setResponseStatus: mocks.setResponseStatus,
}));

const { getTripAccess, requireTripCapability, requireTripRole } = await import(
	"./access.server"
);
const { requireAccount, requireNamedUser, requireUser } = await import(
	"./session.server"
);
const { AppError } = await import("./errors");

const TRIP = "0192f0c1-0000-7000-8000-000000000001";
const kai = {
	id: "kai",
	isAnonymous: false,
	firstName: "Kai",
	lastName: "Tester",
	email: "kai@x.test",
	name: "Kai Tester",
};
const unnamed = { ...kai, id: "new", firstName: "", lastName: "" };
const guest = {
	id: "g",
	isAnonymous: true,
	firstName: "",
	lastName: "",
	email: "temp@guest.yonder.invalid",
	name: "Guest Wren",
};

function signedIn(user: object | null) {
	mocks.getSession.mockResolvedValue(
		user ? { user, session: { id: "s" } } : null,
	);
}
function rows(...r: object[]) {
	mocks.execute.mockResolvedValue({ rows: r });
}
const member = (role: string) => ({
	via: "member",
	role,
	memberId: "m1",
	color: 3,
	slug: "asia-2027",
});
const grant = (role: string) => ({
	via: "grant",
	role,
	memberId: null,
	color: 5,
	slug: "asia-2027",
});

async function failure(
	p: Promise<unknown>,
): Promise<{ message: string; status: number | undefined }> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(AppError);
		return {
			message: (e as Error).message,
			status: mocks.setResponseStatus.mock.calls.at(-1)?.[0],
		};
	}
	throw new Error("expected a failure");
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.request.current = new Request("http://localhost/_serverFn/x");
});

describe("requireTripRole", () => {
	it("401 without a session", async () => {
		signedIn(null);
		expect(await failure(requireTripRole(TRIP, "viewer"))).toEqual({
			message: "UNAUTHORIZED",
			status: 401,
		});
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it("404 when the user has no membership or live grant (never 403)", async () => {
		signedIn(kai);
		rows();
		expect(await failure(requireTripRole(TRIP, "viewer"))).toEqual({
			message: "NOT_FOUND",
			status: 404,
		});
	});

	it("404 for a malformed trip id, without touching SQL", async () => {
		signedIn(kai);
		expect(await failure(requireTripRole("1 or 1=1", "viewer"))).toMatchObject({
			status: 404,
		});
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it("403 when the role is too weak (QA SEC-02: viewer replays an edit)", async () => {
		signedIn(kai);
		rows(member("viewer"));
		expect(await failure(requireTripRole(TRIP, "editor"))).toEqual({
			message: "FORBIDDEN: editor role required",
			status: 403,
		});
	});

	it("403 name required for writes by an account without names (QA AUTH-02)", async () => {
		signedIn(unnamed);
		rows(member("owner"));
		expect(await failure(requireTripRole(TRIP, "editor"))).toEqual({
			message: "FORBIDDEN: name required",
			status: 403,
		});
		// Reads don't need names.
		await expect(requireTripRole(TRIP, "viewer")).resolves.toMatchObject({
			role: "owner",
		});
	});

	it("resolves a member with their role, member id and colour", async () => {
		signedIn(kai);
		rows(member("editor"));
		await expect(requireTripRole(TRIP, "editor")).resolves.toMatchObject({
			tripId: TRIP,
			slug: "asia-2027",
			role: "editor",
			memberId: "m1",
			isGuest: false,
			user: { id: "kai" },
		});
	});

	it("resolves a link guest as a guest editor", async () => {
		signedIn(guest);
		rows(grant("editor"));
		await expect(requireTripRole(TRIP, "editor")).resolves.toMatchObject({
			role: "editor",
			isGuest: true,
			memberId: null,
		});
		expect(await failure(requireTripRole(TRIP, "owner"))).toMatchObject({
			status: 403,
		});
	});

	it("reads access from the DB on every call (revocation is immediate)", async () => {
		signedIn(kai);
		rows(member("editor"));
		await requireTripRole(TRIP, "editor");
		rows();
		expect(await failure(requireTripRole(TRIP, "viewer"))).toMatchObject({
			status: 404,
		});
		expect(mocks.execute).toHaveBeenCalledTimes(2);
	});

	it("uses a user passed in from middleware context instead of the session", async () => {
		rows(member("owner"));
		await expect(
			requireTripRole(TRIP, "owner", kai as never),
		).resolves.toMatchObject({ role: "owner" });
		expect(mocks.getSession).not.toHaveBeenCalled();
	});
});

describe("requireTripCapability", () => {
	it("guest editors can edit but never manage sharing (QA LINK-03)", async () => {
		signedIn(guest);
		rows(grant("editor"));
		await expect(requireTripCapability(TRIP, "edit")).resolves.toMatchObject({
			isGuest: true,
		});
		expect(
			await failure(requireTripCapability(TRIP, "manageShareLinks")),
		).toEqual({
			message: "FORBIDDEN: not allowed: manageShareLinks",
			status: 403,
		});
	});
});

describe("getTripAccess", () => {
	it("is null without a session or access", async () => {
		signedIn(null);
		await expect(getTripAccess(TRIP)).resolves.toBeNull();
		signedIn(kai);
		rows();
		await expect(getTripAccess(TRIP)).resolves.toBeNull();
	});

	it("passes trip and user ids as bound parameters", async () => {
		signedIn(kai);
		rows(member("viewer"));
		await getTripAccess(TRIP);
		const query = mocks.execute.mock.calls[0]?.[0] as {
			queryChunks: unknown[];
		};
		expect(query.queryChunks).toContain(TRIP);
		expect(query.queryChunks).toContain("kai");
	});
});

describe("session helpers", () => {
	it("look the session up once per request, bypassing the cookie cache", async () => {
		signedIn(kai);
		await requireUser();
		await requireNamedUser();
		await requireAccount();
		expect(mocks.getSession).toHaveBeenCalledTimes(1);
		expect(mocks.getSession.mock.calls[0]?.[0]).toMatchObject({
			query: { disableCookieCache: true },
		});
		mocks.request.current = new Request("http://localhost/_serverFn/y");
		await requireUser();
		expect(mocks.getSession).toHaveBeenCalledTimes(2);
	});

	it("requireAccount refuses guests; requireNamedUser lets them through", async () => {
		signedIn(guest);
		await expect(requireNamedUser()).resolves.toMatchObject({ id: "g" });
		expect(await failure(requireAccount())).toEqual({
			message: "FORBIDDEN: account required",
			status: 403,
		});
	});
});
