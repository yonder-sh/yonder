import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import type { ExpenseCategory } from "@/lib/schemas/enums";
import {
	type BudgetInput,
	type BudgetLine,
	type BudgetTree,
	budgetCategories,
	budgetCell,
	budgetNotices,
	defaultLine,
	effectiveBudget,
	groupBudgetCell,
	isWithin,
	lineAmount,
	nearestBudgeted,
	type Spend,
} from "./money-budget";

/**
 * A small tree: root ─ japan ─ kansai ─ kyoto
 *                          │         └ osaka
 *                          ├ tokyo ─ shibuya
 *                          └ fuji
 *                   korea ─ seoul
 */
const PARENT: Record<string, string | null> = {
	japan: null,
	tokyo: "japan",
	shibuya: "tokyo",
	kansai: "japan",
	kyoto: "kansai",
	osaka: "kansai",
	fuji: "japan",
	korea: null,
	seoul: "korea",
};
const DAYS: Record<string, number> = {
	japan: 20,
	tokyo: 8,
	shibuya: 3,
	kansai: 7,
	kyoto: 5,
	osaka: 2,
	fuji: 2,
	korea: 6,
	seoul: 6,
};
const tree: BudgetTree = {
	parentOf: (id) => (id in PARENT ? (PARENT[id] ?? null) : undefined),
	daysIn: (id) => (id === null ? 30 : (DAYS[id] ?? 0)),
};

const D = "dennis";
const A = "audrey";
const M = "maya";

let n = 0;
const line = (l: Partial<BudgetLine>): BudgetLine => ({
	id: `b${++n}`,
	nodeId: null,
	category: null,
	memberId: null,
	amountMinor: 0,
	kind: "total",
	defaultSeenMinor: null,
	...l,
});

/** Spending: member → node → category → Spend (subtree sums computed below). */
type Row = {
	member: string;
	node: string | null;
	category: ExpenseCategory;
	planned: number;
	actual: number;
};
function spender(rows: Row[]) {
	return (
		memberId: string,
		nodeId: string | null,
		category: ExpenseCategory | null,
	): Spend => {
		let planned = 0;
		let actual = 0;
		for (const r of rows) {
			if (r.member !== memberId) continue;
			if (category !== null && r.category !== category) continue;
			if (!isWithin(tree, r.node, nodeId)) continue;
			planned += r.planned;
			actual += r.actual;
		}
		return { planned, actual };
	};
}

const input = (lines: BudgetLine[], rows: Row[] = []): BudgetInput => ({
	lines,
	tree,
	spend: spender(rows),
});

describe("effective values (default + personal override)", () => {
	const def = line({ amountMinor: 350_000 });
	const mine = line({
		memberId: D,
		amountMinor: 300_000,
		defaultSeenMinor: 350_000,
	});
	const lines = [def, mine];

	it("inherits the default unless the member has a custom line", () => {
		expect(effectiveBudget(lines, D, null, null)).toBe(mine);
		expect(effectiveBudget(lines, A, null, null)).toBe(def);
		expect(effectiveBudget(lines, A, "japan", null)).toBeNull();
		expect(defaultLine(lines, null, null)).toBe(def);
	});

	it("labels custom vs default and reports no notice while the default is unchanged", () => {
		const cd = budgetCell(input(lines), D, null, null);
		expect(cd.source).toBe("custom");
		expect(cd.amount).toBe(300_000);
		expect(cd.notice).toBeNull();
		const ca = budgetCell(input(lines), A, null, null);
		expect(ca.source).toBe("default");
		expect(ca.amount).toBe(350_000);
	});

	it("MONEY-17: a changed default moves inheriting members and notifies a custom one", () => {
		const changed = [{ ...def, amountMinor: 380_000 }, mine];
		expect(budgetCell(input(changed), A, null, null).amount).toBe(380_000);
		const cd = budgetCell(input(changed), D, null, null);
		expect(cd.amount).toBe(300_000);
		expect(cd.notice).toEqual({ defaultMinor: 380_000, mineMinor: 300_000 });
		expect(budgetNotices(changed, D)).toHaveLength(1);
		expect(budgetNotices(changed, A)).toHaveLength(0);
		// Setting the line again (seen = the new default) dismisses it.
		const reset = [
			{ ...def, amountMinor: 380_000 },
			{ ...mine, defaultSeenMinor: 380_000 },
		];
		expect(budgetCell(input(reset), D, null, null).notice).toBeNull();
	});

	it("deleting a default drops it for inheriting members; custom lines stay", () => {
		const cd = budgetCell(input([mine]), D, null, null);
		expect(cd.amount).toBe(300_000);
		expect(cd.notice).toBeNull();
		expect(budgetCell(input([mine]), A, null, null).source).toBe("none");
	});

	it("allows personal-only lines with no default", () => {
		const own = line({ memberId: A, nodeId: "seoul", amountMinor: 50_000 });
		expect(budgetCell(input([own]), A, "seoul", null).source).toBe("custom");
		expect(budgetCell(input([own]), D, "seoul", null).source).toBe("none");
	});

	it("multiplies per-day lines by the days touching the scope", () => {
		const pd = line({ nodeId: "tokyo", amountMinor: 10_000, kind: "per_day" });
		expect(lineAmount(pd, tree)).toBe(80_000);
		const c = budgetCell(input([pd]), A, "tokyo", null);
		expect(c.amount).toBe(80_000);
		expect(c.perDay).toEqual({ rate: 10_000, days: 8 });
		expect(lineAmount(line({ amountMinor: 5000, kind: "per_day" }), tree)).toBe(
			150_000,
		);
	});
});

