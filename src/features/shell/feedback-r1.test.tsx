/**
 * Owner feedback round 1 and QA round 3, WP-Shell's part:
 * - FB-12: no "Everything inside / Only …" choice for a node with no
 *   children (the center tabs' RollupToggle, the inspector's Media and Lists
 *   tabs); a link that still says `only` there shows everything.
 * - FB-05: "Rate" in the top bar and "Rate places" in the menus lead to the
 *   Rate screen, on the current scope when it has places to rate; Still to
 *   plan's unrated counts link to it.
 * - PLAN-R3-02 / VIS3-04: Still to plan counts no unaccepted suggestion.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { rateableNodes } from "@/features/places/lib/rate";
import { indexGraph } from "@/lib/engine/graph-index";
import type { GraphNode, TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph, N, scenario } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { hasChildNodes, offersRollupChoice } from "./bundle-target";
import { CenterTabContent } from "./CenterPanel";
import { InspectorBody } from "./InspectorBody";
import { RateButton, RateMenuItem } from "./rate-entry";
import { StillToPlan } from "./StillToPlan";
import { useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";

// A router-free Link that shows where it leads (and a navigate to watch).
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => router.navigate,
		Link: ({
			children,
			to,
			params,
			search,
			...rest
		}: {
			children: ReactNode;
			to: string;
			params?: Record<string, string>;
			search?: Record<string, string>;
		}) => (
			<a
				{...rest}
				href={`${Object.entries(params ?? {}).reduce(
					(p, [k, v]) => p.replace(`$${k}`, v),
					to,
				)}?${new URLSearchParams(search ?? {})}`}
			>
				{children}
			</a>
		),
	};
});

afterEach(() => {
	act(() => useUi.getState().resetUi());
	act(() => useShell.getState().clearInspectorTab());
});

const tokyo = demoGraph.nodes.find((n) => n.id === N.tokyo) as GraphNode;
/** Ginza: an area in Tokyo with nothing inside it yet. */
const GINZA = "00000000-0000-7000-8000-00000000c1a0";
const withGinza: TripGraph = {
	...demoGraph,
	nodes: [
		...demoGraph.nodes,
		{
			...tokyo,
			id: GINZA,
			parentId: N.tokyo ?? null,
			type: "area",
			name: "Ginza",
			slug: "ginza",
			position: "zz",
		},
	],
};

describe("FB-12: the rollup choice only for a node with children", () => {
	const ix = indexGraph(withGinza);
	it("offersRollupChoice: nodes and the trip by their children; days and visits keep theirs", () => {
		expect(hasChildNodes(ix, N.tokyo ?? null)).toBe(true);
		expect(hasChildNodes(ix, GINZA)).toBe(false);
		expect(
			offersRollupChoice(ix, { kind: "node", nodeId: N.tokyo ?? "" }),
		).toBe(true);
		expect(
			offersRollupChoice(ix, { kind: "node", nodeId: N.shibuyaSky ?? "" }),
		).toBe(false);
		expect(offersRollupChoice(ix, { kind: "node", nodeId: GINZA })).toBe(false);
		expect(offersRollupChoice(ix, { kind: "trip" })).toBe(true);
		const empty = indexGraph({ ...demoGraph, nodes: [], items: [], legs: [] });
		expect(offersRollupChoice(empty, { kind: "trip" })).toBe(false);
		const day = demoGraph.days[0]?.id ?? "";
		expect(offersRollupChoice(ix, { kind: "day", dayId: day })).toBe(true);
	});

	it("center tabs: no toggle in an area with nothing inside; Tokyo keeps it", () => {
		const leaf = renderWithWorkspace(<CenterTabContent />, {
			graph: withGinza,
			splat: "japan/tokyo/ginza",
			search: { tab: "notes" },
		});
		expect(leaf.ws().scope?.id).toBe(GINZA);
		expect(screen.queryByLabelText("What to include")).toBeNull();
		leaf.unmount();
		renderWithWorkspace(<CenterTabContent />, {
			graph: withGinza,
			splat: "japan/tokyo",
			search: { tab: "notes" },
		});
		expect(screen.getByLabelText("What to include")).toBeInTheDocument();
	});

	it("a link that says only=1 on such a node shows everything (the URL drops it)", () => {
		const { ws, navigations } = renderWithWorkspace(<CenterTabContent />, {
			graph: withGinza,
			splat: "japan/tokyo/ginza",
			search: { tab: "notes", only: 1 },
		});
		expect(ws().only).toBe(false);
		expect(navigations.at(-1)?.search.only).toBeUndefined();
		expect(navigations.at(-1)?.search.tab).toBe("notes");
	});

	it("keeps only=1 where there is a choice", () => {
		const { ws, navigations } = renderWithWorkspace(<CenterTabContent />, {
			graph: withGinza,
			splat: "japan/tokyo",
			search: { tab: "notes", only: 1 },
		});
		expect(ws().only).toBe(true);
		expect(navigations).toEqual([]);
	});

	it("inspector: a place's Media and Lists tabs offer no toggle; an area with places does", () => {
		const tabs = () => screen.getByTestId(SHELL_TESTID.inspectorTabs);
		const leaf = renderWithWorkspace(<InspectorBody />, {
			search: { sel: `n.${N.shibuyaSky}` },
		});
		fireEvent.mouseDown(within(tabs()).getByRole("tab", { name: /Media/ }));
		expect(screen.getByTestId(TESTID.mediaPanel)).toBeInTheDocument();
		expect(screen.queryByTestId("media-scope-toggle")).toBeNull();
		fireEvent.mouseDown(within(tabs()).getByRole("tab", { name: /Lists/ }));
		expect(screen.getByTestId(TESTID.listsPanel)).toBeInTheDocument();
		expect(screen.queryByTestId("lists-panel-scope")).toBeNull();
		leaf.unmount();

		renderWithWorkspace(<InspectorBody />, {
			search: { sel: `n.${N.shibuya}` },
		});
		fireEvent.mouseDown(within(tabs()).getByRole("tab", { name: /Media/ }));
		expect(screen.getByTestId("media-scope-toggle")).toBeInTheDocument();
		fireEvent.mouseDown(within(tabs()).getByRole("tab", { name: /Lists/ }));
		expect(screen.getByTestId("lists-panel-scope")).toBeInTheDocument();
	});
});

