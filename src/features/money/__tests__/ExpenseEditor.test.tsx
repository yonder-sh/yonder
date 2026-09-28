/**
 * Add an expense (One Yonder P13, "in ten seconds"), in fixture mode on day 3
 * of the demo trip: the amount with its currency and ≈, What for, Paid by and
 * Split equally with as pills, the date and place from where it was opened,
 * Save; "More" still reaches every other field (itemise with fees, exact
 * amounts, pooled payers, private, points), and an existing expense still
 * edits its payments.
 */
import { QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_MEMBERS, demo, N, scenario } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { type AddExpenseRequest, useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { AddExpenseDialog } from "../AddExpenseDialog";
import type { MoneyDto } from "../money.functions";
import { PersonSelect } from "../PersonSelect";
import { MONEY_TESTID as M } from "../testids";

const server = vi.hoisted(() => ({
	calls: [] as [string, Record<string, unknown>][],
}));

vi.mock("../money.functions", async (importOriginal) => ({
	...(await importOriginal<object>()),
	createExpense: async ({ data }: { data: Record<string, unknown> }) => {
		server.calls.push(["create", data]);
		return { id: "00000000-0000-4000-8000-00000000e001" };
	},
	updateExpense: async ({ data }: { data: Record<string, unknown> }) => {
		server.calls.push(["update", data]);
		return { updatedAt: new Date().toISOString() };
	},
}));

const { dennis, audrey } = DEMO_MEMBERS;

const tokyo = { target: { kind: "node", nodeId: N.tokyo ?? "" } } as const;

/** Opens the editor (in Tokyo: yen); ¥150 to the dollar, so ¥9,000 ≈ $60.00. */
async function open(req: AddExpenseRequest = tokyo) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	queryClient.setQueryData(["fixture", "money"], {
		...scenario.money,
		latestRates: { JPY: 150 },
	} satisfies MoneyDto);
	renderWithWorkspace(<AddExpenseDialog />, { queryClient });
	act(() => useUi.getState().openAddExpense(req));
	const dialog = await screen.findByTestId(TESTID.addExpenseDialog);
	return { dialog, d: within(dialog), user: userEvent.setup() };
}

const pills = (root: HTMLElement, testid: string) =>
	within(root).getAllByTestId(testid) as HTMLButtonElement[];
/** Who is picked (member ids). */
const pressed = (els: HTMLElement[]) =>
	els
		.filter((e) => e.getAttribute("aria-pressed") === "true")
		.map((e) => e.dataset.memberId);
const created = () =>
	server.calls.filter(([k]) => k === "create").map(([, v]) => v);
/** The first new expense's payment. */
const firstPayment = () =>
	(
		created()[0]?.payments as
			| { paidAt: string; payers: unknown[] }[]
			| undefined
	)?.[0];

beforeEach(() => {
	server.calls = [];
	// Tue 5 Oct 2027, the trip's day 3.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2027-10-05T10:00:00Z"));
});

afterEach(() => {
	act(() => useUi.getState().openAddExpense(null));
	vi.useRealTimers();
});

