/**
 * FilterPill (One Yonder kit): the one on/off filter pill. A toggle button
 * with its state in `aria-pressed`, the kit's selected look when on, an
 * optional icon or avatar in front and a count after the label.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapPin } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { DEMO_MEMBERS } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { FilterPill } from "..";

describe("FilterPill", () => {
	it("is a toggle button that says whether it's on", () => {
		const { rerender } = render(
			<FilterPill pressed={false}>Everyone's</FilterPill>,
		);
		const pill = screen.getByRole("button", { name: "Everyone's" });
		expect(pill).toHaveAttribute("type", "button");
		expect(pill).toHaveAttribute("aria-pressed", "false");
		expect(pill).toHaveAttribute("data-state", "off");
		expect(pill.className).toContain("border-border");
		rerender(<FilterPill pressed>Everyone's</FilterPill>);
		expect(pill).toHaveAttribute("aria-pressed", "true");
		expect(pill).toHaveAttribute("data-state", "on");
		// The kit's selected look (the Chip `selected` tone).
		expect(pill.className).toContain("bg-foreground");
		expect(pill.className).toContain("text-background");
	});

	it("flips on a click and still calls onClick", async () => {
		const onPressedChange = vi.fn();
		const onClick = vi.fn();
		const { rerender } = render(
			<FilterPill
				pressed={false}
				onPressedChange={onPressedChange}
				onClick={onClick}
			>
				Near Shibuya
			</FilterPill>,
		);
		await userEvent.click(screen.getByRole("button"));
		expect(onPressedChange).toHaveBeenLastCalledWith(true);
		expect(onClick).toHaveBeenCalledTimes(1);
		rerender(
			<FilterPill pressed onPressedChange={onPressedChange}>
				Near Shibuya
			</FilterPill>,
		);
		await userEvent.click(screen.getByRole("button"));
		expect(onPressedChange).toHaveBeenLastCalledWith(false);
	});

	it("does nothing while disabled", async () => {
		const onPressedChange = vi.fn();
		render(
			<FilterPill pressed={false} disabled onPressedChange={onPressedChange}>
				Mon
			</FilterPill>,
		);
		const pill = screen.getByRole("button", { name: "Mon" });
		expect(pill).toBeDisabled();
		await userEvent.click(pill);
		expect(onPressedChange).not.toHaveBeenCalled();
	});

	it("puts a count after the label, 0 included", () => {
		const { rerender } = render(
			<FilterPill pressed={false} count={12}>
				Shortlist
			</FilterPill>,
		);
		expect(screen.getByRole("button", { name: "Shortlist 12" })).toBeVisible();
		rerender(
			<FilterPill pressed={false} count={0}>
				Shortlist
			</FilterPill>,
		);
		expect(screen.getByRole("button", { name: "Shortlist 0" })).toBeVisible();
		rerender(
			<FilterPill pressed={false} count={null}>
				Shortlist
			</FilterPill>,
		);
		expect(screen.getByRole("button", { name: "Shortlist" })).toBeVisible();
	});

	it("takes the touch heights from the control tokens", () => {
		const { rerender } = render(<FilterPill pressed={false}>All</FilterPill>);
		expect(screen.getByRole("button").className).toContain("h-(--control)");
		rerender(
			<FilterPill pressed={false} size="sm">
				All
			</FilterPill>,
		);
		expect(screen.getByRole("button").className).toContain("h-(--control-sm)");
	});

	it("shows an icon, or a person's avatar in front", () => {
		const { rerender } = render(
			<FilterPill pressed={false} icon={MapPin}>
				Near Shibuya
			</FilterPill>,
		);
		const svg = screen.getByRole("button").querySelector("svg");
		expect(svg).toHaveAttribute("aria-hidden", "true");
		rerender(
			<FilterPill pressed={false} user={{ name: "Maya Chen", color: 3 }}>
				Maya
			</FilterPill>,
		);
		expect(screen.getByTitle("Maya Chen")).toBeInTheDocument();
		expect(screen.getByRole("button").querySelector("svg")).toBeNull();
		// The label names her once; the avatar's initials stay out of it.
		expect(screen.getByRole("button", { name: "Maya" })).toBeVisible();
	});

	it("finds a member's avatar in the trip", () => {
		renderWithWorkspace(
			<FilterPill pressed memberId={DEMO_MEMBERS.audrey}>
				Audrey
			</FilterPill>,
		);
		expect(screen.getByTitle("Audrey")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Audrey" })).toBeVisible();
	});
});
