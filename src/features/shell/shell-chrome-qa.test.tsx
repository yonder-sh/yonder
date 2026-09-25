/**
 * Shell chrome fixes from QA round 1: deep scopes collapse the breadcrumb's
 * middle into "…" (PLAN-I2-11 / HIER-02), the md Inspector Sheet uses the
 * inspector's own close control (VIS-13), and the phone controls are 44px
 * touch targets (VIS-02 / MOB-07; the boxes are measured in e2e).
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphNode, TripGraph } from "@/lib/engine/types";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { CenterTabBar } from "./CenterPanel";
import { InspectorSheet } from "./DesktopWorkspace";
import { InboxBell } from "./InboxBell";
import { LensControl } from "./LensControl";
import {
	crumbLayout,
	MAX_FULL_CRUMBS,
	ScopeBreadcrumb,
} from "./ScopeBreadcrumb";
import { useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";

afterEach(() => {
	act(() => useUi.getState().resetUi());
	act(() => useShell.getState().setInboxOpen(false));
});

const japan = demoGraph.nodes.find((x) => x.id === N.japan) as GraphNode;
const deepId = (i: number) =>
	`00000000-0000-7000-8000-0000000d${String(i).padStart(4, "0")}`;
/** Japan › Deep1 › … › Deep9 (areas), ten levels under the root. */
const deepGraph: TripGraph = {
	...demoGraph,
	nodes: [
		...demoGraph.nodes,
		...Array.from({ length: 9 }, (_, k): GraphNode => {
			const i = k + 1;
			return {
				...japan,
				id: deepId(i),
				parentId: i === 1 ? japan.id : deepId(i - 1),
				type: "area",
				category: null,
				name: `Deep${i}`,
				slug: `deep${i}`,
				countryCode: null,
				tz: null,
				position: `zz${i}`,
			};
		}),
	],
};
const deepSplat = [
	"japan",
	...Array.from({ length: 9 }, (_, k) => `deep${k + 1}`),
].join("/");

describe("breadcrumb on deep scopes (PLAN-I2-11)", () => {
	it("crumbLayout keeps the first two and the last two", () => {
		expect(crumbLayout(4, true)).toEqual({ shown: [0, 1, 2, 3], hidden: [] });
		expect(crumbLayout(6, false).hidden).toEqual([]);
		expect(crumbLayout(11, true)).toEqual({
			shown: [0, 1, "gap", 9, 10],
			hidden: [2, 3, 4, 5, 6, 7, 8],
		});
		expect(MAX_FULL_CRUMBS).toBe(6);
	});

	it("'All places › Japan › … › Deep8 › Deep9', the full path in the menu", async () => {
		const user = userEvent.setup();
		const { ws } = renderWithWorkspace(<ScopeBreadcrumb />, {
			graph: deepGraph,
			splat: deepSplat,
		});
		expect(ws().scope?.id).toBe(deepId(9));
		const crumb = screen.getByTestId(TESTID.scopeBreadcrumb);
		const text = crumb.textContent?.replace(/\s+/g, " ") ?? "";
		expect(text).toContain("All places›Japan›…›Deep8›Deep9");
		expect(within(crumb).queryByText("Deep3")).toBeNull();
		const more = screen.getByTestId(SHELL_TESTID.crumbOverflow);
		expect(more).toHaveAccessibleName("7 more levels");
		await user.click(more);
		const menu = await screen.findByRole("menu");
		const names = within(menu)
			.getAllByRole("menuitem")
			.map((el) => el.textContent);
		expect(names).toEqual([
			"All places",
			"Japan",
			...Array.from({ length: 9 }, (_, k) => `Deep${k + 1}`),
		]);
		await user.click(within(menu).getByRole("menuitem", { name: "Deep3" }));
		expect(ws().scope?.id).toBe(deepId(3));
	});

	it("shallow scopes keep every crumb", () => {
		renderWithWorkspace(<ScopeBreadcrumb />, { splat: "japan/tokyo/shibuya" });
		expect(screen.queryByTestId(SHELL_TESTID.crumbOverflow)).toBeNull();
		const crumb = screen.getByTestId(TESTID.scopeBreadcrumb);
		expect(crumb.textContent).toContain("All places›Japan›Tokyo›Shibuya");
	});
});

describe("md Inspector Sheet (VIS-13)", () => {
	it("has the inspector's own close control, not Radix's corner ✕", () => {
		const { ws } = renderWithWorkspace(<InspectorSheet />, {
			search: { sel: `n.${N.tokyo}` },
		});
		const inspector = screen.getByTestId(TESTID.inspector);
		expect(
			within(inspector).getAllByRole("button", { name: "Close" }),
		).toHaveLength(1);
		fireEvent.click(within(inspector).getByTestId(TESTID.inspectorClose));
		expect(ws().sel).toBeNull();
	});
});

describe("phone touch targets (VIS-02, MOB-07)", () => {
	it("the sheet's tabs are 44px tall and at least 44px wide", () => {
		renderWithWorkspace(<CenterTabBar touch />);
		expect(screen.getByTestId(TESTID.centerTabs)).toHaveClass("h-[45px]");
		for (const tab of screen.getAllByRole("tab"))
			expect(tab).toHaveClass("min-w-11", "h-full");
	});

	it("desktop tabs keep the 40px bar", () => {
		renderWithWorkspace(<CenterTabBar />);
		expect(screen.getByTestId(TESTID.centerTabs)).not.toHaveClass("h-[45px]");
	});

	it("the scrollable lens segments are 44px tall", () => {
		renderWithWorkspace(<LensControl scrollable />, { splat: "japan" });
		const radios = screen.getAllByRole("radio");
		expect(radios.length).toBeGreaterThan(1);
		for (const r of radios) expect(r).toHaveClass("h-11", "min-w-11");
	});

	it("the bell takes the pill's 44px size", () => {
		renderWithWorkspace(<InboxBell className="size-11 rounded-full" />);
		const bell = screen.getByTestId(TESTID.inboxBell);
		expect(bell).toHaveClass("size-11");
		expect(bell).not.toHaveClass("size-8");
	});
});

describe("inbox popover (VIS2-02, A11Y-01)", () => {
	it("is a dialog named by its 'Inbox' heading (axe aria-dialog-name)", async () => {
		renderWithWorkspace(<InboxBell />);
		fireEvent.click(screen.getByTestId(TESTID.inboxBell));
		const dialog = await screen.findByRole("dialog", { name: "Inbox" });
		const labelledBy = dialog.getAttribute("aria-labelledby") ?? "";
		expect(document.getElementById(labelledBy)).toHaveTextContent(/^Inbox$/);
		expect(within(dialog).getByTestId(SHELL_TESTID.inboxPanel)).toBeTruthy();
	});
});
