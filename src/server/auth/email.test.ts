import { describe, expect, it } from "vitest";
import { maskEmail, otpEmail } from "./email.server";

describe("otpEmail", () => {
	const mail = otpEmail({ appName: "Yonder", otp: "123456", expiresInMin: 10 });

	it("carries the code and its lifetime", () => {
		expect(mail.subject).toBe("123456 is your Yonder sign-in code");
		expect(mail.text).toContain("123456");
		expect(mail.text).toContain("10 minutes");
		expect(mail.html).toContain("123456");
	});

	it("contains a code, never a link that signs you in (QA AUTH-09)", () => {
		expect(mail.html).not.toMatch(/<a\s/i);
		expect(mail.html).not.toMatch(/https?:\/\//);
		expect(mail.text).not.toMatch(/https?:\/\//);
	});

	it("escapes the app name in HTML", () => {
		const m = otpEmail({
			appName: "<b>Y&o</b>",
			otp: "000000",
			expiresInMin: 10,
		});
		expect(m.html).not.toContain("<b>Y&o</b>");
		expect(m.html).toContain("&#60;b&#62;Y&#38;o&#60;/b&#62;");
	});
});

describe("maskEmail (SECURITY §12)", () => {
	it("keeps only the first character and the domain", () => {
		expect(maskEmail("someone@company.io")).toBe("s***@company.io");
		expect(maskEmail("nope")).toBe("***");
	});
});
