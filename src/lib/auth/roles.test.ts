import { describe, expect, it } from "vitest";
import {
	CAPABILITIES,
	type Capability,
	can,
	canRateOwn,
	editModeOf,
	isTripRole,
	maxRole,
	mustRedact,
	roleAtLeast,
	roleLabel,
	seesMoney,
	type TripRole,
} from "./roles";

describe("roles", () => {
	it("orders viewer < rater < suggester < editor < owner (RANK, never the enum order)", () => {
		expect(roleAtLeast("owner", "editor")).toBe(true);
		expect(roleAtLeast("editor", "editor")).toBe(true);
		expect(roleAtLeast("viewer", "editor")).toBe(false);
		expect(roleAtLeast("editor", "owner")).toBe(false);
		expect(roleAtLeast("viewer", "viewer")).toBe(true);
		expect(roleAtLeast("suggester", "viewer")).toBe(true);
		expect(roleAtLeast("suggester", "editor")).toBe(false);
		expect(roleAtLeast("editor", "suggester")).toBe(true);
		// PLACES §1c: rater sits between viewer and suggester.
		expect(roleAtLeast("rater", "viewer")).toBe(true);
		expect(roleAtLeast("viewer", "rater")).toBe(false);
		expect(roleAtLeast("rater", "suggester")).toBe(false);
		expect(roleAtLeast("suggester", "rater")).toBe(true);
	});

	it("maxRole picks the strongest and ignores empties", () => {
		expect(maxRole([])).toBeNull();
		expect(maxRole([null, undefined])).toBeNull();
		expect(maxRole(["viewer", "editor"])).toBe("editor");
		expect(maxRole(["editor", "owner", "viewer"])).toBe("owner");
		expect(maxRole(["viewer", "suggester"])).toBe("suggester");
		expect(maxRole(["suggester", "editor"])).toBe("editor");
		expect(maxRole(["viewer", "rater"])).toBe("rater");
		expect(maxRole(["rater", "suggester"])).toBe("suggester");
	});

	it("isTripRole admits suggesters and rejects anything else", () => {
		expect(isTripRole("owner")).toBe(true);
		expect(isTripRole("suggester")).toBe(true);
		expect(isTripRole("rater")).toBe(true);
		expect(isTripRole("admin")).toBe(false);
		expect(isTripRole(undefined)).toBe(false);
	});

	it("labels roles for the sharing UI", () => {
		expect(roleLabel("viewer")).toBe("Can view");
		expect(roleLabel("rater")).toBe("Can rate");
		expect(roleLabel("suggester")).toBe("Can suggest");
		expect(roleLabel("editor")).toBe("Can edit");
	});
});

/** SPEC §11.3 + EXTENSIONS §3.1, transcribed column by column. */
const EXPECTED: Record<string, Capability[]> = {
	owner: [
		"read",
		"seeBookingDetails",
		"edit",
		"editNotes",
		"editTripDates",
		"beMentioned",
		"manageMembers",
		"manageShareLinks",
		"tripSettings",
		"changeSlug",
		"deleteTrip",
		"seeMemberEmails",
		"uploadMedia",
		"propose",
		"reviewProposals",
		"searchPlaces",
		"manageExpenses",
		"manageBudgets",
		"setMediaVisibility",
		"addPeople",
		"linkPeople",
		"rate",
		"markDone",
	],
	editor: [
		"read",
		"seeBookingDetails",
		"edit",
		"editNotes",
		"editTripDates",
		"beMentioned",
		"tripSettings",
		"leaveTrip",
		"uploadMedia",
		"propose",
		"reviewProposals",
		"searchPlaces",
		"manageExpenses",
		"manageBudgets",
		"setMediaVisibility",
		"addPeople",
		"linkPeople",
		"rate",
		"markDone",
	],
	suggester: [
		"read",
		"seeBookingDetails",
		"beMentioned",
		"leaveTrip",
		"propose",
		"searchPlaces",
		"manageExpenses",
		"setMediaVisibility",
		"addPeople",
		"rate",
	],
	// PLACES §1c: exactly a viewer, plus rating.
	rater: [
		"read",
		"seeBookingDetails",
		"beMentioned",
		"leaveTrip",
		"setMediaVisibility",
		"rate",
	],
	viewer: [
		"read",
		"seeBookingDetails",
		"beMentioned",
		"leaveTrip",
		"setMediaVisibility",
	],
	// A link guest only views, whatever the link allows (owner, 2026-10-09).
	guestEditor: ["read"],
	guestSuggester: ["read"],
	guestRater: ["read"],
	guestViewer: ["read"],
};

const ACTORS: Record<string, { role: TripRole; isGuest: boolean }> = {
	owner: { role: "owner", isGuest: false },
	editor: { role: "editor", isGuest: false },
	suggester: { role: "suggester", isGuest: false },
	rater: { role: "rater", isGuest: false },
	viewer: { role: "viewer", isGuest: false },
	guestEditor: { role: "editor", isGuest: true },
	guestSuggester: { role: "suggester", isGuest: true },
	guestRater: { role: "rater", isGuest: true },
	guestViewer: { role: "viewer", isGuest: true },
};

