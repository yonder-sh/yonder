/**
 * The Budget section (ADDENDUM §7.1, EXTENSIONS §8.3) at every scope: my
 * budget or the group's (visible members only), per category, against
 * shares planned and paid; "Custom" + "Reset to trip default"; the notice
 * when a default changed under a custom value; allocated / unallocated /
 * over-allocated / derived / unbudgeted from the hierarchy engine; a
 * trip-default editor for owners and editors; the private toggle.
 */
import { cn } from "cn";
import { Lock, MoreHorizontal, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { EmptyState } from "@/components/common/empty-state";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { can } from "@/lib/auth/roles";
import {
	EXPENSE_CATEGORY_LABEL,
	expenseFacts,
	formatMoney,
	minorToInput,
	parseMoneyInput,
} from "@/lib/engine/money";
import {
	type BudgetCell,
	type BudgetInput,
	type BudgetLine,
	budgetCategories,
	budgetCell,
	defaultLine,
	groupBudgetCell,
	isWithin,
	type Spend,
} from "@/lib/engine/money-budget";
import { budgetTree, expenseAnchor } from "@/lib/engine/money-scope";
import { humanError } from "@/lib/errors";
import { useFormPresence } from "@/lib/realtime/form-presence";
import { oneOf, useFollowState } from "@/lib/realtime/view-ui";
import {
	EXPENSE_CATEGORY_VALUES,
	type ExpenseCategory,
} from "@/lib/schemas/enums";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	deleteBudgetLine,
	type MoneyDto,
	setBudgetLine,
	setBudgetPrivate,
} from "./money.functions";
import { Bar, CategoryIcon, Num, Overline } from "./money-ui";
import { MONEY_TESTID } from "./testids";
import { type Display, moneyKeys } from "./use-money";

type Mode = "me" | "group";
const isMode = oneOf<Mode>(["me", "group"]);
const isGroup = oneOf<Mode>(["group"]);

/** Budget inputs for the whole trip: every expense's anchor, category and shares. */
function useBudgetInput(
	data: MoneyDto,
	meId: string | null,
): BudgetInput & { members: string[] } {
	const { ix, graph } = useWorkspace();
	return useMemo(() => {
		const order = graph.members.map((m) => m.id);
		const byId = new Map(data.expenses.map((e) => [e.id, e]));
		const tree = budgetTree(ix);
		type Fact = {
			node: string | null;
			category: ExpenseCategory;
			planned: Record<string, number>;
			actual: Record<string, number>;
		};
		const facts: Fact[] = data.expenses.map((e) => {
			const f = expenseFacts(e, { memberOrder: order, byId });
			const node = expenseAnchor(ix, e.target).nodeId;
			// A private cost is all its creator's (only they see it).
			if (e.isPrivate && meId)
				return {
					node,
					category: e.category,
					planned: { [meId]: f.plannedHome ?? 0 },
					actual: { [meId]: f.actualHome },
				};
			return {
				node,
				category: e.category,
				planned: f.plannedShare,
				actual: f.actualShare,
			};
		});
		const spend = (
			m: string,
			nodeId: string | null,
			category: ExpenseCategory | null,
		): Spend => {
			let planned = 0;
			let actual = 0;
			for (const f of facts) {
				if (category !== null && f.category !== category) continue;
				if (nodeId !== null && !isWithin(tree, f.node, nodeId)) continue;
				planned += f.planned[m] ?? 0;
				actual += f.actual[m] ?? 0;
			}
			return { planned, actual };
		};
		const members = graph.members
			.filter((m) => m.status !== "removed")
			.map((m) => m.id);
		return { lines: data.budgets, tree, spend, members };
	}, [data, ix, graph.members, meId]);
}

