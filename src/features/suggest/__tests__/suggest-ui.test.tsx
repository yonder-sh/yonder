/**
 * The suggestion UI on the demo fixture and `scenario.proposals`: who sees
 * what (editor, suggester, viewer), the drawer's groups and filters, the
 * inspector bar with stacked alternatives, the overview's before → after,
 * the ghost's ✓/✕ and note additions. Server functions are mocked.
 */
import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { demo, N, scenario } from "@/lib/fixtures/demo";
import type { ProposalDto } from "@/lib/schemas/proposals";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { describeProposal } from "../describe-proposal";
import { GhostActions } from "../GhostActions";
import { NoteSuggestions } from "../NoteSuggestions";
import { ProposalBar } from "../ProposalBar";
import { ProposalOverview } from "../ProposalOverview";
import { ReviewDrawer } from "../ReviewDrawer";
import { useReviewStore } from "../review-store";
import { SuggestModeControl, SuggestModeMenuItem } from "../SuggestModeControl";
import { SUGGEST_TESTID } from "../testids";
import { baseIndexOf } from "../use-base-index";
import { graphAs, MAYA_USER, renderSuggest } from "./harness";

const fns = vi.hoisted(() => ({
	resolveProposal: vi.fn(),
	resolveProposals: vi.fn(),
	withdrawProposal: vi.fn(),
	proposeNoteAppend: vi.fn(),
}));
vi.mock("@/functions/proposals.functions", () => ({
	resolveProposal: fns.resolveProposal,
	resolveProposals: fns.resolveProposals,
	withdrawProposal: fns.withdrawProposal,
}));
vi.mock("../suggest.functions", () => ({
	proposeNoteAppend: fns.proposeNoteAppend,
}));

const P = scenario.proposals;
const itoyaMove = P.find((p) => p.op === "item.move") as ProposalDto;
const mine = (p: ProposalDto): ProposalDto => ({
	...p,
	author: { ...p.author, userId: MAYA_USER, name: "Maya" },
});

beforeEach(() => {
	for (const f of Object.values(fns)) f.mockReset();
	useReviewStore.getState().reset();
	useUi.getState().setReviewOpen(false);
	useUi.setState({ suggesting: false });
	try {
		localStorage.clear();
	} catch {
		// no storage in this environment
	}
});
afterEach(() => {
	document.documentElement.removeAttribute("data-yonder-suggesting");
});

describe("SuggestModeControl", () => {
	it("editors: 'Editing ▾' plus the open count, which opens the review", () => {
		renderSuggest(<SuggestModeControl />);
		const ctl = screen.getByTestId(TESTID.suggestModeControl);
		expect(ctl).toHaveAttribute("data-mode", "edit");
		expect(ctl).toHaveTextContent("Editing");
		expect(ctl).toHaveTextContent("7");
		fireEvent.click(
			screen.getByRole("button", { name: "Review 7 suggestions" }),
		);
		expect(useUi.getState().reviewOpen).toBe(true);
	});

	it("hidden when nothing is suggested and the mode is edit; shown while suggesting", () => {
		const { unmount } = renderSuggest(<SuggestModeControl />, {
			proposals: [],
		});
		expect(screen.queryByTestId(TESTID.suggestModeControl)).toBeNull();
		unmount();
		act(() => useUi.setState({ suggesting: true }));
		renderSuggest(<SuggestModeControl />, { proposals: [] });
		const ctl = screen.getByTestId(TESTID.suggestModeControl);
		expect(ctl).toHaveAttribute("data-mode", "suggest");
		expect(ctl).toHaveTextContent("Suggesting");
		// Suggest-mode chrome: the attribute the center-panel rule keys on.
		expect(document.documentElement).toHaveAttribute("data-yonder-suggesting");
		act(() => useUi.setState({ suggesting: false }));
	});

	it("suggesters: a static pill naming the reviewers", () => {
		renderSuggest(<SuggestModeControl />, { graph: graphAs("suggester") });
		const pill = screen.getByTestId(TESTID.suggestModeControl);
		expect(pill).toHaveTextContent("Suggesting");
		expect(pill).toHaveTextContent("7");
		expect(pill.getAttribute("aria-label")).toContain(
			"Your changes go to Dennis for review.",
		);
		fireEvent.click(pill);
		expect(useUi.getState().reviewOpen).toBe(true);
	});

	it("viewers never see it", () => {
		renderSuggest(<SuggestModeControl />, { graph: graphAs("viewer") });
		expect(screen.queryByTestId(TESTID.suggestModeControl)).toBeNull();
	});
});

