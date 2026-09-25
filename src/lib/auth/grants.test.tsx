import { beforeEach, describe, expect, it } from "vitest";
import {
	clearGrants,
	hasGrant,
	lostLinkFor,
	markGrantGone,
	readGrants,
	saveGrant,
} from "./grants";

beforeEach(() => localStorage.clear());

describe("lost links (QA LINK-04/05/07)", () => {
	it("a trip the guest never opened through its link is not a lost link, and their trip is kept", () => {
		saveGrant("asia-2027-k7m2qxw9");
		expect(lostLinkFor("phu-quoc-detour")).toBe(false);
		expect(hasGrant("asia-2027-k7m2qxw9")).toBe(true);
	});

	it("a trip opened through its link that now refuses the guest is lost", () => {
		saveGrant("asia-2027-k7m2qxw9");
		expect(lostLinkFor("asia-2027-k7m2qxw9")).toBe(true);
	});

	it("stays lost on reload after the grant is forgotten", () => {
		saveGrant("asia-2027-k7m2qxw9");
		markGrantGone("asia-2027-k7m2qxw9");
		expect(hasGrant("asia-2027-k7m2qxw9")).toBe(false);
		expect(lostLinkFor("asia-2027-k7m2qxw9")).toBe(true);
		expect(lostLinkFor("phu-quoc-detour")).toBe(false);
	});

	it("opening the trip again clears the mark; sign-out clears everything", () => {
		markGrantGone("asia-2027-k7m2qxw9");
		saveGrant("asia-2027-k7m2qxw9");
		markGrantGone("other");
		expect(localStorage.getItem("yonder:grants-gone")).toBe('["other"]');
		clearGrants();
		expect(lostLinkFor("other")).toBe(false);
		expect(localStorage.getItem("yonder:grants-gone")).toBeNull();
		expect(localStorage.getItem("yonder:grants")).toBeNull();
	});

	it("keeps each slug once, and reads the old { slug: token } shape as its slugs", () => {
		saveGrant("a");
		saveGrant("b");
		saveGrant("a");
		expect(readGrants()).toEqual(["b", "a"]);
		localStorage.setItem(
			"yonder:grants",
			JSON.stringify({
				"asia-2027": "B6w5wDJRMARa-yKzZs0D4QDToWum602dv3OUaZ6v4UM",
			}),
		);
		expect(hasGrant("asia-2027")).toBe(true);
	});

	it("tolerates corrupted storage", () => {
		localStorage.setItem("yonder:grants-gone", "{nope");
		expect(lostLinkFor("asia-2027")).toBe(false);
		localStorage.setItem("yonder:grants-gone", JSON.stringify(["a", 3]));
		expect(lostLinkFor("a")).toBe(true);
	});
});
