/**
 * E5 the Money tab (EXTENSIONS §8.6, ADDENDUM §6–§7) at every scope, with
 * the lists rollup rules (Everything inside / Only; a day range): the
 * summary strip (planned · paid · still to pay, delta, my share, points per
 * programme), the trip-wide balances (root) or the scope's net positions,
 * per person, the Budget section, breakdowns, then the rows. Never rendered
 * for guests; read-only for viewers.
 */
import { Download, MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import { EditGuard } from "@/components/common/edit-guard";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { TabPurpose } from "@/features/shell/TabPurpose";
import { can } from "@/lib/auth/roles";
import { humanError } from "@/lib/errors";
import { formatDateRange } from "@/lib/format";
import { anchorKey } from "@/lib/realtime/cursor-protocol";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { AddExpenseDialog } from "./AddExpenseDialog";
import { Breakdown } from "./Breakdown";
import { BudgetSection } from "./BudgetSection";
import { DisplayCurrencyPicker } from "./DisplayCurrencyPicker";
import { ExpenseRow } from "./ExpenseRow";
import { exportMoneyCsv } from "./money.functions";
import { Overline } from "./money-ui";
import { SettleUpDialog } from "./SettleUpDialog";
import { ShoppingRow } from "./ShoppingRow";
import { Balances, NetPositions, PeopleTable, SummaryStrip } from "./Summary";
import { MONEY_TESTID } from "./testids";
import {
	type Row,
	useDisplayCurrency,
	useMoneyData,
	useMoneyUi,
	useMoneyView,
} from "./use-money";

export function MoneyTab() {
	const { graph, scope, access, days, only } = useWorkspace();
	const openAddExpense = useUi((s) => s.openAddExpense);
	const { data, isLoading, isError, guest } = useMoneyData();
	const view = useMoneyView();
	const d = useDisplayCurrency();
	if (guest) return null;
	const meId = graph.me.memberId;
	const scopeName = scope?.name ?? graph.trip.name;
	const add = () =>
		openAddExpense(scope ? { target: { kind: "node", nodeId: scope.id } } : {});
	const writer = can(access, "manageExpenses");
	const header = (
		<div className="flex min-h-10 flex-wrap items-center gap-2 px-4 pt-2">
			<span className="text-xs text-muted-foreground">
				{view
					? `${view.rows.length} ${view.rows.length === 1 ? "cost" : "costs"}`
					: ""}
				{days ? ` · ${formatDateRange(days.from, days.to)}` : ""}
				{data?.ratesAsOf
					? ` · rates ${formatDateRange(data.ratesAsOf, data.ratesAsOf)}`
					: ""}
			</span>
			<div className="ml-auto flex items-center gap-1">
				<DisplayCurrencyPicker />
				<MoneyMenu />
				{/* Viewers see it disabled ("View only"), SPEC §0 rule 17. */}
				<EditGuard>
					<Button
						size="sm"
						className="h-8"
						data-testid={MONEY_TESTID.addButton}
						disabled={!writer}
						onClick={add}
					>
						<Plus /> Expense
					</Button>
				</EditGuard>
			</div>
		</div>
	);
	if (isLoading || (!data && !isError))
		return (
			<div data-testid={TESTID.moneyTab} className="grid gap-3 p-4">
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-10 w-2/3" />
				<Skeleton className="h-40 w-full" />
			</div>
		);
	if (!data || !view)
		return (
			<div data-testid={TESTID.moneyTab} className="p-4">
				<EmptyState line="Money isn't available right now." />
			</div>
		);
	const empty = view.rows.length === 0 && view.shopping.length === 0;
	const toPay = view.rows.filter((r) => r.expense.status !== "paid");
	const paid = view.rows.filter((r) => r.expense.status === "paid");
	return (
		<div
			data-testid={TESTID.moneyTab}
			data-cursor-vis="members"
			className="pb-24"
		>
			{header}
			{empty ? (
				<EmptyState
					className="py-8"
					lead={<TabPurpose tab="money" />}
					line={`No expenses in ${only && scope ? `${scope.name} itself` : scopeName} yet.`}
					action={
						writer ? (
							<EditGuard>
								<Button size="sm" variant="outline" onClick={add}>
									Add expense
								</Button>
							</EditGuard>
						) : null
					}
				/>
			) : (
				<SummaryStrip summary={view.summary} display={d} meId={meId} />
			)}
			{scope ? (
				<NetPositions
					summary={view.summary}
					display={d}
					meId={meId}
					scopeName={scope.name}
				/>
			) : (
				<Balances
					view={view}
					display={d}
					meId={meId}
					data={data}
					canSettle={writer}
				/>
			)}
			{!empty ? (
				<PeopleTable summary={view.summary} display={d} meId={meId} />
			) : null}
			<BudgetSection data={data} display={d} meId={meId} />
			{!empty ? (
				<Breakdown rows={view.rows} shopping={view.shopping} display={d} />
			) : null}
			{!empty ? (
				<section data-testid={MONEY_TESTID.expenseList} className="pb-4">
					<RowGroup title="To pay" rows={toPay} />
					<RowGroup title="Paid" rows={paid} />
					{view.shopping.length ? (
						<div>
							<Overline className="sticky top-0 z-20 border-b bg-background/95 px-4 backdrop-blur">
								From the shopping list{" "}
								<span className="font-mono font-normal tnum">
									{view.shopping.length}
								</span>
							</Overline>
							<ul className="divide-y">
								{view.shopping.map((r) => (
									<ShoppingRow
										key={r.item.id}
										row={r}
										display={d}
										writer={writer}
									/>
								))}
							</ul>
						</div>
					) : null}
				</section>
			) : null}
			<SettleUpDialog />
			<AddExpenseDialog />
		</div>
	);
}

function RowGroup({ title, rows }: { title: string; rows: Row[] }) {
	const d = useDisplayCurrency();
	if (!rows.length) return null;
	return (
		<div data-cursor-anchor={`money:rows.${anchorKey(title)}`}>
			<Overline className="sticky top-0 z-20 border-b bg-background/95 px-4 backdrop-blur">
				{title}{" "}
				<span className="font-mono font-normal tnum">{rows.length}</span>
			</Overline>
			<ul className="divide-y">
				{rows.map((r) => (
					<ExpenseRow key={r.expense.id} row={r} display={d} />
				))}
			</ul>
		</div>
	);
}

/** ⋯: Export CSV (this view: scope, "Only", day range), Settle up. */
function MoneyMenu() {
	const { graph, scope, only, days } = useWorkspace();
	const d = useDisplayCurrency();
	const openSettle = useMoneyUi((s) => s.openSettle);
	const exportCsv = async () => {
		try {
			const r = await exportMoneyCsv({
				data: {
					tripId: graph.trip.id,
					...(scope ? { nodeId: scope.id } : {}),
					...(only ? { only: true } : {}),
					...(days ? { days: { from: days.from, to: days.to } } : {}),
					...(d.converted ? { displayCurrency: d.code } : {}),
				},
			});
			const url = URL.createObjectURL(
				new Blob([r.csv], { type: "text/csv;charset=utf-8" }),
			);
			const a = document.createElement("a");
			a.href = url;
			a.download = r.filename;
			document.body.append(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1_000);
		} catch (e) {
			toast.error(humanError(e));
		}
	};
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					size="icon-sm"
					variant="ghost"
					aria-label="Money options"
					data-testid={MONEY_TESTID.moreMenu}
				>
					<MoreHorizontal />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem
					className="cursor-pointer"
					onSelect={() => openSettle(true)}
				>
					Settle up…
				</DropdownMenuItem>
				<DropdownMenuItem
					className="cursor-pointer"
					data-testid={MONEY_TESTID.exportCsv}
					onSelect={() => void exportCsv()}
				>
					<Download /> Export CSV{scope ? ` (${scope.name})` : ""}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
