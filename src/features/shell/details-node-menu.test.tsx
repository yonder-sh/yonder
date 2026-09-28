/** One Yonder: a place's row actions live in the details header's ⋯. */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { N } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { InspectorBody } from "./InspectorBody";
import { SHELL_TESTID } from "./testids";

describe("the details ⋯ for a place", () => {
	it("lists the row actions, and Rename edits the title in place", async () => {
		const user = userEvent.setup();
		renderWithWorkspace(<InspectorBody />, {
			splat: "japan",
			search: { sel: `n.${N.tokyo}` },
		});
		await user.click(screen.getByTestId(SHELL_TESTID.detailsMenu));
		const menu = await screen.findByRole("menu");
		for (const name of [/Open Tokyo/, /Add inside/, /Rename/, /Move/, /Delete/])
			expect(within(menu).getByRole("menuitem", { name })).toBeInTheDocument();
		await user.click(within(menu).getByRole("menuitem", { name: /Rename/ }));
		const input = await screen.findByRole("textbox", { name: "Rename Tokyo" });
		await waitFor(() => expect(input).toHaveFocus());
		expect(input).toHaveValue("Tokyo");
		await user.keyboard("{Escape}");
		expect(screen.getByRole("heading", { name: "Tokyo" })).toBeInTheDocument();
	});

	it("isn't there for a stop or the trip", () => {
		renderWithWorkspace(<InspectorBody />, { search: { sel: "root" } });
		expect(screen.queryByTestId(SHELL_TESTID.detailsMenu)).toBeNull();
	});
});
