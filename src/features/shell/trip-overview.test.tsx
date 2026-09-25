/**
 * The trip root overview (QA rounds 1–2), now split (docs/OVERVIEW.md §7):
 * the inspector keeps a compact summary, "Still to plan" and a link to the
 * Overview page, which took the climate table of the visited cities
 * (COLLAB-4 / CLIM-03), the deadline chips with each time in its own zone and
 * the zone's label (COLLAB-9, PLAN-I2-15, titles before their chips VIS2-13),
 * the people and the recent activity. "Still to book" rows name what each
 * to-do is for and open a view filtered to it (PLAN-I2-14, PLAN-R2-05), and
 * a long line can't widen the columns (COLLAB-R2-05).
 */
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClimateCard } from "@/features/insights/ClimateCard";
import type { ListItemDto } from "@/features/lists/lists.functions";
import { Deadlines } from "@/features/overview/TripSections";
import { demo, demoGraph, N } from "@/lib/fixtures/demo";
import { tripKeys } from "@/lib/query/keys";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import { InspectorBody } from "./InspectorBody";
import { useShell } from "./shell-store";
import { TripOverview } from "./TripOverview";
import { SHELL_TESTID } from "./testids";

afterEach(() => {
	act(() => useShell.getState().clearInspectorTab());
});

const nav = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => nav.navigate,
		Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
	};
});

let n = 0;
function todo(p: Partial<ListItemDto>): ListItemDto {
	n += 1;
	return {
		doneAt: null,
		mine: true,
		id: `00000000-0000-7000-8000-0000000e${String(n).padStart(4, "0")}`,
		target: { kind: "trip" },
		list: "todo",
		text: "Something",
		note: null,
		url: null,
		status: "open",
		dueDayId: null,
		dueDate: null,
		dueTime: null,
		dueTz: null,
		dueKind: "due",
		dueRule: null,
		quantity: null,
		priceAmount: null,
		priceCurrency: null,
		position: "a0",
		isPrivate: false,
		assigneeIds: [],
		extraTargetNodeIds: [],
		createdAt: "2027-01-01T00:00:00Z",
		updatedAt: "2027-01-01T00:00:00Z",
		...p,
	} as ListItemDto;
}

const sky = demo.I.sky ?? "";
// A relative ANA-style rule in JST (the day of Shibuya Sky, Sun 3 Oct, 09:00)
// and a hotel window at 20:00 New York time the same calendar day, which is
// 09:00 JST Monday: the JST one comes first.
const ana = todo({
	text: "ANA award seats open",
	dueKind: "opens",
	target: { kind: "item", itemId: sky },
	dueRule: {
		kind: "days",
		itemId: sky,
		days: 0,
		time: "09:00",
		tz: "Asia/Tokyo",
	},
});
const hotel = todo({
	text: "Book the Park Hyatt",
	dueKind: "opens",
	target: { kind: "node", nodeId: N.tokyo ?? "" },
	dueDate: "2027-10-03",
	dueTime: "20:00",
	dueTz: "America/New_York",
});

function renderOverview(
	items: ListItemDto[] = [ana, hotel],
	ui: ReactElement = <TripOverview />,
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	queryClient.setQueryData(tripKeys.lists(demoGraph.trip.id), items);
	return renderWithWorkspace(ui, {
		queryClient,
		search: { sel: "root" },
	});
}
/** The sections the Overview page took from the inspector. */
const moved = (
	<>
		<Deadlines />
		<ClimateCard nodeId="root" />
	</>
);

