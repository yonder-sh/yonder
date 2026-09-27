import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
	it("merges the kit's sizes as sizes, keeping the text colour", () => {
		expect(cn("text-sm text-primary-foreground", "text-meta")).toBe(
			"text-primary-foreground text-meta",
		);
		expect(cn("text-meta", "text-body")).toBe("text-body");
		expect(cn("text-background", "text-meta")).toBe(
			"text-background text-meta",
		);
	});

	it("merges shadow-float as a shadow", () => {
		expect(cn("shadow-md", "shadow-float")).toBe("shadow-float");
		expect(cn("shadow-float", "shadow-black/10")).toBe(
			"shadow-float shadow-black/10",
		);
	});

	it("lets eyebrow replace an earlier size, weight and case", () => {
		expect(cn("px-2 text-sm font-medium", "eyebrow")).toBe("px-2 eyebrow");
		expect(cn("eyebrow", "hover:text-foreground")).toBe(
			"eyebrow hover:text-foreground",
		);
	});
});
