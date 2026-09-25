/**
 * E7 the 36px strip above the inspector tabs for a selected marked entity
 * (EXTENSIONS §3.7): "Suggested by Maya · Move to Day 7 · Accept · Reject".
 * Stacked alternatives on the same thing are listed ("Maya: Day 7 · Audrey:
 * Day 5"), each with Accept; accepting one moves the rest to Conflicts (the
 * server does). The author sees Withdraw; other suggesters just see it.
 * Mounted by WP-Shell's InspectorBody; on touch it is how a tapped ghost is
 * reviewed (long-press is the drag gesture).
 */
import { type CSSProperties, useMemo } from "react";
import { MemberAvatar, presenceColor } from "@/components/common/member";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { MarkKey, ProposalMark } from "@/lib/engine/proposals";
import type { ProposalDto } from "@/lib/schemas/proposals";
import { TESTID } from "@/lib/testids";
import type { Sel } from "@/lib/workspace/search";
import { useProposalMarks } from "@/lib/workspace/use-proposals";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { describeProposal } from "./describe-proposal";
import {
	AcceptButton,
	ConflictNote,
	RejectButton,
	useConflictOf,
	WithdrawButton,
} from "./ProposalRow";
import { entityName, isMine } from "./proposal-view";
import { SUGGEST_TESTID } from "./testids";
import { useBaseIndex } from "./use-base-index";

/** The mark key of a selection (legs go through their row). */
export function markKeyOfSel(sel: Sel | null, ix: GraphIndex): MarkKey | null {
	if (!sel) return null;
	switch (sel.kind) {
		case "node":
			return `node:${sel.id}`;
		case "item":
			return `item:${sel.id}`;
		case "day":
			return `day:${sel.id}`;
		case "root":
			return "trip";
		case "leg": {
			const t = sel.target;
			const leg =
				t.kind === "pair"
					? ix.legByPair.get(`${t.fromItemId}>${t.toItemId}`)
					: ix.legByStay.get(`${t.dayId}:${t.end}`);
			return leg ? `leg:${leg.id}` : null;
		}
		default:
			return null;
	}
}

/** "Move Itoya Ginza to Day 7" → "Move to Day 7" (the inspector already names it). */
export function shortDescription(p: ProposalDto, ix: GraphIndex): string {
	const text = describeProposal(p, ix);
	const name = entityName(p, ix);
	if (!name || p.createdIds.length) return text;
	const cut = text
		.replace(` ${name}`, "")
		.replace(/\s{2,}/g, " ")
		.trim();
	return cut.length >= 4 ? cut : text;
}

type Entry = { m: ProposalMark; p: ProposalDto };

function Actions({ p }: { p: ProposalDto }) {
	const { access, graph } = useWorkspace();
	const mine = isMine(p, graph.me.userId);
	const conflict = useConflictOf(p);
	if (conflict) return null;
	return (
		<span className="ml-auto flex shrink-0 items-center gap-1">
			{mine ? <WithdrawButton p={p} /> : null}
			{access.canReview ? (
				<>
					{mine ? null : <RejectButton p={p} />}
					<AcceptButton p={p} from="inline" tone="solid" />
				</>
			) : null}
		</span>
	);
}

function Lead({ e }: { e: Entry }) {
	const ix = useBaseIndex();
	const conflict = useConflictOf(e.p);
	return (
		<div>
			{/*
			 * Never truncate what the suggestion changes (COLLAB-R2-12): the text
			 * keeps its full width and the actions wrap below it when both don't
			 * fit (a phone), and a long description wraps instead of clipping.
			 */}
			<div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
				<div className="flex min-w-0 flex-auto items-start gap-2">
					<MemberAvatar
						size={16}
						className="mt-px shrink-0"
						user={{
							name: e.p.author.name,
							color: e.p.author.color,
							memberId: e.p.author.memberId,
							guest: e.p.author.isGuest,
						}}
					/>
					<p
						data-testid={SUGGEST_TESTID.barText}
						className="min-w-0 text-[13px] leading-[18px] text-pretty break-words"
					>
						<span className="text-muted-foreground">Suggested by </span>
						<span className="font-medium">{e.p.author.name}</span>
						<span aria-hidden className="text-muted-foreground">
							{" "}
							·{" "}
						</span>
						<span>{shortDescription(e.p, ix)}</span>
					</p>
				</div>
				<Actions p={e.p} />
			</div>
			{e.p.message ? (
				<p className="-mt-1 mb-1.5 pl-6 text-xs text-muted-foreground italic">
					“{e.p.message}”
				</p>
			) : null}
			{conflict ? (
				<div className="pb-2">
					<ConflictNote p={e.p} conflict={conflict} />
				</div>
			) : null}
		</div>
	);
}

