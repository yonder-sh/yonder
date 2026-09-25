/**
 * `isAccessDenied` and the revalidation it guards (QA SEC-R2-04): a graph
 * restored from IndexedDB keeps rendering when its background revalidation
 * fails, and the workspace reads the refetch's NOT_FOUND from the suspense
 * query to leave the trip (the same exit as a live access loss).
 */
import {
	QueryClient,
	QueryClientProvider,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Suspense, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/authz/errors";
import { isAccessDenied } from "./errors";

describe("isAccessDenied", () => {
	it("is NOT_FOUND or FORBIDDEN from the server, never a network failure", () => {
		expect(isAccessDenied(new AppError("NOT_FOUND"))).toBe(true);
		expect(isAccessDenied(new Error("FORBIDDEN: not a member"))).toBe(true);
		expect(isAccessDenied(new TypeError("Failed to fetch"))).toBe(false);
		expect(isAccessDenied(new AppError("UNAUTHORIZED"))).toBe(false);
		expect(isAccessDenied(null)).toBe(false);
	});

	it("sees a restored query's failed revalidation while the data stays", async () => {
		const qc = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const key = ["trip", "t1", "graph"];
		qc.setQueryData(key, { name: "Asia 2027" });
		const queryFn = vi.fn(async (): Promise<{ name: string }> => {
			throw new AppError("NOT_FOUND");
		});
		const lost = vi.fn();
		function Probe() {
			const { data, error } = useSuspenseQuery({ queryKey: key, queryFn });
			const denied = isAccessDenied(error);
			useEffect(() => {
				if (denied) lost();
			}, [denied]);
			return <p>{data.name}</p>;
		}
		render(
			<QueryClientProvider client={qc}>
				<Suspense fallback={null}>
					<Probe />
				</Suspense>
			</QueryClientProvider>,
		);
		expect(screen.getByText("Asia 2027")).toBeInTheDocument();
		await act(async () => {
			await qc.refetchQueries({ queryKey: key }).catch(() => undefined);
		});
		await waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
		expect(screen.getByText("Asia 2027")).toBeInTheDocument();
	});
});
