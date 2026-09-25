/**
 * API login (SPEC §18.5; spikes/auth gotcha 6): send the code, sign in with it,
 * set both names, keep the cookies. Never through the UI (the UI login test
 * belongs to its own spec). Requests carry `Origin: <APP_URL>` and JSON bodies.
 */
import type { APIRequestContext } from "@playwright/test";
import { APP_URL, assertNotMainStack } from "./env";
import { logOffset, readOtp } from "./otp";

/** What Cloudflare's test site keys hand out; the test secret keys accept only it. */
export const TURNSTILE_TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const json = (body: unknown) => ({
	data: body,
	headers: { Origin: APP_URL, "Content-Type": "application/json" },
});

export async function loginViaApi(
	request: APIRequestContext,
	email: string,
	name: { first: string; last: string } = { first: "E2E", last: "Tester" },
): Promise<void> {
	assertNotMainStack();
	const since = logOffset();
	const send = await request.post("/api/auth/email-otp/send-verification-otp", {
		...json({ email, type: "sign-in" }),
		// With Turnstile's test keys on the server, their dummy token passes.
		headers: { ...json(null).headers, "x-captcha-response": TURNSTILE_TEST_TOKEN },
	});
	if (!send.ok()) throw new Error(`send-verification-otp ${send.status()}: ${await send.text()}`);
	const otp = await readOtp(email, { since });
	const sign = await request.post("/api/auth/sign-in/email-otp", json({ email, otp }));
	if (!sign.ok()) throw new Error(`sign-in/email-otp ${sign.status()}: ${await sign.text()}`);
	const session = (await (await request.get("/api/auth/get-session")).json()) as {
		user?: { firstName?: string; lastName?: string };
	} | null;
	if (!session?.user?.firstName?.trim() || !session.user.lastName?.trim()) {
		const upd = await request.post("/api/auth/update-user", json({ firstName: name.first, lastName: name.last }));
		if (!upd.ok()) throw new Error(`update-user ${upd.status()}: ${await upd.text()}`);
	}
}
