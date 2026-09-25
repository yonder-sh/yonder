/**
 * QA PLAN-R2-08 (ADDENDUM §8): "Add “Zed” as a new person" in a field that
 * saves later only makes a PENDING chip. The placeholder is created when a
 * save carries it (`useTripMutation` → create, then swap the ids), so a
 * cancelled comment leaves nobody on the trip.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mentionToken, parseMentionIds } from "@/lib/notes/mentions";
import {
	createPendingPeople,
	pendingPerson,
	pendingPersonId,
	resetPendingPeople,
	swapPendingPeople,
} from "../pending-people";

const TRIP = "01a0cd9b-31b0-71a1-b351-bbe524456f00";
const ZED = "01a0cd9b-31b0-71a1-b351-bbe524456fb9";
const MAYA = "01a0cd9b-31b0-71a1-b351-bbe524456fb0";

afterEach(() => resetPendingPeople());

describe("pending people", () => {
	it("a pending id is a well-formed mention id, the same for the same name on the trip", () => {
		const id = pendingPersonId(TRIP, "Zed");
		expect(parseMentionIds(mentionToken("Zed", id))).toEqual([id]);
		expect(pendingPersonId(TRIP, " zed ")).toBe(id);
		expect(
			pendingPersonId("01a0cd9b-31b0-71a1-b351-bbe524456f01", "Zed"),
		).not.toBe(id);
		expect(pendingPerson(id)).toEqual({ name: "Zed", memberId: null });
		expect(pendingPerson(MAYA)).toBeNull();
	});

	it("nothing is created until a save carries the chip (a cancelled comment adds nobody)", async () => {
		const create = vi.fn(async () => ZED);
		pendingPersonId(TRIP, "Zed"); // picked in the popup, then Cancel
		const vars = { nodeId: "n", comment: `ask ${mentionToken("Maya", MAYA)}` };
		await createPendingPeople(vars, null, create);
		expect(create).not.toHaveBeenCalled();
		expect(swapPendingPeople(vars)).toBe(vars);
	});

	it("a save creates the person once and sends the real id", async () => {
		const create = vi.fn(async () => ZED);
		const pending = pendingPersonId(TRIP, "Zed");
		const vars = {
			nodeId: "n",
			comment: `ask ${mentionToken("Zed", pending)} and ${mentionToken("Maya", MAYA)}`,
			nested: [{ note: `${mentionToken("Zed", pending)} again` }],
			when: 3,
		};
		// Two saves at once share one creation.
		await Promise.all([
			createPendingPeople(vars, null, create),
			createPendingPeople(vars, null, create),
		]);
		expect(create).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith(TRIP, "Zed");
		const sent = swapPendingPeople(vars);
		expect(sent.comment).toBe(
			`ask ${mentionToken("Zed", ZED)} and ${mentionToken("Maya", MAYA)}`,
		);
		expect(sent.nested[0]?.note).toBe(`${mentionToken("Zed", ZED)} again`);
		expect(sent.when).toBe(3);
		expect(vars.comment).toContain(pending); // the caller's object is untouched
		expect(pendingPerson(pending)).toEqual({ name: "Zed", memberId: ZED });
		// A later save (a retry, the same field saved again) reuses the person.
		await createPendingPeople(vars, null, create);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("when creating fails, the save keeps the name as plain text (never an unknown id)", async () => {
		const pending = pendingPersonId(TRIP, "Zed");
		const vars = { text: `gift for ${mentionToken("Zed", pending)}` };
		await createPendingPeople(vars, null, async () => {
			throw new Error("rate limited");
		});
		expect(swapPendingPeople(vars).text).toBe("gift for @Zed");
		// Picking the name again starts over.
		expect(pendingPersonId(TRIP, "Zed")).not.toBe(pending);
	});

	it("refetches the trip's graph (and sharing) once people were created", async () => {
		const pending = pendingPersonId(TRIP, "Zed");
		const qc = {
			invalidateQueries: vi.fn(async () => undefined),
			refetchQueries: vi.fn(async () => undefined),
		};
		await createPendingPeople(
			{ text: mentionToken("Zed", pending) },
			qc as never,
			async () => ZED,
		);
		expect(qc.refetchQueries).toHaveBeenCalledWith({
			queryKey: ["trip", TRIP, "graph"],
			exact: true,
		});
		expect(qc.invalidateQueries).toHaveBeenCalledWith({
			queryKey: ["trip", TRIP, "sharing"],
		});
	});
});
