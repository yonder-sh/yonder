/**
 * ADDENDUM §7.1 budgets, WP-Money. Pure. "Trip default + personal override,
 * inherit unless custom":
 *
 * - A line is (scope: the trip root or a node) × (category: all or one) → an
 *   amount in the home currency, `total` or `per_day` (× the days whose
 *   schedule touches the scope). `memberId` null = the trip default.
 * - Effective value per member: their own line, else the default. Own lines
 *   are absolute. A member line set against an older default shows the notice
 *   "Trip default is now $3,500; yours stays $3,000 · Follow default".
 * - Compared against the member's SHARE of costs in that scope + category,
 *   planned and actual separately (the caller supplies `spend`). A derived
 *   budget is compared against its budgeted parts only (`budgeted`).
 * - Hierarchy: a parent and its budgeted descendants → allocated /
 *   unallocated, over-allocated when Σchildren > parent. Only descendants →
 *   the parent's budget is DERIVED (Σ of them) and spending outside them is
 *   UNBUDGETED. "Descendants" are the nearest budgeted ones (a budgeted city
 *   under an unbudgeted region still counts once), so nothing is counted
 *   twice. Categories are allocations inside the scope's `all` line with the
 *   same rules.
 * - Group totals sum only visible members (a private member is left out).
 */
import type { BudgetKind, ExpenseCategory } from "@/lib/schemas/enums";

export type BudgetLine = {
	id: string;
	nodeId: string | null;
	category: ExpenseCategory | null;
	memberId: string | null;
	amountMinor: number;
	kind: BudgetKind;
	/** Member lines: the default's amount when the line was set (the notice when it differs). */
	defaultSeenMinor?: number | null;
};

export type Spend = { planned: number; actual: number };

export type BudgetTree = {
	/** The node's parent (null = a child of the trip root); undefined = unknown node. */
	parentOf(nodeId: string): string | null | undefined;
	/** Days whose schedule touches the scope (null = the trip: every day). */
	daysIn(nodeId: string | null): number;
};

/** The member's own line if present, else the trip default (null when neither). */
export function effectiveBudget(
	lines: readonly BudgetLine[],
	memberId: string,
	nodeId: string | null,
	category: ExpenseCategory | null,
): BudgetLine | null {
	const match = (l: BudgetLine) =>
		l.nodeId === nodeId && l.category === category;
	return (
		lines.find((l) => match(l) && l.memberId === memberId) ??
		lines.find((l) => match(l) && l.memberId === null) ??
		null
	);
}

/** The trip-default line for a slot, if any. */
export function defaultLine(
	lines: readonly BudgetLine[],
	nodeId: string | null,
	category: ExpenseCategory | null,
): BudgetLine | null {
	return (
		lines.find(
			(l) =>
				l.memberId === null && l.nodeId === nodeId && l.category === category,
		) ?? null
	);
}

/** A line's amount for its scope: `per_day` × the scope's days. */
export function lineAmount(line: BudgetLine, tree: BudgetTree): number {
	return line.kind === "per_day"
		? line.amountMinor * Math.max(0, tree.daysIn(line.nodeId))
		: line.amountMinor;
}

/** `nodeId` is `scopeId` or below it (null = the trip root contains everything known). */
export function isWithin(
	tree: BudgetTree,
	nodeId: string | null,
	scopeId: string | null,
): boolean {
	if (scopeId === null) return true;
	let cur: string | null | undefined = nodeId;
	for (let hops = 0; cur && hops < 64; hops++) {
		if (cur === scopeId) return true;
		cur = tree.parentOf(cur);
	}
	return false;
}

/**
 * Nodes strictly below `scopeId` that carry a budget in `budgeted`, keeping
 * only the nearest ones (no budgeted node between them and the scope).
 */
export function nearestBudgeted(
	tree: BudgetTree,
	scopeId: string | null,
	budgeted: ReadonlySet<string>,
): string[] {
	const out: string[] = [];
	for (const n of budgeted) {
		if (n === scopeId || !isWithin(tree, n, scopeId)) continue;
		let cur = tree.parentOf(n);
		let blocked = false;
		for (let hops = 0; cur && cur !== scopeId && hops < 64; hops++) {
			if (budgeted.has(cur)) {
				blocked = true;
				break;
			}
			cur = tree.parentOf(cur);
		}
		if (!blocked) out.push(n);
	}
	return out.sort();
}

export type BudgetNotice = { defaultMinor: number; mineMinor: number };

