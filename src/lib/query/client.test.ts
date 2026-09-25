/**
 * The global mutation error handling (QA ERR-03, ERR-07): a failure a retry
 * can fix toasts "Couldn't save." with a Retry that re-runs the same mutation
 * (optimistic update included); UNAUTHORIZED opens the re-auth prompt and
 * queues the save for when the account is back.
 */
import { MutationObserver } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { useReauth } from "@/lib/auth/reauth";
import { makeQueryClient } from "./client";
import { sessionKey } from "./keys";

type Action = { label: string; onClick: () => void };

beforeEach(() => {
	toast.error.mockReset();
	useReauth.getState().finish();
});

function run(
	fn: () => Promise<unknown>,
	meta: { silent?: boolean; manualResubmit?: boolean } = {},
) {
	const qc = makeQueryClient();
	const onMutate = vi.fn();
	const obs = new MutationObserver(qc, {
		mutationFn: fn,
		onMutate,
		meta,
	});
	return { obs, onMutate, done: obs.mutate(undefined).catch(() => undefined) };
}

describe("mutation errors", () => {
	it("a server error says Couldn't save, and Retry re-runs it (ERR-03)", async () => {
		let calls = 0;
		const { done, onMutate } = run(async () => {
			calls += 1;
			if (calls === 1) throw new Error("Internal Server Error");
			return "ok";
		});
		await done;
		expect(toast.error).toHaveBeenCalledTimes(1);
		const [message, opts] = toast.error.mock.calls[0] as [
			string,
			{ action: Action },
		];
		expect(message).toBe("Couldn't save.");
		expect(opts.action.label).toBe("Retry");
		opts.action.onClick();
		await vi.waitFor(() => expect(calls).toBe(2));
		// The optimistic step runs again with the retry.
		await vi.waitFor(() => expect(onMutate).toHaveBeenCalledTimes(2));
		expect(toast.error).toHaveBeenCalledTimes(1);
	});

	it("access and validation errors have no Retry", async () => {
		await run(async () => {
			throw new Error("FORBIDDEN");
		}).done;
		expect(toast.error.mock.calls[0]?.[1]).toBeUndefined();
	});

	it("UNAUTHORIZED opens the re-auth prompt and queues the save (ERR-07)", async () => {
		let calls = 0;
		const { done } = run(async () => {
			calls += 1;
			if (calls === 1) throw new Error("UNAUTHORIZED");
			return "ok";
		});
		await done;
		expect(useReauth.getState().open).toBe(true);
		const pending = useReauth.getState().finish();
		expect(pending).toHaveLength(1);
		for (const r of pending) r();
		await vi.waitFor(() => expect(calls).toBe(2));
	});

	it("a manual-resubmit mutation (the UI gives the input back) is never re-run", async () => {
		await run(
			async () => {
				throw new Error("UNAUTHORIZED");
			},
			{ manualResubmit: true },
		).done;
		expect(useReauth.getState().open).toBe(true);
		expect(useReauth.getState().finish()).toHaveLength(0);
		await run(
			async () => {
				throw new Error("boom");
			},
			{ manualResubmit: true },
		).done;
		expect(toast.error.mock.calls.at(-1)).toEqual([
			"Couldn't save.",
			undefined,
		]);
	});
});

describe("query errors", () => {
	it("UNAUTHORIZED for someone who was signed in opens the re-auth prompt", async () => {
		vi.stubGlobal("window", {}); // browser only
		const qc = makeQueryClient();
		const fail = () => Promise.reject(new Error("UNAUTHORIZED"));
		await qc.fetchQuery({ queryKey: ["x"], queryFn: fail }).catch(() => {});
		expect(useReauth.getState().open).toBe(false); // nobody was signed in
		qc.setQueryData(sessionKey, { id: "u1" });
		await qc.fetchQuery({ queryKey: ["y"], queryFn: fail }).catch(() => {});
		expect(useReauth.getState().open).toBe(true);
		expect(toast.error).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});
