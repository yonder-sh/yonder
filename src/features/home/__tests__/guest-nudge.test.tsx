/**
 * The guest line above the workspace (owner, 2026-10-09): signed out, a link
 * guest only views and is told what signing in lets them do.
 */
import { screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { demoGraph } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import { GuestNudge, signInText } from "../GuestNudge";

vi.mock("@tanstack/react-router", async (orig) => ({
	...(await orig<typeof import("@tanstack/react-router")>()),
	Link: ({ children }: { children: ReactNode }) => (
		<a href="/login">{children}</a>
	),
	useLocation: () => ({ pathname: "/t/japan", searchStr: "" }),
}));

describe("the guest line", () => {
	it("says what signing in lets you do, as the link allows", () => {
		expect(signInText("editor")).toBe("Sign in to edit and rate places");
		expect(signInText("suggester")).toBe(
			"Sign in to suggest changes and rate places",
		);
		expect(signInText("rater")).toBe("Sign in to rate places");
		expect(signInText("viewer")).toBe("Sign in to keep this trip");
	});

	it("a signed-out guest on an edit link views, and is asked to sign in", () => {
		const graph = structuredClone(demoGraph);
		graph.me = {
			...graph.me,
			memberId: null,
			isGuest: true,
			role: "viewer",
			linkRole: "editor",
			name: "Guest Heron",
		};
		renderWithWorkspace(<GuestNudge />, { graph });
		const line = screen.getByTestId(TESTID.guestNudge);
		expect(line).toHaveTextContent("You're viewing as Guest Heron");
		expect(line).toHaveTextContent("Sign in to edit and rate places");
	});
});
