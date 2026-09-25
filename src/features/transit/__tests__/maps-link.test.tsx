/**
 * FB-03: "Open in Google Maps" on every non-flight leg with two located ends,
 * in the leg's own travel mode (walking, transit, driving, cycling), in the
 * Plan rows (`LegMapsLink`, still exported as `JapanTransitLink`), the leg
 * editor and the map edge overview. VIS3-05: the flight inspector's summary
 * line gives the flight's own time, not the plan total with airport time.
 */
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TripGraph } from "@/lib/engine/types";
import { demo, demoGraph } from "@/lib/fixtures/demo";
import type { OtherKind } from "@/lib/schemas/legs";
import type { LegTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import { JapanTransitLink } from "../JapanTransitLink";
import { LegMapsLink } from "../LegMapsLink";
import { LegOverview } from "../LegOverview";
import { mapsTravelMode } from "../lib/endpoints";
import { flightTimeMin, withFlightTime } from "../lib/flight";
import { TRANSIT_TESTID } from "../testids";

const I = demo.I as Record<string, string>;
const pair = (from: string, to: string): LegTarget => ({
	kind: "pair",
	fromItemId: I[from] as string,
	toItemId: I[to] as string,
});

/** The demo with the Hands → Loft walk turned into an `other` leg of `kind`. */
function otherLeg(kind: OtherKind): TripGraph {
	const g = structuredClone(demoGraph);
	const leg = g.legs.find((l) => l.id === demo.L.handsLoft);
	if (!leg) throw new Error("no leg");
	leg.mode = "other";
	leg.details = { kind: "other", otherKind: kind };
	return g;
}

const links = () => screen.queryAllByTestId(TRANSIT_TESTID.googleMapsLink);
const modeOf = (a: HTMLElement) =>
	new URL(a.getAttribute("href") ?? "").searchParams.get("travelmode");

describe("mapsTravelMode (FB-03)", () => {
	it("maps each leg mode to Google's travelmode; flights get none", () => {
		expect(mapsTravelMode({ mode: "walk" })).toBe("walking");
		expect(mapsTravelMode({ mode: "transit" })).toBe("transit");
		expect(mapsTravelMode({ mode: "flight" })).toBeNull();
		const other = (otherKind: string) =>
			mapsTravelMode({ mode: "other", details: { kind: "other", otherKind } });
		expect(other("taxi")).toBe("driving");
		expect(other("car")).toBe("driving");
		expect(other("other")).toBe("driving");
		expect(other("bike")).toBe("bicycling");
		expect(other("bus")).toBe("transit");
		expect(other("ferry")).toBe("transit");
		// Unset: the suggestion's mode (transit when there is none).
		expect(mapsTravelMode(null, "walk")).toBe("walking");
		expect(mapsTravelMode({ mode: null }, "flight")).toBeNull();
		expect(mapsTravelMode(undefined, null)).toBe("transit");
	});
});

describe("LegMapsLink (FB-03)", () => {
	it("a walk leg links to walking directions between its two places", () => {
		renderWithWorkspace(<LegMapsLink target={pair("hands", "loft")} compact />);
		const [a] = links();
		expect(a).toBeTruthy();
		const url = new URL(a?.getAttribute("href") ?? "");
		expect(url.searchParams.get("travelmode")).toBe("walking");
		expect(url.searchParams.get("origin")).toBe("35.6617,139.6989");
		expect(url.searchParams.get("destination")).toBe("35.6612,139.6987");
		expect(a?.getAttribute("aria-label")).toBe("Open in Google Maps");
		expect(a?.getAttribute("data-travelmode")).toBe("walking");
		expect(a?.textContent).toContain("Google Maps");
	});

	it("keeps transit for transit legs (the Japan rows) and says nothing for flights", () => {
		renderWithWorkspace(
			<>
				<JapanTransitLink target={pair("itoya", "dropBags")} compact />
				<JapanTransitLink target={pair("kix", "icn")} compact />
			</>,
		);
		expect(links().map(modeOf)).toEqual(["transit"]);
	});

	it("an unset leg follows its suggestion: a short hop walks", () => {
		// Senso-ji → Kama-asa is 0.9 km: suggested as a walk.
		renderWithWorkspace(
			<LegMapsLink target={pair("sensoji", "knives")} compact />,
		);
		expect(links().map(modeOf)).toEqual(["walking"]);
	});

	it("an other leg drives (taxi, car) or cycles (bike)", () => {
		const { unmount } = renderWithWorkspace(
			<LegMapsLink target={pair("hands", "loft")} compact />,
			{ graph: otherLeg("taxi") },
		);
		expect(links().map(modeOf)).toEqual(["driving"]);
		unmount();
		renderWithWorkspace(
			<LegMapsLink target={pair("hands", "loft")} compact />,
			{
				graph: otherLeg("bike"),
			},
		);
		expect(links().map(modeOf)).toEqual(["bicycling"]);
	});
});

describe("LegOverview", () => {
	it("the walk editor offers walking directions in Google Maps (FB-03)", () => {
		renderWithWorkspace(<LegOverview target={pair("hands", "loft")} />);
		const panel = screen.getByTestId(TRANSIT_TESTID.walkPanel);
		const a = within(panel).getByTestId(TRANSIT_TESTID.googleMapsLink);
		expect(modeOf(a)).toBe("walking");
		expect(a.textContent).toContain("Open in Google Maps");
	});

	it("a taxi leg's editor offers driving directions (FB-03)", () => {
		renderWithWorkspace(<LegOverview target={pair("hands", "loft")} />, {
			graph: otherLeg("taxi"),
		});
		const panel = screen.getByTestId(TRANSIT_TESTID.otherPanel);
		expect(
			modeOf(within(panel).getByTestId(TRANSIT_TESTID.googleMapsLink)),
		).toBe("driving");
	});

	it("an unset leg's editor links in its suggested mode (FB-03)", () => {
		renderWithWorkspace(<LegOverview target={pair("sensoji", "knives")} />);
		expect(links().map(modeOf)).toEqual(["walking"]);
	});

	it("the flight's summary line gives its own time, not the plan total (VIS3-05)", () => {
		// KE 724 KIX 13:05 JST → ICN 15:05 KST: a 2h flight. The KIX and ICN
		// stops are the airport time (FB-19a), so the plan counts 2h too.
		const { ws } = renderWithWorkspace(
			<LegOverview target={pair("kix", "icn")} />,
		);
		const planned = ws().schedule.legs[`${I.kix}>${I.icn}`]?.minutes;
		expect(planned).toBe(120);
		const header = screen.getAllByTestId(TESTID.leg)[0] as HTMLElement;
		expect(header.textContent).toContain("KE 724 KIX→ICN");
		expect(header.textContent).toMatch(/KIX→ICN\s*2h$/);
		expect(header.textContent).not.toContain("5h");
		// The flight has no Google Maps link.
		expect(links()).toHaveLength(0);
	});

	it("withFlightTime leaves other legs' schedules alone", () => {
		const flight = demoGraph.legs.find((l) => l.id === demo.L.flight);
		const walk = demoGraph.legs.find((l) => l.id === demo.L.handsLoft);
		const s = { minutes: 300, estimate: true };
		const d = flight?.details as {
			flight: Parameters<typeof flightTimeMin>[0];
		};
		expect(flightTimeMin(d.flight)).toBe(120);
		expect(withFlightTime(flight, s)).toEqual({
			minutes: 120,
			estimate: false,
		});
		expect(withFlightTime(walk, s)).toBe(s);
		expect(withFlightTime(flight, null)).toBeNull();
	});
});
