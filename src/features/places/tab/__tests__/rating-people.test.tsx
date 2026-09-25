/**
 * The group's rating progress: owners and editors leave someone's ratings
 * out ("Maya · not counted") and count them again from their name; "Remind"
 * for people with places left (never you or a placeholder), "Reminded" for
 * 12 hours; viewers get neither.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphMember, TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { RatingProgress } from "../PlacesToolbar";
import { RATING_TESTID as R } from "../rating-testids";
import { usePlaces } from "../use-places";

const MAYA = "00000000-0000-7000-8000-0000000000a1";
const calls: { counted: unknown[]; remind: unknown[] } = {
	counted: [],
	remind: [],
};
let recent: { memberId: string; at: string }[] = [];

vi.mock("@/features/places/rating.functions", () => ({
	getRateReminders: async () => ({ recent, mine: null }),
	remindToRate: async (o: { data: { memberId: string } }) => {
		calls.remind.push(o.data);
		const at = new Date().toISOString();
		recent = [...recent, { memberId: o.data.memberId, at }];
		return { at };
	},
	setRatingsCounted: async (o: { data: unknown }) => {
		calls.counted.push(o.data);
		return { ok: true };
	},
	dismissRateReminder: async () => ({ ok: true }),
}));
vi.mock("@/functions/trips.functions", () => ({
	updateTrip: async () => ({}),
}));

const maya: GraphMember = {
	id: MAYA,
	userId: "user-maya",
	status: "active",
	role: "editor",
	name: "Maya Chen",
	firstName: "Maya",
	color: 2,
};
const graph: TripGraph = {
	...demoGraph,
	members: [...demoGraph.members, maya],
};

function Progress() {
	return <RatingProgress data={usePlaces()} />;
}

const person = (id: string) =>
	screen
		.getAllByTestId(R.person)
		.find((el) => el.dataset.member === id) as HTMLElement;

beforeEach(() => {
	calls.counted = [];
	calls.remind = [];
	recent = [];
});

describe("rating progress", () => {
	it("leave out Maya's ratings, then count them again", async () => {
		const user = userEvent.setup();
		const r = renderWithWorkspace(<Progress />, { graph, mode: "live" });
		await user.click(within(person(MAYA)).getByTestId(R.personMenu));
		await user.click(await screen.findByTestId(R.leaveOut));
		await waitFor(() => expect(calls.counted).toHaveLength(1));
		expect(calls.counted[0]).toEqual({ memberId: MAYA, counted: false });
		// The same data with Maya left out (as the graph refetch brings it).
		r.unmount();
		renderWithWorkspace(<Progress />, {
			graph: {
				...graph,
				members: graph.members.map((m) =>
					m.id === MAYA ? { ...m, ratingsCounted: false } : m,
				),
			},
			mode: "live",
		});
		expect(person(MAYA)).toHaveAttribute("data-counted", "false");
		expect(person(MAYA)).toHaveTextContent(/Maya\s*· not counted/);
		expect(within(person(MAYA)).queryByTestId(R.remind)).toBeNull();
		await user.click(within(person(MAYA)).getByTestId(R.personMenu));
		await user.click(await screen.findByTestId(R.countAgain));
		await waitFor(() => expect(calls.counted).toHaveLength(2));
		expect(calls.counted[1]).toEqual({ memberId: MAYA, counted: true });
	});

	it("Remind for Maya only; Reminded once she was", async () => {
		const user = userEvent.setup();
		renderWithWorkspace(<Progress />, { graph, mode: "live" });
		const remind = await within(person(MAYA)).findByTestId(R.remind);
		expect(remind).toHaveTextContent("Remind");
		// Not for you, not for Audrey (no account: no notifications).
		expect(
			within(person(DEMO_MEMBERS.dennis)).queryByTestId(R.remind),
		).toBeNull();
		expect(
			within(person(DEMO_MEMBERS.audrey)).queryByTestId(R.remind),
		).toBeNull();
		await user.click(remind);
		await waitFor(() => expect(calls.remind).toHaveLength(1));
		expect(calls.remind[0]).toEqual({ tripId: graph.trip.id, memberId: MAYA });
		await waitFor(() =>
			expect(within(person(MAYA)).getByTestId(R.remind)).toHaveTextContent(
				"Reminded",
			),
		);
		expect(within(person(MAYA)).getByTestId(R.remind)).toBeDisabled();
	});

	it("already reminded: Reminded, disabled", async () => {
		recent = [{ memberId: MAYA, at: new Date().toISOString() }];
		renderWithWorkspace(<Progress />, { graph, mode: "live" });
		await waitFor(() =>
			expect(within(person(MAYA)).getByTestId(R.remind)).toHaveAttribute(
				"data-state",
				"reminded",
			),
		);
	});

	it("viewers see the progress, with no menu and no Remind", () => {
		renderWithWorkspace(<Progress />, {
			graph: {
				...graph,
				me: { ...graph.me, role: "viewer" },
				members: graph.members.map((m) =>
					m.id === DEMO_MEMBERS.dennis ? { ...m, role: "viewer" } : m,
				),
			},
			mode: "live",
		});
		expect(screen.queryByTestId(R.personMenu)).toBeNull();
		expect(screen.queryByTestId(R.remind)).toBeNull();
	});
});
