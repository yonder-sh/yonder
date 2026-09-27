/**
 * One Yonder: from 1440 px the five tabs sit in the top bar's row; narrower,
 * above the centre. Only one tab bar is ever rendered.
 */
import { screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import { TopBar } from "./TopBar";

// Router links and the account menu aren't what's under test.
vi.mock("@tanstack/react-router", async (orig) => ({
	...(await orig<typeof import("@tanstack/react-router")>()),
	Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>,
	useNavigate: () => vi.fn(),
}));
vi.mock("@/features/home/AccountMenu", () => ({ AccountMenu: () => null }));

describe("the top bar's tabs", () => {
	it("are the five, in the row, when it has them", () => {
		renderWithWorkspace(<TopBar bp="xl" tabs />, { search: { tab: "plan" } });
		const bar = within(screen.getByTestId(TESTID.topBar));
		const tabs = bar.getByTestId(TESTID.centerTabs);
		expect(
			within(tabs)
				.getAllByRole("tab")
				.map((t) => t.getAttribute("data-tab")),
		).toEqual(["overview", "plan", "places", "lists", "money"]);
	});

	it("aren't there otherwise", () => {
		renderWithWorkspace(<TopBar bp="xl" />, { search: { tab: "plan" } });
		expect(screen.queryByTestId(TESTID.centerTabs)).toBeNull();
	});
});
