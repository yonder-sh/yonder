/**
 * A trip someone added me to says so on its dashboard card until I first
 * open it (its welcome): "New · Nova invited you", or "New" after a link join.
 */
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { TripCard } from "../Dashboard";
import { HOME_TESTID } from "../testids";
import type { MyTrip } from "../types";

// A router-free Link.
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		Link: ({
			children,
			to: _to,
			params: _p,
			...rest
		}: {
			children: ReactNode;
			to: string;
			params?: unknown;
		}) => <a {...rest}>{children}</a>,
	};
});

const trip: MyTrip = {
	id: "t1",
	slug: "japan-with-friends",
	name: "Japan with friends",
	startDate: null,
	endDate: null,
	role: "editor",
	viaLink: false,
	members: [],
	memberCount: 2,
	countryCodes: [],
	coverUrl: null,
	routePoints: [],
	unreadMentions: 0,
	updatedAt: "2027-01-01T00:00:00Z",
	ownerName: "Nova Trip",
};

const card = (t: MyTrip) =>
	render(<TripCard trip={t} shared offline={false} menu={null} />);

describe("TripCard 'New' tag", () => {
	it("names the inviter until I open the trip", () => {
		card({ ...trip, unopened: { invitedBy: "Nova" } });
		expect(screen.getByTestId(HOME_TESTID.tripCardNew)).toHaveTextContent(
			"New · Nova invited you",
		);
	});

	it("says just 'New' after a link join", () => {
		card({ ...trip, unopened: { invitedBy: null } });
		expect(screen.getByTestId(HOME_TESTID.tripCardNew)).toHaveTextContent(
			/^New$/,
		);
	});

	it("is gone once opened", () => {
		card({ ...trip, unopened: null });
		expect(screen.queryByTestId(HOME_TESTID.tripCardNew)).toBeNull();
	});
});