describe("SuggestModeMenuItem (the trip menu's way into suggest mode)", () => {
	const Menu = () => (
		<DropdownMenu defaultOpen>
			<DropdownMenuTrigger>Trip</DropdownMenuTrigger>
			<DropdownMenuContent>
				<SuggestModeMenuItem />
			</DropdownMenuContent>
		</DropdownMenu>
	);
	const menu = <Menu />;

	it("editors switch into Suggesting and back, with nothing suggested yet", async () => {
		const { rerender } = renderSuggest(menu, { proposals: [] });
		const item = await screen.findByTestId(SUGGEST_TESTID.modeMenuItem);
		expect(item).toHaveTextContent("Suggest changes instead");
		fireEvent.click(item);
		expect(useUi.getState().suggesting).toBe(true);
		rerender(<Menu key="again" />); // the menu opens again
		const back = await screen.findByTestId(SUGGEST_TESTID.modeMenuItem);
		expect(back).toHaveTextContent("Back to editing");
		fireEvent.click(back);
		expect(useUi.getState().suggesting).toBe(false);
	});

	it("suggesters and viewers don't get it", async () => {
		const { unmount } = renderSuggest(menu, { graph: graphAs("suggester") });
		await screen.findByText("Trip");
		expect(screen.queryByTestId(SUGGEST_TESTID.modeMenuItem)).toBeNull();
		unmount();
		renderSuggest(menu, { graph: graphAs("viewer") });
		expect(screen.queryByTestId(SUGGEST_TESTID.modeMenuItem)).toBeNull();
	});
});

