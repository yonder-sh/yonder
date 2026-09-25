/**
 * E7 `sel=p.<id>` (EXTENSIONS §3.7): the inspector Overview of one
 * suggestion — who suggested what and when, the message, before → after per
 * field (from the DTO's `before`, else the live value), `DateImpactList` for
 * `trip.*`, the conflict (with "Accept anyway" when it can be forced), the
 * status of a closed one, and the actions: Accept / Reject (reviewers),
 * Withdraw (the author), Show (the thing itself).
 */
import { ArrowRight, LocateFixed } from "lucide-react";
import { type CSSProperties, useMemo } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { MarkdownText } from "@/components/common/markdown-text";
import { MemberAvatar, presenceColor } from "@/components/common/member";
import { Button } from "@/components/ui/button";
import { DateImpactList } from "@/features/insights/DateImpactList";
import { dateChangeImpact } from "@/lib/engine/date-impact";
import { effectiveHours } from "@/lib/engine/hours";
import { todayIn } from "@/lib/format";
import type { ProposalDto } from "@/lib/schemas/proposals";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { describeProposal } from "./describe-proposal";
import {
	AcceptButton,
	ConflictNote,
	RejectButton,
	ScopeCrumb,
	StatusLine,
	useConflictOf,
	WithdrawButton,
} from "./ProposalRow";
import {
	dateChangeOf,
	entityLive,
	fieldRows,
	isMine,
	pObj,
	pStr,
	targetLabel,
	timeAgo,
} from "./proposal-view";
import { SUGGEST_TESTID } from "./testids";
import { useBaseIndex } from "./use-base-index";
import { useProposalActions } from "./use-proposal-actions";

function DateImpact({ p }: { p: ProposalDto }) {
	const { graph } = useWorkspace();
	const ix = useBaseIndex();
	const impact = useMemo(() => {
		const change = dateChangeOf(p);
		if (!change) return null;
		try {
			const settings = graph.trip.settings;
			return dateChangeImpact(graph, change, {
				hoursOf: (nodeId) => {
					const n = ix.node(nodeId);
					return n ? effectiveHours(n, settings) : null;
				},
				holidays: settings.holidays ?? [],
				today: todayIn(ix.defaultTz),
			});
		} catch {
			return null;
		}
	}, [p, graph, ix]);
	if (!impact) return null;
	return (
		<section className="mt-5">
			<h3 className="text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
				What moves
			</h3>
			<div className="mt-2">
				<DateImpactList impact={impact} />
			</div>
		</section>
	);
}

function Fields({ p }: { p: ProposalDto }) {
	const ix = useBaseIndex();
	const rows = fieldRows(p, ix);
	if (!rows.length) return null;
	const isCreate = rows.every((r) => r.before === null);
	return (
		<dl className="mt-4 grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 text-[13px] leading-[18px]">
			{rows.map((r) => (
				<div
					key={r.field}
					data-testid={SUGGEST_TESTID.fieldRow}
					data-field={r.field}
					className="contents"
				>
					<dt className="pt-px text-xs text-muted-foreground">
						{r.label || "Change"}
					</dt>
					<dd className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
						{isCreate || r.before === null ? null : (
							<>
								<span className="text-muted-foreground line-through decoration-muted-foreground/50">
									{r.before}
								</span>
								<ArrowRight
									className="size-3.5 shrink-0 text-muted-foreground"
									aria-label="becomes"
								/>
							</>
						)}
						<span className="font-medium">{r.after}</span>
					</dd>
				</div>
			))}
		</dl>
	);
}

export function ProposalOverview({ proposalId }: { proposalId: string }) {
	const { proposals, access, graph } = useWorkspace();
	const ix = useBaseIndex();
	const { show } = useProposalActions();
	const p = proposals.list.find((x) => x.id === proposalId);
	const conflict = useConflictOf(p);
	if (!p)
		return (
			<div data-testid={TESTID.proposalOverview}>
				<EmptyState line="This suggestion is gone." />
			</div>
		);

	const mine = isMine(p, graph.me.userId);
	const open = p.status === "open";
	const color = presenceColor(p.author.color);
	const note = p.op === "note.append" ? pStr(p.payload, "markdown") : null;

	return (
		<div data-testid={TESTID.proposalOverview} data-status={p.status}>
			<div className="flex items-center gap-2">
				<MemberAvatar
					size={20}
					user={{
						name: p.author.name,
						color: p.author.color,
						memberId: p.author.memberId,
						guest: p.author.isGuest,
					}}
				/>
				<p className="text-[13px] leading-[18px]">
					<span className="font-medium">{p.author.name}</span>
					<span className="text-muted-foreground">
						{" "}
						suggested · {timeAgo(p.createdAt)}
					</span>
				</p>
			</div>
			<div
				className="mt-3 rounded-md px-3 py-2.5 outline-[1.5px] outline-dashed"
				style={
					{
						outlineColor: conflict ? "var(--warning-hairline)" : color,
						backgroundColor: `color-mix(in oklab, ${color} 5%, transparent)`,
					} as CSSProperties
				}
			>
				<p className="text-[15px] leading-[22px] font-medium text-balance">
					{describeProposal(p, ix)}
				</p>
				<ScopeCrumb p={p} className="mt-1" />
				{p.message ? (
					<p className="mt-2 text-[13px] leading-[18px] text-muted-foreground italic">
						“{p.message}”
					</p>
				) : null}
			</div>
			{note ? (
				<div className="mt-4 rounded-md border border-dashed px-3 py-2.5 text-sm">
					<MarkdownText md={note} />
				</div>
			) : null}
			<Fields p={p} />
			{p.op === "trip.shift" || p.op === "trip.dates" ? (
				<DateImpact p={p} />
			) : null}
			<StatusLine p={p} />
			{open && conflict ? <ConflictNote p={p} conflict={conflict} /> : null}
			{open && !conflict ? (
				<div className="mt-5 flex flex-wrap items-center gap-2">
					{entityLive(p, ix) && p.entityKind !== "trip" ? (
						<Button
							variant="ghost"
							size="sm"
							data-testid={SUGGEST_TESTID.show}
							className="-ml-2 text-muted-foreground hover:text-foreground"
							onClick={() => show(p)}
						>
							<LocateFixed />
							Show
						</Button>
					) : null}
					<span className="flex-1" />
					{mine ? <WithdrawButton p={p} size="sm" /> : null}
					{access.canReview ? (
						<>
							{mine ? null : <RejectButton p={p} size="sm" />}
							{p.op === "note.append" ? null : (
								<AcceptButton p={p} size="sm" tone="solid" />
							)}
						</>
					) : null}
				</div>
			) : null}
			{open && p.op === "note.append" && access.canReview ? (
				<p className="mt-3 text-xs text-muted-foreground">
					To accept, open the Notes tab of{" "}
					{targetLabel(pObj(p.payload, "target"), ix) ?? "its place"} and choose
					“Insert at end”.
				</p>
			) : null}
		</div>
	);
}
