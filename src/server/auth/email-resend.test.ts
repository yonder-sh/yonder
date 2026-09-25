/**
 * Resend in production (SPEC §5.1 "Email"): with RESEND_API_KEY the sign-in
 * code goes through Resend with EMAIL_FROM as given, display name included
 * ("Yonder <login@yonder.sh>"), and a Resend error reaches the caller (the
 * OTP route turns it into EMAIL_SEND_FAILED, QA AUTH-14).
 */
import { afterAll, describe, expect, it, vi } from "vitest";

const resend = vi.hoisted(() => {
	const saved = {
		RESEND_API_KEY: process.env.RESEND_API_KEY,
		EMAIL_FROM: process.env.EMAIL_FROM,
		SMTP_HOST: process.env.SMTP_HOST,
		EMAIL_OUTBOX_DIR: process.env.EMAIL_OUTBOX_DIR,
	};
	process.env.RESEND_API_KEY = "re_test_123";
	process.env.EMAIL_FROM = "Yonder <login@yonder.sh>";
	process.env.SMTP_HOST = "";
	process.env.EMAIL_OUTBOX_DIR = "";
	return {
		saved,
		keys: [] as string[],
		sent: [] as Record<string, unknown>[],
		error: null as null | { name: string; message: string },
	};
});

vi.mock("resend", () => ({
	Resend: class {
		constructor(key: string) {
			resend.keys.push(key);
		}
		emails = {
			send: async (m: Record<string, unknown>) => {
				resend.sent.push(m);
				return resend.error
					? { data: null, error: resend.error }
					: { data: { id: "email_1" }, error: null };
			},
		};
	},
}));

import { mailTransport, otpEmail, sendMail } from "./email.server";

afterAll(() => {
	for (const [k, v] of Object.entries(resend.saved))
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
});

describe("Resend", () => {
	it("sends the code from EMAIL_FROM, display name and all", async () => {
		expect(mailTransport()).toBe("resend");
		const mail = otpEmail({
			appName: "Yonder",
			otp: "482913",
			expiresInMin: 10,
		});
		await sendMail({ to: "dennis@example.test", ...mail });
		expect(resend.keys).toEqual(["re_test_123"]);
		expect(resend.sent[0]).toMatchObject({
			from: "Yonder <login@yonder.sh>",
			to: "dennis@example.test",
			subject: "482913 is your Yonder sign-in code",
		});
		expect(String(resend.sent[0]?.html)).toContain("482913");
	});

	it("rejects when Resend refuses the message", async () => {
		resend.error = {
			name: "validation_error",
			message: "The yonder.sh domain is not verified",
		};
		await expect(
			sendMail({ to: "a@example.test", subject: "s", text: "t", html: "h" }),
		).rejects.toThrow(
			"Resend: validation_error: The yonder.sh domain is not verified",
		);
	});
});
