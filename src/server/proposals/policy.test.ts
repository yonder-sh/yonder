/**
 * The server-function audit (SECURITY §1, EXTENSIONS §3.3):
 * - every `createServerFn` export has an authentication middleware;
 * - every POST server function is listed in MUTATION_POLICY (and nothing
 *   stale is listed), and the policy matches how the function is written:
 *   proposable ones hand their handler to `proposable.run(op)`, with each
 *   registry op used by exactly one function;
 * - the gate's decision table.
 *
 * A static scan of the source (the functions are compiled by TanStack Start,
 * so their builder chains are the ground truth).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROPOSAL_OPS } from "@/lib/schemas/proposals";
import { MUTATION_POLICY } from "./policy";
import { decide } from "./proposable.server";
import { REGISTRY } from "./registry.server";

const SRC = path.resolve(__dirname, "../..");

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = path.join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.functions\.ts$/.test(name)) out.push(p);
	}
	return out;
}

type Fn = {
	file: string;
	name: string;
	method: "GET" | "POST";
	middleware: string[];
	op: string | null;
};

const FN_RE =
	/export const (\w+) = createServerFn\(\{ method: "(GET|POST)" \}\)([\s\S]*?)(?=\nexport |\n\/\*\*|$)/g;

function scan(): Fn[] {
	const fns: Fn[] = [];
	for (const file of walk(SRC)) {
		const text = readFileSync(file, "utf8");
		for (const m of text.matchAll(FN_RE)) {
			const body = m[3] ?? "";
			const mw = /\.middleware\(\[([^\]]*)\]\)/.exec(body);
			const op = /\.handler\(proposable\.run\("([\w.]+)"\)\)/.exec(body);
			fns.push({
				file: path.relative(SRC, file),
				name: m[1] as string,
				method: m[2] as "GET" | "POST",
				middleware:
					mw?.[1]
						?.split(",")
						.map((s) => s.trim())
						.filter(Boolean) ?? [],
				op: op?.[1] ?? null,
			});
		}
	}
	return fns;
}

const fns = scan();
const AUTH = new Set([
	"withSession",
	"withUser",
	"withNamedUser",
	"withAccount",
]);

describe("server-function audit", () => {
	it("finds the server functions (sanity)", () => {
		expect(fns.length).toBeGreaterThan(80);
		expect(fns.find((f) => f.name === "moveItem")?.op).toBe("item.move");
	});

	it("every server function runs an authentication middleware (SECURITY §1)", () => {
		// Add a name here only with a reason.
		const PUBLIC_ALLOWLIST = new Set<string>([
			// The sign-in page needs the Turnstile site key before any session
			// exists; it returns only public, non-secret settings.
			"getPublicConfig",
		]);
		const missing = fns.filter(
			(f) =>
				!PUBLIC_ALLOWLIST.has(f.name) && !f.middleware.some((m) => AUTH.has(m)),
		);
		expect(missing.map((f) => `${f.file}:${f.name}`)).toEqual([]);
	});

	it("every mutation (POST) needs a signed-in user, and a named one unless account-level", () => {
		const weak = fns.filter(
			(f) =>
				f.method === "POST" &&
				!f.middleware.some((m) =>
					["withUser", "withNamedUser", "withAccount"].includes(m),
				),
		);
		expect(weak.map((f) => f.name)).toEqual([]);
	});

	it("every POST server function is in MUTATION_POLICY, and nothing stale is", () => {
		const posts = fns.filter((f) => f.method === "POST").map((f) => f.name);
		const policy = Object.keys(MUTATION_POLICY);
		expect(posts.filter((n) => !policy.includes(n))).toEqual([]);
		const gets = new Set(
			fns.filter((f) => f.method === "GET").map((f) => f.name),
		);
		// Direct GETs may be listed (previewTripDates); anything else must exist.
		expect(policy.filter((n) => !posts.includes(n) && !gets.has(n))).toEqual(
			[],
		);
	});

	it("proposable functions go through the gate, one function per op; others never do", () => {
		const byOp = new Map<string, string[]>();
		for (const f of fns) {
			const policy = MUTATION_POLICY[f.name as keyof typeof MUTATION_POLICY];
			if (policy === "proposable") expect(f.op, f.name).not.toBeNull();
			else expect(f.op, f.name).toBeNull();
			if (f.op) byOp.set(f.op, [...(byOp.get(f.op) ?? []), f.name]);
		}
		for (const op of PROPOSAL_OPS) expect(byOp.get(op), op).toHaveLength(1);
		expect([...byOp.keys()].filter((op) => !(op in REGISTRY))).toEqual([]);
	});

	it("every registry entry loads a def with a strict input and a core", async () => {
		for (const op of PROPOSAL_OPS) {
			const def = await REGISTRY[op].load();
			expect(typeof def.core, op).toBe("function");
			expect(typeof def.tripIdOf, op).toBe("function");
			// Strict: an unknown key is refused (proposals re-parse payloads).
			const probe = def.input.safeParse({ __nope: 1 });
			expect(probe.success, op).toBe(false);
			if (!probe.success)
				expect(
					probe.error.issues.some((i) => i.code === "unrecognized_keys"),
					op,
				).toBe(true);
		}
	});
});

describe("the gate's decision (EXTENSIONS §3.4 step 1)", () => {
	const plain = {};
	const direct = { directIf: () => true };
	const proposeOnly = { proposeOnly: true as const };

	it("applies for the op's capability, proposes for suggesters, forbids viewers", () => {
		expect(
			decide({ role: "editor", isGuest: false }, "edit", plain, false),
		).toBe("apply");
		expect(
			decide({ role: "editor", isGuest: true }, "edit", plain, false),
		).toBe("apply");
		expect(
			decide({ role: "suggester", isGuest: false }, "edit", plain, false),
		).toBe("propose");
		expect(
			decide({ role: "suggester", isGuest: true }, "edit", plain, false),
		).toBe("propose");
		expect(
			decide({ role: "viewer", isGuest: false }, "edit", plain, false),
		).toBe("forbid");
		expect(
			decide({ role: "viewer", isGuest: true }, "edit", plain, false),
		).toBe("forbid");
	});

	it("the suggest-mode header only downgrades edit → propose", () => {
		expect(decide({ role: "owner", isGuest: false }, "edit", plain, true)).toBe(
			"propose",
		);
		expect(
			decide({ role: "viewer", isGuest: false }, "edit", plain, true),
		).toBe("forbid");
	});

	it("directIf lets a suggester apply their own changes; proposeOnly always proposes", () => {
		expect(
			decide({ role: "suggester", isGuest: false }, "edit", direct, false),
		).toBe("apply-if-direct");
		expect(
			decide({ role: "editor", isGuest: false }, "edit", proposeOnly, false),
		).toBe("propose");
		expect(
			decide({ role: "viewer", isGuest: false }, "edit", direct, false),
		).toBe("forbid");
	});

	it("a rater applies only a directCap case (their own rating), never proposes (PLACES §1c)", () => {
		const rater = { role: "rater" as const, isGuest: false };
		const rating = { directIf: () => true, directCap: "rate" as const };
		// Their own rating: apply when directIf holds, else FORBIDDEN (never a proposal).
		expect(decide(rater, "edit", rating, false)).toBe("direct-only");
		expect(decide(rater, "edit", rating, true)).toBe("direct-only");
		// Everything else they try is forbidden.
		expect(decide(rater, "edit", plain, false)).toBe("forbid");
		expect(decide(rater, "edit", direct, false)).toBe("forbid");
		expect(decide(rater, "editTripDates", plain, false)).toBe("forbid");
		expect(decide(rater, "edit", { ...rating, proposeOnly: true }, false)).toBe(
			"forbid",
		);
		// A link guest on a "Can rate" link has no member row: nothing to rate as.
		expect(
			decide({ role: "rater", isGuest: true }, "edit", rating, false),
		).toBe("forbid");
	});

	it("a viewer can no longer rate; suggesters and editors rate as before", () => {
		const rating = { directIf: () => true, directCap: "rate" as const };
		expect(
			decide({ role: "viewer", isGuest: false }, "edit", rating, false),
		).toBe("forbid");
		expect(
			decide({ role: "viewer", isGuest: true }, "edit", rating, false),
		).toBe("forbid");
		expect(
			decide({ role: "suggester", isGuest: false }, "edit", rating, false),
		).toBe("apply-if-direct");
		expect(
			decide({ role: "editor", isGuest: false }, "edit", rating, false),
		).toBe("apply");
		expect(
			decide({ role: "editor", isGuest: false }, "edit", rating, true),
		).toBe("apply-if-direct");
	});

	it("setNodePriority's def rates your own member only, with `rate` for non-proposers", async () => {
		const def = await REGISTRY["node.priority"].load();
		expect(REGISTRY["node.priority"].capability).toBe("edit");
		expect(def.directCap).toBe("rate");
		const access = {
			tripId: "t",
			slug: "t",
			role: "rater" as const,
			memberId: "me",
			isGuest: false,
			color: 0,
		};
		const input = { nodeId: "n", memberId: "me", priority: "must" };
		const tx = null as never;
		expect(await def.directIf?.(input as never, access, tx)).toBe(true);
		expect(
			await def.directIf?.(
				{ ...input, memberId: "audrey" } as never,
				access,
				tx,
			),
		).toBe(false);
		expect(
			await def.directIf?.(input as never, { ...access, memberId: null }, tx),
		).toBe(false);
		expect(MUTATION_POLICY.setNodePriority).toBe("proposable");
	});

	it("trip dates need editTripDates", () => {
		expect(
			decide({ role: "editor", isGuest: false }, "editTripDates", plain, false),
		).toBe("apply");
		expect(
			decide(
				{ role: "suggester", isGuest: false },
				"editTripDates",
				plain,
				false,
			),
		).toBe("propose");
	});
});
