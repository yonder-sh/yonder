/**
 * Breakdowns (EXTENSIONS §8.6): by category, by place (the scope's children)
 * or by day — rows with an 8px bar, planned behind paid. Priced shopping-list
 * items count as planned Shopping costs (ADDENDUM §6), as in the summary, so
 * the rows add up to its Planned total.
 */
import { useMemo, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	EXPENSE_CATEGORY_LABEL,
	formatMoneyShort,
	originalAmounts,
} from "@/lib/engine/money";
import { formatDayDate } from "@/lib/format";
import { oneOf, useMirror } from "@/lib/realtime/view-ui";
import {
	EXPENSE_CATEGORY_VALUES,
	type ExpenseCategory,
} from "@/lib/schemas/enums";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { Bar, CategoryIcon, Num, Overline } from "./money-ui";
import { MONEY_TESTID } from "./testids";
import type { Display, Row, ShoppingRow } from "./use-money";

type By = "category" | "place" | "day";
const isBy = oneOf<By>(["category", "place", "day"]);
/** Planned and paid in one currency, exactly (null = the parts' currencies differ). */
type Exact = { currency: string; planned: number; actual: number } | null;
type Line = {
	key: string;
	label: string;
	planned: number;
	actual: number;
	/** The same line in the costs' own currency when they share one (QA MONEY-19). */
	exact?: Exact;
	icon?: React.ReactNode;
};

/** One cost as the breakdown sees it (an expense row or a shopping-list item). */
type Part = {
	category: ExpenseCategory;
	anchor: Row["anchor"];
	planned: number;
	actual: number;
	exact: Exact;
};

/** The public costs in view: expenses, then priced shopping items (planned only). */
export function breakdownParts(
	rows: readonly Row[],
	shopping: readonly ShoppingRow[],
): Part[] {
	return [
		...rows
			.filter((r) => !r.expense.isPrivate)
			.map((r) => ({
				category: r.expense.category,
				anchor: r.anchor,
				planned: r.facts.plannedHome ?? 0,
				actual: r.facts.actualHome,
				exact: originalAmounts(r.expense),
			})),
		...shopping
			.filter((s) => !s.item.isPrivate)
			.map((s) => ({
				category: "shopping" as const,
				anchor: s.anchor,
				planned: s.homeMinor ?? 0,
				actual: 0,
				exact: { currency: s.currency, planned: s.amountMinor, actual: 0 },
			})),
	];
}

/** Adds a part's exact amounts to a line's (null once two currencies meet). */
function addExact(line: Exact | undefined, part: Exact): Exact {
	if (!part || line === null) return null;
	if (line === undefined) return { ...part };
	if (line.currency !== part.currency) return null;
	return {
		currency: line.currency,
		planned: line.planned + part.planned,
		actual: line.actual + part.actual,
	};
}

const NO_SHOPPING: ShoppingRow[] = [];

