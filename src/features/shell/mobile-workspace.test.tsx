/**
 * The phone (One Yonder, P09–P12): a header with Where and a Map button, the
 * tab's page, and five tabs at the foot. The map is a button: Map swaps the
 * page for it, List (or any tab) swaps back.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { MobileWorkspace } from "./MobileWorkspace";
import { SHELL_TESTID } from "./testids";

vi.mock("@tanstack/react-router", async (orig) => ({
	...(await orig<typeof import("@tanstack/react-router")>()),
	Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>,
	useNavigate: () => vi.fn(),
}));
vi.mock("./MapRegion", () => ({
	MapRegion: () => <div data-testid="map-stub" />,
}));

afterEach(() => act(() => useUi.getState().resetUi()));

describe("the phone", () => {
	it("has Where in the header and the five tabs at the foot", () => {
		renderWithWorkspace(<MobileWorkspace />, { search: { tab: "plan" } });
		expect(screen.getByTestId(SHELL_TESTID.whereButton)).toBeInTheDocument();
		const tabs = within(screen.getByTestId(TESTID.centerTabs)).getAllByRole(
			"tab",
		);
		expect(tabs.map((t) => t.getAttribute("data-tab"))).toEqual([
			"overview",
			"plan",
			"places",
			"lists",
			"money",
		]);
		expect(screen.queryByTestId("map-stub")).toBeNull();
	});

	it("opens the map from the header, and a tab brings the page back", () => {
		const { ws } = renderWithWorkspace(<MobileWorkspace />, {
			search: { tab: "plan" },
		});
		const toggle = screen.getByTestId(SHELL_TESTID.mobileMapToggle);
		fireEvent.click(toggle);
		expect(screen.getByTestId("map-stub")).toBeInTheDocument();
		expect(toggle).toHaveAttribute("aria-label", "Show the list");
		act(() =>
			fireEvent.click(
				within(screen.getByTestId(TESTID.centerTabs)).getByRole("tab", {
					name: /Lists/,
				}),
			),
		);
		expect(screen.queryByTestId("map-stub")).toBeNull();
		expect(ws().tab).toBe("lists");
	});
});