export function BudgetSection({
	data,
	display: d,
	meId,
	nodeId: nodeIdProp,
	className,
}: {
	data: MoneyDto;
	display: Display;
	meId: string | null;
	/** The inspector's place (null = the trip); default: the current scope. */
	nodeId?: string | null;
	className?: string;
}) {
	const { scope, ix, access, graph } = useWorkspace();
	const guard = useEditGuard();
	const input = useBudgetInput(data, meId);
	// FB-21d: "Me" / "Group" travels (a follower's "Me" is their own budget).
	const [mode, setMode] = useFollowState<Mode>(
		"money.budget",
		meId ? "me" : "group",
		meId ? isMode : isGroup,
	);
	const nodeId = nodeIdProp !== undefined ? nodeIdProp : (scope?.id ?? null);
	const hidden = useMemo(
		() => new Set(data.privateBudgetMemberIds),
		[data.privateBudgetMemberIds],
	);
	const myPrivate = data.myBudgetPrivate ?? false;
	const spentCats = useMemo(() => {
		const s = new Set<ExpenseCategory>();
		for (const e of data.expenses) {
			const n = expenseAnchor(ix, e.target).nodeId;
			if (nodeId === null || isWithin(input.tree, n, nodeId)) s.add(e.category);
		}
		return s;
	}, [data.expenses, ix, nodeId, input.tree]);
	const cats = budgetCategories(data.budgets, nodeId, spentCats).sort(
		(a, b) =>
			EXPENSE_CATEGORY_VALUES.indexOf(a) - EXPENSE_CATEGORY_VALUES.indexOf(b),
	);
	const cell = (category: ExpenseCategory | null): BudgetCell =>
		mode === "me" && meId
			? budgetCell(input, meId, nodeId, category)
			: groupBudgetCell(input, input.members, hidden, nodeId, category);
	const all = cell(null);
	const rows = cats
		.map((c) => cell(c))
		.filter((c) => c.amount !== null || c.spent.planned !== 0);
	const anyBudget = all.amount !== null || rows.some((r) => r.amount !== null);
	const canDefault = can(access, "manageBudgets");
	const canOwn = can(access, "manageExpenses") && !!meId;
	const tripId = graph.trip.id;
	const priv = useTripMutation(
		(v: boolean) => setBudgetPrivate({ data: { tripId, private: v } }),
		{
			keys: moneyKeys(tripId),
		},
	);
	const scopeName = (nodeId ? ix.node(nodeId)?.name : null) ?? "the trip";
	const editor = (trigger: React.ReactElement<{ disabled?: boolean }>) =>
		guard.disabled ? (
			<EditGuard>{trigger}</EditGuard>
		) : (
			<BudgetEditor
				nodeId={nodeId}
				data={data}
				meId={meId}
				canDefault={canDefault}
				home={d.home}
				trigger={trigger}
			/>
		);
	return (
		<section
			data-testid={MONEY_TESTID.budget}
			// FB-17: members-only; my own budget, when I made it private, is mine alone.
			data-cursor-anchor="money:budget"
			data-cursor-vis={mode === "me" && myPrivate ? "private" : "members"}
			className={cn("px-4 pb-4", className)}
		>
			<Overline
				right={
					<>
						{meId ? (
							<ToggleGroup
								type="single"
								size="sm"
								variant="outline"
								value={mode}
								onValueChange={(v) => v && setMode(v as Mode)}
								className="h-7"
								aria-label="Whose budget"
							>
								<ToggleGroupItem value="me" className="h-7 px-2 text-xs">
									Mine
								</ToggleGroupItem>
								<ToggleGroupItem value="group" className="h-7 px-2 text-xs">
									Group
								</ToggleGroupItem>
							</ToggleGroup>
						) : null}
						{anyBudget && (canOwn || canDefault)
							? editor(
									<Button
										size="icon-sm"
										variant="ghost"
										className="size-7"
										aria-label="Set a budget"
									>
										<Plus />
									</Button>,
								)
							: null}
						{canOwn ? (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										size="icon-sm"
										variant="ghost"
										className="size-7"
										aria-label="Budget options"
									>
										<MoreHorizontal />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuCheckboxItem
										data-testid={MONEY_TESTID.budgetPrivate}
										checked={myPrivate}
										disabled={guard.disabled}
										onCheckedChange={(v) =>
											priv.mutate(!!v, {
												onError: (e) => toast.error(humanError(e)),
											})
										}
									>
										Keep my budgets private
									</DropdownMenuCheckboxItem>
								</DropdownMenuContent>
							</DropdownMenu>
						) : null}
					</>
				}
			>
				Budget
			</Overline>
			{!anyBudget ? (
				<EmptyState
					className="py-4"
					line={`No budget for ${scopeName} yet.`}
					action={
						canOwn || canDefault
							? editor(
									<Button size="sm" variant="outline">
										Set a budget
									</Button>,
								)
							: null
					}
				/>
			) : (
				<ul className="grid gap-3">
					<BudgetRow
						cell={all}
						display={d}
						data={data}
						meId={meId}
						canDefault={canDefault}
						mode={mode}
					/>
					{rows.map((c) => (
						<BudgetRow
							key={c.category}
							cell={c}
							display={d}
							data={data}
							meId={meId}
							canDefault={canDefault}
							mode={mode}
						/>
					))}
				</ul>
			)}
			{mode === "group" && hidden.size ? (
				<p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
					<Lock className="size-3" aria-hidden="true" />
					{hidden.size === 1 ? "1 person keeps" : `${hidden.size} people keep`}{" "}
					their budget private.
				</p>
			) : null}
		</section>
	);
}

