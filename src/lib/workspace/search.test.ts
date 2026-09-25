import { describe, expect, it } from "vitest";
import {
	extendRange,
	parseDays,
	parseSel,
	type Sel,
	serializeDays,
	serializeSel,
	splitScopePath,
	WorkspaceSearch,
} from "./search";

const A = "00000000-0000-7000-8000-000000000101";
const B = "00000000-0000-7000-8000-000000000102";

describe("WorkspaceSearch (SPEC §12.1)", () => {
	it("keeps valid params", () => {
		expect(
			WorkspaceSearch.parse({
				lens: "area",
				days: "2027-04-13",
				tab: "media",
				only: 1,
				sel: `n.${A}`,
			}),
		).toEqual({
			lens: "area",
			days: "2027-04-13",
			tab: "media",
			only: 1,
			sel: `n.${A}`,
		});
	});

	it("drops invalid values instead of throwing", () => {
		expect(
			WorkspaceSearch.parse({
				lens: "planet",
				days: "tomorrow",
				sel: "n.<script>",
				who: "x",
				only: 2,
			}),
		).toEqual({});
	});
});

describe("sel encoding", () => {
	const cases: [string, Sel][] = [
		["root", { kind: "root" }],
		[`n.${A}`, { kind: "node", id: A }],
		[`i.${A}`, { kind: "item", id: A }],
		[`d.${A}`, { kind: "day", id: A }],
		[`e.${A}.${B}`, { kind: "edge", from: A, to: B }],
		[
			`l.${A}.${B}`,
			{ kind: "leg", target: { kind: "pair", fromItemId: A, toItemId: B } },
		],
		[
			`s.${A}.end`,
			{ kind: "leg", target: { kind: "stay", dayId: A, end: "end" } },
		],
	];
	it.each(cases)("%s round-trips", (raw, sel) => {
		expect(parseSel(raw)).toEqual(sel);
		expect(serializeSel(sel)).toBe(raw);
	});

	it("rejects malformed values", () => {
		expect(parseSel("n.abc")).toBeNull();
		expect(parseSel(`x.${A}`)).toBeNull();
		expect(parseSel(`s.${A}.middle`)).toBeNull();
	});
});

describe("days", () => {
	it("parses one day or a range, ordered", () => {
		expect(parseDays("2027-10-05")).toEqual({
			from: "2027-10-05",
			to: "2027-10-05",
		});
		expect(parseDays("2027-10-07..2027-10-05")).toEqual({
			from: "2027-10-05",
			to: "2027-10-07",
		});
		expect(parseDays("nope")).toBeNull();
		expect(serializeDays({ from: "2027-10-05", to: "2027-10-05" })).toBe(
			"2027-10-05",
		);
		expect(serializeDays({ from: "2027-10-05", to: "2027-10-07" })).toBe(
			"2027-10-05..2027-10-07",
		);
	});

	it("extends a range with shift-click", () => {
		expect(extendRange(null, "2027-10-05")).toEqual({
			from: "2027-10-05",
			to: "2027-10-05",
		});
		expect(
			extendRange({ from: "2027-10-05", to: "2027-10-05" }, "2027-10-08"),
		).toEqual({
			from: "2027-10-05",
			to: "2027-10-08",
		});
		expect(
			extendRange({ from: "2027-10-05", to: "2027-10-08" }, "2027-10-03"),
		).toEqual({
			from: "2027-10-03",
			to: "2027-10-08",
		});
	});

	it("splits the scope path", () => {
		expect(splitScopePath("japan/tokyo/")).toEqual(["japan", "tokyo"]);
		expect(splitScopePath("")).toEqual([]);
		expect(splitScopePath("caf%C3%A9")).toEqual(["café"]);
	});
});
