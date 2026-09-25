/**
 * Rating comments (ADDENDUM §10): you edit your own; Cancel and Escape never
 * save; Save sends the trimmed comment (or null to clear) through
 * `setNodePriority`; other members' comments are read-only, except a
 * placeholder's, which editors may write on their behalf.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph, N } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { PLACES_TESTID } from "../testids";
import { MemberRatings, mayRate } from "../ui/member-ratings";

const calls = vi.hoisted(() => ({ setNodePriority: [] as unknown[] }));
vi.mock("@/functions/nodes.functions", () => ({
	setNodePriority: async (opts: { data: unknown }) => {
		calls.setNodePriority.push(opts.data);
		return { ok: true };
	},
	updateNode: async () => ({ ok: true }),
	createNodePath: async () => ({ ok: true }),
	moveNode: async () => ({ ok: true }),
}));

// WP-Lists' MentionInput is a TipTap field (contenteditable), which
// happy-dom can't type into with `fireEvent.change`; these tests are about
// the rating logic, so a plain textarea stands in for it.
vi.mock("@/features/notes/MentionInput", () => ({
	MentionInput: (p: {
		value: string;
		onChange: (v: string) => void;
		placeholder?: string;
		ariaLabel?: string;
	}) => (
		<textarea
			aria-label={p.ariaLabel}
			placeholder={p.placeholder}
			value={p.value}
			onChange={(e) => p.onChange(e.target.value)}
		/>
	),
}));

const D = DEMO_MEMBERS.dennis;
const A = DEMO_MEMBERS.audrey;

const graph: TripGraph = {
	...demoGraph,
	nodes: demoGraph.nodes.map((n) =>
		n.id === N.itoya
			? {
					...n,
					priorities: { [D]: "really_want", [A]: "must" },
					ratingComments: { [A]: "Pens for Mom" },
				}
			: n,
	),
};
const itoya = graph.nodes.find((n) => n.id === N.itoya);

function rowOf(memberId: string) {
	return screen
		.getAllByTestId(PLACES_TESTID.priorityRow)
		.find((r) => r.getAttribute("data-member") === memberId) as HTMLElement;
}

beforeEach(() => {
	calls.setNodePriority.length = 0;
});

describe("rating comments", () => {
	it("Cancel closes the editor without saving", async () => {
		renderWithWorkspace(<MemberRatings node={itoya as never} />, { graph });
		fireEvent.click(within(rowOf(D)).getByText("Add a comment"));
		const editor = within(rowOf(D)).getByTestId(PLACES_TESTID.ratingComment);
		const field = await within(editor).findByRole("textbox");
		fireEvent.change(field, { target: { value: "only after Nishiki" } });
		fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
		expect(
			within(rowOf(D)).queryByTestId(PLACES_TESTID.ratingComment),
		).toBeNull();
		expect(calls.setNodePriority).toEqual([]);
	});

	it("Save sends your trimmed comment with your rating", async () => {
		renderWithWorkspace(<MemberRatings node={itoya as never} />, { graph });
		fireEvent.click(within(rowOf(D)).getByText("Add a comment"));
		const editor = within(rowOf(D)).getByTestId(PLACES_TESTID.ratingComment);
		fireEvent.change(await within(editor).findByRole("textbox"), {
			target: { value: "  only after Nishiki  " },
		});
		fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
		await vi.waitFor(() =>
			expect(calls.setNodePriority).toEqual([
				{
					nodeId: N.itoya,
					memberId: D,
					priority: "really_want",
					comment: "only after Nishiki",
				},
			]),
		);
	});

	it("over 280 characters can't be saved", async () => {
		renderWithWorkspace(<MemberRatings node={itoya as never} />, { graph });
		fireEvent.click(within(rowOf(D)).getByText("Add a comment"));
		const editor = within(rowOf(D)).getByTestId(PLACES_TESTID.ratingComment);
		fireEvent.change(await within(editor).findByRole("textbox"), {
			target: { value: "x".repeat(281) },
		});
		expect(within(editor).getByRole("button", { name: "Save" })).toBeDisabled();
		expect(editor).toHaveTextContent("281/280");
	});

	it("the counter counts what you see, not the mention markup (PLAN-R2-07)", async () => {
		renderWithWorkspace(<MemberRatings node={itoya as never} />, { graph });
		fireEvent.click(within(rowOf(D)).getByText("Add a comment"));
		const editor = within(rowOf(D)).getByTestId(PLACES_TESTID.ratingComment);
		const field = await within(editor).findByRole("textbox");
		const count = () =>
			within(editor).getByTestId(PLACES_TESTID.ratingCommentCount);
		// "ask @Audrey Tester" is 18 characters on screen, 66 stored.
		const md = `ask [@Audrey Tester](mention:${A})`;
		expect(md).toHaveLength(66);
		fireEvent.change(field, { target: { value: md } });
		expect(count()).toHaveTextContent("18/280");
		// 'ask @Kenji' (a new person): 10, not 59.
		fireEvent.change(field, {
			target: { value: `ask [@Kenji](mention:${D})` },
		});
		expect(count()).toHaveTextContent("10/280");
		// Escaped brackets in a label count once.
		fireEvent.change(field, {
			target: { value: `[@A \\[b\\] c](mention:${D})` },
		});
		expect(count()).toHaveTextContent("8/280");
		// Two mentions and 150 more characters: 172 shown (268 stored), savable.
		const two = `${"x".repeat(150)} [@Audrey Tester](mention:${A}) [@Kenji](mention:${D})`;
		expect(two).toHaveLength(268);
		fireEvent.change(field, { target: { value: two } });
		expect(count()).toHaveTextContent("172/280");
		expect(within(editor).queryByRole("alert")).toBeNull();
		fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
		await vi.waitFor(() =>
			expect(calls.setNodePriority).toEqual([
				expect.objectContaining({ comment: two }),
			]),
		);
	});

	it("many mentions: only what you see counts, up to 280 (PLAN-R3-03)", async () => {
		renderWithWorkspace(<MemberRatings node={itoya as never} />, { graph });
		fireEvent.click(within(rowOf(D)).getByText("Add a comment"));
		const editor = within(rowOf(D)).getByTestId(PLACES_TESTID.ratingComment);
		const field = await within(editor).findByRole("textbox");
		const count = () =>
			within(editor).getByTestId(PLACES_TESTID.ratingCommentCount);
		const save = () => within(editor).getByRole("button", { name: "Save" });
		// The QA repro: 200 characters, "ask @Audrey Tester and @Kenji": 230
		// shown, 326 stored. It used to be refused ("Mentions take extra room").
		const md = `${"x".repeat(200)} ask [@Audrey Tester](mention:${A}) and [@Kenji](mention:${D})`;
		expect(md.length).toBeGreaterThan(280);
		fireEvent.change(field, { target: { value: md } });
		expect(count()).toHaveTextContent("230/280");
		expect(within(editor).queryByRole("alert")).toBeNull();
		expect(save()).toBeEnabled();
		// Exactly 280 shown with six mentions (well over 280 stored) still saves.
		const six = Array.from(
			{ length: 6 },
			() => `[@Audrey Tester](mention:${A}) `,
		).join("");
		const full = `${six}${"y".repeat(280 - 6 * 15)}`;
		fireEvent.change(field, { target: { value: full } });
		expect(count()).toHaveTextContent("280/280");
		expect(save()).toBeEnabled();
		// One more character you can see is one too many.
		fireEvent.change(field, { target: { value: `${full}y` } });
		expect(count()).toHaveTextContent("281/280");
		expect(save()).toBeDisabled();
		fireEvent.change(field, { target: { value: full } });
		fireEvent.click(save());
		await vi.waitFor(() =>
			expect(calls.setNodePriority).toEqual([
				expect.objectContaining({ comment: full }),
			]),
		);
	});

	it("a placeholder's comment is shown to everyone and editable by editors", () => {
		renderWithWorkspace(<MemberRatings node={itoya as never} />, { graph });
		expect(rowOf(A)).toHaveTextContent("Pens for Mom");
		const audrey = graph.members.find((m) => m.id === A);
		if (!audrey) throw new Error("fixture: Audrey");
		expect(audrey.status).toBe("placeholder");
		const editor = { memberId: D, role: "editor" as const, isGuest: false };
		expect(mayRate(editor, audrey)).toBe(true);
		// Another account's rating is theirs alone; guests rate nothing.
		expect(mayRate(editor, { ...audrey, status: "active" })).toBe(false);
		expect(
			mayRate({ memberId: null, role: "viewer", isGuest: true }, audrey),
		).toBe(false);
		// The placeholder's comment has an edit button for an editor.
		expect(
			within(rowOf(A)).getByRole("button", { name: "Edit Audrey's comment" }),
		).toBeInTheDocument();
	});
});
