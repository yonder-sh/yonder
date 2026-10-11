import { describe, expect, it } from "vitest";
import { stackedInset } from "./bottom-bars";

const VH = 844;

describe("stackedInset", () => {
	it("is 0 with no bars", () => {
		expect(stackedInset([], VH)).toBe(0);
	});

	it("reaches the top of a bar on the foot", () => {
		expect(stackedInset([{ top: 754, bottom: 844 }], VH)).toBe(90);
	});

	it("stacks a dock on the tab bar and a float just above it", () => {
		const tabs = { top: 754, bottom: 844 };
		const dock = { top: 710, bottom: 754 };
		const fab = { top: 638, bottom: 694 };
		expect(stackedInset([fab, tabs, dock], VH)).toBe(206);
	});

	it("ignores a bar mid-screen and what sits above it", () => {
		const tabs = { top: 754, bottom: 844 };
		const mid = { top: 300, bottom: 400 };
		expect(stackedInset([tabs, mid], VH)).toBe(90);
	});

	it("ignores empty boxes", () => {
		expect(stackedInset([{ top: 844, bottom: 844 }], VH)).toBe(0);
	});
});