export type BudgetCell = {
	nodeId: string | null;
	category: ExpenseCategory | null;
	/** null = the group (visible members summed). */
	memberId: string | null;
	/** custom = the member's own line; default = inherited; derived = Σ below; none. */
	source: "custom" | "default" | "derived" | "none";
	line: BudgetLine | null;
	/** The budget in home minor units (derived included); null = none. */
	amount: number | null;
	/** `per_day` lines: the rate and the days it was multiplied by. */
	perDay: { rate: number; days: number } | null;
	/** Σ of the nearest budgeted descendant scopes (same category). */
	allocated: number;
	/** The budgeted descendant scopes, nearest first (node ids). */
	children: { nodeId: string; amount: number }[];
	/** amount − allocated (explicit budgets only). */
	unallocated: number | null;
	overAllocated: boolean;
	/** `all` cells: Σ of this scope's category budgets. */
	categoryAllocated: number;
	categoryOverAllocated: boolean;
	/** Every share of costs in the scope + category. */
	spent: Spend;
	/**
	 * What `amount` is compared against ("left" / "over"): `spent`, except for
	 * a derived budget, which covers only its budgeted parts (the rest is
	 * `unbudgeted`, never counted against it too).
	 */
	budgeted: Spend;
	/** Derived budgets: spending in the scope outside every budgeted part. */
	unbudgeted: Spend | null;
	/** A custom line set against a default that has since changed. */
	notice: BudgetNotice | null;
};

export type BudgetInput = {
	lines: readonly BudgetLine[];
	tree: BudgetTree;
	/** The member's share of costs within the scope (subtree) and category (null = all). */
	spend: (
		memberId: string,
		nodeId: string | null,
		category: ExpenseCategory | null,
	) => Spend;
};

const ZERO: Spend = { planned: 0, actual: 0 };
const plus = (a: Spend, b: Spend): Spend => ({
	planned: a.planned + b.planned,
	actual: a.actual + b.actual,
});
const minus = (a: Spend, b: Spend): Spend => ({
	planned: a.planned - b.planned,
	actual: a.actual - b.actual,
});

/** Nodes where the member has an effective line for `category`. */
function budgetedNodes(
	lines: readonly BudgetLine[],
	memberId: string,
	category: ExpenseCategory | null,
): Set<string> {
	const s = new Set<string>();
	for (const l of lines)
		if (
			l.category === category &&
			l.nodeId !== null &&
			(l.memberId === null || l.memberId === memberId)
		)
			s.add(l.nodeId);
	return s;
}

/** The explicit (own or default) amount of a slot for a member, or null. */
function explicitAmount(
	input: BudgetInput,
	memberId: string,
	nodeId: string | null,
	category: ExpenseCategory | null,
): number | null {
	const l = effectiveBudget(input.lines, memberId, nodeId, category);
	return l ? lineAmount(l, input.tree) : null;
}

/** Categories with a budget line for the member at exactly this node. */
function categoryLines(
	input: BudgetInput,
	memberId: string,
	nodeId: string | null,
): { category: ExpenseCategory; amount: number }[] {
	const cats = new Set<ExpenseCategory>();
	for (const l of input.lines)
		if (
			l.nodeId === nodeId &&
			l.category !== null &&
			(l.memberId === null || l.memberId === memberId)
		)
			cats.add(l.category);
	const out: { category: ExpenseCategory; amount: number }[] = [];
	for (const c of [...cats].sort()) {
		const a = explicitAmount(input, memberId, nodeId, c);
		if (a !== null) out.push({ category: c, amount: a });
	}
	return out;
}

/** One member's budget for (scope, category). */
export function budgetCell(
	input: BudgetInput,
	memberId: string,
	nodeId: string | null,
	category: ExpenseCategory | null,
): BudgetCell {
	const { lines, tree } = input;
	const line = effectiveBudget(lines, memberId, nodeId, category);
	const spent = input.spend(memberId, nodeId, category);
	const kids = nearestBudgeted(
		tree,
		nodeId,
		budgetedNodes(lines, memberId, category),
	).map((id) => ({
		nodeId: id,
		amount: explicitAmount(input, memberId, id, category) ?? 0,
	}));
	const allocated = kids.reduce((a, k) => a + k.amount, 0);
	const cats = category === null ? categoryLines(input, memberId, nodeId) : [];
	const categoryAllocated = cats.reduce((a, c) => a + c.amount, 0);

	let notice: BudgetNotice | null = null;
	if (line && line.memberId !== null) {
		const def = defaultLine(lines, nodeId, category);
		if (
			def &&
			line.defaultSeenMinor !== null &&
			line.defaultSeenMinor !== undefined &&
			def.amountMinor !== line.defaultSeenMinor &&
			def.amountMinor !== line.amountMinor
		)
			notice = { defaultMinor: def.amountMinor, mineMinor: line.amountMinor };
	}

	if (line) {
		const amount = lineAmount(line, tree);
		return {
			nodeId,
			category,
			memberId,
			source: line.memberId === null ? "default" : "custom",
			line,
			amount,
			perDay:
				line.kind === "per_day"
					? { rate: line.amountMinor, days: tree.daysIn(nodeId) }
					: null,
			allocated,
			children: kids,
			unallocated: kids.length ? amount - allocated : null,
			overAllocated: kids.length > 0 && allocated > amount,
			categoryAllocated,
			categoryOverAllocated: cats.length > 0 && categoryAllocated > amount,
			spent,
			budgeted: spent,
			unbudgeted: null,
			notice,
		};
	}

	// No explicit line: derived from this scope's categories (all only), else
	// from the nearest budgeted descendants; the rest of the spending is unbudgeted.
	if (cats.length || kids.length) {
		const fromCats = cats.length > 0;
		const amount = fromCats ? categoryAllocated : allocated;
		const covered = fromCats
			? cats.reduce(
					(a, c) => plus(a, input.spend(memberId, nodeId, c.category)),
					ZERO,
				)
			: kids.reduce(
					(a, k) => plus(a, input.spend(memberId, k.nodeId, category)),
					ZERO,
				);
		return {
			nodeId,
			category,
			memberId,
			source: "derived",
			line: null,
			amount,
			perDay: null,
			allocated,
			children: kids,
			unallocated: null,
			overAllocated: false,
			categoryAllocated,
			categoryOverAllocated: false,
			spent,
			budgeted: covered,
			unbudgeted: minus(spent, covered),
			notice: null,
		};
	}
	return {
		nodeId,
		category,
		memberId,
		source: "none",
		line: null,
		amount: null,
		perDay: null,
		allocated: 0,
		children: [],
		unallocated: null,
		overAllocated: false,
		categoryAllocated: 0,
		categoryOverAllocated: false,
		spent,
		budgeted: spent,
		unbudgeted: null,
		notice: null,
	};
}