function Alternatives({ entries }: { entries: Entry[] }) {
	const ix = useBaseIndex();
	return (
		<div className="py-1.5">
			<p className="text-xs text-muted-foreground">
				{entries.length} suggestions for the same change
			</p>
			<ul className="mt-1 grid gap-0.5">
				{entries.map((e) => (
					<li
						key={e.p.id}
						data-testid={SUGGEST_TESTID.barAlternative}
						data-proposal-id={e.p.id}
						className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1"
					>
						<div className="flex min-w-0 flex-auto items-start gap-2">
							<MemberAvatar
								size={16}
								className="mt-px shrink-0"
								user={{
									name: e.p.author.name,
									color: e.p.author.color,
									memberId: e.p.author.memberId,
									guest: e.p.author.isGuest,
								}}
							/>
							<p className="min-w-0 text-[13px] leading-[18px] text-pretty break-words">
								<span className="font-medium">{e.p.author.name}:</span>{" "}
								{shortDescription(e.p, ix)}
							</p>
						</div>
						<span className="ml-auto flex shrink-0 items-center">
							<AltActions p={e.p} />
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function AltActions({ p }: { p: ProposalDto }) {
	const { access, graph } = useWorkspace();
	const conflict = useConflictOf(p);
	if (conflict)
		return <span className="text-xs text-warning">Needs a look</span>;
	if (access.canReview) return <AcceptButton p={p} from="inline" />;
	if (isMine(p, graph.me.userId)) return <WithdrawButton p={p} />;
	return null;
}

export function ProposalBar({ sel }: { sel: Sel | null }) {
	const { ix, proposals } = useWorkspace();
	const key = markKeyOfSel(sel, ix);
	const marks = useProposalMarks(key);
	const byId = useMemo(
		() => new Map(proposals.list.map((p) => [p.id, p])),
		[proposals.list],
	);
	const entries: Entry[] = marks.flatMap((m) => {
		const p = byId.get(m.proposalId);
		return p && p.status === "open" && p.op !== "note.append" ? [{ m, p }] : [];
	});
	if (!entries.length) return null;

	// Alternatives: marks sharing a field with a stacked one.
	const stackedFields = new Set(
		entries.filter((e) => e.m.stacked).flatMap((e) => e.m.fields ?? ["*"]),
	);
	const inStack = (e: Entry) =>
		(e.m.fields ?? ["*"]).some((f) => stackedFields.has(f));
	const stack = entries.filter(inStack);
	const singles = entries.filter((e) => !inStack(e));
	const lead = singles[0] ?? stack[0];
	if (!lead) return null;
	const color = presenceColor(lead.p.author.color);

	return (
		<section
			data-testid={TESTID.proposalBar}
			data-proposal-id={lead.p.id}
			aria-label="Suggested changes"
			className="mx-4 mt-3 rounded-md px-2.5 outline-[1.5px] outline-offset-0 outline-dashed"
			style={
				{
					outlineColor: color,
					backgroundColor: `color-mix(in oklab, ${color} 6%, transparent)`,
				} as CSSProperties
			}
		>
			{singles.map((e, i) => (
				<div
					key={e.p.id}
					className={i > 0 ? "border-t border-dashed" : undefined}
				>
					<Lead e={e} />
				</div>
			))}
			{stack.length ? (
				<div className={singles.length ? "border-t border-dashed" : undefined}>
					<Alternatives entries={stack} />
				</div>
			) : null}
		</section>
	);
}