describe("trip overview", () => {
	it("the inspector keeps a summary, Still to plan and a way to the Overview", () => {
		const { ws } = renderOverview();
		const ov = screen.getByTestId(SHELL_TESTID.tripOverview);
		expect(ov).toHaveTextContent("Dates");
		expect(ov).toHaveTextContent("Countries");
		expect(
			within(ov).getByTestId(SHELL_TESTID.stillToPlan),
		).toBeInTheDocument();
		// Deadlines, weather, people and activity moved to the Overview page.
		expect(screen.queryByTestId(SHELL_TESTID.deadlines)).toBeNull();
		expect(screen.queryByTestId(TESTID.climateCard)).toBeNull();
		expect(screen.queryByText("People")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /Open the Overview/ }));
		expect(ws().tab).toBe("overview");
		expect(ws().sel).toBeNull();
	});

	it("shows the visited cities' climate table on the Overview (COLLAB-4)", () => {
		renderOverview([], moved);
		const card = screen.getByTestId(TESTID.climateCard);
		expect(card).toHaveAttribute("data-nodeid", "root");
		expect(card).toHaveTextContent("Climate · typical for your visit");
		expect(within(card).getByText("Tokyo")).toBeInTheDocument();
	});

	it("labels every deadline time with its own zone (COLLAB-9, PLAN-I2-15)", () => {
		renderOverview(undefined, moved);
		const chips = screen
			.getAllByTestId(SHELL_TESTID.deadlineChip)
			.map((el) => el.textContent);
		expect(chips).toEqual([
			"Opens Sun 3 Oct · 09:00 JST",
			"Opens Sun 3 Oct · 20:00 EDT",
		]);
	});

	it("'still to book' lists each to-do and opens its own context (PLAN-I2-14)", () => {
		nav.navigate.mockClear();
		renderOverview();
		const row = screen
			.getAllByTestId(SHELL_TESTID.stillToPlanRow)
			.find((el) => el.getAttribute("data-row") === "book");
		if (!row) throw new Error("no 'still to book' row");
		fireEvent.click(within(row).getByRole("button", { name: /still to book/ }));
		const items = within(row).getAllByTestId(SHELL_TESTID.stillToPlanItem);
		expect(items.map((el) => el.textContent)).toEqual([
			expect.stringContaining("ANA award seats open"),
			expect.stringContaining("Book the Park Hyatt"),
		]);
		fireEvent.click(items[1] as HTMLElement);
		expect(nav.navigate).toHaveBeenCalledTimes(1);
		const call = nav.navigate.mock.calls[0]?.[0] as {
			params: Record<string, string>;
			search: Record<string, unknown>;
		};
		// PLAN-R2-05: scoped to Tokyo (a filtered list), Tokyo selected.
		expect(call.params._splat).toBe("japan/tokyo");
		expect(call.search).toEqual({
			tab: "lists",
			list: "todo",
			sel: `n.${N.tokyo}`,
		});
		fireEvent.click(items[0] as HTMLElement);
		const second = nav.navigate.mock.calls[1]?.[0] as {
			search: Record<string, unknown>;
		};
		expect(second.search.sel).toBe(`i.${sky}`);
	});

	it("each 'still to book' row names what it's for (PLAN-R2-05, COLLAB-R2-13, VIS2-04)", () => {
		const ahead = (itemId: string) =>
			todo({ text: "Book ahead", target: { kind: "item", itemId } });
		renderOverview([
			ahead(sky),
			ahead(demo.I.meiji ?? ""),
			todo({
				text: "Book ahead",
				target: { kind: "leg", legId: demo.L.flight ?? "" },
			}),
		]);
		const row = screen
			.getAllByTestId(SHELL_TESTID.stillToPlanRow)
			.find((el) => el.getAttribute("data-row") === "book");
		if (!row) throw new Error("no 'still to book' row");
		fireEvent.click(within(row).getByRole("button", { name: /still to book/ }));
		const items = within(row).getAllByTestId(SHELL_TESTID.stillToPlanItem);
		const texts = items.map((el) => el.textContent?.trim());
		expect(texts.filter((t) => t === "Book ahead")).toEqual([]);
		expect(new Set(texts).size).toBe(texts.length);
		expect(texts[0]).toMatch(/^Book ahead · Shibuya Sky · Day \d+/);
		expect(texts[2]).toMatch(/^Book ahead · Flight · KE 724 KIX → ICN/);
		// The full line is the row's title (the panel truncates it).
		expect(items[0]).toHaveAttribute(
			"title",
			expect.stringMatching(/^Book ahead · Shibuya Sky · Day \d+$/),
		);
	});

	it("a to-do row asks the inspector to open that selection's Lists tab (PLAN-R2-05)", () => {
		nav.navigate.mockClear();
		renderOverview();
		const row = screen
			.getAllByTestId(SHELL_TESTID.stillToPlanRow)
			.find((el) => el.getAttribute("data-row") === "book");
		if (!row) throw new Error("no 'still to book' row");
		fireEvent.click(within(row).getByRole("button", { name: /still to book/ }));
		fireEvent.click(
			within(row).getAllByTestId(
				SHELL_TESTID.stillToPlanItem,
			)[0] as HTMLElement,
		);
		expect(useShell.getState().inspectorTab).toMatchObject({
			sel: `i.${sky}`,
			tab: "lists",
			from: "root",
		});
	});

	it("the inspector opens on Lists for a requested selection (PLAN-R2-05)", () => {
		act(() =>
			useShell.getState().openInspectorTab(`i.${sky}`, "lists", "root"),
		);
		const { unmount } = renderWithWorkspace(<InspectorBody />, {
			search: { sel: `i.${sky}` },
		});
		const tab = (name: RegExp) =>
			within(screen.getByTestId(SHELL_TESTID.inspectorTabs)).getByRole("tab", {
				name,
			});
		expect(tab(/Lists/)).toHaveAttribute("aria-selected", "true");
		// The request holds while the selection stays: a remount (the route's
		// search changing) opens on Lists again.
		unmount();
		const { ws } = renderWithWorkspace(<InspectorBody />, {
			search: { sel: `i.${sky}` },
		});
		expect(tab(/Lists/)).toHaveAttribute("aria-selected", "true");
		// Selecting something else spends it; coming back opens on Overview.
		act(() => ws().nav.select({ kind: "node", id: N.tokyo ?? "" }));
		expect(useShell.getState().inspectorTab).toBeNull();
		expect(tab(/Overview/)).toHaveAttribute("aria-selected", "true");
		act(() => ws().nav.select({ kind: "item", id: sky }));
		expect(tab(/Overview/)).toHaveAttribute("aria-selected", "true");
	});

	it("a request survives the click's own selection until the target is selected", () => {
		// The row is clicked at the root overview; the navigation lands a moment later.
		act(() =>
			useShell.getState().openInspectorTab(`i.${sky}`, "lists", "root"),
		);
		const { ws } = renderWithWorkspace(<InspectorBody />, {
			search: { sel: "root" },
		});
		expect(useShell.getState().inspectorTab).not.toBeNull();
		act(() => ws().nav.select({ kind: "item", id: sky }));
		expect(
			within(screen.getByTestId(SHELL_TESTID.inspectorTabs)).getByRole("tab", {
				name: /Lists/,
			}),
		).toHaveAttribute("aria-selected", "true");
	});

	it("another selection ignores the request and opens on Overview", () => {
		act(() => useShell.getState().openInspectorTab(`n.${N.tokyo}`, "lists"));
		renderWithWorkspace(<InspectorBody />, { search: { sel: `i.${sky}` } });
		expect(
			within(screen.getByTestId(SHELL_TESTID.inspectorTabs)).getByRole("tab", {
				name: /Overview/,
			}),
		).toHaveAttribute("aria-selected", "true");
	});

	it("a deadline row puts its title before the chip and opens the to-do's view (VIS2-13)", () => {
		nav.navigate.mockClear();
		renderOverview(undefined, moved);
		const rows = screen.getAllByTestId(SHELL_TESTID.deadlineRow);
		const first = rows[0] as HTMLElement;
		const chip = within(first).getByTestId(SHELL_TESTID.deadlineChip);
		// The title comes first (a full line), the chip under it.
		expect(first.textContent?.indexOf("ANA award seats open")).toBe(0);
		expect(chip.parentElement).toHaveClass("flex-col");
		fireEvent.click(first);
		const call = nav.navigate.mock.calls[0]?.[0] as {
			search: Record<string, unknown>;
		};
		expect(call.search).toMatchObject({ tab: "lists", sel: `i.${sky}` });
		expect(useShell.getState().inspectorTab?.tab).toBe("lists");
	});

	it("columns can't be widened by a long line (COLLAB-R2-05)", () => {
		renderOverview([]);
		const ov = screen.getByTestId(SHELL_TESTID.tripOverview);
		// An `auto` grid column grows to a nowrap child's width; minmax(0,1fr) doesn't.
		expect(ov).toHaveClass("grid-cols-[minmax(0,1fr)]", "min-w-0");
		expect(ov.querySelector("dl")).toHaveClass(
			"grid-cols-[88px_minmax(0,1fr)]",
		);
	});
});
