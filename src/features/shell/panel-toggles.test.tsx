/**
 * The desktop side panels (owner, 2026-09-25): the Outline and the map hide
 * to slim rails, by their buttons or ⌘\ / ⌘⇧\, remembered on this device;
 * with the map hidden the centre (and the Places tab) takes its width. The
 * details dock as a pane at the right (2026-09-26), folding the Outline,
 * then the map, where there's no room.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/theme-provider";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { DesktopWorkspace } from "./DesktopWorkspace";
import { pixelLayoutStorage } from "./pane-layout";
import { SHORTCUTS } from "./ShortcutsDialog";
import { MAP_HIDDEN_KEY, useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";
import { useWorkspaceHotkeys } from "./use-workspace-hotkeys";

// The top bar and the guest nudge (router links) are not what's under test.
vi.mock("./TopBar", () => ({ TopBar: () => null }));
vi.mock("@/features/home/GuestNudge", () => ({ GuestNudge: () => null }));

afterEach(() => {
	act(() => {
		useShell.setState({ mapHidden: false });
		useUi.getState().resetUi();
	});
	localStorage.clear();
});

/** The desktop layout at a breakpoint, in the app's theme. */
const desktop = (bp: "md" | "lg" | "xl") => (
	<ThemeProvider>
		<DesktopWorkspace bp={bp} />
	</ThemeProvider>
);

describe("side panels", () => {
	it("has no Outline column (One Yonder: Where moves around, the Plan lists the ideas)", () => {
		renderWithWorkspace(desktop("xl"), { search: { tab: "plan" } });
		expect(screen.queryByTestId(TESTID.outline)).toBeNull();
		expect(screen.queryByTestId(TESTID.ideasBin)).toBeNull();
	});

	it("the map hides to a rail at md, lg and xl; the centre takes its width", () => {
		for (const bp of ["md", "lg", "xl"] as const) {
			const { unmount } = renderWithWorkspace(desktop(bp), {
				search: { tab: "plan" },
			});
			fireEvent.click(screen.getByRole("button", { name: "Hide the map" }));
			expect(screen.queryByTestId(TESTID.tripMap)).toBeNull();
			expect(screen.getByTestId(SHELL_TESTID.mapRail)).toBeInTheDocument();
			expect(localStorage.getItem(MAP_HIDDEN_KEY)).toBe("1");
			fireEvent.click(screen.getByRole("button", { name: "Show the map" }));
			expect(screen.queryByTestId(SHELL_TESTID.mapRail)).toBeNull();
			expect(screen.getByRole("button", { name: "Hide the map" })).toBeTruthy();
			expect(localStorage.getItem(MAP_HIDDEN_KEY)).toBeNull();
			unmount();
		}
	});

	it("with the map hidden, a selection docks beside the centre (lg/xl)", () => {
		act(() => useShell.setState({ mapHidden: true }));
		const { ws } = renderWithWorkspace(desktop("lg"), {
			search: { tab: "plan", lens: "place" },
		});
		expect(screen.queryByTestId(TESTID.inspector)).toBeNull();
		act(() => ws().nav.select({ kind: "day", id: ws().ix.days[0]?.id ?? "" }));
		const inspector = screen.getByTestId(TESTID.inspector);
		expect(inspector.tagName).toBe("ASIDE");
		expect(inspector.style.width).toBe("380px");
	});

	it("the Places tab is wide with the map hidden, and has no toggle of its own", () => {
		act(() => useShell.setState({ mapHidden: true }));
		renderWithWorkspace(desktop("xl"), {
			search: { tab: "places", pv: "table" },
		});
		const places = screen.getByTestId("places-tab");
		expect(screen.queryByTestId("places-wide")).toBeNull();
		// Wide: "Add a place" spells itself out (it's an icon beside the map).
		expect(
			within(places).getByRole("button", { name: /Add a place/ }),
		).toHaveTextContent("Add a place");
		expect(screen.getByTestId(SHELL_TESTID.mapRail)).toBeInTheDocument();
	});

	it("a fresh start reads the map's from storage", async () => {
		localStorage.setItem(MAP_HIDDEN_KEY, "1");
		vi.resetModules();
		const fresh = await import("./shell-store");
		expect(fresh.useShell.getState()).toMatchObject({ mapHidden: true });
	});
});

describe("pane sizes", () => {
	it("are kept as the centre's pixels, so a wider or narrower group finds the same centre", () => {
		const mem = new Map<string, string>();
		const base = {
			getItem: (k: string) => mem.get(k) ?? null,
			setItem: (k: string, v: string) => void mem.set(k, v),
		};
		let width = 1200;
		const storage = pixelLayoutStorage(base, () => width);
		storage.setItem("k", JSON.stringify({ center: 50.3, map: 49.7 }));
		expect(JSON.parse(mem.get("k") ?? "")).toEqual({ centerPx: 603.6 });
		storage.setItem("k", JSON.stringify({ center: 50, map: 50 }));
		expect(JSON.parse(mem.get("k") ?? "")).toEqual({ centerPx: 600 });
		width = 1000;
		expect(JSON.parse(storage.getItem("k") ?? "")).toEqual({
			center: 60,
			map: 40,
		});
		// An older percentage layout is read as it is; nothing stored is nothing.
		mem.set("old", JSON.stringify({ center: 44.255, map: 55.745 }));
		expect(storage.getItem("old")).toBe(mem.get("old"));
		expect(storage.getItem("none")).toBeNull();
	});
});

