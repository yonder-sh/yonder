/** QA ERR-04: the branded error page retries and never shows internals. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const invalidate = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
}));

const { RouteError } = await import("./route-error");

describe("RouteError", () => {
	it("says 'Something went wrong, try again' and retries the route", async () => {
		const reset = vi.fn();
		render(<RouteError reset={reset} />);
		expect(
			screen.getByText("Something went wrong, try again."),
		).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/session|Error|stack/i);
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
		expect(reset).toHaveBeenCalledTimes(1);
	});
});