export function Breakdown({
	rows,
	shopping = NO_SHOPPING,
	display: d,
}: {
	rows: Row[];
	/** Priced shopping-list items in view (planned costs). */
	shopping?: ShoppingRow[];
	display: Display;
}) {
	const { ix, scope, nav } = useWorkspace();
	const [by, setBy] = useState<By>("category");
	// FB-21d: the grouping travels with my view (members only: never to guests).
	useMirror("money.by", by, setBy, isBy);
	const lines = useMemo((): Line[] => {
		const pub = breakdownParts(rows, shopping);
		const acc = new Map<string, Line>();
		const add = (
			key: string,
			label: string,
			r: Part,
			icon?: React.ReactNode,
		) => {
			let l = acc.get(key);
			if (!l) {
				l = { key, label, planned: 0, actual: 0, ...(icon ? { icon } : {}) };
				acc.set(key, l);
			}
			l.planned += r.planned;
			l.actual += r.actual;
			l.exact = addExact(l.exact, r.exact);
		};
		if (by === "category") {
			for (const r of pub)
				add(
					r.category,
					EXPENSE_CATEGORY_LABEL[r.category],
					r,
					<CategoryIcon
						category={r.category}
						className="text-muted-foreground"
					/>,
				);
			return [...acc.values()].sort(
				(a, b) =>
					EXPENSE_CATEGORY_VALUES.indexOf(a.key as never) -
					EXPENSE_CATEGORY_VALUES.indexOf(b.key as never),
			);
		}
		if (by === "place") {
			const scopeId = scope?.id ?? null;
			const children = ix.children(scopeId);
			for (const r of pub) {
				const n = r.anchor.nodeId;
				const child = n
					? children.find((c) => ix.isWithin(n, c.id))
					: undefined;
				if (child) add(child.id, child.name, r);
				else add("_here", scope ? `${scope.name} (itself)` : "Trip-wide", r);
			}
			return [...acc.values()].sort((a, b) => b.planned - a.planned);
		}
		for (const r of pub) {
			const day = r.anchor.dayId ? ix.day(r.anchor.dayId) : undefined;
			if (day)
				add(
					day.id,
					`Day ${ix.dayNumber(day.id)} · ${formatDayDate(day.date)}`,
					r,
				);
			else add("_none", "No day", r);
		}
		return [...acc.values()].sort((a, b) => {
			if (a.key === "_none") return 1;
			if (b.key === "_none") return -1;
			return (ix.day(a.key)?.date ?? "") < (ix.day(b.key)?.date ?? "") ? -1 : 1;
		});
	}, [rows, shopping, by, ix, scope]);
	const max = Math.max(1, ...lines.map((l) => Math.max(l.planned, l.actual)));
	/**
	 * In the display currency: exact when every cost on the line is in it
	 * ("Lodging ¥10K paid" under a PAID ¥10,000, never ¥10.5K via home cents).
	 */
	const exactOf = (l: Line) =>
		d.converted && l.exact && l.exact.currency === d.code ? l.exact : null;
	const amount = (l: Line, k: "planned" | "actual") => {
		const e = exactOf(l);
		return e
			? formatMoneyShort(e[k], d.code)
			: d.fmt(l[k], { short: true, approx: false });
	};
	const partPaid = (l: Line) => {
		const e = exactOf(l);
		return e ? e.actual !== e.planned : l.actual !== l.planned;
	};
	if (!lines.length) return null;
	return (
		<section data-testid={MONEY_TESTID.breakdown} className="px-4 pb-4">
			<Overline
				right={
					<ToggleGroup
						type="single"
						size="sm"
						variant="outline"
						value={by}
						onValueChange={(v) => v && setBy(v as By)}
						className="h-7"
						aria-label="Break down by"
					>
						<ToggleGroupItem value="category" className="h-7 px-2 text-xs">
							Category
						</ToggleGroupItem>
						<ToggleGroupItem value="place" className="h-7 px-2 text-xs">
							Place
						</ToggleGroupItem>
						<ToggleGroupItem value="day" className="h-7 px-2 text-xs">
							Day
						</ToggleGroupItem>
					</ToggleGroup>
				}
			>
				Breakdown
			</Overline>
			<ul className="grid gap-2.5">
				{lines.map((l) => (
					<li key={l.key} className="grid gap-1">
						<div className="flex items-baseline gap-2 text-[13px]">
							{l.icon}
							{by === "place" && ix.node(l.key) ? (
								<button
									type="button"
									className="cursor-pointer truncate text-left hover:underline"
									onClick={() => nav.zoomTo(l.key)}
								>
									{l.label}
								</button>
							) : (
								<span className="truncate">{l.label}</span>
							)}
							<span className="ml-auto shrink-0 text-xs text-muted-foreground">
								<Num className="text-foreground">{amount(l, "planned")}</Num>
								{partPaid(l) ? (
									<>
										{" · "}
										<Num>{amount(l, "actual")}</Num> paid
									</>
								) : null}
							</span>
						</div>
						<Bar value={l.actual} marker={l.planned} max={max} />
					</li>
				))}
			</ul>
		</section>
	);
}
