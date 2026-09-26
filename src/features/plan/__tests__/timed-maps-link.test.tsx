/**
 * FB-03 (QA re-check): the overnight reserved train's Plan row (`TimedLegRow`,
 * e.g. "SP3 night train · Hanoi Station → Lao Cai Station dep 22:00 →
 * 06:00+1") offers Google Maps ↗ in transit mode, like every same-day
 * reserved row (`LegRow`) does. Clicking it leaves the row unselected.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TRANSIT_TESTID } from "@/features/transit/testids";
import type { TripGraph } from "@/lib/engine/types";
import { demo, demoGraph } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import { PlanTab } from "../PlanTab";
import { PLAN_TESTID } from "../testids";

/** The demo's Fuji Excursion (Itoya → Kawaguchiko) as a reserved train. */
function reserved(
	train: string,
	depUtc: string,
	arrUtc: string,
	departLocal: string,
	arriveLocal: string,
): TripGraph {
	const g = structuredClone(demoGraph);
	const leg = g.legs.find((l) => l.id === demo.L.fuji);
	if (!leg) throw new Error("no leg");
	leg.mode = "transit";
	leg.depAt = depUtc;
	leg.arrAt = arrUtc;
	leg.details = {
		kind: "transit",
		fixed: {
			departLocal,
			arriveLocal,
			fromTz: "Asia/Tokyo",
			toTz: "Asia/Tokyo",
			accessMin: 10,
			egressMin: 0,
		},
		booking: { trainNumber: train, seats: [] },
	};
	return g;
}

/** SP3 night train: 21:35 Mon 4 Oct → 05:30 Tue 5 Oct (a `TimedLegRow`). */
const nightTrain = () =>
	reserved(
		"SP3",
		"2027-10-04T12:35:00.000Z",
		"2027-10-04T20:30:00.000Z",
		"2027-10-04T21:35",
		"2027-10-05T05:30",
	);

const sp3Row = () =>
	screen
		.getAllByTestId(TESTID.leg)
		.find(
			(r) =>
				/SP3/.test(r.textContent ?? "") &&
				!/continued/.test(r.textContent ?? ""),
		) as HTMLElement;

describe("reserved overnight train row (FB-03)", () => {
	it("links to transit directions between its two stations", () => {
		renderWithWorkspace(<PlanTab />, {
			graph: nightTrain(),
			search: { lens: "place", days: "2027-10-04" },
		});
		const row = sp3Row();
		expect(row).toBeTruthy();
		const links = within(row).getAllByTestId(TRANSIT_TESTID.googleMapsLink);
		expect(links).toHaveLength(1);
		const a = links[0] as HTMLElement;
		const url = new URL(a.getAttribute("href") ?? "");
		expect(url.origin + url.pathname).toBe("https://www.google.com/maps/dir/");
		expect(url.searchParams.get("travelmode")).toBe("transit");
		// Itoya Ginza → Kawaguchiko Ryokan (the demo's two ends).
		expect(url.searchParams.get("origin")).toBe("35.6723,139.7672");
		expect(url.searchParams.get("destination")).toBe("35.51,138.76");
		expect(a.getAttribute("aria-label")).toBe("Open in Google Maps");
		expect(a.getAttribute("target")).toBe("_blank");
		// An icon in the row's details (shown on hover, focus or selection).
		expect(a.closest(`[data-testid="${PLAN_TESTID.legMore}"]`)).toBeTruthy();
	});

	it("opening the link doesn't select the row", () => {
		const { ws } = renderWithWorkspace(<PlanTab />, {
			graph: nightTrain(),
			search: { lens: "place", days: "2027-10-04" },
		});
		const a = within(sp3Row()).getByTestId(TRANSIT_TESTID.googleMapsLink);
		fireEvent.click(a);
		expect(ws().sel).toBeNull();
		// The row itself still selects the leg.
		fireEvent.click(sp3Row());
		expect(ws().sel).toMatchObject({ kind: "leg" });
	});

	it("matches the same-day reserved row (LegRow), which already had it", () => {
		// Fuji Excursion 7: 14:00 → 15:56 the same day.
		renderWithWorkspace(<PlanTab />, {
			graph: reserved(
				"Fuji Excursion 7",
				"2027-10-04T05:00:00.000Z",
				"2027-10-04T06:56:00.000Z",
				"2027-10-04T14:00",
				"2027-10-04T15:56",
			),
			search: { lens: "place", days: "2027-10-04" },
		});
		const row = screen
			.getAllByTestId(TESTID.leg)
			.find((r) => /Fuji Excursion 7/.test(r.textContent ?? "")) as HTMLElement;
		expect(row).toBeTruthy();
		const a = within(row).getByTestId(TRANSIT_TESTID.googleMapsLink);
		expect(a.getAttribute("data-travelmode")).toBe("transit");
	});
});
