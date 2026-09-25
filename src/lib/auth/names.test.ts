import { describe, expect, it } from "vitest";
import {
	cleanName,
	fullName,
	GuestName,
	hasFullName,
	initials,
	PersonName,
	PersonNames,
	randomGuestName,
} from "./names";

describe("cleanName", () => {
	it("NFC-normalizes (QA AUTH-03)", () => {
		const decomposed = "Thảo"; // a + combining hook above
		expect(cleanName(decomposed)).toBe("Thảo");
		expect(cleanName(decomposed)).toBe("Thảo".normalize("NFC"));
	});

	it("strips bidi overrides, zero-width and control characters (SECURITY §2)", () => {
		expect(cleanName("Den‮nis")).toBe("Dennis");
		expect(cleanName("A​da")).toBe("Ada");
		expect(cleanName("Kai\u0000\u0007")).toBe("Kai");
		expect(cleanName("﻿Audrey")).toBe("Audrey");
	});

	it("collapses whitespace and trims", () => {
		expect(cleanName("  Mary \t Ann  ")).toBe("Mary Ann");
		expect(cleanName("Line\nBreak")).toBe("Line Break");
	});

	it("keeps apostrophes, hyphens and markup-looking text verbatim (rendered as text)", () => {
		expect(cleanName("Nguyễn-O'Brien")).toBe("Nguyễn-O'Brien");
		expect(cleanName("<img src=x onerror=alert(1)>")).toBe(
			"<img src=x onerror=alert(1)>",
		);
	});
});

describe("PersonName / PersonNames", () => {
	it("requires 1–60 characters after cleaning", () => {
		expect(PersonName.safeParse("").success).toBe(false);
		expect(PersonName.safeParse("   ").success).toBe(false);
		expect(PersonName.safeParse("​").success).toBe(false);
		expect(PersonName.safeParse("x".repeat(61)).success).toBe(false);
		expect(PersonName.parse(" Dennis ")).toBe("Dennis");
		expect(PersonName.parse("x".repeat(60))).toHaveLength(60);
	});

	it("parses both names together", () => {
		expect(
			PersonNames.parse({ firstName: "Thảo", lastName: "Nguyễn-O'Brien" }),
		).toEqual({
			firstName: "Thảo",
			lastName: "Nguyễn-O'Brien",
		});
		expect(
			PersonNames.safeParse({ firstName: "Kai", lastName: "" }).success,
		).toBe(false);
	});
});

describe("GuestName", () => {
	it("allows 1–40 characters", () => {
		expect(GuestName.parse("  Guest Heron ")).toBe("Guest Heron");
		expect(GuestName.safeParse("x".repeat(41)).success).toBe(false);
		expect(GuestName.safeParse(" ").success).toBe(false);
	});
});

describe("helpers", () => {
	it("hasFullName treats null, '' and whitespace as missing", () => {
		expect(hasFullName({ firstName: "A", lastName: "B" })).toBe(true);
		expect(hasFullName({ firstName: "A", lastName: "" })).toBe(false);
		expect(hasFullName({ firstName: " ", lastName: "B" })).toBe(false);
		expect(hasFullName({ firstName: null, lastName: null })).toBe(false);
		expect(hasFullName({})).toBe(false);
	});

	it("fullName joins or returns ''", () => {
		expect(fullName({ firstName: "Dennis", lastName: "Tester" })).toBe(
			"Dennis Tester",
		);
		expect(fullName({ firstName: "Dennis" })).toBe("");
	});

	it("initials use first and last word, by grapheme", () => {
		expect(initials("Dennis Tester")).toBe("DT");
		expect(initials("Thảo Nguyễn-O'Brien")).toBe("TN");
		expect(initials("Mary Ann Smith")).toBe("MS");
		expect(initials("Cher")).toBe("C");
		expect(initials("  ")).toBe("");
	});

	it("randomGuestName is 'Guest <Bird>'", () => {
		expect(randomGuestName(() => 0)).toBe("Guest Albatross");
		expect(randomGuestName(() => 0.999999)).toMatch(/^Guest [A-Z][a-z]+$/);
		expect(GuestName.safeParse(randomGuestName()).success).toBe(true);
	});
});
