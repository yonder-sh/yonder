/**
 * Invite in the header: filled while nobody else has joined, quiet once
 * someone has; it opens the share dialog.
 */
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { demoGraph } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { InviteButton } from "./InviteButton";

describe("Invite", () => {
	it("stands out while you're the only one on the trip", () => {
		const graph = structuredClone(demoGraph);
		graph.members = graph.members.filter((m) => m.id === graph.me.memberId);
		renderWithWorkspace(<InviteButton />, { graph });
		const b = screen.getByTestId(TESTID.shareButton);
		expect(b).toHaveTextContent("Invite");
		expect(b).toHaveAttribute("data-alone");
	});

	it("is quiet once someone has joined, and opens the share dialog", () => {
		useUi.setState({ shareOpen: false });
		// Audrey has an account now (in the demo she's a placeholder: still alone).
		const graph = structuredClone(demoGraph);
		graph.members = graph.members.map((m) =>
			m.id === graph.me.memberId
				? m
				: { ...m, userId: "user-audrey", status: "active" as const },
		);
		renderWithWorkspace(<InviteButton phone />, { graph });
		const b = screen.getByRole("button", { name: "Invite" });
		expect(b).not.toHaveAttribute("data-alone");
		fireEvent.click(b);
		expect(useUi.getState().shareOpen).toBe(true);
	});
});