describe("ReviewDrawer", () => {
	const open = () => act(() => useUi.getState().setReviewOpen(true));

	it("groups open suggestions by author batch; reviewers accept a row", async () => {
		fns.resolveProposal.mockResolvedValue({ ok: true, status: "accepted" });
		renderSuggest(<ReviewDrawer />);
		open();
		const drawer = await screen.findByTestId(TESTID.reviewDrawer);
		const groups = within(drawer).getAllByTestId(SUGGEST_TESTID.group);
		expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
			"Maya's suggestions",
			"Guest Wren's suggestions",
			"Audrey's suggestions",
		]);
		const row = within(drawer)
			.getAllByTestId(SUGGEST_TESTID.row)
			.find((r) => r.getAttribute("data-proposal-id") === itoyaMove.id);
		expect(row).toHaveTextContent("Move Itoya Ginza to Day 1");
		expect(row).toHaveTextContent("Japan›Tokyo·Day 2 · Mon 4 Oct");
		fireEvent.click(
			within(row as HTMLElement).getByTestId(SUGGEST_TESTID.accept),
		);
		await waitFor(() =>
			expect(fns.resolveProposal).toHaveBeenCalledWith({
				data: { proposalId: itoyaMove.id, decision: "accept" },
			}),
		);
	});

	it("a 'changed' conflict expands the row with Accept anyway", async () => {
		fns.resolveProposal.mockResolvedValueOnce({
			ok: false,
			conflict: {
				reason: "changed",
				fields: ["dayId"],
				message: "Itoya Ginza was moved to Day 5 since",
			},
		});
		fns.resolveProposal.mockResolvedValueOnce({ ok: true, status: "accepted" });
		renderSuggest(<ReviewDrawer />);
		open();
		const drawer = await screen.findByTestId(TESTID.reviewDrawer);
		const row = () =>
			within(drawer)
				.getAllByTestId(SUGGEST_TESTID.row)
				.find(
					(r) => r.getAttribute("data-proposal-id") === itoyaMove.id,
				) as HTMLElement;
		fireEvent.click(within(row()).getByTestId(SUGGEST_TESTID.accept));
		const note = await within(row()).findByTestId(SUGGEST_TESTID.conflict);
		expect(note).toHaveTextContent("Itoya Ginza was moved to Day 5 since.");
		fireEvent.click(within(row()).getByTestId(SUGGEST_TESTID.acceptAnyway));
		await waitFor(() =>
			expect(fns.resolveProposal).toHaveBeenLastCalledWith({
				data: { proposalId: itoyaMove.id, decision: "accept", force: true },
			}),
		);
		// The Conflicts filter counted it while it was open.
	});

	it("reject sends the optional note", async () => {
		fns.resolveProposal.mockResolvedValue({ ok: true, status: "rejected" });
		renderSuggest(<ReviewDrawer />);
		open();
		const drawer = await screen.findByTestId(TESTID.reviewDrawer);
		const row = within(drawer)
			.getAllByTestId(SUGGEST_TESTID.row)
			.find(
				(r) => r.getAttribute("data-proposal-id") === itoyaMove.id,
			) as HTMLElement;
		fireEvent.click(within(row).getByTestId(SUGGEST_TESTID.reject));
		const note = await screen.findByTestId(SUGGEST_TESTID.rejectNote);
		fireEvent.change(note, { target: { value: "too far that day" } });
		fireEvent.click(screen.getByTestId(SUGGEST_TESTID.rejectConfirm));
		await waitFor(() =>
			expect(fns.resolveProposal).toHaveBeenCalledWith({
				data: {
					proposalId: itoyaMove.id,
					decision: "reject",
					note: "too far that day",
				},
			}),
		);
	});

	it("Mine lists the author's own, closed ones with status and note; they withdraw, not accept", async () => {
		fns.withdrawProposal.mockResolvedValue({ ok: true });
		const rejected: ProposalDto = {
			...mine(P[2] as ProposalDto),
			id: "00000000-0000-7000-8000-00000000c10d",
			status: "rejected",
			reviewedBy: "user-dennis",
			reviewedAt: "2026-09-22T12:00:00.000Z",
			reviewNote: "too far that day",
		};
		renderSuggest(<ReviewDrawer />, {
			graph: graphAs("suggester"),
			proposals: [
				mine(itoyaMove),
				rejected,
				...P.filter((p) => p.author.userId !== MAYA_USER),
			],
		});
		act(() => useReviewStore.getState().setFilter("mine"));
		open();
		const drawer = await screen.findByTestId(TESTID.reviewDrawer);
		const rows = within(drawer).getAllByTestId(SUGGEST_TESTID.row);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toHaveAttribute("data-status", "open");
		expect(
			within(rows[1] as HTMLElement).getByTestId(SUGGEST_TESTID.status),
		).toHaveTextContent("Rejected by Dennis");
		expect(rows[1]).toHaveTextContent("“too far that day”");
		expect(within(drawer).queryByTestId(SUGGEST_TESTID.accept)).toBeNull();
		fireEvent.click(
			within(rows[0] as HTMLElement).getByTestId(SUGGEST_TESTID.withdraw),
		);
		await waitFor(() =>
			expect(fns.withdrawProposal).toHaveBeenCalledWith({
				data: { proposalId: itoyaMove.id },
			}),
		);
	});

	it("Show selects the thing and closes the drawer", async () => {
		const { ws } = renderSuggest(<ReviewDrawer />);
		open();
		const drawer = await screen.findByTestId(TESTID.reviewDrawer);
		const row = within(drawer)
			.getAllByTestId(SUGGEST_TESTID.row)
			.find(
				(r) => r.getAttribute("data-proposal-id") === itoyaMove.id,
			) as HTMLElement;
		fireEvent.click(within(row).getByTestId(SUGGEST_TESTID.show));
		expect(ws().sel).toEqual({ kind: "item", id: demo.I.itoya });
		expect(useUi.getState().reviewOpen).toBe(false);
	});

	it("an editor's own suggestion: Withdraw and Accept, never Reject", async () => {
		const own: ProposalDto = {
			...itoyaMove,
			author: { ...itoyaMove.author, userId: "user-dennis", name: "Dennis" },
		};
		renderSuggest(<ReviewDrawer />, { proposals: [own] });
		open();
		const drawer = await screen.findByTestId(TESTID.reviewDrawer);
		const row = within(drawer).getByTestId(SUGGEST_TESTID.row);
		expect(
			within(row).getByTestId(SUGGEST_TESTID.withdraw),
		).toBeInTheDocument();
		expect(within(row).getByTestId(SUGGEST_TESTID.accept)).toBeInTheDocument();
		expect(within(row).queryByTestId(SUGGEST_TESTID.reject)).toBeNull();
	});

	it("a trip-wide suggestion offers its details instead of Show", async () => {
		const { ws } = renderSuggest(<ReviewDrawer />);
		open();
		const drawer = await screen.findByTestId(TESTID.reviewDrawer);
		const shift = P.find((p) => p.op === "trip.shift") as ProposalDto;
		const row = within(drawer)
			.getAllByTestId(SUGGEST_TESTID.row)
			.find(
				(r) => r.getAttribute("data-proposal-id") === shift.id,
			) as HTMLElement;
		const details = within(row).getByTestId(SUGGEST_TESTID.show);
		expect(details).toHaveTextContent("Details");
		fireEvent.click(details);
		expect(ws().sel).toEqual({ kind: "proposal", id: shift.id });
	});

	it("a conflicted row keeps Show beside Reject / Accept anyway", async () => {
		const conflicted: ProposalDto = {
			...itoyaMove,
			lastError: {
				reason: "changed",
				fields: ["dayId"],
				message: "Audrey's suggestion for this was accepted.",
			},
		};
		renderSuggest(<ReviewDrawer />, { proposals: [conflicted] });
		act(() => useReviewStore.getState().setFilter("conflicts"));
		open();
		const drawer = await screen.findByTestId(TESTID.reviewDrawer);
		const note = within(drawer).getByTestId(SUGGEST_TESTID.conflict);
		expect(note).toHaveTextContent(
			"Audrey's suggestion for this was accepted.",
		);
		expect(within(note).getByTestId(SUGGEST_TESTID.show)).toBeInTheDocument();
		expect(within(note).getByTestId(SUGGEST_TESTID.reject)).toBeInTheDocument();
		expect(
			within(note).getByTestId(SUGGEST_TESTID.acceptAnyway),
		).toBeInTheDocument();
	});

	it("empty filters use the one-line empty state", async () => {
		renderSuggest(<ReviewDrawer />);
		act(() => useReviewStore.getState().setFilter("conflicts"));
		open();
		expect(await screen.findByText("No conflicts.")).toBeInTheDocument();
	});
});

