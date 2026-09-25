/**
 * COLLAB-8 (EXTENSIONS §3.7): the ghost's accessible description says what the
 * suggestion does, not only its kind.
 */
import { describe, expect, it, vi } from "vitest";
import {
	demo,
	demoGraph,
	demoProposals,
	scenario,
} from "@/lib/engine/__fixtures__/demo";
import { applyProposals } from "@/lib/engine/proposals";

vi.mock("@/features/home/sharing.functions", () => ({
	addPlaceholder: vi.fn(),
}));

import { describeMark, ghostTitle } from "./proposal-ghost";

describe("describeMark", () => {
	it("uses the proposal's summary (where the move goes)", () => {
		const open = scenario.proposals.map((p) =>
			p.op === "item.move" && p.entityId === demo.I.itoya
				? { ...p, summary: "moved Itoya to Tue 5 Oct" }
				: p,
		);
		const mark = applyProposals(demoGraph, open).marks.get(
			`item:${demo.I.itoya}`,
		)?.[0];
		expect(mark && describeMark(mark)).toBe(
			"Suggested by Maya: moved Itoya to Tue 5 Oct",
		);
	});

	it("falls back to the kind without a summary", () => {
		expect(
			describeMark({
				proposalId: "p",
				op: "item.delete",
				kind: "delete",
				author: { userId: null, memberId: null, name: "Sue", color: 1 },
			}),
		).toBe("Suggested by Sue: delete");
	});
});

describe("ghostTitle (QA COLLAB-R2-09)", () => {
	const base = demoProposals.find((p) => p.op === "item.move");
	const update = (
		before: Record<string, string | number | null>,
		patch: Record<string, string | number | null>,
	) => {
		if (!base) throw new Error("no demo move");
		const p = {
			...base,
			id: "01a0cf12-13f1-77a3-b4e2-995b86c871cb",
			op: "item.update" as const,
			entityKind: "item" as const,
			entityId: demo.I.itoya as string,
			fields: Object.keys(before),
			before,
			payload: { itemId: demo.I.itoya as string, patch },
			author: { ...base.author, name: "Maya Suggester" },
			lastError: null,
		};
		const mark = applyProposals(demoGraph, [p]).marks.get(
			`item:${demo.I.itoya}`,
		)?.[0];
		if (!mark) throw new Error("no mark");
		return mark;
	};

	it("reads like the UI, not field names and minutes", () => {
		expect(ghostTitle(update({ durationMin: 240 }, { durationMin: 180 }))).toBe(
			"Maya: 4h → 3h",
		);
		expect(ghostTitle(update({ durationMin: 45 }, { durationMin: 90 }))).toBe(
			"Maya: 45m → 1h30",
		);
		expect(
			ghostTitle(update({ pinnedStart: "09:30" }, { pinnedStart: null })),
		).toBe("Maya: pinned start 09:30 → none");
		expect(ghostTitle(update({ title: "Lunch" }, { title: "Brunch" }))).toBe(
			"Maya: “Lunch” → “Brunch”",
		);
	});

	it("says 'was' without the new value, and nothing for other kinds", () => {
		const m = update({ durationMin: 240 }, {});
		expect(ghostTitle(m)).toBe("Maya: was 4h");
		expect(ghostTitle({ ...m, kind: "move" })).toBeUndefined();
	});
});
