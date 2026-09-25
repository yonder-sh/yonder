import { describe, expect, it } from "vitest";
import type { GraphMember } from "@/lib/engine/types";
import {
	dueAudience,
	memberUserIds,
	planAudience,
	reviewAudience,
	selectRecipients,
	todoAudience,
	wants,
} from "./recipients";

const TRIP = "00000000-0000-7000-8000-000000000001";
const OTHER_TRIP = "00000000-0000-7000-8000-000000000002";

const m = (
	id: string,
	userId: string | null,
	status: GraphMember["status"] = "active",
	extra: Partial<GraphMember> = {},
): GraphMember => ({
	id,
	userId,
	status,
	role: "editor",
	name: id,
	color: 0,
	...extra,
});

const members: GraphMember[] = [
	m("m-dennis", "u-dennis"),
	m("m-maya", "u-maya"),
	m("m-kai", "u-kai"),
	m("m-audrey", null, "placeholder"),
	m("m-invite", null, "invited"),
	m("m-old", null, "removed", { name: "Old" }),
	// A placeholder merged into Kai: its old id resolves to Kai.
	m("m-kai-ph", null, "removed", { mergedIntoId: "m-kai" }),
];

describe("selectRecipients", () => {
	const all = new Set(["u-dennis", "u-maya", "u-kai"]);

	it("never the actor, only subscribed people, deduplicated", () => {
		expect(
			selectRecipients(["u-dennis", "u-maya", "u-maya", "u-zed", null], {
				type: "mention",
				tripId: TRIP,
				actorUserIds: ["u-dennis"],
				subscribed: all,
				prefs: new Map(),
			}),
		).toEqual(["u-maya"]);
	});

	it("respects the per-type switch and the per-trip mute", () => {
		const prefs = new Map([
			["u-maya", { offTypes: ["review"], mutedTripIds: [] }],
			["u-kai", { offTypes: [], mutedTripIds: [TRIP] }],
		]);
		const pick = (type: "review" | "mention", tripId = TRIP) =>
			selectRecipients(["u-dennis", "u-maya", "u-kai"], {
				type,
				tripId,
				subscribed: all,
				prefs,
			});
		expect(pick("review")).toEqual(["u-dennis"]);
		expect(pick("mention")).toEqual(["u-dennis", "u-maya"]);
		// Kai muted only this trip.
		expect(pick("mention", OTHER_TRIP)).toEqual([
			"u-dennis",
			"u-maya",
			"u-kai",
		]);
	});

	it("no stored prefs means every type is on (opt-out)", () => {
		expect(wants(undefined, "countdown", TRIP)).toBe(true);
		expect(
			wants({ offTypes: ["countdown"], mutedTripIds: [] }, "countdown", TRIP),
		).toBe(false);
	});
});

describe("audiences", () => {
	it("memberUserIds: active accounts only; merged ids resolve", () => {
		expect(memberUserIds(members).sort()).toEqual([
			"u-dennis",
			"u-kai",
			"u-maya",
		]);
		expect(
			memberUserIds(members, ["m-audrey", "m-invite", "m-old", "m-kai-ph"]),
		).toEqual(["u-kai"]);
	});

	it("booking windows: private → author only; assigned → assignees; else everyone", () => {
		expect(
			todoAudience(
				{ isPrivate: true, createdBy: "u-maya", assigneeIds: ["m-kai"] },
				members,
			),
		).toEqual(["u-maya"]);
		// A private to-do of someone who left the trip tells nobody.
		expect(
			todoAudience(
				{ isPrivate: true, createdBy: "u-gone", assigneeIds: [] },
				members,
			),
		).toEqual([]);
		expect(
			todoAudience(
				{ isPrivate: false, createdBy: "u-dennis", assigneeIds: ["m-maya"] },
				members,
			),
		).toEqual(["u-maya"]);
		expect(
			todoAudience(
				{ isPrivate: false, createdBy: "u-dennis", assigneeIds: [] },
				members,
			).sort(),
		).toEqual(["u-dennis", "u-kai", "u-maya"]);
	});

	it("due reminders: assigned to-dos only (private: the author)", () => {
		expect(
			dueAudience(
				{ isPrivate: false, createdBy: "u-dennis", assigneeIds: [] },
				members,
			),
		).toEqual([]);
		expect(
			dueAudience(
				{ isPrivate: false, createdBy: "u-dennis", assigneeIds: ["m-kai"] },
				members,
			),
		).toEqual(["u-kai"]);
		expect(
			dueAudience(
				{ isPrivate: true, createdBy: "u-dennis", assigneeIds: ["m-dennis"] },
				members,
			),
		).toEqual(["u-dennis"]);
	});

	it("plan changes: its travellers, or everyone when nobody is assigned", () => {
		expect(planAudience(["m-maya"], members)).toEqual(["u-maya"]);
		expect(planAudience([], members)).toHaveLength(3);
	});

	it("suggestions: owners, editors and link editors; never the author", () => {
		const people = [
			{ userId: "u-owner", access: { role: "owner" as const, isGuest: false } },
			{
				userId: "u-editor",
				access: { role: "editor" as const, isGuest: false },
			},
			{
				userId: "u-sugg",
				access: { role: "suggester" as const, isGuest: false },
			},
			{ userId: "u-view", access: { role: "viewer" as const, isGuest: false } },
			{
				userId: "u-guested",
				access: { role: "editor" as const, isGuest: true },
			},
			{
				userId: "u-guestsug",
				access: { role: "suggester" as const, isGuest: true },
			},
		];
		expect(reviewAudience(people, "u-editor")).toEqual([
			"u-owner",
			"u-guested",
		]);
	});
});