describe("hierarchy (MONEY-18)", () => {
	it("finds the nearest budgeted descendants only", () => {
		expect(
			nearestBudgeted(tree, null, new Set(["japan", "kyoto", "tokyo"])),
		).toEqual(["japan"]);
		expect(
			nearestBudgeted(
				tree,
				"japan",
				new Set(["japan", "kyoto", "tokyo", "shibuya"]),
			),
		).toEqual(["kyoto", "tokyo"]);
		expect(nearestBudgeted(tree, "kansai", new Set(["tokyo"]))).toEqual([]);
		expect(isWithin(tree, "shibuya", "japan")).toBe(true);
		expect(isWithin(tree, "seoul", "japan")).toBe(false);
		expect(isWithin(tree, null, "japan")).toBe(false);
		expect(isWithin(tree, "nowhere", null)).toBe(true);
	});

	it("parent + children: allocated, unallocated, no warning when within", () => {
		const lines = [
			line({ nodeId: "japan", amountMinor: 200_000 }),
			line({ nodeId: "tokyo", amountMinor: 80_000 }),
			line({ nodeId: "kyoto", amountMinor: 50_000 }),
		];
		const c = budgetCell(input(lines), A, "japan", null);
		expect(c.source).toBe("default");
		expect(c.allocated).toBe(130_000);
		expect(c.unallocated).toBe(70_000);
		expect(c.overAllocated).toBe(false);
		expect(c.children.map((k) => k.nodeId)).toEqual(["kyoto", "tokyo"]);
	});

	it("warns when the children add up to more than the parent", () => {
		const lines = [
			line({ nodeId: "japan", amountMinor: 100_000 }),
			line({ nodeId: "tokyo", amountMinor: 80_000 }),
			line({ nodeId: "kyoto", amountMinor: 50_000 }),
		];
		const c = budgetCell(input(lines), A, "japan", null);
		expect(c.overAllocated).toBe(true);
		expect(c.unallocated).toBe(-30_000);
	});

	it("children only: the parent's budget is derived and the rest is unbudgeted", () => {
		const lines = [
			line({ nodeId: "tokyo", amountMinor: 80_000 }),
			line({ nodeId: "kyoto", amountMinor: 50_000 }),
		];
		const rows: Row[] = [
			{
				member: A,
				node: "shibuya",
				category: "food_drink",
				planned: 10_000,
				actual: 4000,
			},
			{
				member: A,
				node: "kyoto",
				category: "lodging",
				planned: 30_000,
				actual: 30_000,
			},
			{
				member: A,
				node: "fuji",
				category: "activities",
				planned: 7000,
				actual: 0,
			},
			{
				member: A,
				node: "japan",
				category: "transport",
				planned: 3000,
				actual: 3000,
			},
			{
				member: D,
				node: "fuji",
				category: "activities",
				planned: 99_000,
				actual: 0,
			},
		];
		const c = budgetCell(input(lines, rows), A, "japan", null);
		expect(c.source).toBe("derived");
		expect(c.amount).toBe(130_000);
		expect(c.spent).toEqual({ planned: 50_000, actual: 37_000 });
		expect(c.unbudgeted).toEqual({ planned: 10_000, actual: 3000 });
		// Compared against its budgeted parts only (QA MONEY-QA-06).
		expect(c.budgeted).toEqual({ planned: 40_000, actual: 34_000 });
		// The root derives from Japan's derived parts, never twice.
		const root = budgetCell(input(lines, rows), A, null, null);
		expect(root.source).toBe("derived");
		expect(root.amount).toBe(130_000);
	});

	it("QA MONEY-QA-06: a derived category budget isn't 'over' because of unbudgeted spend", () => {
		// Kyoto food has its own $10 line; Osaka food has none; nothing above.
		const lines = [
			line({ nodeId: "kyoto", category: "food_drink", amountMinor: 1000 }),
		];
		const rows: Row[] = [
			{
				member: D,
				node: "kyoto",
				category: "food_drink",
				planned: 952,
				actual: 952,
			},
			{
				member: D,
				node: "osaka",
				category: "food_drink",
				planned: 1903,
				actual: 1903,
			},
		];
		const root = budgetCell(input(lines, rows), D, null, "food_drink");
		expect(root.source).toBe("derived");
		expect(root.amount).toBe(1000);
		expect(root.budgeted.planned).toBe(952);
		expect(root.unbudgeted?.planned).toBe(1903);
		expect(root.spent.planned).toBe(952 + 1903);
		// The group's derived cell compares the same way.
		const g = groupBudgetCell(
			input(lines, rows),
			[D],
			new Set(),
			null,
			"food_drink",
		);
		expect(g.budgeted.planned).toBe(952);
		// An explicit line still compares against everything in its scope.
		const kyoto = budgetCell(input(lines, rows), D, "kyoto", "food_drink");
		expect(kyoto.budgeted).toEqual(kyoto.spent);
	});

	it("a budgeted child under an unbudgeted middle level still counts once", () => {
		const lines = [
			line({ nodeId: "japan", amountMinor: 100_000 }),
			line({ nodeId: "kyoto", amountMinor: 30_000 }),
		];
		const c = budgetCell(input(lines), M, "japan", null);
		expect(c.allocated).toBe(30_000);
		const kansai = budgetCell(input(lines), M, "kansai", null);
		expect(kansai.source).toBe("derived");
		expect(kansai.amount).toBe(30_000);
	});

	it("categories are allocations inside the scope's all line", () => {
		const lines = [
			line({ nodeId: "japan", amountMinor: 100_000 }),
			line({ nodeId: "japan", category: "food_drink", amountMinor: 60_000 }),
			line({ nodeId: "japan", category: "lodging", amountMinor: 50_000 }),
		];
		const c = budgetCell(input(lines), A, "japan", null);
		expect(c.categoryAllocated).toBe(110_000);
		expect(c.categoryOverAllocated).toBe(true);
		const food = budgetCell(input(lines), A, "japan", "food_drink");
		expect(food.amount).toBe(60_000);
		expect(food.source).toBe("default");
	});

	it("categories only: the all budget is derived from them", () => {
		const lines = [
			line({ nodeId: "tokyo", category: "food_drink", amountMinor: 20_000 }),
		];
		const rows: Row[] = [
			{
				member: A,
				node: "tokyo",
				category: "food_drink",
				planned: 15_000,
				actual: 5000,
			},
			{
				member: A,
				node: "shibuya",
				category: "shopping",
				planned: 8000,
				actual: 8000,
			},
		];
		const c = budgetCell(input(lines, rows), A, "tokyo", null);
		expect(c.source).toBe("derived");
		expect(c.amount).toBe(20_000);
		expect(c.unbudgeted).toEqual({ planned: 8000, actual: 8000 });
	});

	it("per-category hierarchy across places works the same way", () => {
		const lines = [
			line({ nodeId: "japan", category: "food_drink", amountMinor: 80_000 }),
			line({ nodeId: "tokyo", category: "food_drink", amountMinor: 30_000 }),
			line({ nodeId: "kyoto", category: "food_drink", amountMinor: 60_000 }),
		];
		const c = budgetCell(input(lines), A, "japan", "food_drink");
		expect(c.allocated).toBe(90_000);
		expect(c.overAllocated).toBe(true);
	});

	it("a member's own child lines count in their hierarchy, not in others'", () => {
		const lines = [
			line({ nodeId: "japan", amountMinor: 100_000 }),
			line({ nodeId: "tokyo", memberId: D, amountMinor: 120_000 }),
		];
		expect(budgetCell(input(lines), D, "japan", null).overAllocated).toBe(true);
		expect(budgetCell(input(lines), A, "japan", null).overAllocated).toBe(
			false,
		);
	});
});