describe("Add an expense (P13)", () => {
	it("reads amount, What for, Paid by, Split equally with, the day and place, Save", async () => {
		const { dialog, d, user } = await open();
		expect(d.getByRole("heading", { name: "Add an expense" })).toBeTruthy();
		expect(d.getByRole("button", { name: "Close" })).toBeTruthy();
		const amount = d.getByTestId(M.amount);
		expect(document.activeElement).toBe(amount);
		// Tokyo pays in yen; ≈ in the display currency.
		expect(d.getByTestId(M.currency).textContent).toBe("JPY");
		await user.type(amount, "9000");
		expect(d.getByTestId(M.converted).textContent).toBe("≈ $60.00");
		await user.type(d.getByLabelText("What for"), "Dinner at Omoide Yokocho");
		// Paid by: You first, picked; the others after.
		const payers = pills(dialog, M.payerPerson);
		expect(payers.map((p) => p.textContent)).toEqual(["You", "Audrey"]);
		expect(pressed(payers)).toEqual([dennis]);
		// Split equally with everyone, a check on each.
		expect(d.getByText("Split equally with")).toBeTruthy();
		expect(d.getByText("who was there")).toBeTruthy();
		const split = pills(dialog, M.splitPerson);
		expect(split.map((p) => p.dataset.memberId)).toEqual([dennis, audrey]);
		expect(pressed(split)).toEqual([dennis, audrey]);
		// The avatar is decoration: the pill's name is the person's.
		expect(d.getByRole("button", { name: "Audrey", pressed: true })).toBe(
			split[1],
		);
		expect(split.every((p) => p.querySelector(".lucide-check"))).toBe(true);
		// The date and the place, and More (closed).
		expect(d.getByTestId(M.when).textContent).toBe("Tue 5 Oct");
		expect(d.getByTestId(M.when).getAttribute("aria-label")).toBe(
			"Paid on: Tue 5 Oct",
		);
		expect(d.getByTestId(M.place).textContent).toBe("Tokyo");
		expect(d.getByTestId(M.more).textContent).toBe(
			"More: itemise, fees, points",
		);
		expect(d.queryByTestId(M.moreFields)).toBeNull();
		expect(d.queryByTestId(M.status)).toBeNull();

		await user.click(d.getByTestId(M.save));
		await waitFor(() => expect(created()).toHaveLength(1));
		expect(created()[0]).toMatchObject({
			target: { kind: "node", nodeId: N.tokyo },
			title: "Dinner at Omoide Yokocho",
			amountMinor: 9000,
			currency: "JPY",
			split: {
				mode: "equal",
				shares: [{ memberId: dennis }, { memberId: audrey }],
			},
		});
		expect(firstPayment()?.paidAt.slice(0, 10)).toBe("2027-10-05");
		expect(firstPayment()?.payers).toEqual([
			{ memberId: dennis, amountMinor: 9000 },
		]);
		await waitFor(() =>
			expect(screen.queryByTestId(TESTID.addExpenseDialog)).toBeNull(),
		);
	});

	it("starts on the stop's day and place, and changes the date", async () => {
		const { d, user } = await open({
			target: { kind: "item", itemId: demo.I.sky ?? "" },
			title: "Shibuya Sky",
		});
		expect(d.getByTestId(M.when).textContent).toBe("Sun 3 Oct");
		expect(d.getByTestId(M.place).textContent).toBe("Shibuya Sky");
		await user.click(d.getByTestId(M.when));
		const calendar = await screen.findByRole("grid");
		await user.click(
			within(calendar).getByRole("button", { name: /October 4th, 2027/ }),
		);
		expect(d.getByTestId(M.when).textContent).toBe("Mon 4 Oct");
		await user.type(d.getByTestId(M.amount), "3600");
		await user.click(d.getByTestId(M.save));
		await waitFor(() => expect(created()).toHaveLength(1));
		expect(firstPayment()?.paidAt.slice(0, 10)).toBe("2027-10-04");
	});

	it("Paid by: someone else, or nobody yet (planned, expected on its day)", async () => {
		const { dialog, d, user } = await open({
			target: { kind: "day", dayId: demo.D.d4 ?? "" },
		});
		await user.type(d.getByTestId(M.amount), "1200");
		const audreyPill = () =>
			pills(dialog, M.payerPerson).find(
				(p) => p.dataset.memberId === audrey,
			) as HTMLButtonElement;
		await user.click(audreyPill());
		expect(pressed(pills(dialog, M.payerPerson))).toEqual([audrey]);
		// Tapping her again: nobody has paid yet.
		await user.click(audreyPill());
		expect(pressed(pills(dialog, M.payerPerson))).toEqual([]);
		expect(d.getByTestId(M.payer).textContent).toContain("Not paid yet");
		expect(d.getByTestId(M.when).getAttribute("aria-label")).toBe(
			"Expected on: Wed 6 Oct",
		);
		await user.click(d.getByTestId(M.save));
		await waitFor(() => expect(created()).toHaveLength(1));
		expect(created()[0]).toMatchObject({
			target: { kind: "day", dayId: demo.D.d4 },
			expectedOn: "2027-10-06",
			payments: [],
		});
	});

	it("Split: untick who wasn't there", async () => {
		const { dialog, d, user } = await open();
		await user.type(d.getByTestId(M.amount), "3000");
		const her = pills(dialog, M.splitPerson).find(
			(p) => p.dataset.memberId === audrey,
		) as HTMLButtonElement;
		await user.click(her);
		expect(her.getAttribute("aria-pressed")).toBe("false");
		expect(her.querySelector(".lucide-check")).toBeNull();
		await user.click(d.getByTestId(M.save));
		await waitFor(() => expect(created()).toHaveLength(1));
		expect(created()[0]?.split).toEqual({
			mode: "equal",
			shares: [{ memberId: dennis }],
		});
	});

	it("More reveals every other field", async () => {
		const { d, user } = await open();
		await user.click(d.getByTestId(M.more));
		const more = within(d.getByTestId(M.moreFields));
		expect(d.getByTestId(M.more).textContent).toBe("Show less");
		expect(more.getByTestId(M.status)).toBeTruthy();
		expect(more.getByLabelText("Time paid")).toBeTruthy();
		expect(more.getByTestId(M.category)).toBeTruthy();
		expect(more.getByRole("radio", { name: "Exact amounts" })).toBeTruthy();
		expect(
			more.getByRole("switch", { name: "Several people paid (pooled cash)" }),
		).toBeTruthy();
		expect(more.getByTestId(M.private)).toBeTruthy();
		expect(more.getByTestId(M.itemize)).toBeTruthy();
		expect(more.getByTestId(M.points)).toBeTruthy();
		expect(more.getByTestId(M.receipt)).toBeTruthy();
		expect(more.getByLabelText("Note")).toBeTruthy();
		// Planned under More too: Paid by then waits.
		await user.click(more.getByRole("radio", { name: "Planned" }));
		expect(d.getByTestId(M.payer).textContent).toContain("Not paid yet");
		await user.click(d.getByTestId(M.more));
		expect(d.queryByTestId(M.moreFields)).toBeNull();
	});

	it("itemises two dishes with a 10% service charge", async () => {
		const { dialog, d, user } = await open();
		await user.type(d.getByTestId(M.amount), "2860");
		await user.click(d.getByTestId(M.more));
		await user.click(d.getByTestId(M.itemize));
		expect(
			d.getByText("Split by item: who had what, under More."),
		).toBeTruthy();
		expect(d.queryByTestId(M.splitPerson)).toBeNull();
		const line = () => within(dialog).getAllByTestId(M.line);
		await user.type(
			within(line()[0] as HTMLElement).getByLabelText("Item"),
			"Ramen",
		);
		await user.type(
			within(line()[0] as HTMLElement).getByTestId(M.lineAmount),
			"1200",
		);
		await user.click(d.getByTestId(M.addLine));
		const beer = within(line()[1] as HTMLElement);
		await user.type(beer.getByLabelText("Item"), "Beer");
		await user.type(beer.getByTestId(M.lineAmount), "1400");
		await user.click(
			beer
				.getAllByTestId(M.linePerson)
				.find((b) => b.textContent?.includes("Audrey")) as HTMLElement,
		);
		await user.click(d.getByTestId(M.addFee));
		expect(d.getAllByTestId(M.remainder).at(-1)?.textContent).toBe("Adds up ✓");
		await user.click(d.getByTestId(M.save));
		await waitFor(() => expect(created()).toHaveLength(1));
		expect(created()[0]).toMatchObject({
			lines: [
				{ label: "Ramen", amountMinor: 1200, memberIds: [dennis, audrey] },
				{ label: "Beer", amountMinor: 1400, memberIds: [audrey] },
			],
			fees: [{ label: "Service", kind: "percent", percent: 10 }],
		});
	});

	it("splits by exact amounts, from More", async () => {
		const { dialog, d, user } = await open();
		await user.type(d.getByTestId(M.amount), "9000");
		await user.click(d.getByTestId(M.more));
		await user.click(d.getByTestId(M.splitExact));
		expect(d.getByTestId(M.splitToggle).textContent).toContain(
			"Split by exact amounts",
		);
		const [mine, hers] = within(dialog).getAllByTestId(
			M.splitExactAmount,
		) as HTMLInputElement[];
		await user.type(mine as HTMLInputElement, "6000");
		expect(d.getByTestId(M.splitToggle).textContent).toContain("left");
		await user.type(hers as HTMLInputElement, "3000");
		expect(d.getByTestId(M.splitToggle).textContent).toContain("Adds up ✓");
		await user.click(d.getByTestId(M.save));
		await waitFor(() => expect(created()).toHaveLength(1));
		expect(created()[0]?.split).toEqual({
			mode: "exact",
			shares: [
				{ memberId: dennis, amountMinor: 6000 },
				{ memberId: audrey, amountMinor: 3000 },
			],
		});
	});

	it("pooled cash: Paid by lists each payer and what they put in", async () => {
		const { dialog, d, user } = await open();
		await user.type(d.getByTestId(M.amount), "9000");
		await user.click(d.getByTestId(M.more));
		await user.click(
			d.getByRole("switch", { name: "Several people paid (pooled cash)" }),
		);
		expect(d.queryByTestId(M.payerPerson)).toBeNull();
		const rows = within(d.getByTestId(M.multiPayer));
		const [a, b] = rows.getAllByTestId(M.payerAmount) as HTMLInputElement[];
		await user.type(a as HTMLInputElement, "5000");
		await user.type(b as HTMLInputElement, "4000");
		expect(rows.getByTestId(M.remainder).textContent).toBe("Adds up ✓");
		await user.click(within(dialog).getByTestId(M.save));
		await waitFor(() => expect(created()).toHaveLength(1));
		expect(firstPayment()?.payers).toEqual([
			{ memberId: dennis, amountMinor: 5000 },
			{ memberId: audrey, amountMinor: 4000 },
		]);
	});

	it("private: only mine, not split", async () => {
		const { d, user } = await open();
		await user.type(d.getByTestId(M.amount), "18000");
		await user.click(d.getByTestId(M.more));
		await user.click(d.getByTestId(M.private));
		expect(d.queryByTestId(M.payer)).toBeNull();
		expect(d.queryByTestId(M.splitPerson)).toBeNull();
		expect(d.getByText(/Only you see this/)).toBeTruthy();
		await user.click(d.getByTestId(M.save));
		await waitFor(() => expect(created()).toHaveLength(1));
		expect(created()[0]).toMatchObject({ isPrivate: true });
		expect(created()[0]?.split).toBeUndefined();
	});

	it("points: the amount is the cash part, and may stay empty", async () => {
		const { d, user } = await open();
		await user.click(d.getByTestId(M.more));
		await user.click(d.getByTestId(M.points));
		expect(d.getByText("The cash part: taxes and fees.")).toBeTruthy();
		await user.type(d.getByLabelText("Programme"), "Aeroplan");
		await user.type(d.getByLabelText("Points"), "60000");
		await user.click(d.getByTestId(M.save));
		await waitFor(() => expect(created()).toHaveLength(1));
		expect(created()[0]?.amountMinor).toBeUndefined();
		expect(created()[0]?.points).toEqual({
			program: "Aeroplan",
			points: 60000,
		});
	});

	it("before the trip: planned by default, expected on its day; picking who paid records it paid today", async () => {
		vi.setSystemTime(new Date("2026-09-28T10:00:00Z"));
		const { dialog, d, user } = await open({
			target: { kind: "day", dayId: demo.D.d2 ?? "" },
		});
		expect(pressed(pills(dialog, M.payerPerson))).toEqual([]);
		expect(d.getByTestId(M.payer).textContent).toContain("Not paid yet");
		expect(d.getByTestId(M.when).textContent).toBe("Expected Mon 4 Oct");
		await user.click(pills(dialog, M.payerPerson)[0] as HTMLElement);
		expect(pressed(pills(dialog, M.payerPerson))).toEqual([dennis]);
		expect(d.getByTestId(M.when).textContent).toBe("Mon 28 Sep 2026");
	});

	it("opens an existing expense on its payments, split and actions", async () => {
		const kiyomizu = scenario.money.expenses[0];
		const { dialog, d } = await open({ expenseId: kiyomizu?.id ?? "" });
		expect(d.getByRole("heading", { name: "Expense" })).toBeTruthy();
		expect((d.getByTestId(M.title) as HTMLInputElement).value).toBe(
			"Kiyomizu-dera tickets",
		);
		expect(d.getByTestId(M.payments)).toBeTruthy();
		expect(d.queryByTestId(M.payerPerson)).toBeNull();
		expect(pressed(pills(dialog, M.splitPerson))).toEqual([dennis, audrey]);
		expect(d.getByTestId(M.when).getAttribute("aria-label")).toMatch(
			/^Paid on: Wed 6 Oct/,
		);
		expect(d.getByTestId(M.place).textContent).toBe("Kiyomizu-dera");
		expect(d.getByTestId(M.refund)).toBeTruthy();
		expect(d.getByTestId(M.delete)).toBeTruthy();
		expect(d.getByTestId(M.save).textContent).toBe("Save");
	});

	it("PersonSelect opens from a given trigger (Paid by's + Person)", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		renderWithWorkspace(
			<PersonSelect
				value={dennis}
				onChange={onChange}
				trigger={<button type="button">Person</button>}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Person" }));
		await user.click(await screen.findByRole("option", { name: /Audrey/ }));
		expect(onChange).toHaveBeenCalledWith(audrey);
	});
});
