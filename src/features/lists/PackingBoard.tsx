/**
 * The Packing tab (One Yonder D12): one packing list, shared and personal.
 * "For everyone" is what the whole trip sees; "Just mine" is what only its
 * author sees (a private row, ADDENDUM §7.2). Each group has its own add
 * row. Rows are simple: the text, a tick and, if you like, who packs it;
 * a ticked row stays in place, struck through.
 */

import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { useHoursIssues } from "@/features/insights/use-hours-issues";
import { MentionInput } from "@/features/notes/MentionInput";
import { dueCtxOf, sortListItems } from "@/lib/engine/due";
import type { BundleTarget } from "@/lib/schemas/targets";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { PersonFilter } from "./ListBoard";
import { ListRow, type RowCtx } from "./ListRow";
import { rollupRows, type ScopeOptions } from "./list-model";
import type { ListItemDto } from "./lists.functions";
import { LISTS_TESTID } from "./testids";
import { type ListActions, useListActions } from "./use-list-actions";
import { useNow } from "./use-now";

type PackingGroupKey = "everyone" | "mine";

const GROUP_TITLE: Record<PackingGroupKey, string> = {
	everyone: "For everyone",
	mine: "Just mine",
};

export function PackingBoard({
	items,
	scope,
	addTarget,
	who,
	setWho,
	headerStart,
}: {
	items: readonly ListItemDto[];
	scope: ScopeOptions;
	addTarget: BundleTarget;
	who: string | null;
	setWho: (memberId: string | null) => void;
	where: string;
	loading?: boolean;
	headerStart?: ReactNode;
}) {
	const ws = useWorkspace();
	const { ix, schedule } = ws;
	const editGuard = useEditGuard();
	const canEdit = ws.mode === "live" && !editGuard.disabled;
	const reason = ws.mode === "live" ? editGuard.reason : "Preview only";
	// "Just mine" needs a member who can keep private rows (never a link guest).
	const canPrivate =
		ws.mode === "live" && !ws.access.isGuest && !!ws.access.memberId;
	const actions = useListActions();
	const now = useNow();
	const hours = useHoursIssues();
	const dueCtx = useMemo(() => dueCtxOf(ix, schedule), [ix, schedule]);
	const closedIssue = useCallback(
		(itemId: string) =>
			(hours.byItem[itemId] ?? []).some(
				(i) => i.kind === "closed" && i.severity === "warn",
			),
		[hours],
	);

	const rows = useMemo(() => {
		const out: ListItemDto[] = [];
		const seen = new Set<string>();
		const packing = items.filter((r) => r.list === "packing");
		for (const g of rollupRows(ix, packing, scope))
			for (const s of g.subs)
				for (const r of s.rows)
					if (!seen.has(r.id) && (!who || r.assigneeIds.includes(who))) {
						seen.add(r.id);
						out.push(r);
					}
		return sortListItems(out, "place", dueCtx);
	}, [ix, items, scope, who, dueCtx]);

	const rowCtx: RowCtx = {
		ix,
		schedule,
		dueCtx,
		now,
		scopeId: scope.scopeId,
		showSource: true,
		canEdit,
		reason,
		closedIssue,
	};
	const groups: PackingGroupKey[] = canPrivate
		? ["everyone", "mine"]
		: ["everyone"];

	return (
		<section
			data-testid={LISTS_TESTID.packing}
			aria-label="Packing"
			className="@container flex min-w-0 flex-col"
		>
			<div className="flex flex-wrap items-center gap-2 px-4 py-2">
				{headerStart}
				<div className="ml-auto flex items-center gap-1.5">
					<PersonFilter who={who} setWho={setWho} />
				</div>
			</div>
			{groups.map((g) => (
				<PackingGroup
					key={g}
					group={g}
					rows={rows.filter((r) => r.isPrivate === (g === "mine"))}
					target={addTarget}
					canEdit={canEdit}
					reason={reason}
					rowCtx={rowCtx}
					actions={actions}
				/>
			))}
		</section>
	);
}

function PackingGroup({
	group,
	rows,
	target,
	canEdit,
	reason,
	rowCtx,
	actions,
}: {
	group: PackingGroupKey;
	rows: ListItemDto[];
	target: BundleTarget;
	canEdit: boolean;
	reason: string | null;
	rowCtx: RowCtx;
	actions: ListActions;
}) {
	const title = GROUP_TITLE[group];
	const [text, setText] = useState("");
	const open = rows.filter((r) => r.status === "open").length;
	const onToggle = (row: ListItemDto) =>
		actions.setStatus(row.id, row.status === "open" ? "done" : "open");
	const add = (value: string) => {
		const v = value.trim();
		if (!v || !canEdit) return;
		actions.create(
			{
				target,
				list: "packing",
				text: v,
				isPrivate: group === "mine" || undefined,
			},
			{ onError: () => setText((cur) => cur || v) },
		);
		setText("");
	};
	return (
		<div
			data-testid={LISTS_TESTID.packingGroup}
			data-group={group}
			className="pb-2"
		>
			<div
				data-testid={LISTS_TESTID.groupHead}
				className="sticky top-0 z-20 flex h-8 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur"
			>
				<span className="truncate text-xs font-medium">{title}</span>
				{open ? (
					<span className="text-xs text-muted-foreground tnum">{open}</span>
				) : null}
				<span className="ml-auto text-xs text-muted-foreground">
					{group === "mine"
						? "Only you see these"
						: "The whole trip sees these"}
				</span>
			</div>
			{rows.length ? (
				<ul className="flex flex-col">
					{rows.map((row) => (
						<ListRow
							key={row.id}
							row={row}
							ctx={rowCtx}
							lingering={false}
							glow={false}
							onToggle={onToggle}
							actions={actions}
							simple
						/>
					))}
				</ul>
			) : null}
			<div
				data-testid={LISTS_TESTID.packingAdd}
				data-group={group}
				className="flex items-center gap-2 px-4 pt-1.5"
				title={canEdit ? undefined : (reason ?? undefined)}
			>
				<MentionInput
					value={text}
					onChange={setText}
					onSubmit={add}
					placeholder={
						canEdit
							? group === "mine"
								? "Something only you pack…"
								: "Something to pack…"
							: (reason ?? "View only")
					}
					ariaLabel={`Add to ${title}`}
					disabled={!canEdit}
					className="h-8 flex-1"
				/>
			</div>
		</div>
	);
}