describe("group totals and visibility", () => {
	const lines = [
		line({ amountMinor: 300_000 }),
		line({ memberId: D, amountMinor: 250_000 }),
		line({ memberId: M, amountMinor: 500_000 }),
	];
	const rows: Row[] = [
		{
			member: D,
			node: "tokyo",
			category: "food_drink",
			planned: 10_000,
			actual: 10_000,
		},
		{
			member: A,
			node: "tokyo",
			category: "food_drink",
			planned: 20_000,
			actual: 0,
		},
		{
			member: M,
			node: "tokyo",
			category: "food_drink",
			planned: 30_000,
			actual: 0,
		},
	];

	it("sums every visible member's effective budget and share", () => {
		const g = groupBudgetCell(
			input(lines, rows),
			[D, A, M],
			new Set(),
			null,
			null,
		);
		expect(g.amount).toBe(250_000 + 300_000 + 500_000);
		expect(g.spent).toEqual({ planned: 60_000, actual: 10_000 });
		expect(g.members).toHaveLength(3);
	});

	it("leaves private members out of the group", () => {
		const g = groupBudgetCell(
			input(lines, rows),
			[D, A, M],
			new Set([M]),
			null,
			null,
		);
		expect(g.amount).toBe(550_000);
		expect(g.spent.planned).toBe(30_000);
		expect(g.members.map((c) => c.memberId)).toEqual([D, A]);
	});

	it("is none when nobody has a budget, derived when everyone's is", () => {
		expect(
			groupBudgetCell(input([]), [D, A], new Set(), null, null).source,
		).toBe("none");
		const derived = groupBudgetCell(
			input([line({ nodeId: "tokyo", amountMinor: 1000 })]),
			[D, A],
			new Set(),
			"japan",
			null,
		);
		expect(derived.source).toBe("derived");
		expect(derived.amount).toBe(2000);
	});

	it("MONEY-R2-05: compares only the shares of members with a budget; the rest is unbudgeted", () => {
		// Only Maya has a Kyoto line ($40); a $100 dinner is split with Dennis.
		const kyotoLines = [
			line({ nodeId: "kyoto", memberId: M, amountMinor: 4000 }),
		];
		const dinner: Row[] = [
			{
				member: D,
				node: "kyoto",
				category: "food_drink",
				planned: 5000,
				actual: 5000,
			},
			{
				member: M,
				node: "kyoto",
				category: "food_drink",
				planned: 5000,
				actual: 5000,
			},
		];
		const g = groupBudgetCell(
			input(kyotoLines, dinner),
			[D, A, M],
			new Set(),
			"kyoto",
			null,
		);
		expect(g.amount).toBe(4000);
		expect(g.budgeted).toEqual({ planned: 5000, actual: 5000 });
		expect(g.budgeted.planned - (g.amount ?? 0)).toBe(1000); // $10 over, not $60
		expect(g.unbudgeted).toEqual({ planned: 5000, actual: 5000 });
		expect(g.spent).toEqual({ planned: 10_000, actual: 10_000 });
		// With the trip default for everyone, nobody is unbudgeted.
		const all = groupBudgetCell(
			input(
				[...kyotoLines, line({ nodeId: "kyoto", amountMinor: 8000 })],
				dinner,
			),
			[D, A, M],
			new Set(),
			"kyoto",
			null,
		);
		expect(all.amount).toBe(4000 + 8000 + 8000);
		expect(all.budgeted).toEqual(all.spent);
		expect(all.unbudgeted).toBeNull();
		// Nobody has one: the row shows everyone's spending.
		const none = groupBudgetCell(
			input([], dinner),
			[D, M],
			new Set(),
			"kyoto",
			null,
		);
		expect(none.budgeted).toEqual(none.spent);
		expect(none.unbudgeted).toBeNull();
	});

	it("lists the categories that matter at a scope", () => {
		const cats = budgetCategories(
			[
				line({ nodeId: "tokyo", category: "lodging", amountMinor: 1 }),
				line({ nodeId: "kyoto", category: "shopping", amountMinor: 1 }),
			],
			"tokyo",
			["food_drink"],
		);
		expect(cats.sort()).toEqual(["food_drink", "lodging"]);
	});
});