function BudgetRow({
	cell: c,
	display: d,
	data,
	meId,
	canDefault,
	mode,
}: {
	cell: BudgetCell;
	display: Display;
	data: MoneyDto;
	meId: string | null;
	canDefault: boolean;
	mode: Mode;
}) {
	const { ix, graph } = useWorkspace();
	const guard = useEditGuard();
	const tripId = graph.trip.id;
	const follow = useTripMutation(
		(id: string) => deleteBudgetLine({ data: { id } }),
		{
			keys: moneyKeys(tripId),
			onSuccess: () => toast("Following the trip default"),
		},
	);
	const label = c.category ? EXPENSE_CATEGORY_LABEL[c.category] : "All costs";
	const amount = c.amount;
	// A derived budget covers only its budgeted parts; the rest is shown as
	// unbudgeted below, never counted against it too (ADDENDUM §7.1).
	const cmp = c.budgeted;
	const over = amount !== null && cmp.planned > amount;
	const fmt = (m: number) => d.fmt(m, { approx: false, short: true });
	const editable = !guard.disabled && mode === "me";
	const body = (
		<div className="min-w-0">
			<div className="flex items-baseline gap-2 text-[13px]">
				{c.category ? (
					<CategoryIcon
						category={c.category}
						className="text-muted-foreground"
					/>
				) : null}
				<span className="font-medium">{label}</span>
				{c.source === "custom" ? (
					<span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
						Custom
					</span>
				) : c.source === "derived" ? (
					<span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
						derived
					</span>
				) : null}
				<span className="ml-auto">
					{amount !== null ? (
						<Num className="font-medium">{fmt(amount)}</Num>
					) : (
						<span className="text-xs text-muted-foreground">No budget</span>
					)}
					{c.perDay ? (
						<Num className="ml-1 text-xs text-muted-foreground">
							{fmt(c.perDay.rate)}/day × {c.perDay.days}
						</Num>
					) : null}
				</span>
			</div>
			{amount !== null ? (
				<Bar
					className="mt-1.5"
					value={cmp.actual}
					marker={cmp.planned}
					max={Math.max(amount, cmp.planned)}
					tone={over ? "warning" : "ink"}
					label={`${label}: ${fmt(cmp.planned)} planned, ${fmt(cmp.actual)} paid of ${fmt(amount)}`}
				/>
			) : null}
			<p className="mt-1 text-xs text-muted-foreground">
				<Num>{fmt(cmp.planned)}</Num> planned · <Num>{fmt(cmp.actual)}</Num>{" "}
				paid
				{c.source === "derived" ? " in the budgeted parts" : null}
				{amount !== null ? (
					<>
						{" · "}
						<span className={cn(over && "text-warning")}>
							<Num>
								{fmt(over ? cmp.planned - amount : amount - cmp.planned)}
							</Num>{" "}
							{over ? "over" : "left"}
						</span>
					</>
				) : null}
				{mode === "group"
					? amount !== null
						? " (shares of the people with a budget)"
						: " (shares of everyone visible)"
					: null}
			</p>
			{c.children.length && c.source !== "derived" ? (
				<p className="mt-0.5 text-xs text-muted-foreground">
					{c.children
						.map((k) => `${ix.node(k.nodeId)?.name ?? "?"} ${fmt(k.amount)}`)
						.join(" · ")}
					{c.unallocated !== null && c.unallocated >= 0
						? ` · ${fmt(c.unallocated)} unallocated`
						: null}
				</p>
			) : null}
			{c.unbudgeted &&
			(c.unbudgeted.planned !== 0 || c.unbudgeted.actual !== 0) &&
			(c.source === "derived" || mode === "group") ? (
				<p className="mt-0.5 text-xs text-muted-foreground">
					<Num>{fmt(c.unbudgeted.planned)}</Num> planned
					{mode === "group"
						? " outside these budgets (shares of people without one)"
						: " outside the budgeted parts"}{" "}
					(unbudgeted)
				</p>
			) : null}
			{c.overAllocated ? (
				<p className="mt-1 text-xs text-warning">
					Over-allocated: its places add up to <Num>{fmt(c.allocated)}</Num>.
				</p>
			) : null}
			{c.categoryOverAllocated ? (
				<p className="mt-1 text-xs text-warning">
					Over-allocated: its categories add up to{" "}
					<Num>{fmt(c.categoryAllocated)}</Num>.
				</p>
			) : null}
		</div>
	);
	return (
		<li
			data-testid={MONEY_TESTID.budgetRow}
			data-category={c.category ?? "all"}
			data-source={c.source}
			data-cursor-anchor={`budget:${c.category ?? "all"}`}
		>
			{editable &&
			(c.source === "custom" ||
				c.source === "default" ||
				c.source === "none") ? (
				<BudgetEditor
					nodeId={c.nodeId}
					category={c.category}
					data={data}
					meId={meId}
					canDefault={canDefault}
					home={d.home}
					line={c.line}
					trigger={
						<button
							type="button"
							data-testid={MONEY_TESTID.budgetEdit}
							className="-mx-2 w-[calc(100%+1rem)] cursor-pointer rounded-md px-2 py-1 text-left hover:bg-accent/50"
						>
							{body}
						</button>
					}
				/>
			) : (
				body
			)}
			{c.notice && c.line ? (
				<p
					data-testid={MONEY_TESTID.budgetNotice}
					className="mt-1 flex flex-wrap items-center gap-x-2 rounded-md bg-muted px-3 py-1.5 text-xs"
				>
					<span>
						Trip default is now{" "}
						<Num>{formatMoney(c.notice.defaultMinor, d.home)}</Num>; yours stays{" "}
						<Num>{formatMoney(c.notice.mineMinor, d.home)}</Num>
					</span>
					{!guard.disabled ? (
						<Button
							variant="link"
							size="xs"
							className="h-5 px-0"
							onClick={() =>
								c.line &&
								follow.mutate(c.line.id, {
									onError: (e) => toast.error(humanError(e)),
								})
							}
						>
							Follow default
						</Button>
					) : null}
				</p>
			) : null}
		</li>
	);
}

