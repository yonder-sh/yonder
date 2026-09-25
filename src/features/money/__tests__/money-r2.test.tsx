/**
 * QA round 2 (money), in fixture mode: the budget editor reopens on the
 * row's CURRENT line (MONEY-R2-01), a settlement shows its place or day tag
 * (MONEY-R2-07), and the breakdown counts priced shopping items so it adds
 * up to Planned (MONEY-R2-04).
 */
import { QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DEMO_MEMBERS, N, scenario } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { breakdownParts } from "../Breakdown";
import { budgetEditorStart } from "../BudgetSection";
import { MoneyTab } from "../MoneyTab";
import type { MoneyDto } from "../money.functions";
import { settlementTagLabel } from "../SettleUpDialog";
import { MONEY_TESTID as M } from "../testids";
import type { Row, ShoppingRow } from "../use-money";
import { useMoneyUi } from "../use-money";

const qc = (money: MoneyDto) => {
	const q = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	q.setQueryData(["fixture", "money"], money);
	return q;
};

describe("MONEY-R2-01: the budget editor opens on the row's current line", () => {
	it("budgetEditorStart: my Custom line → Just me with my amount; the default → Trip default", () => {
		expect(
			budgetEditorStart(
				{ memberId: "me", amountMinor: 4000, kind: "total" },
				true,
			),
		).toEqual({ forWhom: "me", kind: "total", amountMinor: 4000 });
		expect(
			budgetEditorStart(
				{ memberId: null, amountMinor: 8000, kind: "per_day" },
				true,
			),
		).toEqual({ forWhom: "everyone", kind: "per_day", amountMinor: 8000 });
		// Someone who can't set the default starts their own line from it.
		expect(
			budgetEditorStart(
				{ memberId: null, amountMinor: 8000, kind: "total" },
				false,
			).forWhom,
		).toBe("me");
		expect(budgetEditorStart(null, true).amountMinor).toBeNull();
	});

	it("a row that became Custom (a live update) reopens on Just me with Reset to trip default", async () => {
		const user = userEvent.setup();
		const q = qc(scenario.money);
		renderWithWorkspace(<MoneyTab />, { queryClient: q });
		const budget = await screen.findByTestId(M.budget);
		const allRow = () =>
			within(budget)
				.getAllByTestId(M.budgetRow)
				.find((r) => r.dataset.category === "all") as HTMLElement;
		const popover = () =>
			document.querySelector("[data-slot=popover-content]") as HTMLElement;
		// 1) The trip default ($3,500): opens on Trip default.
		await user.click(within(allRow()).getByTestId(M.budgetEdit));
		await waitFor(() => expect(popover()).toBeTruthy());
		expect(
			within(popover()).getByRole("radio", { name: "Trip default" }),
		).toHaveAttribute("aria-checked", "true");
		expect(
			(within(popover()).getByLabelText(/Amount/) as HTMLInputElement).value,
		).toBe("3500.00");
		await user.keyboard("{Escape}");
		await waitFor(() => expect(popover()).toBeNull());
		// 2) My own $3,000 line arrives from another tab.
		act(() => {
			q.setQueryData(["fixture", "money"], {
				...scenario.money,
				budgets: [
					...scenario.money.budgets,
					{
						id: "00000000-0000-4000-8000-0000000063ff",
						nodeId: null,
						category: null,
						memberId: DEMO_MEMBERS.dennis,
						amountMinor: 300_000,
						kind: "total",
						defaultSeenMinor: 350_000,
					},
				],
			} satisfies MoneyDto);
		});
		await waitFor(() => expect(allRow().dataset.source).toBe("custom"));
		await user.click(within(allRow()).getByTestId(M.budgetEdit));
		await waitFor(() => expect(popover()).toBeTruthy());
		const pop = within(popover());
		expect(pop.getByRole("radio", { name: "Just me" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		expect((pop.getByLabelText(/Amount/) as HTMLInputElement).value).toBe(
			"3000.00",
		);
		expect(
			pop.getByRole("button", { name: "Reset to trip default" }),
		).toBeTruthy();
		expect(pop.queryByRole("button", { name: "Remove default" })).toBeNull();
		// Switching to Trip default shows the default's amount, not mine.
		await user.click(pop.getByRole("radio", { name: "Trip default" }));
		expect((pop.getByLabelText(/Amount/) as HTMLInputElement).value).toBe(
			"3500.00",
		);
	});
});

describe("MONEY-R2-07: a settlement's context tag", () => {
	it("labels a place or a day, and nothing once it's gone", () => {
		const ix = {
			node: (id: string | null | undefined) =>
				id === "n1" ? ({ name: "Kyoto" } as never) : undefined,
			day: (id: string | null | undefined) =>
				id === "d6" ? ({ id: "d6" } as never) : undefined,
			dayNumber: () => 6,
		};
		expect(settlementTagLabel(ix, { nodeId: "n1" })).toBe("Kyoto");
		expect(settlementTagLabel(ix, { dayId: "d6" })).toBe("Day 6");
		expect(settlementTagLabel(ix, { nodeId: "gone" })).toBeNull();
		expect(settlementTagLabel(ix, null)).toBeNull();
	});

	it("shows the Kyoto tag on the recorded row in Settle up", async () => {
		renderWithWorkspace(<MoneyTab />);
		await screen.findAllByTestId(M.expenseRow);
		act(() => useMoneyUi.getState().openSettle(true));
		const row = await screen.findByTestId(M.settlementRow);
		expect(within(row).getByTestId(M.settlementTag).textContent).toContain(
			"Kyoto",
		);
		expect(row.textContent).toMatch(/cash · Kyoto/);
		act(() => useMoneyUi.getState().openSettle(false));
	});

	it("recording from one day's view tags the settlement to that day", async () => {
		const user = userEvent.setup();
		renderWithWorkspace(<MoneyTab />, { search: { days: "2027-10-06" } });
		await screen.findByTestId(M.balances);
		act(() => useMoneyUi.getState().openSettle(true));
		const dialog = await screen.findByTestId(M.settleUpDialog);
		await user.click(
			within(dialog).getAllByTestId(M.transferRecord)[0] as HTMLElement,
		);
		const tag = within(dialog).getByLabelText("Tag it to a place or a day");
		expect(tag.textContent).toBe("On Day 4 · 6 Oct");
		act(() => useMoneyUi.getState().openSettle(false));
	});
});

describe("MONEY-R2-04: the breakdown counts priced shopping items", () => {
	it("adds the shopping list's planned costs (never private ones) to the rows", () => {
		const anchor = { nodeId: N.tokyo ?? null, dayId: null } as Row["anchor"];
		const row = {
			expense: {
				category: "lodging",
				isPrivate: false,
				amountMinor: 80_000,
				currency: "JPY",
				payments: [],
			},
			facts: { plannedHome: 50_753, actualHome: 0 },
			anchor,
		} as unknown as Row;
		const knife = {
			item: { isPrivate: false },
			homeMinor: 7613,
			amountMinor: 12_000,
			currency: "JPY",
			anchor,
		} as unknown as ShoppingRow;
		const gift = {
			item: { isPrivate: true },
			homeMinor: 999,
			anchor,
		} as unknown as ShoppingRow;
		const parts = breakdownParts([row], [knife, gift]);
		expect(parts.map((p) => [p.category, p.planned, p.actual])).toEqual([
			["lodging", 50_753, 0],
			["shopping", 7613, 0],
		]);
		expect(parts.reduce((a, p) => a + p.planned, 0)).toBe(50_753 + 7613);
		// QA MONEY-19: each part also carries its exact amount in its currency.
		expect(parts.map((p) => p.exact)).toEqual([
			{ currency: "JPY", planned: 80_000, actual: 0, remaining: 80_000 },
			{ currency: "JPY", planned: 12_000, actual: 0 },
		]);
	});
});