describe("ProposalBar", () => {
	it("names the suggestion on the selected thing, with Accept and Reject for reviewers", () => {
		renderSuggest(
			<ProposalBar sel={{ kind: "item", id: demo.I.itoya ?? "" }} />,
		);
		const bar = screen.getByTestId(TESTID.proposalBar);
		expect(bar).toHaveTextContent("Suggested by Maya · Move to Day 1");
		expect(within(bar).getByTestId(SUGGEST_TESTID.accept)).toBeInTheDocument();
		expect(within(bar).getByTestId(SUGGEST_TESTID.reject)).toBeInTheDocument();
	});

	it("lists stacked alternatives, each with Accept", () => {
		renderSuggest(
			<ProposalBar sel={{ kind: "item", id: demo.I.knives ?? "" }} />,
		);
		const alts = screen.getAllByTestId(SUGGEST_TESTID.barAlternative);
		expect(alts.map((a) => a.textContent)).toEqual([
			expect.stringContaining("Maya: Move to Day 4"),
			expect.stringContaining("Audrey: Move to Day 1"),
		]);
		for (const a of alts)
			expect(within(a).getByTestId(SUGGEST_TESTID.accept)).toBeInTheDocument();
	});

	it("trip-level suggestions show on the root; nothing for unmarked things or viewers", () => {
		const { unmount } = renderSuggest(<ProposalBar sel={{ kind: "root" }} />);
		expect(screen.getByTestId(TESTID.proposalBar)).toHaveTextContent(
			"Shift the trip +1 day",
		);
		unmount();
		const r2 = renderSuggest(
			<ProposalBar sel={{ kind: "item", id: demo.I.hands ?? "" }} />,
		);
		expect(screen.queryByTestId(TESTID.proposalBar)).toBeNull();
		r2.unmount();
		renderSuggest(
			<ProposalBar sel={{ kind: "item", id: demo.I.itoya ?? "" }} />,
			{
				graph: graphAs("viewer"),
			},
		);
		expect(screen.queryByTestId(TESTID.proposalBar)).toBeNull();
	});

	it("on a phone the change itself is never truncated away (COLLAB-R2-12)", () => {
		const knives = demo.I.knives ?? "";
		const update: ProposalDto = {
			...itoyaMove,
			id: "00000000-0000-7000-8000-00000000b001",
			op: "item.update",
			entityId: knives,
			summary: "changed Kama-asa (knives)",
			fields: ["durationMin"],
			before: { durationMin: 90 },
			payload: { itemId: knives, patch: { durationMin: 150 } },
		};
		renderSuggest(<ProposalBar sel={{ kind: "item", id: knives }} />, {
			proposals: [update],
		});
		const bar = screen.getByTestId(TESTID.proposalBar);
		const text = within(bar).getByTestId(SUGGEST_TESTID.barText);
		expect(text).toHaveTextContent("Suggested by Maya · Change to 2h 30m");
		// Wraps (text first, the actions below it) instead of clipping with "…".
		expect(text.className).not.toMatch(/\btruncate\b/);
		expect(text.parentElement?.parentElement?.className).toMatch(
			/\bflex-wrap\b/,
		);
		expect(within(bar).getByTestId(SUGGEST_TESTID.reject)).toBeInTheDocument();
		expect(within(bar).getByTestId(SUGGEST_TESTID.accept)).toBeInTheDocument();
	});

	it("a suggester sees it without review actions; the author can withdraw", () => {
		renderSuggest(
			<ProposalBar sel={{ kind: "item", id: demo.I.itoya ?? "" }} />,
			{
				graph: graphAs("suggester"),
				proposals: [mine(itoyaMove)],
			},
		);
		const bar = screen.getByTestId(TESTID.proposalBar);
		expect(within(bar).queryByTestId(SUGGEST_TESTID.accept)).toBeNull();
		expect(
			within(bar).getByTestId(SUGGEST_TESTID.withdraw),
		).toBeInTheDocument();
	});
});

