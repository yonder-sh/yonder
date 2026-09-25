/**
 * Round-3 fixes: QA PLAN-R3-01 ("Add inside…" opened no input when its row
 * landed below the fold: the closing menu took the focus back) and owner
 * feedback FB-05 (the Ideas header's "Rate ideas →").
 */
import {
	act,
	fireEvent,
	renderHook,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphNode, TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph, N } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { EMPTY_FILTER, parseFilter } from "@/lib/workspace/filter";
import { renderWithWorkspace } from "@/test/render-workspace";
import { IdeasBin } from "../IdeasBin";
import { rateIdeasSearch } from "../ideas";
import { blurredIntoClosingMenu, useMenuHandoff } from "../NodeMenu";
import { Outline } from "../Outline";
import { OUTLINE_TESTID } from "../testids";

const { dennis: D } = DEMO_MEMBERS;

beforeEach(() => localStorage.clear());

describe("useMenuHandoff (PLAN-R3-01)", () => {
	afterEach(() => vi.useRealTimers());

	it("runs the item's action only once the menu has unmounted, and keeps the focus off the trigger", () => {
		vi.useFakeTimers();
		const fn = vi.fn();
		const { result } = renderHook(() => useMenuHandoff());
		result.current.handOff(fn)();
		// The menu is still animating out: nothing yet, even after a tick.
		vi.advanceTimersByTime(200);
		expect(fn).not.toHaveBeenCalled();
		const e = new Event("focusScope.autoFocusOnUnmount", { cancelable: true });
		result.current.onCloseAutoFocus(e);
		expect(e.defaultPrevented).toBe(true);
		expect(fn).toHaveBeenCalledTimes(1);
		// The safety net doesn't run it twice.
		vi.advanceTimersByTime(2000);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("a menu closed without a hand-off returns the focus as usual", () => {
		const { result } = renderHook(() => useMenuHandoff());
		const e = new Event("x", { cancelable: true });
		result.current.onCloseAutoFocus(e);
		expect(e.defaultPrevented).toBe(false);
	});

	it("still runs the action if the menu never reports its unmount", () => {
		vi.useFakeTimers();
		const fn = vi.fn();
		const { result } = renderHook(() => useMenuHandoff());
		result.current.handOff(fn)();
		vi.advanceTimersByTime(1000);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("recognises a menu that is closing, not an open one or other targets", () => {
		const closing = document.createElement("div");
		closing.setAttribute("role", "menu");
		closing.dataset.state = "closed";
		const item = document.createElement("div");
		closing.append(item);
		const open = document.createElement("div");
		open.setAttribute("role", "menu");
		open.dataset.state = "open";
		expect(blurredIntoClosingMenu(closing)).toBe(true);
		expect(blurredIntoClosingMenu(item)).toBe(true);
		expect(blurredIntoClosingMenu(open)).toBe(false);
		expect(blurredIntoClosingMenu(document.body)).toBe(false);
		expect(blurredIntoClosingMenu(null)).toBe(false);
	});
});

describe("Add inside… survives a closing menu taking the focus (PLAN-R3-01)", () => {
	const rowOf = (name: string) =>
		screen
			.getAllByTestId(TESTID.outlineRow)
			.find((el) =>
				el.getAttribute("aria-label")?.startsWith(`${name},`),
			) as HTMLElement;
	const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 30)));

	it("the empty input stays open and takes the focus back", async () => {
		renderWithWorkspace(<Outline />, { splat: "japan" });
		const kyoto = rowOf("Kyoto");
		act(() => kyoto.focus());
		fireEvent.contextMenu(kyoto, { clientX: 20, clientY: 20 });
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /Add inside/ }),
		);
		const input = await screen.findByTestId(OUTLINE_TESTID.inlineInput);
		await settle();
		expect(document.activeElement).toBe(input);

		// What Radix does on pointer leave while the menu animates out.
		const menu = document.createElement("div");
		menu.setAttribute("role", "menu");
		menu.dataset.state = "closed";
		menu.tabIndex = -1;
		document.body.append(menu);
		act(() => menu.focus());
		expect(screen.getByTestId(OUTLINE_TESTID.inlineInput)).toBe(input);
		await settle();
		expect(document.activeElement).toBe(input);
		menu.remove();

		// Leaving for anything else still closes the empty row.
		act(() => input.blur());
		expect(screen.queryByTestId(OUTLINE_TESTID.inlineInput)).toBeNull();
	});
});

