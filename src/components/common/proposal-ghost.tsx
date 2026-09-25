/**
 * E7 ghosts (EXTENSIONS §3.7, F-owned): a proposed change drawn on the thing
 * it touches, in its author's presence colour.
 *
 * - Look: a 1.5px dashed outline in `--presence-N` and a 16px avatar top-right;
 *   `aria-description` "Suggested by Maya: move to Day 7".
 * - Delete: line-through at 50%. Update: dotted underline, tooltip with the
 *   before value. Conflict: an amber hairline + `TriangleAlert`.
 * - Reviewers (pointer): hovering or focusing shows `GhostActions` (WP-Suggest)
 *   via the `actions` render prop; touch selects instead (long-press is drag).
 *
 *   <ProposalGhost marks={useProposalMarks(`item:${id}`)}>{card}</ProposalGhost>
 */
import { cn } from "cn";
import { TriangleAlert } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { ProposalMark } from "@/lib/engine/proposals";
import { formatDuration } from "@/lib/format";
import type { Json } from "@/lib/schemas/proposals";
import { TESTID } from "@/lib/testids";
import { MemberAvatar, presenceColor } from "./member";

/** The first applied (non-stacked) mark, else the first one. */
export function leadMark(marks: readonly ProposalMark[]): ProposalMark | null {
	return marks.find((m) => !m.stacked) ?? marks[0] ?? null;
}

/**
 * What screen readers hear: what the suggestion does, from its summary
 * ("Suggested by Maya: moved Itoya to Tue 5 Oct", QA COLLAB-8), else its kind
 * ("Suggested by Maya: move").
 */
export function describeMark(m: ProposalMark): string {
	const what =
		m.summary?.trim() ||
		(m.kind === "create"
			? "add"
			: m.kind === "delete"
				? "delete"
				: m.kind === "move"
					? "move"
					: "change");
	return `Suggested by ${m.author.name}: ${what}`;
}

/** Fields whose value says what it is on its own ("4h → 3h", "“Lunch” → “Brunch”"). */
const SELF_EVIDENT = new Set(["durationMin", "title", "name", "text"]);

/** A field's value for people: durations as "1h30", times as-is, text quoted. */
function fieldValue(field: string, v: Json | undefined): string {
	if (v === null || v === undefined || v === "") return "none";
	if (typeof v === "number" && /Min$/.test(field))
		return formatDuration(v, { compact: true });
	if (typeof v === "string") {
		const t = v.length > 40 ? `${v.slice(0, 39)}…` : v;
		return SELF_EVIDENT.has(field) ? `“${t}”` : t;
	}
	if (typeof v === "boolean") return v ? "yes" : "no";
	if (typeof v === "number") return String(v);
	return "…";
}

/** "pinnedStart" → "pinned start ". Empty for self-evident fields. */
function fieldLabel(field: string): string {
	if (SELF_EVIDENT.has(field)) return "";
	return `${field
		.replace(/Min$/, "")
		.replace(/Id$/, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase()} `;
}

/**
 * The update tooltip (EXTENSIONS §3.7): "Maya: 4h → 3h", "Maya: pinned start
 * 09:30 → none"; "was …" when the payload doesn't carry the new value. Never
 * raw field names or JSON (QA COLLAB-R2-09).
 */
export function ghostTitle(m: ProposalMark): string | undefined {
	if (m.kind !== "update" || !m.before) return undefined;
	const parts = Object.entries(m.before).map(([f, v]) => {
		if (/Id$/.test(f)) return `${fieldLabel(f)}changed`;
		const was = fieldValue(f, v);
		return m.after && f in m.after
			? `${fieldLabel(f)}${was} → ${fieldValue(f, m.after[f])}`
			: `${fieldLabel(f)}was ${was}`;
	});
	if (!parts.length) return undefined;
	const who = m.author.name.trim().split(/\s+/)[0] || m.author.name;
	return `${who}: ${parts.join(" · ")}`;
}

/**
 * Styling for things that aren't DOM rows (WP-Map pins and edges): the lead
 * author's colour, dashed, and whether it is a delete or in conflict.
 */
export function proposalStyle(marks: readonly ProposalMark[]): {
	proposed: boolean;
	color: string | null;
	dashed: boolean;
	deleted: boolean;
	conflict: boolean;
	author: ProposalMark["author"] | null;
} {
	const lead = leadMark(marks);
	return {
		proposed: lead !== null,
		color: lead ? presenceColor(lead.author.color) : null,
		dashed: lead !== null,
		deleted: lead?.kind === "delete",
		conflict: marks.some((m) => m.conflict),
		author: lead?.author ?? null,
	};
}

export function ProposalGhost({
	marks,
	children,
	className,
	actions,
	describe = "wrapper",
}: {
	marks: readonly ProposalMark[];
	children: ReactNode;
	className?: string;
	/** Reviewer controls (WP-Suggest `GhostActions`) shown on hover/focus. */
	actions?: (lead: ProposalMark) => ReactNode;
	/**
	 * `item`: the child is a listbox option or a treeitem. A listbox or tree
	 * may own only its items (axe `aria-required-children`), so the wrapper
	 * then carries no ARIA and the avatar is hidden; the caller puts
	 * `aria-description={describeMark(lead)}` on the item itself.
	 */
	describe?: "wrapper" | "item";
}) {
	const lead = leadMark(marks);
	if (!lead) return <>{children}</>;
	const style = proposalStyle(marks);
	const onItem = describe === "item";
	return (
		<div
			data-testid={TESTID.proposalGhost}
			data-proposed={lead.kind}
			data-proposal-id={lead.proposalId}
			aria-description={onItem ? undefined : describeMark(lead)}
			title={ghostTitle(lead)}
			className={cn(
				"group/ghost relative rounded-md outline-[1.5px] outline-offset-1 outline-dashed",
				style.deleted && "line-through opacity-50",
				lead.kind === "update" && "underline decoration-dotted",
				style.conflict && "outline-warning-hairline",
				className,
			)}
			style={
				{
					outlineColor: style.conflict ? undefined : (style.color ?? undefined),
				} as CSSProperties
			}
		>
			{children}
			<span
				aria-hidden={onItem || undefined}
				className="pointer-events-none absolute -top-2 -right-2 flex items-center gap-0.5"
			>
				{style.conflict ? (
					<TriangleAlert className="size-3.5 text-warning" aria-hidden />
				) : null}
				<MemberAvatar
					user={{
						name: lead.author.name,
						color: lead.author.color,
						memberId: lead.author.memberId,
					}}
					size={16}
				/>
			</span>
			{actions ? (
				<span className="absolute -top-2 right-4 hidden gap-1 group-focus-within/ghost:flex group-hover/ghost:flex">
					{actions(lead)}
				</span>
			) : null}
		</div>
	);
}
