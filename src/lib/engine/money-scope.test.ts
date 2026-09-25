import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import { demo, N } from "./__fixtures__/demo";
import { indexGraph } from "./graph-index";
import {
	budgetTree,
	commonPlace,
	daysTouching,
	expenseAnchor,
	inMoneyView,
	type MoneyTarget,
	onTarget,
	scopeCountry,
	targetLabel,
} from "./money-scope";

const ix = indexGraph(demo.graph);
const I = demo.I as Record<string, string>;
const DY = demo.D as Record<string, string>;
const L = demo.L as Record<string, string>;
const node = (k: string) => N[k] as string;

describe("anchors", () => {
	it("puts an item at its effective place and on its day", () => {
		const a = expenseAnchor(ix, { kind: "item", itemId: I.kiyomizu as string });
		expect(a.nodeId).toBe(node("kiyomizu"));
		expect(a.dayId).toBe(DY.d4);
	});

	it("puts a leg at its FROM endpoint", () => {
		const a = expenseAnchor(ix, { kind: "leg", legId: L.fuji as string });
		expect(a.nodeId).toBe(node("itoya"));
		expect(a.dayId).toBe(DY.d2);
	});

	it("puts a day at the common place of its stops", () => {
		expect(
			expenseAnchor(ix, { kind: "day", dayId: DY.d1 as string }).nodeId,
		).toBe(node("tokyo"));
		// Day 4: the ryokan (Fuji) and Kiyomizu (Kyoto) → Japan.
		expect(
			expenseAnchor(ix, { kind: "day", dayId: DY.d4 as string }).nodeId,
		).toBe(node("japan"));
		expect(commonPlace(ix, [node("hands"), node("loft")])).toBe(
			node("shibuya"),
		);
		expect(commonPlace(ix, [node("hands"), node("seoul")])).toBeNull();
	});

	it("keeps unknown targets trip-wide", () => {
		expect(
			expenseAnchor(ix, {
				kind: "item",
				itemId: "00000000-0000-7000-8000-00000000dead",
			}),
		).toEqual({
			nodeId: null,
			dayId: null,
		});
		expect(expenseAnchor(ix, { kind: "trip" })).toEqual({
			nodeId: null,
			dayId: null,
		});
	});
});

describe("views (MONEY-02)", () => {
	const kyotoItem: MoneyTarget = { kind: "item", itemId: I.kiyomizu as string };
	const fujiTrain: MoneyTarget = { kind: "leg", legId: L.fuji as string };
	const tokyoNode: MoneyTarget = { kind: "node", nodeId: node("tokyo") };
	const trip: MoneyTarget = { kind: "trip" };

	it("MONEY-02: a Kyoto item counts in the Kyoto and Japan rollups, not Tokyo", () => {
		expect(inMoneyView(ix, kyotoItem, { scopeId: node("kyoto") })).toBe(true);
		expect(inMoneyView(ix, kyotoItem, { scopeId: node("japan") })).toBe(true);
		expect(inMoneyView(ix, kyotoItem, { scopeId: null })).toBe(true);
		expect(inMoneyView(ix, kyotoItem, { scopeId: node("tokyo") })).toBe(false);
	});

	it("counts a leg once, at its from-endpoint", () => {
		expect(inMoneyView(ix, fujiTrain, { scopeId: node("tokyo") })).toBe(true);
		expect(inMoneyView(ix, fujiTrain, { scopeId: node("mtFuji") })).toBe(false);
	});

	it("'Only' keeps the scope's own costs", () => {
		expect(
			inMoneyView(ix, tokyoNode, { scopeId: node("tokyo"), only: true }),
		).toBe(true);
		expect(
			inMoneyView(ix, kyotoItem, { scopeId: node("tokyo"), only: true }),
		).toBe(false);
		expect(inMoneyView(ix, trip, { scopeId: null, only: true })).toBe(true);
		expect(inMoneyView(ix, tokyoNode, { scopeId: null, only: true })).toBe(
			false,
		);
		expect(inMoneyView(ix, trip, { scopeId: node("tokyo") })).toBe(false);
	});

	it("follows a day range", () => {
		const d1 = ix.day(DY.d1)?.date as string;
		const d4 = ix.day(DY.d4)?.date as string;
		expect(
			inMoneyView(ix, kyotoItem, { scopeId: null, days: { from: d4, to: d4 } }),
		).toBe(true);
		expect(
			inMoneyView(ix, kyotoItem, { scopeId: null, days: { from: d1, to: d1 } }),
		).toBe(false);
		// A Tokyo-wide cost shows when the range visits Tokyo.
		expect(
			inMoneyView(ix, tokyoNode, { scopeId: null, days: { from: d1, to: d1 } }),
		).toBe(true);
		expect(
			inMoneyView(ix, tokyoNode, { scopeId: null, days: { from: d4, to: d4 } }),
		).toBe(false);
		expect(
			inMoneyView(ix, trip, { scopeId: null, days: { from: d1, to: d4 } }),
		).toBe(false);
	});

	it("matches inspector targets", () => {
		expect(
			onTarget(ix, kyotoItem, { kind: "day", dayId: DY.d4 as string }),
		).toBe(true);
		expect(
			onTarget(ix, kyotoItem, { kind: "node", nodeId: node("kyoto") }),
		).toBe(true);
		expect(
			onTarget(ix, kyotoItem, { kind: "item", itemId: I.kiyomizu as string }),
		).toBe(true);
		expect(
			onTarget(ix, kyotoItem, { kind: "item", itemId: I.hands as string }),
		).toBe(false);
		expect(
			onTarget(ix, fujiTrain, { kind: "leg", legId: L.fuji as string }),
		).toBe(true);
	});
});

describe("budget tree, days and labels", () => {
	it("counts the days whose schedule touches a scope", () => {
		expect(daysTouching(ix, null)).toBe(ix.days.length);
		expect(daysTouching(ix, node("tokyo"))).toBeGreaterThanOrEqual(2);
		expect(daysTouching(ix, node("kyoto"))).toBe(1);
		expect(daysTouching(ix, node("taiwan"))).toBe(0);
		const t = budgetTree(ix);
		expect(t.parentOf(node("tokyo"))).toBe(node("japan"));
		expect(t.parentOf(node("japan"))).toBeNull();
		expect(t.parentOf("nope")).toBeUndefined();
		expect(t.daysIn(node("kyoto"))).toBe(1);
	});

	it("finds the country of a scope for the Local display currency", () => {
		expect(scopeCountry(ix, node("shibuya"))).toBe("JP");
		expect(scopeCountry(ix, node("seoul"))).toBe("KR");
		expect(scopeCountry(ix, null)).toBeNull();
	});

	it("labels targets", () => {
		expect(targetLabel(ix, { kind: "trip" })).toBe("Trip-wide");
		expect(targetLabel(ix, { kind: "day", dayId: DY.d2 as string })).toBe(
			"Day 2",
		);
		expect(targetLabel(ix, { kind: "leg", legId: L.handsLoft as string })).toBe(
			"Hands Shibuya → Shibuya Loft",
		);
		expect(targetLabel(ix, { kind: "item", itemId: I.lunch1 as string })).toBe(
			"Lunch",
		);
	});
});