describe("permission matrix (SPEC §11.3, EXTENSIONS §3.1)", () => {
	for (const [name, access] of Object.entries(ACTORS)) {
		it(`${name} has exactly the expected capabilities`, () => {
			const granted = CAPABILITIES.filter((c) => can(access, c));
			expect(granted.sort()).toEqual([...(EXPECTED[name] ?? [])].sort());
		});
	}

	it("a link guest only views, whatever the link allows: only members change things", () => {
		for (const role of ["editor", "suggester", "rater", "viewer"] as const)
			for (const cap of CAPABILITIES)
				expect(can({ role, isGuest: true }, cap)).toBe(cap === "read");
	});

	it("guests never manage sharing, members, emails, money or the trip itself (SECURITY §1)", () => {
		for (const access of [
			ACTORS.guestEditor,
			ACTORS.guestSuggester,
			ACTORS.guestRater,
			ACTORS.guestViewer,
		]) {
			for (const cap of [
				"manageMembers",
				"manageShareLinks",
				"seeMemberEmails",
				"deleteTrip",
				"changeSlug",
				"beMentioned",
				"manageExpenses",
				"manageBudgets",
				"setMediaVisibility",
				"addPeople",
				"linkPeople",
				"rate",
				"markDone",
			] as const) {
				expect(can(access, cap)).toBe(false);
			}
		}
	});

	it("no access means no capability", () => {
		expect(can(null, "read")).toBe(false);
		expect(can(undefined, "read")).toBe(false);
	});

	it("redacts booking details for guests only", () => {
		expect(mustRedact({ role: "editor", isGuest: true })).toBe(true);
		expect(mustRedact({ role: "suggester", isGuest: true })).toBe(true);
		expect(mustRedact({ role: "viewer", isGuest: true })).toBe(true);
		expect(mustRedact({ role: "viewer", isGuest: false })).toBe(false);
		expect(mustRedact({ role: "suggester", isGuest: false })).toBe(false);
		// A rater sees exactly what a viewer sees.
		expect(mustRedact({ role: "rater", isGuest: false })).toBe(false);
		expect(mustRedact({ role: "rater", isGuest: true })).toBe(true);
	});

	it("shows money to members who pay: not link guests, not 'Can view'", () => {
		expect(seesMoney({ role: "owner", isGuest: false })).toBe(true);
		expect(seesMoney({ role: "editor", isGuest: false })).toBe(true);
		expect(seesMoney({ role: "suggester", isGuest: false })).toBe(true);
		expect(seesMoney({ role: "rater", isGuest: false })).toBe(true);
		expect(seesMoney({ role: "viewer", isGuest: false })).toBe(false);
		expect(seesMoney({ role: "editor", isGuest: true })).toBe(false);
	});

	it("a rater is a viewer who may rate (PLACES §1c); plain viewers never rate", () => {
		const viewer = ACTORS.viewer as { role: TripRole; isGuest: boolean };
		const rater = ACTORS.rater as { role: TripRole; isGuest: boolean };
		for (const cap of CAPABILITIES)
			if (cap !== "rate") expect(can(rater, cap), cap).toBe(can(viewer, cap));
		expect(can(rater, "rate")).toBe(true);
		expect(can(viewer, "rate")).toBe(false);
		// Own rating needs a member row: link guests have none.
		expect(canRateOwn({ ...rater, memberId: "m1" })).toBe(true);
		expect(canRateOwn({ ...rater, memberId: null })).toBe(false);
		expect(canRateOwn({ ...viewer, memberId: "m1" })).toBe(false);
		expect(
			canRateOwn({ role: "suggester", isGuest: false, memberId: "m1" }),
		).toBe(true);
		expect(canRateOwn({ role: "editor", isGuest: true, memberId: null })).toBe(
			false,
		);
	});

	it("derives the workspace edit mode (EXTENSIONS §2.3)", () => {
		expect(editModeOf({ role: "editor", isGuest: false })).toBe("edit");
		expect(editModeOf({ role: "editor", isGuest: false }, true)).toBe(
			"suggest",
		);
		expect(editModeOf({ role: "suggester", isGuest: false })).toBe("suggest");
		expect(editModeOf({ role: "suggester", isGuest: true })).toBe("read");
		expect(editModeOf({ role: "editor", isGuest: true })).toBe("read");
		expect(editModeOf({ role: "viewer", isGuest: false })).toBe("read");
		expect(editModeOf({ role: "viewer", isGuest: true }, true)).toBe("read");
		// Raters are read-only outside their own rating (`useEditGuard('rate')`).
		expect(editModeOf({ role: "rater", isGuest: false })).toBe("read");
		expect(editModeOf({ role: "rater", isGuest: false }, true)).toBe("read");
		expect(editModeOf(null)).toBe("read");
	});
});
