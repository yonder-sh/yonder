import { describe, expect, it } from "vitest";
import type { GraphMember } from "@/lib/engine/types";
import { savedAtLabel } from "../../offline/OfflineBanner";
import { matchingPlaceholder, nameMatchesPerson } from "../claim-match";
import { dayCount } from "../Dashboard";
import { likelyPlaceholder } from "../GuestNudge";

const m = (id: string, name: string, status: GraphMember["status"]) =>
	({ id, name, status, role: "viewer", userId: null, color: 0 }) as GraphMember;

describe("'Are you Audrey?' (ADDENDUM §10 claim prompt)", () => {
	const members = [
		m("1", "Dennis Pham", "active"),
		m("2", "Audrey", "placeholder"),
		m("3", "Kai", "placeholder"),
		m("4", "Audrey", "removed"),
	];
	it("matches a placeholder by first or full name, case-insensitively", () => {
		expect(
			likelyPlaceholder(members, { name: "Audrey Nguyen", firstName: "audrey" })
				?.id,
		).toBe("2");
		expect(likelyPlaceholder(members, { name: "Kai" })?.id).toBe("3");
	});
	it("stays quiet without a single clear match", () => {
		expect(likelyPlaceholder(members, { name: "Maya Chen" })).toBeNull();
		expect(
			likelyPlaceholder([...members, m("5", "audrey", "placeholder")], {
				name: "Audrey N",
			}),
		).toBeNull();
	});
});

describe("claim-match (the server's claim and promote checks use it too)", () => {
	it("matches a placeholder by the person's full or first name only", () => {
		const audrey = { name: "Audrey  Nguyen", firstName: "Audrey" };
		expect(nameMatchesPerson("audrey", audrey)).toBe(true);
		expect(nameMatchesPerson(" Audrey Nguyen ", audrey)).toBe(true);
		expect(nameMatchesPerson("Kai", audrey)).toBe(false);
		expect(nameMatchesPerson("", audrey)).toBe(false);
		// No first name on file: the first word of the name.
		expect(nameMatchesPerson("Mallory", { name: "Mallory Stranger" })).toBe(
			true,
		);
		expect(nameMatchesPerson("Audrey", { name: "Mallory Stranger" })).toBe(
			false,
		);
	});
	it("prefers a full-name match, else the only first-name one", () => {
		const list = [
			m("1", "Audrey", "placeholder"),
			m("2", "Audrey Nguyen", "placeholder"),
			m("3", "Audrey Nguyen", "active"),
		];
		expect(
			matchingPlaceholder(list, { name: "Audrey Nguyen", firstName: "Audrey" })
				?.id,
		).toBe("2");
		expect(
			matchingPlaceholder(list, { name: "Audrey Smith", firstName: "Audrey" })
				?.id,
		).toBe("1");
		expect(matchingPlaceholder(list, { name: "Kai Tan" })).toBeNull();
	});
});

describe("dashboard day count (QA HOME-7)", () => {
	it("says '1 day', never '1 days'", () => {
		expect(dayCount(1)).toBe("1 day");
		expect(dayCount(37)).toBe("37 days");
	});
});

describe("offline banner time", () => {
	it("shows the time today and the day before that", () => {
		const now = new Date(2027, 9, 5, 18, 0).getTime();
		expect(savedAtLabel(new Date(2027, 9, 5, 14, 2).getTime(), now)).toMatch(
			/14.02/,
		);
		expect(savedAtLabel(new Date(2027, 9, 3, 9, 30).getTime(), now)).toMatch(
			/3/,
		);
	});
});