describe("describing against the server graph", () => {
	it("an overlay that already shows the move doesn't turn it into a reorder", () => {
		// While suggestions are shown, `ws.ix` has Itoya on Day 1 already.
		const { ws } = renderSuggest(<span />);
		expect(ws().ix.item(demo.I.itoya)?.dayId).toBe(demo.D.d1);
		expect(ws().graph.items.find((i) => i.id === demo.I.itoya)?.dayId).toBe(
			demo.D.d2,
		);
		// Even given the overlay index, the snapshot (`before`) keeps it a move.
		expect(
			describeProposal(
				{ ...itoyaMove, before: { dayId: demo.D.d2 ?? null } },
				ws().ix,
			),
		).toBe("Move Itoya Ginza to Day 1");
		expect(describeProposal(itoyaMove, baseIndexOf(ws().graph, ws().ix))).toBe(
			"Move Itoya Ginza to Day 1",
		);
	});
});

describe("ProposalOverview", () => {
	it("shows before → after and the actions", () => {
		renderSuggest(<ProposalOverview proposalId={itoyaMove.id} />);
		const view = screen.getByTestId(TESTID.proposalOverview);
		expect(view).toHaveTextContent("Move Itoya Ginza to Day 1");
		const row = within(view).getByTestId(SUGGEST_TESTID.fieldRow);
		expect(row).toHaveAttribute("data-field", "dayId");
		expect(view).toHaveTextContent("Day 2 · Mon 4 Oct");
		expect(view).toHaveTextContent("Day 1 · Sun 3 Oct");
		expect(within(view).getByTestId(SUGGEST_TESTID.accept)).toBeInTheDocument();
	});

	it("a trip shift lists what moves", () => {
		const shift = P.find((p) => p.op === "trip.shift") as ProposalDto;
		renderSuggest(<ProposalOverview proposalId={shift.id} />);
		expect(screen.getByTestId(TESTID.dateImpactList)).toBeInTheDocument();
		expect(screen.getByText("Mon 4 Oct 2027")).toBeInTheDocument();
	});

	it("hours and flight suggestions read before → after, not '— → —' (COLLAB-R2-07)", () => {
		const hours: ProposalDto = {
			...itoyaMove,
			id: "00000000-0000-7000-8000-00000000b002",
			op: "node.hours",
			entityKind: "node",
			entityId: N.itoya ?? null,
			summary: "updated hours of Itoya Ginza",
			fields: ["details.openingHours"],
			before: { "details.openingHours": null },
			payload: {
				nodeId: N.itoya ?? "",
				hours: {
					source: "manual",
					periods: [1, 2, 3, 4, 5, 6].map((day) => ({
						day,
						open: "19:00",
						close: "02:00",
					})),
					closedDays: [0],
					exceptions: [
						{ date: "2027-10-05", closed: true, label: "Private event" },
					],
					updatedAt: "2026-09-23T09:00:00.000Z",
				},
			},
		};
		renderSuggest(<ProposalOverview proposalId={hours.id} />, {
			proposals: [hours],
		});
		const view = screen.getByTestId(TESTID.proposalOverview);
		const rows = within(view).getAllByTestId(SUGGEST_TESTID.fieldRow);
		expect(rows.map((r) => r.textContent)).toEqual([
			"Opening hoursNo hoursMon–Sat 19:00–02:00 · Closed Sun",
			"Special datesNoneTue 5 Oct closed (Private event)",
		]);
		expect(view).not.toHaveTextContent("OpeningHours");
		expect(view).not.toHaveTextContent("— —");
	});

	it("a vanished suggestion says so", () => {
		renderSuggest(
			<ProposalOverview proposalId="00000000-0000-7000-8000-0000000000ff" />,
		);
		expect(screen.getByText("This suggestion is gone.")).toBeInTheDocument();
	});
});

