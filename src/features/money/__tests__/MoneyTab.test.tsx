/**
 * The Money tab in fixture mode (`scenario.money`: three expenses, one
 * private, a ¥ settlement, budgets): rows, the private row, the summary,
 * net positions at a scope, the budget notice for a custom line, the editor
 * opening from a row, and nothing at all for a guest.
 */
import { QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { demoGraph, N, scenario } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { MoneyPanel } from "../MoneyPanel";
import { MoneyTab } from "../MoneyTab";
import type { ExpenseDto } from "../money.functions";
import { MONEY_TESTID as M } from "../testids";
import { type Display, originalAndApprox } from "../use-money";

describe("MoneyTab (fixture)", () => {
	it("lists the trip's costs with the private one marked, and the summary", async () => {
		renderWithWorkspace(<MoneyTab />);
		const rows = await screen.findAllByTestId(M.expenseRow);
		expect(rows).toHaveLength(3);
		const pen = rows.find((r) => r.textContent?.includes("Fountain pen"));
		expect(pen?.textContent).toContain("Only you");
		const ryokan = rows.find((r) =>
			r.textContent?.includes("Kawaguchiko Ryokan"),
		);
		expect(ryokan?.textContent).toContain("¥10K of ¥60K");
		expect(screen.getByTestId(M.summaryPlanned).textContent).toMatch(/^\$/);
		expect(screen.getByTestId(M.balances)).toBeTruthy();
	});

	it("shows net positions at a scope and a custom budget's notice", async () => {
		renderWithWorkspace(<MoneyTab />, { splat: "japan" });
		await screen.findAllByTestId(M.expenseRow);
		expect(screen.getByTestId(M.netPositions).textContent).toContain(
			"Within Japan",
		);
		// Dennis's own Japan food line was set against 70,000; the default is now 80,000.
		const budget = screen.getByTestId(M.budget);
		await waitFor(() =>
			expect(within(budget).getByTestId(M.budgetNotice).textContent).toContain(
				"Trip default is now",
			),
		);
	});

	it("opens the editor from a row", async () => {
		const user = userEvent.setup();
		renderWithWorkspace(<MoneyTab />);
		const rows = await screen.findAllByTestId(M.expenseRow);
		const kiyomizu = rows.find((r) => r.textContent?.includes("Kiyomizu"));
		if (!kiyomizu) throw new Error("no row");
		await user.click(kiyomizu);
		const dialog = await screen.findByTestId(TESTID.addExpenseDialog);
		expect(
			(within(dialog).getByTestId(M.title) as HTMLInputElement).value,
		).toBe("Kiyomizu-dera tickets");
		expect(within(dialog).getByTestId(M.payments)).toBeTruthy();
	});

	it("opens an expense or a refund from `useUi().openAddExpense` (inbox links, overviews)", async () => {
		renderWithWorkspace(<MoneyTab />);
		await screen.findAllByTestId(M.expenseRow);
		const kiyomizu = scenario.money.expenses.find((e) =>
			e.title.startsWith("Kiyomizu"),
		);
		if (!kiyomizu) throw new Error("no expense");
		act(() => useUi.getState().openAddExpense({ expenseId: kiyomizu.id }));
		let dialog = await screen.findByTestId(TESTID.addExpenseDialog);
		expect(
			(within(dialog).getByTestId(M.title) as HTMLInputElement).value,
		).toBe("Kiyomizu-dera tickets");
		act(() => useUi.getState().openAddExpense({ refundOfId: kiyomizu.id }));
		dialog = await screen.findByTestId(TESTID.addExpenseDialog);
		expect(
			within(dialog).getByText("Split back like the original."),
		).toBeTruthy();
		act(() => useUi.getState().openAddExpense(null));
		await waitFor(() =>
			expect(screen.queryByTestId(TESTID.addExpenseDialog)).toBeNull(),
		);
	});

	it("QA MONEY-QA-10: a payment's payers and their amounts are editable, with the remainder", async () => {
		const user = userEvent.setup();
		renderWithWorkspace(<MoneyTab />);
		await screen.findAllByTestId(M.expenseRow);
		const ryokan = scenario.money.expenses.find((e) =>
			e.title.startsWith("Kawaguchiko"),
		);
		if (!ryokan) throw new Error("no expense");
		act(() => useUi.getState().openAddExpense({ expenseId: ryokan.id }));
		const dialog = await screen.findByTestId(TESTID.addExpenseDialog);
		const row = within(dialog).getByTestId(M.paymentRow);
		// A payment can be in another currency than the cost.
		expect(within(row).getByTestId(M.paymentCurrency).textContent).toContain(
			"JPY",
		);
		await user.click(within(row).getByTestId(M.paymentAddPayer));
		const amounts = within(row).getAllByTestId(
			M.paymentPayerAmount,
		) as HTMLInputElement[];
		expect(amounts).toHaveLength(2);
		expect(amounts[0]?.value).toBe("10000");
		await user.type(amounts[1] as HTMLInputElement, "2000");
		expect(within(row).getByTestId(M.remainder).textContent).toContain(
			"too much",
		);
		const save = within(dialog).getByTestId(M.save) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		expect(dialog.textContent).toContain("Payers must add up to each payment.");
		await user.clear(amounts[0] as HTMLInputElement);
		await user.type(amounts[0] as HTMLInputElement, "8000");
		expect(within(row).getByTestId(M.remainder).textContent).toContain(
			"Adds up",
		);
		expect(save.disabled).toBe(false);
	});

	it("QA MONEY-QA-10: pooled payers follow a new payment amount in their proportions", async () => {
		const user = userEvent.setup();
		const [kiyomizu, ryokan] = scenario.money.expenses;
		if (!kiyomizu?.payments[0] || !ryokan?.payments[0])
			throw new Error("no fixture");
		const dennis = kiyomizu.payments[0].payers[0]?.memberId as string;
		const audrey = ryokan.payments[0].payers[0]?.memberId as string;
		const pooled: ExpenseDto = {
			...kiyomizu,
			id: "00000000-0000-4000-8000-00000000abcd",
			title: "Pooled cash dinner",
			amountMinor: 9000,
			homeAmountMinor: 6000,
			payments: [
				{
					...kiyomizu.payments[0],
					amountMinor: 9000,
					homeAmountMinor: 6000,
					payers: [
						{ memberId: dennis, amountMinor: 5000 },
						{ memberId: audrey, amountMinor: 4000 },
					],
				},
			],
		};
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData(["fixture", "money"], {
			...scenario.money,
			expenses: [...scenario.money.expenses, pooled],
		});
		renderWithWorkspace(<MoneyTab />, { queryClient });
		await screen.findAllByTestId(M.expenseRow);
		act(() => useUi.getState().openAddExpense({ expenseId: pooled.id }));
		const dialog = await screen.findByTestId(TESTID.addExpenseDialog);
		const row = within(dialog).getByTestId(M.paymentRow);
		const amounts = () =>
			(
				within(row).getAllByTestId(M.paymentPayerAmount) as HTMLInputElement[]
			).map((i) => i.value);
		expect(amounts()).toEqual(["5000", "4000"]);
		const payment = within(row).getByLabelText("Payment amount");
		await user.clear(payment);
		await user.type(payment, "9900");
		expect(amounts()).toEqual(["5500", "4400"]);
		expect(within(row).getByTestId(M.remainder).textContent).toContain(
			"Adds up",
		);
		// Once a payer is edited by hand, the amounts stay put.
		const first = within(row).getAllByTestId(
			M.paymentPayerAmount,
		)[0] as HTMLInputElement;
		await user.clear(first);
		await user.type(first, "6000");
		await user.clear(payment);
		await user.type(payment, "10400");
		expect(amounts()).toEqual(["6000", "4400"]);
		expect(within(row).getByTestId(M.remainder).textContent).toContain(
			"Adds up",
		);
	});

	it("QA MONEY-QA-12: the points editor shows cents per point for both programmes", async () => {
		const user = userEvent.setup();
		renderWithWorkspace(<MoneyTab />);
		await screen.findAllByTestId(M.expenseRow);
		act(() => useUi.getState().openAddExpense({}));
		const dialog = await screen.findByTestId(TESTID.addExpenseDialog);
		const d = within(dialog);
		await user.type(d.getByTestId(M.amount), "300");
		await user.click(d.getByTestId(M.more));
		await user.click(d.getByTestId(M.points));
		await user.type(d.getByLabelText("Programme"), "Aeroplan");
		await user.type(d.getByLabelText("Points"), "240000");
		await user.type(d.getByLabelText("Source programme"), "Chase UR");
		await user.type(d.getByLabelText("Source points"), "200000");
		await user.type(d.getByLabelText("Cash price"), "6000");
		expect(dialog.textContent).toContain(
			"2.38¢ per point · 2.85¢ per Chase UR point",
		);
	});

	it("QA MONEY-QA-03: a paid row's ≈ shows what was paid, not the plan at today's rate", () => {
		const display = {
			code: "USD",
			toDisplay: (m: number) => m,
		} as unknown as Display;
		const base = {
			amountMinor: 60_000,
			currency: "JPY",
			homeAmountMinor: 38_065,
		};
		const paid = originalAndApprox(
			{
				...base,
				status: "paid",
				payments: [
					{ homeAmountMinor: 6_700 },
					{ homeAmountMinor: 31_422 },
				] as ExpenseDto["payments"],
			},
			display,
		);
		expect(paid).toEqual({ original: "¥60,000", approx: "≈ $381.22" });
		const partial = originalAndApprox(
			{
				...base,
				status: "partial",
				payments: [{ homeAmountMinor: 6_700 }] as ExpenseDto["payments"],
			},
			display,
		);
		expect(partial.approx).toBe("≈ $380.65");
	});

	it("shows a viewer the Expense button, disabled", async () => {
		const graph = {
			...demoGraph,
			me: { ...demoGraph.me, role: "viewer" as const },
		};
		renderWithWorkspace(<MoneyTab />, { graph });
		await screen.findAllByTestId(M.expenseRow);
		expect(
			(screen.getByTestId(M.addButton) as HTMLButtonElement).disabled,
		).toBe(true);
	});

	it("the inspector panel on a place: its costs, net positions and budget", async () => {
		renderWithWorkspace(
			<MoneyPanel target={{ kind: "node", nodeId: N.japan ?? "" }} />,
		);
		await screen.findAllByTestId(M.expenseRow);
		const panel = screen.getByTestId(TESTID.moneyPanel);
		expect(within(panel).getByTestId(M.budget)).toBeTruthy();
		expect(within(panel).getByTestId(M.netPositions).textContent).toContain(
			"Within Japan",
		);
	});

	it("renders nothing for a link guest", () => {
		const graph = {
			...demoGraph,
			me: {
				...demoGraph.me,
				isGuest: true,
				memberId: null,
				role: "editor" as const,
			},
		};
		const { container } = renderWithWorkspace(<MoneyTab />, { graph });
		expect(
			container.querySelector(`[data-testid=${TESTID.moneyTab}]`),
		).toBeNull();
	});
});