describe("shortcuts", () => {
	function Keys() {
		useWorkspaceHotkeys();
		return null;
	}
	const press = (shiftKey: boolean) =>
		act(() => {
			fireEvent.keyDown(document, {
				key: shiftKey ? "|" : "\\",
				code: "Backslash",
				ctrlKey: true,
				metaKey: true,
				shiftKey,
			});
			fireEvent.keyUp(document, {
				key: shiftKey ? "|" : "\\",
				code: "Backslash",
				ctrlKey: true,
				metaKey: true,
				shiftKey,
			});
		});

	it("⌘⇧\\ toggles the map; ⌘\\ alone does nothing now", () => {
		renderWithWorkspace(<Keys />);
		press(true);
		expect(useShell.getState().mapHidden).toBe(true);
		press(false);
		expect(useShell.getState().mapHidden).toBe(true);
		press(true);
		expect(useShell.getState().mapHidden).toBe(false);
	});

	it("the map's is in the shortcuts list", () => {
		const labels = SHORTCUTS.map((s) => s.label);
		expect(labels).not.toContain("Show or hide the outline");
		expect(labels).toContain("Show or hide the map");
		const map = SHORTCUTS.find((s) => s.label === "Show or hide the map");
		expect(map?.keys.at(-1)).toBe("\\");
		expect(map?.keys).toHaveLength(3);
	});
});

describe("the details pane (lg/xl)", () => {
	const setWidth = (w: number) =>
		Object.defineProperty(window, "innerWidth", {
			value: w,
			configurable: true,
		});
	const real = window.innerWidth;
	afterEach(() => {
		setWidth(real);
		act(() =>
			useShell.setState({ detailsFoldedFor: null, detailsWidth: null }),
		);
	});
	const day = (ws: () => { ix: { days: readonly { id: string }[] } }) =>
		ws().ix.days[0]?.id ?? "";

	it("docks beside the map (not over it), folds to a rail with its name, and a new selection unfolds it", () => {
		setWidth(1600);
		const { ws } = renderWithWorkspace(desktop("xl"), {
			search: { tab: "plan", lens: "place" },
		});
		act(() => ws().nav.select({ kind: "day", id: day(ws) }));
		const pane = screen.getByTestId(TESTID.inspector);
		expect(pane.className).not.toContain("absolute");
		expect(pane.style.width).toBe("400px");

		fireEvent.click(screen.getByTestId(SHELL_TESTID.detailsCollapse));
		expect(screen.queryByTestId(TESTID.inspector)).toBeNull();
		const rail = screen.getByTestId(SHELL_TESTID.detailsRail);
		expect(within(rail).getByRole("button").getAttribute("aria-label")).toMatch(
			/^Show the details of /,
		);
		// The selection stays; another one opens the pane again.
		expect(ws().sel).not.toBeNull();
		act(() => ws().nav.select({ kind: "day", id: ws().ix.days[1]?.id ?? "" }));
		expect(screen.getByTestId(TESTID.inspector)).toBeInTheDocument();
	});

	it("resizes from its edge (← / →), remembered on this device", () => {
		setWidth(1600);
		const { ws } = renderWithWorkspace(desktop("xl"), {
			search: { tab: "plan", lens: "place" },
		});
		act(() => ws().nav.select({ kind: "day", id: day(ws) }));
		fireEvent.keyDown(screen.getByTestId(SHELL_TESTID.detailsResize), {
			key: "ArrowLeft",
		});
		expect(screen.getByTestId(TESTID.inspector).style.width).toBe("416px");
		expect(localStorage.getItem("yonder:details-width")).toBe("416");
	});

	it("at 1280 px the list, the map and the pane all fit (no Outline to fold)", () => {
		setWidth(1280);
		const { ws } = renderWithWorkspace(desktop("xl"), {
			search: { tab: "plan", lens: "place" },
		});
		act(() => ws().nav.select({ kind: "day", id: day(ws) }));
		expect(screen.getByTestId(TESTID.inspector).className).not.toContain(
			"absolute",
		);
		expect(screen.queryByTestId(SHELL_TESTID.mapRail)).toBeNull();
		expect(screen.queryByTestId(SHELL_TESTID.detailsRail)).toBeNull();
	});

	it("without room for the list, the map and the pane, the map folds; showing it folds the pane instead", () => {
		setWidth(1100);
		const { ws } = renderWithWorkspace(desktop("lg"), {
			search: { tab: "plan", lens: "place" },
		});
		expect(screen.getByRole("button", { name: "Hide the map" })).toBeTruthy();
		act(() => ws().nav.select({ kind: "day", id: day(ws) }));
		expect(screen.getByTestId(SHELL_TESTID.mapRail)).toBeInTheDocument();
		expect(screen.getByTestId(TESTID.inspector).style.width).toBe("380px");
		fireEvent.click(screen.getByRole("button", { name: "Show the map" }));
		expect(screen.getByTestId(SHELL_TESTID.detailsRail)).toBeInTheDocument();
		expect(screen.queryByTestId(SHELL_TESTID.mapRail)).toBeNull();
		// Your own map setting is untouched.
		expect(localStorage.getItem(MAP_HIDDEN_KEY)).toBeNull();
	});
});
