/**
 * The status pills under the Places toolbar (All · Shortlist · Ideas · On a
 * day · Not going · Disagreements) are the kit's FilterPill: one on at a
 * time with its count, the pick in the URL, and Disagreements on its own.
 */
import { fireEvent, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderWithWorkspace } from "@/test/render-workspace";
import { PlacesTab } from "../PlacesTab";
import { PLACES_TAB_TESTID as T } from "../testids";
import { lastReviewView } from "../use-places";

beforeAll(() => {
	// The table measures and observes; happy-dom has neither.
	const g = globalThis as unknown as Record<string, unknown>;
	class Noop {
		observe() {}
		unobserve() {}
		disconnect() {}
		takeRecords() {
			return [];
		}
	}
	g.ResizeObserver ??= Noop;
	g.IntersectionObserver ??= Noop;
});

beforeEach(() => {
	lastReviewView.current = "table";
});

const pill = (value: string) =>
	screen
		.getAllByTestId(T.statusPill)
		.find((p) => p.dataset.value === value) as HTMLElement;

describe("the Places status pills", () => {
	it("All is on to start; each pill has its count", () => {
		renderWithWorkspace(<PlacesTab />, {
			search: { tab: "places", pv: "table" },
		});
		const pills = screen.getAllByTestId(T.statusPill);
		expect(pills.map((p) => p.dataset.value)).toEqual([
			"all",
			"shortlist",
			"idea",
			"scheduled",
			"dropped",
		]);
		for (const p of pills) {
			expect(p).toHaveAttribute("data-slot", "filter-pill");
			expect(p.textContent).toMatch(
				/^(All|Shortlist|Ideas|On a day|Not going)\d+$/,
			);
		}
		expect(pill("all")).toHaveAttribute("aria-pressed", "true");
		expect(pill("idea")).toHaveAttribute("aria-pressed", "false");
		const talk = screen.getByTestId(T.talkPill);
		expect(talk).toHaveAttribute("data-slot", "filter-pill");
		expect(talk.textContent).toMatch(/^Disagreements\d+$/);
		expect(talk).toHaveAttribute("aria-pressed", "false");
	});

	it("a pill puts its status in the URL; All clears it", () => {
		const { navigations } = renderWithWorkspace(<PlacesTab />, {
			search: { tab: "places", pv: "table", pst: "shortlist" },
		});
		expect(pill("shortlist")).toHaveAttribute("aria-pressed", "true");
		expect(pill("all")).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(pill("idea"));
		expect(navigations.at(-1)?.search.pst).toBe("idea");
		expect(pill("idea")).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(pill("all"));
		expect(navigations.at(-1)?.search.pst).toBeUndefined();
		expect(pill("all")).toHaveAttribute("aria-pressed", "true");
	});

	it("Disagreements turns on and off by itself", () => {
		const { navigations } = renderWithWorkspace(<PlacesTab />, {
			search: { tab: "places", pv: "table" },
		});
		const talk = screen.getByTestId(T.talkPill);
		fireEvent.click(talk);
		expect(navigations.at(-1)?.search.talk).toBe(1);
		expect(talk).toHaveAttribute("aria-pressed", "true");
		expect(pill("all")).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(talk);
		expect(navigations.at(-1)?.search.talk).toBeUndefined();
		expect(talk).toHaveAttribute("aria-pressed", "false");
	});
});