describe("GhostActions", () => {
	it("reviewers get ✓/✕ that resolve directly", async () => {
		fns.resolveProposal.mockResolvedValue({ ok: true, status: "rejected" });
		renderSuggest(<GhostActions proposalId={itoyaMove.id} />);
		fireEvent.click(screen.getByTestId(SUGGEST_TESTID.ghostReject));
		await waitFor(() =>
			expect(fns.resolveProposal).toHaveBeenCalledWith({
				data: { proposalId: itoyaMove.id, decision: "reject" },
			}),
		);
		expect(screen.getByTestId(SUGGEST_TESTID.ghostAccept)).toHaveAccessibleName(
			"Accept: Move Itoya Ginza to Day 1",
		);
	});

	it("nothing for suggesters or offline-disabled when offline", () => {
		const { unmount } = renderSuggest(
			<GhostActions proposalId={itoyaMove.id} />,
			{
				graph: graphAs("suggester"),
			},
		);
		expect(screen.queryByTestId(SUGGEST_TESTID.ghostAccept)).toBeNull();
		unmount();
		renderSuggest(<GhostActions proposalId={itoyaMove.id} />, {
			connection: "offline",
		});
		expect(screen.getByTestId(SUGGEST_TESTID.ghostAccept)).toBeDisabled();
	});
});

