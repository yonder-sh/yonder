import { beforeEach, describe, expect, it, vi } from "vitest";

const authSignOut = vi.hoisted(() => vi.fn());
vi.mock("./auth-client", () => ({ authClient: { signOut: authSignOut } }));

const { clearGrants, forgetGrant, grantFor, readGrants, saveGrant } =
	await import("./grants");
const { onSignOut, signOut } = await import("./sign-out");

const TOKEN = "B6w5wDJRMARa-yKzZs0D4QDToWum602dv3OUaZ6v4UM";

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	authSignOut.mockReset().mockResolvedValue({ data: { success: true } });
});

describe("grants (localStorage yonder:grants)", () => {
	it("saves, reads and forgets per slug", () => {
		saveGrant("asia-2027", TOKEN);
		saveGrant("phu-quoc", TOKEN);
		expect(grantFor("asia-2027")).toBe(TOKEN);
		forgetGrant("asia-2027");
		expect(readGrants()).toEqual({ "phu-quoc": TOKEN });
		clearGrants();
		expect(readGrants()).toEqual({});
	});

	it("tolerates corrupted storage and drops malformed tokens", () => {
		localStorage.setItem("yonder:grants", "{not json");
		expect(readGrants()).toEqual({});
		localStorage.setItem(
			"yonder:grants",
			JSON.stringify({ a: TOKEN, b: "short", c: 3 }),
		);
		expect(readGrants()).toEqual({ a: TOKEN });
	});
});

describe("signOut (SPEC §11.2 flow 8, SECURITY §11)", () => {
	it("runs registered cleanups, signs out, clears the query cache and private storage", async () => {
		const cleanup = vi.fn();
		const off = onSignOut(cleanup);
		const queryClient = { clear: vi.fn() };
		const navigate = vi.fn();
		saveGrant("asia-2027", TOKEN);
		localStorage.setItem("yonder:saved-trips", "[]");
		localStorage.setItem("yonder-theme", "dark");
		sessionStorage.setItem("yonder:pending-join", TOKEN);

		await signOut({ queryClient, reload: false, navigate });

		expect(cleanup).toHaveBeenCalledOnce();
		expect(authSignOut).toHaveBeenCalledOnce();
		expect(queryClient.clear).toHaveBeenCalledOnce();
		expect(localStorage.getItem("yonder:grants")).toBeNull();
		expect(localStorage.getItem("yonder:saved-trips")).toBeNull();
		expect(localStorage.getItem("yonder-theme")).toBe("dark"); // a UI pref, not private data
		expect(sessionStorage.length).toBe(0);
		expect(navigate).toHaveBeenCalledWith("/login");
		off();
	});

	it("still wipes local data when the network call fails (offline, shared device)", async () => {
		authSignOut.mockRejectedValue(new Error("offline"));
		const failing = vi
			.fn()
			.mockRejectedValue(new Error("provider already gone"));
		const off = onSignOut(failing);
		saveGrant("asia-2027", TOKEN);
		const navigate = vi.fn();
		await signOut({ reload: false, navigate });
		expect(localStorage.getItem("yonder:grants")).toBeNull();
		expect(navigate).toHaveBeenCalledWith("/login");
		off();
	});

	it("unregistered cleanups no longer run", async () => {
		const cleanup = vi.fn();
		onSignOut(cleanup)();
		await signOut({ reload: false, navigate: vi.fn() });
		expect(cleanup).not.toHaveBeenCalled();
	});
});
