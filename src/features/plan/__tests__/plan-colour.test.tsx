/**
 * The calmer, more colourful Plan (owner, 2026-09-25): cards carry their map
 * pin's family (bar, tint, icon; `data-family`), blocks without a place stay
 * neutral, and leg rows show the mode and the time, with the rest in a pill
 * that shows on hover, focus or selection.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TRANSIT_TESTID } from "@/features/transit/testids";
import { demo } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import { cardTone } from "../card-tone";
import { PlanTab } from "../PlanTab";
import { PLAN_TESTID } from "../testids";

const I = demo.I;
const planCss = readFileSync(
	join(process.cwd(), "src/features/plan/plan.css"),
	"utf8",
);

const cardOf = (id: string | undefined) =>
	screen
		.getAllByTestId(TESTID.timelineItem)
		.find((c) => c.getAttribute("data-item-id") === id) as HTMLElement;
/** The card's own box (the row also holds the time rail). */
const boxOf = (id: string | undefined) =>
	cardOf(id).querySelector("[data-family]") as HTMLElement;

describe("card colour", () => {
	it("a place takes its pin's family; stops their travel mode; a block none", () => {
		const place = (category: Parameters<typeof cardTone>[0] & object) =>
			cardTone(category);
		expect(place({ type: "place", category: "temple_shrine" })).toBe("culture");
		expect(place({ type: "place", category: "restaurant" })).toBe("food");
		expect(place({ type: "place", category: "onsen" })).toBe("water");
		expect(place({ type: "place", category: "bar" })).toBe("nightlife");
		expect(place({ type: "place", category: "lodging" })).toBe("lodging");
		expect(place({ type: "place", category: "airport" })).toBe("flight");
		expect(place({ type: "place", category: "station" })).toBe("rail");
		expect(place({ type: "place", category: "port" })).toBe("ferry");
		expect(place({ type: "place", category: "other" })).toBe("transit");
		expect(place({ type: "city" })).toBe("area");
		expect(cardTone(null)).toBe("none");
	});

	it("cards carry data-family, the bar class and the category icon in its colour", () => {
		renderWithWorkspace(<PlanTab />, { search: { lens: "place" } });
		expect(boxOf(I.hands).dataset.family).toBe("shopping");
		expect(boxOf(I.sensoji).dataset.family).toBe("culture");
		expect(boxOf(I.sky).dataset.family).toBe("culture");
		expect(boxOf(I.dropBags).dataset.family).toBe("lodging");
		expect(boxOf(I.kix).dataset.family).toBe("flight");
		for (const id of [I.hands, I.sensoji, I.kix])
			expect(boxOf(id).className).toMatch(/\bplan-tone\b/);
		// The icon (not the old dot) takes the family colour.
		expect(boxOf(I.sensoji).querySelector("svg.plan-tone-ink")).toBeTruthy();
	});

	it("a block without a place stays neutral: no bar, no tint", () => {
		renderWithWorkspace(<PlanTab />, { search: { lens: "place" } });
		const lunch = boxOf(I.lunch1);
		expect(lunch.dataset.family).toBe("none");
		expect(lunch.className).not.toMatch(/\bplan-tone\b/);
	});

	it("the flight's ticket stub reads in the flight colour", () => {
		renderWithWorkspace(<PlanTab />, { search: { lens: "place" } });
		const stub = screen.getByTestId(PLAN_TESTID.flightStub);
		expect(stub.dataset.family).toBe("flight");
		expect(stub.className).toMatch(/\bplan-tone\b/);
	});
});

/** plan.css's reveal rules, applied to the rendered Plan. */
function withPlanCss() {
	const style = document.createElement("style");
	style.textContent = planCss.replace(/@reference[^;]*;/, "");
	document.head.append(style);
	return () => style.remove();
}

describe("leg rows", () => {
	let removeCss: (() => void) | null = null;
	afterEach(() => {
		removeCss?.();
		removeCss = null;
	});

	const legRow = (name: RegExp) =>
		screen
			.getByRole("button", { name })
			.closest(`[data-testid="${TESTID.leg}"]`) as HTMLElement;

	it("show the mode and the time; the distance, Google Maps and accept chips wait in the pill", () => {
		renderWithWorkspace(<PlanTab />, { search: { lens: "place" } });
		// A set leg: glyph and "3m" up front.
		const walk = legRow(/^Travel Hands Shibuya → Shibuya Loft/);
		expect(within(walk).getByTestId(TESTID.legMode)).toHaveTextContent(/3m/);
		const walkMore = within(walk).getByTestId(PLAN_TESTID.legMore);
		expect(
			within(walkMore).getByTestId(TRANSIT_TESTID.googleMapsLink),
		).toHaveAccessibleName("Open in Google Maps");
		expect(
			within(walk).getAllByTestId(TRANSIT_TESTID.googleMapsLink),
		).toHaveLength(1);
		// An unset leg: one quiet line; the suggestions are in the pill only.
		const unset = legRow(/^Travel Shibuya Loft → Meiji Jingu/);
		expect(
			within(unset).getByTestId(TESTID.legMode).getAttribute("data-mode"),
		).toBe("unset");
		const chips = within(unset).getAllByTestId(PLAN_TESTID.legAccept);
		expect(chips.length).toBeGreaterThan(0);
		const more = within(unset).getByTestId(PLAN_TESTID.legMore);
		for (const c of chips) expect(more.contains(c)).toBe(true);
		// Nothing leaves the accessibility tree or the tab order.
		for (const c of chips) expect(c.tabIndex).not.toBe(-1);
		expect(unset.className).toMatch(/\bplan-leg\b/);
	});

	// happy-dom has no :hover or :focus-within: those two are the rule below, and e2e.
	it("the pill is hidden until the leg is selected", () => {
		removeCss = withPlanCss();
		const { ws } = renderWithWorkspace(<PlanTab />, {
			search: { lens: "place" },
		});
		const row = () => legRow(/^Travel Shibuya Loft → Meiji Jingu/);
		const more = () => within(row()).getByTestId(PLAN_TESTID.legMore);
		const opacity = () => getComputedStyle(more()).opacity;
		expect(opacity()).toBe("0");
		// Still reachable by keyboard while unseen (focusing it shows it).
		const link = within(more()).getByTestId(TRANSIT_TESTID.googleMapsLink);
		link.focus();
		expect(document.activeElement).toBe(link);
		link.blur();
		// Selecting the leg (a tap on a phone) shows it while it's selected.
		fireEvent.click(
			screen.getByRole("button", {
				name: /^Travel Shibuya Loft → Meiji Jingu/,
			}),
		);
		expect(ws().sel).toMatchObject({ kind: "leg" });
		expect(row()).toHaveAttribute("data-selected");
		expect(opacity()).toBe("1");
	});

	it("plan.css reveals the pill on hover, focus and selection", () => {
		const rule = /([^{}]+)\{\s*opacity:\s*1;?\s*\}/.exec(
			planCss.slice(planCss.indexOf(".plan-leg-more")),
		);
		const selectors = rule?.[1]?.split(",").map((s) => s.trim()) ?? [];
		expect(selectors).toEqual([
			".plan-leg:hover .plan-leg-more",
			".plan-leg:focus-within .plan-leg-more",
			".plan-leg[data-selected] .plan-leg-more",
		]);
	});
});
