import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultReviewView, lastReviewView } from "../use-places";

const width = (px: number) =>
	vi.spyOn(window, "matchMedia").mockImplementation(
		(q: string) =>
			({
				matches: q === "(max-width: 767px)" && px < 768,
				media: q,
			}) as MediaQueryList,
	);

afterEach(() => vi.restoreAllMocks());

describe("the Review step's first view", () => {
	it("is the Board on a phone, the table on a laptop", () => {
		width(390);
		expect(defaultReviewView()).toBe("board");
		width(1440);
		expect(defaultReviewView()).toBe("table");
	});

	it("keeps a view once shown, the table on a phone too", () => {
		width(390);
		lastReviewView.current = "table";
		expect(lastReviewView.current).toBe("table");
	});
});
