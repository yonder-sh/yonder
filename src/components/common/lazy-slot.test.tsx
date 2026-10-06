/** A lazy part whose chunk can't load offline keeps its fallback (QA: offline taps blanked the app). */
import { render, screen } from "@testing-library/react";
import { lazy } from "react";
import { describe, expect, it, vi } from "vitest";
import { isChunkError, LazySlot } from "./lazy-slot";

describe("LazySlot", () => {
	it("a chunk that fails to load leaves the fallback", async () => {
		const Missing = lazy(() =>
			Promise.reject(
				new TypeError("Failed to fetch dynamically imported module: /x.js"),
			),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});
		render(
			<LazySlot fallback={<p>Stand-in</p>}>
				<Missing />
			</LazySlot>,
		);
		expect(await screen.findByText("Stand-in")).toBeInTheDocument();
		vi.restoreAllMocks();
	});

	it("only chunk errors are caught", () => {
		expect(isChunkError(new TypeError("Importing a module script failed."))).toBe(
			true,
		);
		expect(isChunkError(new Error("x is not a function"))).toBe(false);
	});
});