/** A workspace href's path and search (the harness writes `/t/<slug>/<splat>?…`). */
function parts(href: string | null) {
	const url = new URL(href ?? "", "http://x");
	return { path: url.pathname, q: Object.fromEntries(url.searchParams) };
}

describe("FB-05: the way into the Rate feed (the Places tab, docs/PLACES.md §1b)", () => {
	it("the top bar's Rate: the whole trip at the root, the scope inside Tokyo", () => {
		const root = renderWithWorkspace(<RateButton />);
		const a = screen.getByTestId(SHELL_TESTID.rateButton);
		expect(a).toHaveTextContent("Rate");
		expect(parts(a.getAttribute("href"))).toEqual({
			path: `/t/${demoGraph.trip.slug}/`,
			q: { tab: "places", pv: "rate" },
		});
		expect(a).toHaveAttribute("title", "Rate places");
		root.unmount();

		renderWithWorkspace(<RateButton compact />, { splat: "japan/tokyo" });
		const b = screen.getByTestId(SHELL_TESTID.rateButton);
		expect(parts(b.getAttribute("href"))).toMatchObject({
			path: `/t/${demoGraph.trip.slug}/japan/tokyo`,
			q: { tab: "places", pv: "rate" },
		});
		expect(b).toHaveAttribute("title", "Rate places in Tokyo");
		// Compact (md): the icon, with the word for screen readers.
		expect(within(b).getByText("Rate")).toHaveClass("sr-only");
	});

	it("a scope with nothing to rate opens the whole trip", () => {
		renderWithWorkspace(<RateButton />, {
			graph: withGinza,
			splat: "japan/tokyo/ginza",
		});
		expect(
			parts(screen.getByTestId(SHELL_TESTID.rateButton).getAttribute("href"))
				.path,
		).toBe(`/t/${demoGraph.trip.slug}/`);
	});

	it("'Rate places' in a menu opens the feed on the scope", () => {
		const { navigations } = renderWithWorkspace(
			<DropdownMenu open>
				<DropdownMenuTrigger>Menu</DropdownMenuTrigger>
				<DropdownMenuContent>
					<RateMenuItem />
				</DropdownMenuContent>
			</DropdownMenu>,
			{ splat: "japan/kyoto" },
		);
		fireEvent.click(
			screen.getByRole("menuitem", { name: /Rate places in Kyoto/ }),
		);
		expect(navigations.at(-1)).toMatchObject({
			splat: "japan/kyoto",
			search: { tab: "places", pv: "rate" },
		});
	});
});

describe("Still to plan › unrated places (PLAN-R3-02, FB-05)", () => {
	it("counts the rateable places, not Maya's unaccepted suggestion, and links each count to the Rate feed", () => {
		const { ws } = renderWithWorkspace(<StillToPlan />, {
			proposals: scenario.proposals,
			search: { sel: "root" },
		});
		// The overlay shows the suggested Nishiki Market as a ghost node.
		const ghost = ws().ix.outline.find((n) => n.name === "Nishiki Market");
		expect(ghost).toBeDefined();
		const liveIds = new Set(demoGraph.nodes.map((n) => n.id));
		const live = rateableNodes(ws().ix, null, { liveIds }).length;
		expect(rateableNodes(ws().ix, null).length).toBe(live + 1);

		const row = screen
			.getByTestId(SHELL_TESTID.stillToPlan)
			.querySelector('[data-row="unrated"]') as HTMLElement;
		fireEvent.click(
			within(row).getByRole("button", { name: /unrated places/ }),
		);
		const you = within(row).getByRole("link", { name: /You/ });
		expect(you).toHaveTextContent(`${live} of ${live}`);
		expect(parts(you.getAttribute("href")).q).toMatchObject({
			tab: "places",
			pv: "rate",
			f: "u:me",
		});
		const audrey = within(row).getByRole("link", { name: /Audrey/ });
		expect(parts(audrey.getAttribute("href")).q).toMatchObject({
			f: `u:${DEMO_MEMBERS.audrey}`,
		});
		expect(
			within(row).getByRole("link", { name: /Rate them one by one/ }),
		).toBeInTheDocument();
		// The map filter is still one tap away.
		fireEvent.click(
			within(row).getByRole("button", { name: "Show on the map" }),
		);
		expect(router.navigate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({ f: "u:me" }),
			}),
		);
	});
});
