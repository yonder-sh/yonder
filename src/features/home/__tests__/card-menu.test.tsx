/**
 * FB-05: the dashboard trip card's ⋯ menu is one of the Rate screen's entry
 * points. "Rate places" leads to `/t/<trip>/rate` for every member, whatever
 * their role (the menu used to hold only Duplicate… / Leave trip); link
 * guests still get no menu.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CardMenu } from "../CardMenu";
import { HOME_TESTID } from "../testids";

// A router-free Link that shows where it leads.
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		Link: ({
			children,
			to,
			params,
			...rest
		}: {
			children: ReactNode;
			to: string;
			params?: Record<string, string>;
		}) => (
			<a
				{...rest}
				href={Object.entries(params ?? {}).reduce(
					(p, [k, v]) => p.replace(`$${k}`, v),
					to,
				)}
			>
				{children}
			</a>
		),
	};
});

type Trip = Parameters<typeof CardMenu>[0]["trip"];
const asia: Trip = {
	slug: "asia-2027",
	name: "Asia 2027",
	role: "owner",
	viaLink: false,
};

async function openMenu(trip: Trip) {
	const onDuplicate = vi.fn();
	const onLeave = vi.fn();
	render(<CardMenu trip={trip} onDuplicate={onDuplicate} onLeave={onLeave} />);
	const trigger = screen.getByRole("button", { name: `More for ${trip.name}` });
	trigger.focus();
	fireEvent.keyDown(trigger, { key: "Enter" });
	await screen.findByRole("menu");
	return { onDuplicate, onLeave };
}

describe("CardMenu (FB-05)", () => {
	it("offers 'Rate places' first, leading to the trip's Rate screen", async () => {
		await openMenu(asia);
		const items = screen.getAllByRole("menuitem");
		expect(items.map((i) => i.textContent?.trim())).toEqual([
			"Rate places",
			"Duplicate…",
		]);
		const rate = screen.getByRole("menuitem", { name: "Rate places" });
		expect(rate.tagName).toBe("A");
		expect(rate).toHaveAttribute("href", "/t/asia-2027/rate");
		expect(rate).toHaveAttribute("data-testid", HOME_TESTID.tripCardRate);
	});

	it("keeps Duplicate… and Leave trip for a non-owner member", async () => {
		const { onLeave } = await openMenu({
			slug: "phu-quoc-detour",
			name: "Phu Quoc detour",
			role: "viewer",
			viaLink: false,
		});
		expect(
			screen.getAllByRole("menuitem").map((i) => i.textContent?.trim()),
		).toEqual(["Rate places", "Duplicate…", "Leave trip"]);
		expect(
			screen.getByRole("menuitem", { name: "Rate places" }),
		).toHaveAttribute("href", "/t/phu-quoc-detour/rate");
		const leave = screen.getByRole("menuitem", { name: "Leave trip" });
		leave.focus();
		fireEvent.keyDown(leave, { key: "Enter" });
		await act(async () => {});
		expect(onLeave).toHaveBeenCalledTimes(1);
	});

	it("stays usable offline: Rate is a link, the trip changes are disabled", async () => {
		const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
		try {
			await openMenu(asia);
			expect(
				screen.getByRole("menuitem", { name: "Rate places" }),
			).not.toHaveAttribute("data-disabled");
			expect(
				screen.getByRole("menuitem", { name: "Duplicate…" }),
			).toHaveAttribute("data-disabled");
			expect(screen.getByText("Reconnect to change trips.")).toBeVisible();
		} finally {
			onLine.mockRestore();
		}
	});

	it("shows no menu to a link guest", () => {
		render(
			<CardMenu
				trip={{ ...asia, role: "viewer", viaLink: true }}
				onDuplicate={() => {}}
				onLeave={() => {}}
			/>,
		);
		expect(screen.queryByRole("button", { name: /More for/ })).toBeNull();
	});
});
