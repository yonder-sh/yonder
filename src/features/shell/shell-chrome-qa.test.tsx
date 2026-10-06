/**
 * Shell chrome fixes from QA round 1: the md Inspector Sheet uses the
 * inspector's own close control (VIS-13), and the phone's bell is a 44px
 * touch target (VIS-02 / MOB-07; the boxes are measured in e2e). The bell
 * and its panel are built from the kit (Button, Chip, Skeleton).
 */
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { inboxQuery } from "@/lib/query/trip-queries";
import type { InboxDto, InboxItem } from "@/lib/schemas/inbox";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { InspectorSheet } from "./DesktopWorkspace";
import { InboxBell } from "./InboxBell";
import { useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";

// The inbox never answers: the panel stays loading.
vi.mock("@/functions/inbox.functions", () => ({
	listInbox: () => new Promise(() => {}),
	markInboxRead: async () => ({ ok: true }),
}));

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
	it("the bell takes the pill's 44px size", () => {
		renderWithWorkspace(<InboxBell className="size-11 rounded-full" />);
		const bell = screen.getByTestId(TESTID.inboxBell);
		expect(bell).toHaveClass("size-11");
		expect(bell).not.toHaveClass("size-8");
		expect(bell).not.toHaveClass("size-(--control)");
	});

	it("is the kit's icon button: 32px, a step taller on touch screens", () => {
		renderWithWorkspace(<InboxBell />);
		const bell = screen.getByTestId(TESTID.inboxBell);
		expect(bell).toHaveAttribute("data-variant", "ghost");
		expect(bell).toHaveAttribute("data-size", "icon");
		expect(bell).toHaveClass("size-(--control)");
	});
});

describe("the inbox panel (One Yonder kit)", () => {
	const due = (
		key: string,
		state: "overdue" | "open_now" | "today" | "soon",
	): InboxItem => ({
		key,
		kind: "due",
		tripId: demoGraph.trip.id,
		tripName: demoGraph.trip.name,
		// Fixed and ordered (newest first is "a"), so the panel's order never depends on the clock.
		at: new Date(Date.UTC(2027, 0, 2) - key.charCodeAt(0) * 1000).toISOString(),
		read: false,
		actor: null,
		title: `Book it (${key})`,
		link: { tripSlug: demoGraph.trip.slug, tab: "lists", list: "todo" },
		listItemId: key,
		dueKind: "due",
		dueAt: new Date().toISOString(),
		state,
	});

	it("a to-do's due label is a kit chip: accent when overdue or open, neutral otherwise", async () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData<InboxDto>(inboxQuery(demoGraph.trip.id).queryKey, {
			items: [due("a", "overdue"), due("b", "soon")],
			unread: 2,
		});
		renderWithWorkspace(<InboxBell />, { queryClient });
		fireEvent.click(screen.getByTestId(TESTID.inboxBell));
		const dialog = await screen.findByRole("dialog", { name: /^Inbox/ });
		const chips = within(dialog)
			.getAllByTestId(SHELL_TESTID.inboxRow)
			.map((r) => r.querySelector("[data-slot=chip]"));
		expect(chips.map((c) => c?.textContent)).toEqual(["Overdue", "Soon"]);
		expect(chips.map((c) => c?.getAttribute("data-tone"))).toEqual([
			"accent",
			"neutral",
		]);
		const markAll = within(dialog).getByTestId(SHELL_TESTID.inboxMarkAll);
		expect(markAll).toHaveAttribute("data-size", "sm");
		expect(markAll.className).not.toMatch(/\bh-7\b|\btext-xs\b/);
	});

	it("loads with row-shaped skeletons, like the other panels", async () => {
		renderWithWorkspace(<InboxBell />, { mode: "live" });
		fireEvent.click(screen.getByTestId(TESTID.inboxBell));
		const dialog = await screen.findByRole("dialog", { name: "Inbox" });
		const busy = within(dialog).getByRole("list", { busy: true });
		// Three rows: an avatar and two lines each.
		expect(busy.querySelectorAll("[data-slot=skeleton]")).toHaveLength(9);
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
