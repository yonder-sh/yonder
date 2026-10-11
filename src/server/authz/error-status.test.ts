import { execValidator } from "@tanstack/react-start";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { humanError, isRetryableError } from "@/lib/errors";
import { CreateTripInput } from "@/server/cores/trips.server";
import { AppError, errorCode, validatorError } from "./errors";

const status = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock("@tanstack/react-start/server", () => ({
	getRequest: () => new Request("http://x/"),
	setResponseStatus: status.set,
}));
vi.mock("@/server/auth.server", () => ({ auth: {} }));
vi.mock("@/server/cache.server", () => ({ fnRateLimit: async () => {} }));

const { withErrorStatus } = await import("./middleware");

/** The error TanStack Start's validator step throws for `input`. */
async function validatorThrow(schema: z.ZodType, input: unknown) {
	try {
		await execValidator(schema, input);
	} catch (e) {
		return e;
	}
	throw new Error("expected the validator to throw");
}

/** Runs `withErrorStatus` around a step that throws `e`; returns what it rethrows. */
async function through(e: unknown) {
	const { server } = withErrorStatus.options as unknown as {
		server: (o: { next: () => Promise<never> }) => Promise<unknown>;
	};
	return server({ next: () => Promise.reject(e) }).then(
		() => {
			throw new Error("expected a rethrow");
		},
		(err: unknown) => err,
	);
}

beforeEach(() => status.set.mockClear());

describe("validatorError", () => {
	it("turns a failed input validator into VALIDATION with the issues", async () => {
		const app = validatorError(
			await validatorThrow(CreateTripInput, { name: "  " }),
		);
		expect(app).toBeInstanceOf(AppError);
		expect(app?.code).toBe("VALIDATION");
		expect(app?.status).toBe(400);
		expect(app?.message).toMatch(/^VALIDATION: name: /);
	});

	it("keeps a refinement's message", async () => {
		const e = await validatorThrow(CreateTripInput, {
			name: "Japan",
			startDate: "2027-10-01",
		});
		expect(validatorError(e)?.detail).toContain("Give both dates or neither");
	});

	it("leaves other errors alone", () => {
		expect(validatorError(new Error("boom"))).toBeNull();
		expect(validatorError(new Error("[not json"))).toBeNull();
		expect(validatorError(new Error("[1, 2]"))).toBeNull();
		expect(validatorError(new AppError("FORBIDDEN"))).toBeNull();
		expect(validatorError("[]")).toBeNull();
	});
});

describe("withErrorStatus", () => {
	it("answers a failed validator with 400 (QA AUTH-02: a nameless createTrip)", async () => {
		const err = await through(
			await validatorThrow(CreateTripInput, { name: "" }),
		);
		expect(errorCode(err)).toBe("VALIDATION");
		expect(status.set).toHaveBeenCalledWith(400);
	});

	it("answers a thrown AppError with its status", async () => {
		const e = new AppError("CONFLICT", "That's already in Saved.");
		expect(await through(e)).toBe(e);
		expect(status.set).toHaveBeenCalledWith(409);
	});

	it("rethrows anything else untouched", async () => {
		const e = new Error("db down");
		expect(await through(e)).toBe(e);
		expect(status.set).not.toHaveBeenCalled();
	});
});

describe("on the client (seroval keeps only the message)", () => {
	const asClient = (e: AppError | null) => new Error(e?.message);

	it("reads as a validation problem, not a retryable crash", async () => {
		const e = asClient(
			validatorError(await validatorThrow(CreateTripInput, { name: "" })),
		);
		expect(errorCode(e)).toBe("VALIDATION");
		expect(humanError(e)).toBe(
			"That doesn't look right. Check the value and try again.",
		);
		expect(isRetryableError(e)).toBe(false);
	});

	it("shows a refinement written as a sentence", async () => {
		const Input = z
			.object({ a: z.number() })
			.refine((v) => v.a > 0, { message: "Pick at least one night." });
		const e = asClient(validatorError(await validatorThrow(Input, { a: 0 })));
		expect(humanError(e)).toBe("Pick at least one night.");
	});
});
