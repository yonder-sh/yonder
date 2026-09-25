/**
 * QA ERR-07: the in-place sign-in prompt. The email comes from the last known
 * session; after the code step the waiting saves run again (same account) and
 * the collab socket reconnects with the new cookie.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	send: vi.fn(async () => ({ error: null })),
	verify: vi.fn(async () => ({
		data: { user: { id: "u-audrey" } },
		error: null,
	})),
	reconnect: vi.fn(),
}));
vi.mock("@/lib/auth/auth-client", () => ({
	authClient: {
		emailOtp: { sendVerificationOtp: m.send },
		signIn: { emailOtp: m.verify },
	},
}));
vi.mock("@/lib/realtime/collab-client", () => ({
	reconnectCollabClient: m.reconnect,
}));

import { requestReauth, useReauth } from "@/lib/auth/reauth";
import { sessionKey } from "@/lib/query/keys";
import { ReauthDialog } from "./reauth-dialog";

describe("ReauthDialog", () => {
	it("signs the same account back in and runs the waiting save", async () => {
		const qc = new QueryClient();
		qc.setQueryData(sessionKey, {
			id: "u-audrey",
			email: "audrey@asia2027.test",
			isAnonymous: false,
		});
		render(
			<QueryClientProvider client={qc}>
				<ReauthDialog />
			</QueryClientProvider>,
		);
		const retry = vi.fn();
		act(() => requestReauth(retry));
		const email = await screen.findByLabelText("Email");
		expect(email).toHaveValue("audrey@asia2027.test");
		fireEvent.click(screen.getByRole("button", { name: "Send code" }));
		const code = await screen.findByLabelText(/Code sent to/);
		fireEvent.change(code, { target: { value: "123456" } });
		fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
		await vi.waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
		expect(m.verify).toHaveBeenCalledWith({
			email: "audrey@asia2027.test",
			otp: "123456",
		});
		expect(m.reconnect).toHaveBeenCalled();
		expect(useReauth.getState().open).toBe(false);
	});
});