describe("rateIdeasSearch (FB-05)", () => {
	it("asks for the Ideas set, with the shared filter plus 'not scheduled' and the scope as `in`", () => {
		expect(rateIdeasSearch(EMPTY_FILTER, null)).toEqual({
			f: "ns",
			set: "ideas",
		});
		expect(rateIdeasSearch(EMPTY_FILTER, N.tokyo as string)).toEqual({
			f: "ns",
			in: N.tokyo,
			set: "ideas",
		});
		expect(
			rateIdeasSearch(parseFilter("g:food_drink;p:want;u:me"), null),
		).toEqual({
			f: "g:food_drink;p:want;u:me;ns",
			set: "ideas",
		});
		// Already "not scheduled": not twice.
		expect(rateIdeasSearch(parseFilter("ns"), null)).toEqual({
			f: "ns",
			set: "ideas",
		});
	});
});

describe("Ideas header: Rate ideas → (FB-05)", () => {
	function withIdeas(): TripGraph {
		const itoya = demoGraph.nodes.find((n) => n.id === N.itoya) as GraphNode;
		return {
			...demoGraph,
			nodes: [
				...demoGraph.nodes,
				{
					...itoya,
					id: "00000000-0000-7000-8000-00000000f201",
					name: "Golden Gai",
					slug: "golden-gai",
					position: "z1",
					category: "restaurant",
					priorities: { [D]: "must" },
				},
			],
		};
	}
	const link = () =>
		within(screen.getByTestId(TESTID.ideasBin)).queryByTestId(
			OUTLINE_TESTID.rateIdeas,
		);

	it("'Open in Places →': the Places tab's Ideas, with the filter and the scope (docs/PLACES.md §5)", () => {
		renderWithWorkspace(<IdeasBin />, {
			graph: withIdeas(),
			splat: "japan/tokyo",
			search: { f: "g:food_drink" },
			mode: "live",
		});
		const a = link();
		expect(a).toHaveTextContent("Open in Places");
		expect(a).toHaveAccessibleName("Open the ideas in Tokyo in Places");
		const href = new URL(a?.getAttribute("href") ?? "", "http://x");
		expect(href.pathname).toBe(`/t/${demoGraph.trip.slug}/japan/tokyo`);
		expect(href.searchParams.get("tab")).toBe("places");
		expect(href.searchParams.get("pst")).toBe("idea");
		expect(href.searchParams.get("f")).toBe("g:food_drink");
	});

	it("shows while the list is collapsed (it's the way in)", () => {
		localStorage.setItem("yonder:ideas:open", "0");
		renderWithWorkspace(<IdeasBin />, {
			graph: withIdeas(),
			splat: "japan/tokyo",
			mode: "live",
		});
		expect(screen.queryAllByTestId(OUTLINE_TESTID.ideaRow)).toHaveLength(0);
		expect(link()).not.toBeNull();
	});

	it("isn't offered when the only ideas are logistics (airports, stays)", () => {
		// The demo's own ideas are its airports (TPE, IST, EWR).
		renderWithWorkspace(<IdeasBin />, { mode: "live" });
		expect(
			screen.getAllByTestId(OUTLINE_TESTID.ideaRow).length,
		).toBeGreaterThan(0);
		expect(link()).toBeNull();
	});

	it("isn't offered with nothing to rate, to viewers, or on the fixture", () => {
		const { unmount } = renderWithWorkspace(<IdeasBin />, {
			graph: withIdeas(),
			splat: "japan/tokyo",
			search: { f: "g:nature" },
			mode: "live",
		});
		expect(link()).toBeNull();
		unmount();
		const viewer: TripGraph = {
			...withIdeas(),
			me: { ...demoGraph.me, role: "viewer" },
		};
		const v = renderWithWorkspace(<IdeasBin />, {
			graph: viewer,
			splat: "japan/tokyo",
			mode: "live",
		});
		expect(link()).toBeNull();
		v.unmount();
		renderWithWorkspace(<IdeasBin />, {
			graph: withIdeas(),
			splat: "japan/tokyo",
		});
		expect(link()).toBeNull();
	});
});
