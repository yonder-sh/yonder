/**
 * "Mark decided" (owner, 2026-09-28): decided places stop counting as "to
 * rate" everywhere that count is made: the top bar's Rate, the phone's Rate
 * pill, the Places tab badge, the Rate feed's "N left", Overview's Where
 * things stand, Still to plan and the Plan's split of days.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { whereThingsStand } from "@/features/overview/lib/standing";
import { leftToRate } from "@/features/plan/day-split/day-split";
import { RateButton } from "@/features/shell/rate-entry";
import { stillToPlan } from "@/features/shell/still-to-plan";
import { SHELL_TESTID } from "@/features/shell/testids";
import { indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import type { TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph, N } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { buildRows, openPlaces } from "../model";
import { PlacesTab } from "../PlacesTab";
import { RatePill } from "../RatePill";
import { PLACES_TAB_TESTID as T } from "../testids";
import { usePlacesToDecide } from "../use-places";

const D = DEMO_MEMBERS.dennis;
const LATER = "2030-01-01T00:00:00.000Z";

/** The demo trip (nothing rated), Tokyo marked decided; `trip` marks the whole trip. */
function marked(where: "tokyo" | "trip" | null): TripGraph {
	const g = structuredClone(demoGraph);
	if (where === "trip") g.trip = { ...g.trip, decidedAt: LATER };
	if (where === "tokyo")
		g.nodes = g.nodes.map((n) =>
			n.id === N.tokyo ? { ...n, decidedAt: LATER } : n,
		);
	return g;
}

const ix0 = indexGraph(demoGraph);
const places = openPlaces(ix0);
const inTokyo = places.filter((n) => ix0.isWithin(n.id, N.tokyo ?? null));
const unrated = (xs: typeof places) =>
	xs.filter((n) => !n.priorities[D]).length;
const ALL = unrated(places);
const OUTSIDE = ALL - unrated(inTokyo);

describe("decided places leave the to-rate counts", () => {
	it("the fixture has places both in and out of Tokyo to rate", () => {
		expect(unrated(inTokyo)).toBeGreaterThan(0);
		expect(OUTSIDE).toBeGreaterThan(0);
	});

	it("the top bar's Rate and the phone's Rate pill", () => {
		for (const [g, n] of [
			[marked(null), ALL],
			[marked("tokyo"), OUTSIDE],
		] as const) {
			const a = renderWithWorkspace(<RateButton />, { graph: g });
			expect(screen.getByTestId(SHELL_TESTID.rateButton)).toHaveAttribute(
				"data-count",
				String(n),
			);
			a.unmount();
			const b = renderWithWorkspace(<RatePill />, { graph: g });
			expect(screen.getByTestId(T.ratePill)).toHaveAttribute(
				"data-count",
				String(n),
			);
			b.unmount();
		}
		// All decided: nothing to rate, so no pill.
		renderWithWorkspace(<RatePill />, { graph: marked("trip") });
		expect(screen.queryByTestId(T.ratePill)).toBeNull();
	});

	it("inside a decided scope, Rate opens the whole trip", () => {
		renderWithWorkspace(<RateButton />, {
			graph: marked("tokyo"),
			splat: "japan/tokyo",
		});
		const a = screen.getByTestId(SHELL_TESTID.rateButton);
		expect(a).toHaveAttribute("title", "Rate places");
		expect(a).toHaveAttribute("data-count", String(OUTSIDE));
	});

	it("the Places tab badge", () => {
		function Badge() {
			return <span data-testid="badge">{usePlacesToDecide()}</span>;
		}
		// Nothing on a day yet: every place waits.
		const open = (g: TripGraph) => ({ ...g, items: [], legs: [] });
		const a = renderWithWorkspace(<Badge />, { graph: open(marked(null)) });
		expect(screen.getByTestId("badge")).toHaveTextContent(
			String(places.length),
		);
		a.unmount();
		const b = renderWithWorkspace(<Badge />, { graph: open(marked("tokyo")) });
		expect(screen.getByTestId("badge")).toHaveTextContent(
			String(places.length - inTokyo.length),
		);
		b.unmount();
		renderWithWorkspace(<Badge />, { graph: open(marked("trip")) });
		expect(screen.getByTestId("badge")).toHaveTextContent("0");
	});

	it("the Rate feed's pile and its 'N left'", async () => {
		renderWithWorkspace(<PlacesTab phone />, {
			graph: marked("tokyo"),
			search: { tab: "places", pv: "rate" },
		});
		const left = await screen.findByTestId(T.feedLeft, {}, { timeout: 5000 });
		expect(left).toHaveTextContent(`${OUTSIDE} left`);
		const cards = screen.getAllByTestId(T.feedCard).map((c) => c.dataset.place);
		for (const n of inTokyo) expect(cards).not.toContain(n.id);
	});

	it("Overview's Where things stand", () => {
		const stand = (g: TripGraph) => {
			const ix = indexGraph(g);
			return whereThingsStand({
				ix,
				schedule: computeSchedule(ix),
				members: g.members,
				me: D,
				bar: 3,
			});
		};
		expect(stand(marked(null)).myLeft).toBe(ALL);
		expect(stand(marked("tokyo")).myLeft).toBe(OUTSIDE);
		const all = stand(marked("trip"));
		expect(all.myLeft).toBe(0);
		expect(all.lines.find((l) => l.key === "rating")).toMatchObject({
			detail: "everyone is done",
			done: true,
		});
		// Still every place added.
		expect(all.places).toBe(places.length);
	});

	it("Still to plan and the Plan's split of days", () => {
		const g = marked("tokyo");
		const ix = indexGraph(g);
		const mine = stillToPlan({
			ix,
			schedule: computeSchedule(ix),
			members: g.members,
			now: Date.parse("2027-09-01T00:00:00Z"),
		}).unrated.find((u) => u.memberId === D);
		expect(mine?.count).toBe(OUTSIDE);
		const rows = buildRows(ix, openPlaces(ix), {
			memberIds: [D],
			threshold: 3,
		});
		const left = leftToRate(rows, g.members, D).find((x) => x.you);
		expect(left?.count).toBe(OUTSIDE);
	});
});
