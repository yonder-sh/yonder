/**
 * The phone (One Yonder, P09–P12): a header with Where and a Map button, the
 * tab's page, and five tabs at the foot. The map is a button: Map swaps the
 * page for it, List (or any tab) swaps back.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoGraph } from "@/lib/fixtures/demo";
import { useFollowedStore } from "@/lib/realtime/view-ui";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { useFollowPause } from "./follow-pause";
import { MobileWorkspace } from "./MobileWorkspace";
import { SHELL_TESTID } from "./testids";

vi.mock("@tanstack/react-router", async (orig) => ({
	...(await orig<typeof import("@tanstack/react-router")>()),
	Link: ({
		children,
		to: _to,
		search: _search,
		...p
	}: {
		children?: ReactNode;
		to?: unknown;
		search?: unknown;
	}) => (
		<a href="/" {...p}>
			{children}
		</a>
	),
	useNavigate: () => vi.fn(),
	useLocation: () => ({ pathname: "/t/demo", searchStr: "" }),
}));
vi.mock("./MapRegion", () => ({
	MapRegion: () => <div data-testid="map-stub" />,
}));

afterEach(() =>
	act(() => {
		useUi.getState().resetUi();
		useFollowedStore.setState({ focus: null });
		useFollowPause.setState({ scroll: false, sheet: false });
	}),
);

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

	it("a follower during the trip: the Overview lit, Today next to it (P17)", () => {
		renderWithWorkspace(<MobileWorkspace />, {
			graph: { ...demoGraph, me: { ...demoGraph.me, role: "viewer" } },
			search: { asOf: "2027-10-05T11:00" },
		});
		const tabs = within(screen.getByTestId(TESTID.centerTabs)).getAllByRole(
			"tab",
		);
		expect(tabs.map((t) => t.getAttribute("data-tab"))).toEqual([
			"overview",
			"today",
			"plan",
			"places",
			"lists",
		]);
		expect(
			tabs.filter((t) => t.getAttribute("aria-selected") === "true"),
		).toEqual([tabs[0]]);
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

	it("follows the leader to the map or the page, and my own switch holds it until Resume", () => {
		renderWithWorkspace(<MobileWorkspace />, { search: { tab: "plan" } });
		act(() => useUi.getState().setFollowing("maya"));
		act(() => useFollowedStore.setState({ focus: "map" }));
		expect(screen.getByTestId("map-stub")).toBeInTheDocument();
		fireEvent.click(screen.getByTestId(SHELL_TESTID.mobileMapToggle));
		expect(useFollowPause.getState().sheet).toBe(true);
		expect(screen.queryByTestId("map-stub")).toBeNull();
		act(() => useFollowedStore.setState({ focus: "map" }));
		act(() => useFollowedStore.setState({ focus: "panel" }));
		act(() => useFollowedStore.setState({ focus: "map" }));
		expect(screen.queryByTestId("map-stub")).toBeNull();
		act(() => useFollowPause.getState().resume());
		expect(screen.getByTestId("map-stub")).toBeInTheDocument();
	});

	it("a link guest without an account: Sign in on screen and in ⋯, never Sign out", async () => {
		const user = userEvent.setup();
		renderWithWorkspace(<MobileWorkspace />, {
			graph: {
				...demoGraph,
				me: {
					...demoGraph.me,
					memberId: null,
					isGuest: true,
					role: "rater",
					name: "Guest Heron",
				},
			},
			search: { tab: "overview" },
		});
		expect(screen.getByTestId(TESTID.guestNudge)).toHaveTextContent(
			"Sign in to rate places",
		);
		await user.click(screen.getByRole("button", { name: "More" }));
		expect(
			await screen.findByRole("menuitem", { name: "Sign in to rate places" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: "Change your name" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Sign out" })).toBeNull();
	});
});
