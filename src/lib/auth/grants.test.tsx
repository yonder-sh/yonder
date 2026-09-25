import { beforeEach, describe, expect, it } from "vitest";
import {
	clearGrants,
	grantFor,
	lostLinkFor,
	markGrantGone,
	saveGrant,
} from "./grants";

const TOKEN = "B6w5wDJRMARa-yKzZs0D4QDToWum602dv3OUaZ6v4UM";
const TOKEN2 = "Zz5wDJRMARa-yKzZs0D4QDToWum602dv3OUaZ6v4UM";

beforeEach(() => localStorage.clear());

describe("lost links (QA LINK-04/05/07)", () => {
	it("a trip the guest never had a link to is not a lost link, and their link is kept", () => {
		saveGrant("asia-2027", TOKEN);
		expect(lostLinkFor("phu-quoc-detour")).toBe(false);
		expect(grantFor("asia-2027")).toBe(TOKEN);
	});

	it("a remembered link whose trip now refuses the guest is lost", () => {
		saveGrant("asia-2027", TOKEN);
		expect(lostLinkFor("asia-2027")).toBe(true);
	});

	it("stays lost on reload after the token is forgotten", () => {
		saveGrant("asia-2027", TOKEN);
		markGrantGone("asia-2027");
		expect(grantFor("asia-2027")).toBeNull();
		expect(lostLinkFor("asia-2027")).toBe(true);
		expect(lostLinkFor("phu-quoc-detour")).toBe(false);
	});

	it("a new link for the same trip clears the mark; sign-out clears everything", () => {
		markGrantGone("asia-2027");
		saveGrant("asia-2027", TOKEN2);
		markGrantGone("other");
		expect(localStorage.getItem("yonder:grants-gone")).toBe('["other"]');
		clearGrants();
		expect(lostLinkFor("other")).toBe(false);
		expect(localStorage.getItem("yonder:grants-gone")).toBeNull();
	});

	it("tolerates corrupted storage", () => {
		localStorage.setItem("yonder:grants-gone", "{nope");
		expect(lostLinkFor("asia-2027")).toBe(false);
		localStorage.setItem("yonder:grants-gone", JSON.stringify(["a", 3]));
		expect(lostLinkFor("a")).toBe(true);
	});
});
