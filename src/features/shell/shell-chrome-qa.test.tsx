/**
 * Shell chrome fixes from QA round 1: deep scopes collapse the breadcrumb's
 * middle into "…" (PLAN-I2-11 / HIER-02), the md Inspector Sheet uses the
 * inspector's own close control (VIS-13), and the phone controls are 44px
 * touch targets (VIS-02 / MOB-07; the boxes are measured in e2e).
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { N } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { CenterTabBar } from "./CenterPanel";
import { InspectorSheet } from "./DesktopWorkspace";
import { InboxBell } from "./InboxBell";
import { useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";

afterEach(() => {
	act(() => useUi.getState().resetUi());
	act(() => useShell.getState().setInboxOpen(false));
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
