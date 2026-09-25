/**
 * MemberAvatar (QA TAG-04, A11Y-01): a removed member greys out with
 * "(former member)" like MemberName; initials sit on a darkened fill.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GraphMember } from "@/lib/engine/types";

const members: GraphMember[] = [
	{
		id: "m-kai",
		userId: null,
		status: "removed",
		role: "viewer",
		name: "Kai Viewer",
		color: 2,
	},
	{
		id: "m-maya",
		userId: "u-maya",
		status: "active",
		role: "editor",
		name: "Maya Suggester",
		color: 3,
	},
];

vi.mock("@/features/home/sharing.functions", () => ({
	addPlaceholder: vi.fn(),
}));
vi.mock("@/lib/workspace/model-context", () => ({
	useWorkspaceOptional: () => ({ graph: { members } }),
}));

import { MemberAvatar, presenceFill } from "./member";

describe("MemberAvatar", () => {
	it("greys a removed member and says so (TAG-04)", () => {
		render(<MemberAvatar memberId="m-kai" />);
		const a = screen.getByTitle("Kai Viewer (former member)");
		expect(a).toHaveAttribute("data-former-member");
		expect(a.className).toContain("grayscale");
	});

	it("an active member keeps full colour and a plain title", () => {
		render(<MemberAvatar memberId="m-maya" />);
		const a = screen.getByTitle("Maya Suggester");
		expect(a).not.toHaveAttribute("data-former-member");
		expect(a.className).not.toContain("grayscale");
	});

	it("initials sit on the darkened presence fill (A11Y-01)", () => {
		expect(presenceFill(2)).toBe(
			"color-mix(in oklab, var(--presence-3) 75%, black)",
		);
	});
});
