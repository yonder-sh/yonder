/**
 * The flight form (QA FLT-02, MT-15, MOB-06/VIS-18): inline errors follow the
 * fields once a save was refused, and code fields ask phones for capitals.
 * The Add flight dialog adds one booking: one ref and price for a connection
 * or a round trip.
 */
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FlightBooking, FlightDetails } from "@/lib/schemas/legs";
import { FlightForm } from "../components/FlightForm";
import { TRANSIT_TESTID } from "../testids";

const nh9 = {
	from: {
		iata: "JFKK",
		name: "JFKK",
		tz: "America/New_York",
		lat: 0,
		lng: 0,
	},
	to: { iata: "HND", name: "HND", tz: "Asia/Tokyo", lat: 0, lng: 0 },
	depLocal: "2027-10-02T02:00",
	arrLocal: "2027-10-03T05:00",
	seats: [],
} satisfies FlightDetails;

const errorTexts = () =>
	screen.queryAllByTestId(TRANSIT_TESTID.flightError).map((e) => e.textContent);

describe("FlightForm", () => {
	it("clears 'Unknown airport' and 'Not a flight number' as soon as the fields are fixed (QA MT-15)", async () => {
		const onSubmit = vi.fn();
		render(
			<FlightForm
				initial={[{ ...nh9, flightNumber: "HELLO" }]}
				members={[]}
				onSubmit={onSubmit}
			/>,
		);
		fireEvent.click(screen.getByTestId(TRANSIT_TESTID.flightSave));
		await waitFor(() =>
			expect(errorTexts()).toEqual(
				expect.arrayContaining(["Not a flight number", "Unknown airport"]),
			),
		);
		expect(onSubmit).not.toHaveBeenCalled();

		fireEvent.change(screen.getByTestId(TRANSIT_TESTID.flightNumber), {
			target: { value: "NH 9" },
		});
		await waitFor(() => expect(errorTexts()).toEqual(["Unknown airport"]));

		fireEvent.change(screen.getByTestId(TRANSIT_TESTID.flightFrom), {
			target: { value: "JFK" },
		});
		await waitFor(() => expect(errorTexts()).toEqual([]));

		fireEvent.click(screen.getByTestId(TRANSIT_TESTID.flightSave));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		const [segments] = onSubmit.mock.calls[0] as [FlightDetails[]];
		expect(segments[0]?.from.iata).toBe("JFK");
		expect(segments[0]?.flightNumber).toBe("NH9");
	});

	it("saves a flight with only its airports and date: no number, no times (FB-18)", async () => {
		const onSubmit = vi.fn();
		render(
			<FlightForm
				defaults={{
					depDate: "2026-12-12",
					arrDate: "2026-12-13",
					fromIata: "JFK",
					toIata: "HND",
				}}
				members={[]}
				onSubmit={onSubmit}
			/>,
		);
		const duration = screen.getByTestId(TRANSIT_TESTID.flightDuration);
		await waitFor(() =>
			expect(duration.textContent).toBe(
				"about 14h 5m flight · add times when you know them",
			),
		);
		fireEvent.click(screen.getByTestId(TRANSIT_TESTID.flightSave));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		const [segments] = onSubmit.mock.calls[0] as [FlightDetails[]];
		const f = segments[0];
		expect(f?.from.iata).toBe("JFK");
		expect(f?.to.iata).toBe("HND");
		expect(f?.depDate).toBe("2026-12-12");
		expect(f?.arrDate).toBe("2026-12-13");
		expect(f && "flightNumber" in f).toBe(false);
		expect(f?.depLocal).toBeUndefined();
		expect(f?.arrLocal).toBeUndefined();
	});

	it("with only a departure time, the arrival is estimated in its own zone (FB-18, FB-20)", async () => {
		render(
			<FlightForm
				defaults={{
					depDate: "2026-12-12",
					arrDate: "2026-12-13",
					fromIata: "JFK",
					toIata: "HND",
				}}
				members={[]}
				onSubmit={() => {}}
			/>,
		);
		const duration = screen.getByTestId(TRANSIT_TESTID.flightDuration);
		await waitFor(() => expect(duration.textContent).toMatch(/^about 14h 5m/));
		fireEvent.change(screen.getByRole("textbox", { name: "Departure time" }), {
			target: { value: "02:00" },
		});
		// 02:00 EST (UTC−5, December) + 14h 5m = 16:05 EST = 06:05 JST next day.
		await waitFor(() =>
			expect(duration.textContent).toBe(
				"about 14h 5m flight · arrives ~06:05 JST (Sun 13 Dec)",
			),
		);
	});

	it("asks EDT or EST for a time the clocks repeat, and the duration follows (QA TZ-07)", async () => {
		const onSubmit = vi.fn();
		const ist = {
			...nh9,
			flightNumber: "TK11",
			from: { ...nh9.from, iata: "IST", tz: "Europe/Istanbul" },
			to: { ...nh9.to, iata: "EWR", tz: "America/New_York" },
			depLocal: "2027-11-06T19:30",
			arrLocal: "2027-11-07T01:30",
		} satisfies FlightDetails;
		render(<FlightForm initial={[ist]} members={[]} onSubmit={onSubmit} />);
		const duration = screen.getByTestId(TRANSIT_TESTID.flightDuration);
		await waitFor(() => expect(duration.textContent).toBe("13h flight"));
		const choices = await screen.findAllByTestId(TRANSIT_TESTID.flightFold);
		expect(choices.map((c) => c.textContent)).toEqual([
			"01:30 EDT",
			"01:30 EST",
		]);
		expect(choices[0]?.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(choices[1] as HTMLElement);
		await waitFor(() => expect(duration.textContent).toBe("14h flight"));
		fireEvent.click(screen.getByTestId(TRANSIT_TESTID.flightSave));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		const [segments] = onSubmit.mock.calls[0] as [FlightDetails[]];
		expect(segments[0]?.arrFold).toBe("later");
		expect(segments[0]?.depFold).toBeUndefined();
	});

	it("asks phones for capitals, without autocorrect, in every code field (QA MOB-06)", () => {
		render(
			<FlightForm
				initial={[{ ...nh9, from: { ...nh9.from, iata: "JFK" } }]}
				members={[]}
				onSubmit={() => {}}
			/>,
		);
		for (const id of [
			TRANSIT_TESTID.flightNumber,
			TRANSIT_TESTID.flightAirline,
			TRANSIT_TESTID.flightFrom,
			TRANSIT_TESTID.flightTo,
			TRANSIT_TESTID.flightRef,
			TRANSIT_TESTID.flightFromTerminal,
			TRANSIT_TESTID.flightToGate,
		]) {
			const input = screen.getByTestId(id);
			expect(input.getAttribute("autocapitalize"), id).toBe("characters");
			expect(input.getAttribute("autocorrect"), id).toBe("off");
			expect(input.getAttribute("spellcheck"), id).toBe("false");
		}
	});
});

type Extra = { booking: FlightBooking; returnSegments?: FlightDetails[] };

describe("FlightForm as one booking (the Add flight dialog)", () => {
	it("asks for the ref and the price once, and sends them beside the flights", async () => {
		const onSubmit = vi.fn();
		render(
			<FlightForm
				multi
				defaults={{ depDate: "2026-12-24", fromIata: "PHL", toIata: "CLT" }}
				members={[]}
				onSubmit={onSubmit}
			/>,
		);
		fireEvent.click(screen.getByTestId(TRANSIT_TESTID.flightAddConnection));
		// The connection leaves from where the first flight lands.
		const tos = screen.getAllByTestId(TRANSIT_TESTID.flightTo);
		fireEvent.change(tos[1] as HTMLElement, { target: { value: "DFW" } });
		expect(screen.getAllByTestId(TRANSIT_TESTID.flightCostAmount)).toHaveLength(
			1,
		);
		expect(screen.getAllByTestId(TRANSIT_TESTID.flightRef)).toHaveLength(1);
		expect(
			screen.getByTestId(TRANSIT_TESTID.flightBooking).textContent,
		).toContain("One ref and one price for all 2 flights.");

		fireEvent.change(screen.getByTestId(TRANSIT_TESTID.flightCostAmount), {
			target: { value: "412.50" },
		});
		fireEvent.change(screen.getByTestId(TRANSIT_TESTID.flightRef), {
			target: { value: "abc123" },
		});
		fireEvent.click(screen.getByTestId(TRANSIT_TESTID.flightSave));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		const [segments, extra] = onSubmit.mock.calls[0] as [
			FlightDetails[],
			Extra,
		];
		expect(segments.map((f) => `${f.from.iata}-${f.to.iata}`)).toEqual([
			"PHL-CLT",
			"CLT-DFW",
		]);
		for (const f of segments) {
			expect(f.cost).toBeUndefined();
			expect(f.bookingRef).toBeUndefined();
		}
		expect(extra.booking).toEqual({
			ref: "ABC123",
			cost: { amount: 412.5, currency: "USD" },
		});
		expect(extra.returnSegments).toBeUndefined();
	});

	it("a round trip comes back to where it started, after the way out", async () => {
		const onSubmit = vi.fn();
		render(
			<FlightForm
				multi
				defaults={{ depDate: "2026-12-24", fromIata: "PHL", toIata: "DFW" }}
				members={[]}
				onSubmit={onSubmit}
			/>,
		);
		expect(screen.queryByTestId(TRANSIT_TESTID.flightReturn)).toBeNull();
		fireEvent.click(
			within(screen.getByTestId(TRANSIT_TESTID.flightTripKind)).getByText(
				"Round trip",
			),
		);
		const back = await screen.findByTestId(TRANSIT_TESTID.flightReturn);
		const from = () =>
			within(back).getByTestId(TRANSIT_TESTID.flightFrom) as HTMLInputElement;
		const to = () =>
			within(back).getByTestId(TRANSIT_TESTID.flightTo) as HTMLInputElement;
		expect([from().value, to().value]).toEqual(["DFW", "PHL"]);

		// The way back follows the way out until its own ends are typed in.
		fireEvent.change(
			screen.getAllByTestId(TRANSIT_TESTID.flightTo)[0] as HTMLElement,
			{ target: { value: "IAH" } },
		);
		await waitFor(() => expect(from().value).toBe("IAH"));

		// It needs its date, and that date can't be before the way out lands.
		fireEvent.click(screen.getByTestId(TRANSIT_TESTID.flightSave));
		await waitFor(() => expect(errorTexts()).toEqual(["Required"]));
		expect(onSubmit).not.toHaveBeenCalled();
		const date = within(back).getByTestId(TRANSIT_TESTID.flightDepDate);
		fireEvent.change(date, { target: { value: "2026-12-20" } });
		await waitFor(() =>
			expect(errorTexts()).toEqual(["Before the outbound flight lands"]),
		);
		fireEvent.change(date, { target: { value: "2026-12-31" } });
		await waitFor(() => expect(errorTexts()).toEqual([]));

		fireEvent.click(screen.getByTestId(TRANSIT_TESTID.flightSave));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		const [segments, extra] = onSubmit.mock.calls[0] as [
			FlightDetails[],
			Extra,
		];
		expect(segments.map((f) => `${f.from.iata}-${f.to.iata}`)).toEqual([
			"PHL-IAH",
		]);
		expect(
			extra.returnSegments?.map(
				(f) => `${f.from.iata}-${f.to.iata} ${f.depDate} ${f.arrDate}`,
			),
		).toEqual(["IAH-PHL 2026-12-31 2026-12-31"]);
		expect(extra.booking).toEqual({});
	});

	it("one way again leaves the way back out", async () => {
		const onSubmit = vi.fn();
		render(
			<FlightForm
				multi
				defaults={{ depDate: "2026-12-24", fromIata: "PHL", toIata: "DFW" }}
				members={[]}
				onSubmit={onSubmit}
			/>,
		);
		const kind = within(screen.getByTestId(TRANSIT_TESTID.flightTripKind));
		fireEvent.click(kind.getByText("Round trip"));
		await screen.findByTestId(TRANSIT_TESTID.flightReturn);
		fireEvent.click(kind.getByText("One way"));
		await waitFor(() =>
			expect(screen.queryByTestId(TRANSIT_TESTID.flightReturn)).toBeNull(),
		);
		fireEvent.click(screen.getByTestId(TRANSIT_TESTID.flightSave));
		await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
		const [segments, extra] = onSubmit.mock.calls[0] as [
			FlightDetails[],
			Extra,
		];
		expect(segments).toHaveLength(1);
		expect(extra.returnSegments).toBeUndefined();
	});

	it("a flight of a booking says its ref and price are the whole booking's", () => {
		render(
			<FlightForm
				initial={[{ ...nh9, from: { ...nh9.from, iata: "JFK" } }]}
				sharedWith={["HND → KIX", "KIX → JFK"]}
				members={[]}
				onSubmit={() => {}}
			/>,
		);
		expect(
			screen.getByTestId(TRANSIT_TESTID.flightBookingNote).textContent,
		).toBe(
			"Booked with HND → KIX and KIX → JFK: the ref, price, points, and fees below are for all 3 flights.",
		);
		// Its own form still has the ref and the price: they are the booking's.
		expect(screen.getAllByTestId(TRANSIT_TESTID.flightCostAmount)).toHaveLength(
			1,
		);
	});
});
