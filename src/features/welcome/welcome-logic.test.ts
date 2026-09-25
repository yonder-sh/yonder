/** The welcome's button and words (welcome-logic.ts). */
import { describe, expect, it } from "vitest";
import type { GraphMember } from "@/lib/engine/types";
import {
	accessRequest,
	datesLine,
	primaryAction,
	whoLine,
} from "./welcome-logic";

describe("primaryAction", () => {
	it("rate first, then add, else see the plan", () => {
		expect(
			primaryAction({ canRate: true, myLeft: 48, canEdit: true, places: 48 }),
		).toEqual({ kind: "rate", label: "Rate 48 places" });
		expect(
			primaryAction({ canRate: true, myLeft: 1, canEdit: false, places: 9 }),
		).toEqual({ kind: "rate", label: "Rate 1 place" });
		expect(
			primaryAction({ canRate: true, myLeft: 0, canEdit: true, places: 0 }),
		).toEqual({ kind: "add", label: "Add a place you want to go" });
		// All rated, or you only view: the plan.
		expect(
			primaryAction({ canRate: true, myLeft: 0, canEdit: true, places: 9 }),
		).toMatchObject({ kind: "plan", label: "See the plan" });
		expect(
			primaryAction({
				canRate: false,
				myLeft: null,
				canEdit: false,
				places: 0,
			}),
		).toMatchObject({ kind: "plan" });
	});
});

describe("datesLine", () => {
	it("one month, two months, one day, none", () => {
		expect(datesLine("2027-10-01", "2027-10-14")).toBe("Fri 1 – Thu 14 Oct");
		expect(datesLine("2027-09-30", "2027-10-06")).toBe(
			"Thu 30 Sep – Wed 6 Oct",
		);
		expect(datesLine("2027-10-01", "2027-10-01")).toBe("Fri 1 Oct");
		expect(datesLine(null, null)).toBe("No dates yet");
	});
});

describe("whoLine", () => {
	const m = (id: string, name: string, extra: Partial<GraphMember> = {}) =>
		({
			id,
			userId: `u-${id}`,
			status: "active",
			role: "editor",
			name,
			firstName: name.split(" ")[0],
			color: 0,
			...extra,
		}) as GraphMember;
	const members = [
		m("maya", "Maya Chen"),
		m("dennis", "Dennis Pham", { role: "owner" }),
		m("audrey", "Audrey", { userId: null, status: "placeholder" }),
		m("me", "Sam Lee"),
		m("gone", "Old", { status: "removed", userId: null }),
	];

	it("the inviter, then who else is in (not you, not the inviter)", () => {
		expect(
			whoLine({
				members,
				me: "me",
				meUserId: "u-me",
				via: "invite",
				invitedBy: "Maya",
				inviterUserId: "u-maya",
			}),
		).toBe("Maya invited you · with Dennis and Audrey");
	});

	it("the trip link, and a guest who is no member", () => {
		expect(
			whoLine({
				members,
				me: null,
				meUserId: "guest-1",
				via: "link",
				invitedBy: null,
			}),
		).toBe(
			"You're joining through the trip link · with Maya, Dennis, Audrey and Sam",
		);
	});

	it("many people: three names and how many more", () => {
		const lots = ["A", "B", "C", "D", "E", "F"].map((n) => m(n, n));
		expect(
			whoLine({
				members: lots,
				me: null,
				meUserId: "x",
				via: null,
				invitedBy: null,
			}),
		).toBe("With A, B, C and 3 more");
		expect(
			whoLine({
				members: [],
				me: null,
				meUserId: "x",
				via: null,
				invitedBy: null,
			}),
		).toBeNull();
	});
});

it("the access request names the owner, the trip and its address", () => {
	expect(
		accessRequest({
			owner: "Dennis",
			trip: "Summer in Japan",
			url: "https://yonder.sh/t/summer-k7m2qxw9",
		}),
	).toBe(
		"Hi Dennis, could you give me edit access to Summer in Japan? https://yonder.sh/t/summer-k7m2qxw9",
	);
});
