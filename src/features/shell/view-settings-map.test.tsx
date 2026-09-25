/**
 * FB-04 (QA re-test, defect 1): View settings › Map shows the style the map
 * is drawing, not a fixed "Light". In the dark app with no saved style the
 * map is Dark, so Dark is marked and Light can be chosen; a click on the
 * marked segment keeps (and saves) it.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderWithWorkspace } from "@/test/render-workspace";
import { useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";
import { ViewSettingsDialog } from "./ViewSettingsDialog";
import { PREFS_STORAGE_KEY, resetPrefsCacheForTests } from "./view-prefs";

const saved = () =>
	JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY) ?? "{}") as {
		mapStyle?: string;
	};

function openSettings() {
	renderWithWorkspace(<ViewSettingsDialog />);
	act(() => useShell.getState().setViewSettingsOpen(true));
	const dialog = screen.getByTestId(SHELL_TESTID.viewSettingsDialog);
	const group = within(dialog).getByRole("radiogroup", { name: "Map style" });
	const item = (label: string) =>
		within(group).getByText(label, { exact: true });
	return { item };
}

describe("View settings › Map (FB-04)", () => {
	beforeEach(() => {
		localStorage.clear();
		resetPrefsCacheForTests();
	});
	afterEach(() => {
		act(() => useShell.getState().setViewSettingsOpen(false));
		document.documentElement.classList.remove("dark");
		localStorage.clear();
		resetPrefsCacheForTests();
	});

	it("dark app, nothing saved: marks Dark (what the map draws), and Light can be chosen", () => {
		document.documentElement.classList.add("dark");
		const { item } = openSettings();
		expect(item("Dark")).toHaveAttribute("data-state", "on");
		expect(item("Light")).toHaveAttribute("data-state", "off");
		fireEvent.click(item("Light"));
		expect(saved().mapStyle).toBe("light");
		expect(item("Light")).toHaveAttribute("data-state", "on");
		expect(item("Dark")).toHaveAttribute("data-state", "off");
	});

	it("light app, nothing saved: marks Light; Dark and Satellite save", () => {
		const { item } = openSettings();
		expect(item("Light")).toHaveAttribute("data-state", "on");
		fireEvent.click(item("Dark"));
		expect(saved().mapStyle).toBe("dark");
		expect(item("Dark")).toHaveAttribute("data-state", "on");
		fireEvent.click(item("Satellite"));
		expect(saved().mapStyle).toBe("satellite");
		expect(item("Satellite")).toHaveAttribute("data-state", "on");
	});

	it("a saved style wins over the app theme", () => {
		localStorage.setItem(
			PREFS_STORAGE_KEY,
			JSON.stringify({ mapStyle: "satellite" }),
		);
		resetPrefsCacheForTests();
		document.documentElement.classList.add("dark");
		const { item } = openSettings();
		expect(item("Satellite")).toHaveAttribute("data-state", "on");
		expect(item("Dark")).toHaveAttribute("data-state", "off");
	});

	it("a click on the marked segment keeps it and saves it (it only followed the theme before)", () => {
		document.documentElement.classList.add("dark");
		const { item } = openSettings();
		expect(saved().mapStyle).toBeUndefined();
		fireEvent.click(item("Dark"));
		expect(saved().mapStyle).toBe("dark");
		expect(item("Dark")).toHaveAttribute("data-state", "on");
	});
});
