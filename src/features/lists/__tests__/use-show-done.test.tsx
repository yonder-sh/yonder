/**
 * QA ROLL-08 (CONTENT-11): the done-rows fold is remembered per user — it
 * comes from the account's `user_prefs` (another browser has the same
 * answer) and a change is sent there, not only kept in this browser.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
	stored: {} as Record<string, unknown>,
	patches: [] as Record<string, unknown>[],
}));

vi.mock("@/functions/prefs.functions", () => ({
	getUserPrefs: vi.fn(async () => server.stored),
	setUserPrefs: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
		server.patches.push(data);
		server.stored = { ...server.stored, ...data };
		return server.stored;
	}),
}));

import { resetPrefsCacheForTests } from "@/features/shell/view-prefs";
import { UserPrefs } from "@/lib/schemas/misc";
import { useShowDone } from "../use-show-done";

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			{children}
		</QueryClientProvider>
	);
}

afterEach(() => {
	localStorage.clear();
	resetPrefsCacheForTests();
	server.stored = {};
	server.patches = [];
});

describe("useShowDone", () => {
	it("reads the account's choice in a fresh browser", async () => {
		server.stored = { listsShowDone: true };
		const { result } = renderHook(() => useShowDone(), { wrapper });
		await waitFor(() => expect(result.current[0]).toBe(true));
	});

	it("sends a change to the account", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const { result } = renderHook(() => useShowDone(), { wrapper });
			expect(result.current[0]).toBe(false);
			act(() => result.current[1](true));
			expect(result.current[0]).toBe(true);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(600);
			});
			await waitFor(() =>
				expect(server.patches).toContainEqual({ listsShowDone: true }),
			);
			// Nothing kept under the old browser-only key.
			expect(localStorage.getItem("yonder:lists:done-open")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("the key survives the prefs schema (setUserPrefs' validator)", () => {
		expect(UserPrefs.parse({ listsShowDone: true })).toEqual({
			listsShowDone: true,
		});
	});
});