/**
 * The group's budget for (scope, category): every visible member's cell
 * summed (members whose budgets are private are left out, except `me`).
 * The budgets are compared only with the shares of the members who HAVE one
 * (`budgeted`); the shares of visible members without a budget, and what a
 * derived budget doesn't cover, are `unbudgeted` (never counted against
 * someone else's budget). `spent` stays every visible member's share.
 */
export function groupBudgetCell(
	input: BudgetInput,
	memberIds: readonly string[],
	hidden: ReadonlySet<string>,
	nodeId: string | null,
	category: ExpenseCategory | null,
): BudgetCell & { members: BudgetCell[] } {
	const members = memberIds
		.filter((m) => !hidden.has(m))
		.map((m) => budgetCell(input, m, nodeId, category));
	const withBudget = members.filter((c) => c.amount !== null);
	const without = members.filter((c) => c.amount === null);
	const amount = withBudget.length
		? withBudget.reduce((a, c) => a + (c.amount ?? 0), 0)
		: null;
	const allocated = members.reduce((a, c) => a + c.allocated, 0);
	const categoryAllocated = members.reduce(
		(a, c) => a + c.categoryAllocated,
		0,
	);
	const spent = members.reduce((a, c) => plus(a, c.spent), ZERO);
	// Nobody has a budget: the row just shows what everyone spent.
	const budgeted =
		amount === null
			? spent
			: withBudget.reduce((a, c) => plus(a, c.budgeted), ZERO);
	const derived =
		withBudget.length > 0 && withBudget.every((c) => c.source === "derived");
	const outside =
		amount === null
			? []
			: [
					...withBudget.map((c) => c.unbudgeted ?? ZERO),
					...without.map((c) => c.spent),
				];
	const unbudgeted = outside.some((s) => s.planned !== 0 || s.actual !== 0)
		? outside.reduce(plus, ZERO)
		: null;
	return {
		nodeId,
		category,
		memberId: null,
		source: amount === null ? "none" : derived ? "derived" : "default",
		line: null,
		amount,
		perDay: null,
		allocated,
		children: [],
		unallocated:
			amount !== null && !derived && members.some((c) => c.unallocated !== null)
				? amount - allocated
				: null,
		overAllocated: members.some((c) => c.overAllocated),
		categoryAllocated,
		categoryOverAllocated: members.some((c) => c.categoryOverAllocated),
		spent,
		budgeted,
		unbudgeted,
		notice: null,
		members,
	};
}

/** Every custom line whose default changed since it was set (the member's notices). */
export function budgetNotices(
	lines: readonly BudgetLine[],
	memberId: string,
): (BudgetNotice & { line: BudgetLine })[] {
	const out: (BudgetNotice & { line: BudgetLine })[] = [];
	for (const l of lines) {
		if (l.memberId !== memberId) continue;
		const def = defaultLine(lines, l.nodeId, l.category);
		if (
			def &&
			l.defaultSeenMinor !== null &&
			l.defaultSeenMinor !== undefined &&
			def.amountMinor !== l.defaultSeenMinor &&
			def.amountMinor !== l.amountMinor
		)
			out.push({
				line: l,
				defaultMinor: def.amountMinor,
				mineMinor: l.amountMinor,
			});
	}
	return out;
}

/** Categories that matter at a scope: any line (for a visible member) or any spending. */
export function budgetCategories(
	lines: readonly BudgetLine[],
	nodeId: string | null,
	spentCategories: Iterable<ExpenseCategory>,
): ExpenseCategory[] {
	const s = new Set<ExpenseCategory>(spentCategories);
	for (const l of lines)
		if (l.nodeId === nodeId && l.category) s.add(l.category);
	return [...s];
}
