/**
 * `/join` (QA SEC-R2-02, LINK-04/05, SEC-07): on the "This link no longer
 * works" page, a new link opened in the same tab (only the hash changes, so
 * nothing remounts) is redeemed and scrubbed from the address bar. FB-14:
 * per-person join links (`#c=`) are gone.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
	const subscribers = new Set<() => void>();
	return {
		subscribers,
		router: {
			navigate: vi.fn(async () => {}),
			invalidate: vi.fn(async () => {}),
			history: {
				subscribe: (cb: () => void) => {
					subscribers.add(cb);
					return () => subscribers.delete(cb);
				},
			},
		},
		session: vi.fn(),
		redeem: vi.fn(),
		signInAnon: vi.fn(),
		deleteAnon: vi.fn(async () => {}),
	};
});

vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
	Link: ({ children }: { children: ReactNode }) => (
		<a href="/login">{children}</a>
	),
	useRouter: () => m.router,
}));
vi.mock("@/lib/auth/session.functions", () => ({ getSessionFn: m.session }));
vi.mock("@/lib/auth/share.functions", () => ({ redeemShareLink: m.redeem }));
vi.mock("@/lib/auth/auth-client", () => ({
	authClient: {
		signIn: { anonymous: m.signInAnon },
		deleteAnonymousUser: m.deleteAnon,
	},
}));
vi.mock("./-components/auth-shell", () => ({
	AuthShell: ({ title, children }: { title: string; children: ReactNode }) => (
		<div>
			<h1>{title}</h1>
			{children}
		</div>
	),
}));

const { Route } = await import("./join");
const JoinPage = (Route as unknown as { options: { component: ComponentType } })
	.options.component;

const TOKEN = "B6w5wDJRMARa-yKzZs0D4QDToWum602dv3OUaZ6v4UM";

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	sessionStorage.clear();
	window.history.replaceState(null, "", "/join");
	m.session.mockResolvedValue(null);
	m.signInAnon.mockResolvedValue({ error: null });
	m.redeem.mockResolvedValue({ slug: "demo-trip" });
});

describe("/join", () => {
	it("redeems a new link opened in the same tab after 'no longer works'", async () => {
		render(<JoinPage />);
		await screen.findByText("This link no longer works.");
		expect(m.redeem).not.toHaveBeenCalled();

		// The new link, pasted into the address bar: only the fragment changes.
		act(() => {
			window.history.replaceState(null, "", `/join#t=${TOKEN}`);
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		});
		// Scrubbed at once, then redeemed and opened.
		expect(window.location.hash).toBe("");
		expect(window.location.pathname).toBe("/join");
		await waitFor(() =>
			expect(m.router.navigate).toHaveBeenCalledWith({
				href: "/t/demo-trip",
				replace: true,
			}),
		);
		expect(m.redeem).toHaveBeenCalledTimes(1);
		expect(m.redeem).toHaveBeenCalledWith({ data: { token: TOKEN } });
		expect(localStorage.getItem("yonder:grants")).toContain(TOKEN);
	});

	it("also takes a link that arrives through the router's history", async () => {
		render(<JoinPage />);
		await screen.findByText("This link no longer works.");
		act(() => {
			window.history.replaceState(null, "", `/join#t=${TOKEN}`);
			for (const cb of m.subscribers) cb();
			// The same change can also fire hashchange: still one redemption.
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		});
		await waitFor(() => expect(m.router.navigate).toHaveBeenCalled());
		expect(m.redeem).toHaveBeenCalledTimes(1);
		expect(window.location.hash).toBe("");
	});

	it("FB-14: an old per-person join link (#c=) no longer works and redeems nothing", async () => {
		window.history.replaceState(null, "", `/join#c=${TOKEN}`);
		render(<JoinPage />);
		await screen.findByText("This link no longer works.");
		expect(window.location.hash).toBe("");
		expect(m.redeem).not.toHaveBeenCalled();
		expect(m.signInAnon).not.toHaveBeenCalled();
		expect(m.router.navigate).not.toHaveBeenCalled();
	});

	it("ignores hash changes without a token", async () => {
		render(<JoinPage />);
		await screen.findByText("This link no longer works.");
		act(() => {
			window.history.replaceState(null, "", "/join#section");
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		});
		expect(m.redeem).not.toHaveBeenCalled();
		expect(screen.getByText("This link no longer works.")).toBeInTheDocument();
	});
});
