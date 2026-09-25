/**
 * E5 the inspector's Money section for one target (EXTENSIONS §8.6): the
 * costs on an item, leg, day, place (everything inside) or the trip, their
 * planned · paid · still to pay, my share, the target's net positions (as
 * information; settle-up is trip-wide), the rows, the Budget section for a
 * place or the trip, and Add expense prefilled with the target. Never
 * rendered for guests; read-only for viewers.
 */
import { Plus } from "lucide-react";
import { EditGuard } from "@/components/common/edit-guard";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/roles";
import { formatMoney } from "@/lib/engine/money";
import type { BundleTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { AddExpenseDialog } from "./AddExpenseDialog";
import { BudgetSection } from "./BudgetSection";
import { ExpenseRow } from "./ExpenseRow";
import { Num } from "./money-ui";
import { SettleUpDialog } from "./SettleUpDialog";
import { NetPositions } from "./Summary";
import { MONEY_TESTID } from "./testids";
import { useDisplayCurrency, useMoneyData, useMoneyView } from "./use-money";

export function MoneyPanel({ target }: { target: BundleTarget }) {
	const { access, graph, ix } = useWorkspace();
	const openAddExpense = useUi((s) => s.openAddExpense);
	const { guest, isLoading, data } = useMoneyData();
	const view = useMoneyView(target);
	const d = useDisplayCurrency();
	if (guest) return null;
	const writer = can(access, "manageExpenses");
	const s = view?.summary;
	const meId = graph.me.memberId;
	const mine = meId ? s?.perPerson[meId] : undefined;
	// QA MONEY-19: exact in the display currency when every cost is in it.
	const ex = d.exactOf(s);
	const myExact = ex && meId ? ex.perPerson[meId] : undefined;
	const total = (k: "planned" | "actual" | "remaining") =>
		ex
			? formatMoney(ex[k], d.code)
			: d.fmt(
					s?.[
						k === "planned"
							? "plannedHome"
							: k === "actual"
								? "actualHome"
								: "remainingHome"
					] ?? 0,
					{ approx: false },
				);
	const share = (k: "planned" | "actual") =>
		myExact
			? formatMoney(myExact[k], d.code)
			: d.fmt(mine?.[k] ?? 0, { approx: false });
	const budgetNode =
		target.kind === "node"
			? target.nodeId
			: target.kind === "trip"
				? null
				: undefined;
	const targetName =
		target.kind === "node"
			? (ix.node(target.nodeId)?.name ?? "this place")
			: target.kind === "trip"
				? graph.trip.name
				: target.kind === "item"
					? (ix.item(target.itemId)?.title ?? "this item")
					: target.kind === "day"
						? "this day"
						: "this leg";
	return (
		<div
			data-testid={TESTID.moneyPanel}
			data-cursor-anchor="money:panel"
			data-cursor-vis="members"
			className="grid gap-2 py-2"
		>
			<div className="flex items-center gap-2 px-4">
				{s && view.rows.length ? (
					<p className="text-[13px] text-muted-foreground">
						<Num className="text-foreground">{total("planned")}</Num> planned ·{" "}
						<Num className="text-foreground">{total("actual")}</Num> paid
						{s.remainingHome ? (
							<>
								{" · "}
								<Num>{total("remaining")}</Num> to pay
							</>
						) : null}
					</p>
				) : (
					<p className="text-[13px] text-muted-foreground">
						{isLoading ? "Loading…" : "No expenses here yet."}
					</p>
				)}
				<EditGuard>
					<Button
						size="xs"
						variant="outline"
						className="ml-auto"
						data-testid={MONEY_TESTID.addButton}
						disabled={!writer}
						onClick={() => openAddExpense({ target })}
					>
						<Plus /> Expense
					</Button>
				</EditGuard>
			</div>
			{s && mine && (mine.planned || mine.actual) ? (
				<p className="px-4 text-[13px] text-muted-foreground">
					Your share <Num className="text-foreground">{share("planned")}</Num>{" "}
					planned · <Num className="text-foreground">{share("actual")}</Num>{" "}
					paid
				</p>
			) : null}
			{s && Object.keys(s.perPerson).length > 1 ? (
				<NetPositions
					summary={s}
					display={d}
					meId={meId}
					scopeName={targetName}
				/>
			) : null}
			{view?.rows.length ? (
				<ul className="divide-y">
					{view.rows.map((r) => (
						<ExpenseRow
							key={r.expense.id}
							row={r}
							display={d}
							showWhere={target.kind !== "item" && target.kind !== "leg"}
						/>
					))}
				</ul>
			) : null}
			{data && budgetNode !== undefined ? (
				<BudgetSection
					data={data}
					display={d}
					meId={meId}
					nodeId={budgetNode}
					className="pt-2"
				/>
			) : null}
			<AddExpenseDialog />
			<SettleUpDialog />
		</div>
	);
}