type ForWhom = "everyone" | "me";

/**
 * How the budget editor opens for a row (ADDENDUM §7.1): on the row's own
 * line (my Custom line → "Just me" with my amount and "Reset to trip
 * default"; the inherited default → "Trip default" for owners and editors),
 * else a new line (the default for those who may set it, else mine).
 */
export function budgetEditorStart(
	line: Pick<BudgetLine, "memberId" | "amountMinor" | "kind"> | null,
	canDefault: boolean,
): { forWhom: ForWhom; kind: "total" | "per_day"; amountMinor: number | null } {
	const forWhom: ForWhom = line
		? line.memberId !== null
			? "me"
			: canDefault
				? "everyone"
				: "me"
		: canDefault
			? "everyone"
			: "me";
	return {
		forWhom,
		kind: line?.kind ?? "total",
		// Someone who can't set the default starts their own line from it.
		amountMinor: line ? line.amountMinor : null,
	};
}

/** Set / edit a budget line: amount, total or per day, category, and (editors) everyone vs me. */
function BudgetEditor({
	nodeId,
	category: initialCategory = null,
	data,
	meId,
	canDefault,
	home,
	line,
	trigger,
}: {
	nodeId: string | null;
	category?: ExpenseCategory | null;
	data: MoneyDto;
	meId: string | null;
	canDefault: boolean;
	home: string;
	line?: BudgetLine | null;
	trigger: React.ReactNode;
}) {
	const { graph, ix } = useWorkspace();
	const tripId = graph.trip.id;
	const [open, setOpen] = useState(false);
	const [category, setCategory] = useState<ExpenseCategory | null>(
		initialCategory,
	);
	// Everything below is (re)read from the row's CURRENT line each time the
	// popover opens: the line changes under a mounted row (my own save, a live
	// update from another tab), and a stale "Trip default" would write my
	// amount into everyone's default.
	const start = budgetEditorStart(line ?? null, canDefault);
	const [forWhom, setForWhom] = useState<ForWhom>(start.forWhom);
	const [kind, setKind] = useState<"total" | "per_day">(start.kind);
	const [text, setText] = useState(
		start.amountMinor === null ? "" : minorToInput(start.amountMinor, home),
	);
	const amount = parseMoneyInput(text, home);
	// FB-24: "Dennis is editing a budget" on the budget section; my own
	// private budget shows nothing.
	useFormPresence(
		open
			? {
					k: "budget",
					m: line ? "edit" : "add",
					t: "money:budget",
					private: forWhom === "me" && !!data.myBudgetPrivate,
				}
			: null,
	);
	const set = useTripMutation(
		(v: Parameters<typeof setBudgetLine>[0]["data"]) =>
			setBudgetLine({ data: v }),
		{
			keys: moneyKeys(tripId),
			onSuccess: () => setOpen(false),
		},
	);
	const del = useTripMutation(
		(id: string) => deleteBudgetLine({ data: { id } }),
		{
			keys: moneyKeys(tripId),
			onSuccess: () => setOpen(false),
		},
	);
	const def = defaultLine(data.budgets, nodeId, category);
	const mine = meId
		? data.budgets.find(
				(l) =>
					l.memberId === meId && l.nodeId === nodeId && l.category === category,
			)
		: undefined;
	/** The amount a choice starts from: that line's, if it has one. */
	const lineFor = (w: ForWhom) => (w === "me" ? mine : def) ?? null;
	const switchTo = (w: ForWhom) => {
		// An untouched amount follows the choice (mine ↔ the default's); with
		// no line there yet, it stays as the starting point.
		const was = lineFor(forWhom);
		const untouched = text === (was ? minorToInput(was.amountMinor, home) : "");
		const next = lineFor(w);
		if (untouched && next) {
			setText(minorToInput(next.amountMinor, home));
			setKind(next.kind);
		}
		setForWhom(w);
	};
	const save = () => {
		if (amount === null || amount < 0) return;
		set.mutate(
			{
				tripId,
				nodeId,
				category,
				memberId: forWhom === "everyone" ? null : meId,
				amountMinor: amount,
				kind,
			},
			{ onError: (e) => toast.error(humanError(e)) },
		);
	};
	return (
		<Popover
			open={open}
			onOpenChange={(v) => {
				setOpen(v);
				if (v) {
					const s = budgetEditorStart(line ?? null, canDefault);
					setCategory(initialCategory);
					setForWhom(s.forWhom);
					setKind(s.kind);
					setText(
						s.amountMinor === null ? "" : minorToInput(s.amountMinor, home),
					);
				}
			}}
		>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent className="w-80" align="end">
				<form
					className="grid gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						save();
					}}
				>
					<div className="text-sm font-medium">
						Budget for{" "}
						{nodeId ? (ix.node(nodeId)?.name ?? "this place") : "the trip"}
					</div>
					<div className="grid gap-1.5">
						<Label
							htmlFor="budget-cat"
							className="text-xs text-muted-foreground"
						>
							Category
						</Label>
						<Select
							value={category ?? "all"}
							onValueChange={(v) =>
								setCategory(v === "all" ? null : (v as ExpenseCategory))
							}
						>
							<SelectTrigger id="budget-cat" size="sm" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem className="cursor-pointer" value="all">
									All costs
								</SelectItem>
								{EXPENSE_CATEGORY_VALUES.map((c) => (
									<SelectItem className="cursor-pointer" key={c} value={c}>
										{EXPENSE_CATEGORY_LABEL[c]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex gap-2">
						<div className="grid flex-1 gap-1.5">
							<Label
								htmlFor="budget-amount"
								className="text-xs text-muted-foreground"
							>
								Amount ({home})
							</Label>
							<Input
								id="budget-amount"
								autoFocus
								inputMode="decimal"
								className="font-mono tnum placeholder:font-sans"
								value={text}
								onChange={(e) => setText(e.target.value)}
							/>
						</div>
						<div className="grid gap-1.5">
							<span className="text-xs text-muted-foreground">Per</span>
							<ToggleGroup
								type="single"
								variant="outline"
								size="sm"
								value={kind}
								onValueChange={(v) => v && setKind(v as "total" | "per_day")}
							>
								<ToggleGroupItem value="total" className="px-2 text-xs">
									Total
								</ToggleGroupItem>
								<ToggleGroupItem value="per_day" className="px-2 text-xs">
									Day
								</ToggleGroupItem>
							</ToggleGroup>
						</div>
					</div>
					{canDefault && meId ? (
						<ToggleGroup
							type="single"
							variant="outline"
							size="sm"
							value={forWhom}
							onValueChange={(v) => v && switchTo(v as ForWhom)}
							className="w-full"
						>
							<ToggleGroupItem value="everyone" className="flex-1 text-xs">
								Trip default
							</ToggleGroupItem>
							<ToggleGroupItem value="me" className="flex-1 text-xs">
								Just me
							</ToggleGroupItem>
						</ToggleGroup>
					) : null}
					{forWhom === "me" && def ? (
						<p className="text-xs text-muted-foreground">
							Trip default: <Num>{formatMoney(def.amountMinor, home)}</Num>.
							Yours replaces it for you.
						</p>
					) : null}
					<div className="flex items-center gap-2">
						{forWhom === "me" && mine ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() =>
									del.mutate(mine.id, {
										onError: (e) => toast.error(humanError(e)),
									})
								}
							>
								{def ? "Reset to trip default" : "Remove"}
							</Button>
						) : forWhom === "everyone" && def ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() =>
									del.mutate(def.id, {
										onError: (e) => toast.error(humanError(e)),
									})
								}
							>
								Remove default
							</Button>
						) : null}
						<Button
							type="submit"
							size="sm"
							className="ml-auto"
							disabled={amount === null || set.isPending}
						>
							Save
						</Button>
					</div>
				</form>
			</PopoverContent>
		</Popover>
	);
}