describe("NoteSuggestions", () => {
	const target = { kind: "node", nodeId: N.shibuyaSky ?? "" } as const;
	const addition: ProposalDto = {
		...(P[0] as ProposalDto),
		id: "00000000-0000-7000-8000-00000000a0a0",
		op: "note.append",
		entityKind: "note",
		entityId: N.shibuyaSky ?? null,
		createdIds: [],
		summary: "suggested an addition to the notes",
		payload: {
			tripId: scenario.proposals[0]?.tripId ?? "",
			target,
			markdown:
				"**Sunset** slots sell out — book 4 weeks ahead\n\n<img src=x onerror=alert(1)>",
		},
	};

	it("suggesters in suggest mode get 'Suggest an addition' and send Markdown", async () => {
		fns.proposeNoteAppend.mockResolvedValue({
			proposed: { id: "p1", summary: "suggested an addition" },
		});
		renderSuggest(<NoteSuggestions target={target} editor={null} />, {
			graph: graphAs("suggester"),
			proposals: [],
		});
		fireEvent.click(screen.getByTestId(SUGGEST_TESTID.noteSuggestButton));
		fireEvent.change(screen.getByTestId(SUGGEST_TESTID.noteTextarea), {
			target: { value: "- go at *sunset*" },
		});
		fireEvent.click(screen.getByTestId(SUGGEST_TESTID.noteSend));
		await waitFor(() =>
			expect(fns.proposeNoteAppend).toHaveBeenCalledWith({
				data: {
					tripId: scenario.proposals[0]?.tripId,
					target,
					markdown: "- go at *sunset*",
				},
			}),
		);
	});

	it("reviewers see the addition as Markdown (never raw HTML) and insert it at the end", async () => {
		fns.resolveProposal.mockResolvedValue({ ok: true, status: "accepted" });
		const insertContentAt = vi.fn(() => true);
		const editor = {
			state: { doc: { content: { size: 42 } } },
			commands: { insertContentAt, undo: vi.fn() },
		};
		const { container } = renderSuggest(
			<NoteSuggestions target={target} editor={editor} />,
			{ proposals: [addition] },
		);
		const block = screen.getByTestId(SUGGEST_TESTID.noteBlock);
		expect(within(block).getByText("Sunset").tagName).toBe("STRONG");
		expect(container.querySelector("img")).toBeNull();
		fireEvent.click(screen.getByTestId(SUGGEST_TESTID.noteInsert));
		expect(insertContentAt).toHaveBeenCalledWith(
			42,
			addition.payload.markdown,
			{
				contentType: "markdown",
			},
		);
		await waitFor(() =>
			expect(fns.resolveProposal).toHaveBeenCalledWith({
				data: {
					proposalId: addition.id,
					decision: "accept",
					appliedClientSide: true,
				},
			}),
		);
	});

	it("an accept that fails undoes the insertion", async () => {
		fns.resolveProposal.mockResolvedValue({
			ok: false,
			conflict: { reason: "gone", message: "Shibuya Sky was deleted since" },
		});
		const undo = vi.fn();
		const editor = {
			state: { doc: { content: { size: 1 } } },
			commands: { insertContentAt: vi.fn(() => true), undo },
		};
		renderSuggest(<NoteSuggestions target={target} editor={editor} />, {
			proposals: [addition],
		});
		fireEvent.click(screen.getByTestId(SUGGEST_TESTID.noteInsert));
		await waitFor(() => expect(undo).toHaveBeenCalled());
	});

	it("other notes' additions and viewers show nothing", () => {
		const { unmount } = renderSuggest(
			<NoteSuggestions
				target={{ kind: "node", nodeId: N.tokyo ?? "" }}
				editor={null}
			/>,
			{ proposals: [addition] },
		);
		expect(screen.queryByTestId(TESTID.noteSuggestions)).toBeNull();
		unmount();
		renderSuggest(<NoteSuggestions target={target} editor={null} />, {
			graph: graphAs("viewer"),
			proposals: [addition],
		});
		expect(screen.queryByTestId(TESTID.noteSuggestions)).toBeNull();
	});
});
