/**
 * One expense row (EXTENSIONS §8.6): glyph, title, where it hangs, payer
 * avatars + "split 3", the original amount with "≈ display", and the status
 * ("¥10k of ¥60k"). Private rows get a 12px Lock and "Only you". Planned
 * rows are NOT dashed (ADDENDUM §10). Click opens the editor.
 */
import { cn } from "cn";
import { Lock, Undo2 } from "lucide-react";
import { Crumbs } from "@/components/common/crumbs";
import { PersonAvatar, resolveMember } from "@/components/common/member";
import { targetLabel } from "@/lib/engine/money-scope";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { CategoryGlyph, MonoNumbers, Num, statusText } from "./money-ui";
import { MONEY_TESTID } from "./testids";
import { type Display, originalAndApprox, type Row } from "./use-money";

export function ExpenseRow({
	row,
	display,
	showWhere = true,
}: {
	row: Row;
	display: Display;
	showWhere?: boolean;
}) {
	const { ix, graph, scope } = useWorkspace();
	const open = useUi((s) => s.openAddExpense);
	const e = row.expense;
	const payerIds = [
		...new Set(e.payments.flatMap((p) => p.payers.map((x) => x.memberId))),
	];
	const payers = payerIds.map((id) => {
		const m = resolveMember(graph.members, id);
		return {
			id,
			name: m?.name ?? "Former member",
			color: m?.color ?? 0,
			image: m?.image ?? null,
		};
	});
	const splitN = e.lines.length
		? new Set(e.lines.flatMap((l) => l.memberIds)).size
		: e.shares.length;
	const { original, approx } = originalAndApprox(e, display);
	const where = targetLabel(ix, e.target);
	const status = statusText(e);
	const cashless = e.amountMinor === null;
	return (
		// FB-17: guests never see money; a private expense (only me) never shares my cursor.
		<li
			data-cursor-anchor={`exp:${e.id}`}
			data-cursor-vis={e.isPrivate ? "private" : "members"}
		>
			<button
				type="button"
				data-testid={MONEY_TESTID.expenseRow}
				data-expense-id={e.id}
				data-status={e.status}
				onClick={() => open({ expenseId: e.id })}
				className="group flex w-full cursor-pointer items-start gap-3 px-4 py-2.5 text-left hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
			>
				<CategoryGlyph category={e.category} className="mt-0.5" />
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<span className="min-w-0 flex-1 truncate text-sm font-medium">
							{e.refundOfId ? (
								<Undo2
									className="mr-1 inline size-3 text-muted-foreground"
									aria-label="Refund"
								/>
							) : null}
							{e.title}
						</span>
						{original ? (
							<Num
								className={cn(
									"text-[13px] font-medium",
									e.amountMinor !== null &&
										e.amountMinor < 0 &&
										"text-muted-foreground",
								)}
							>
								{original}
							</Num>
						) : null}
						{e.points ? (
							<Num className="text-[13px] font-medium">
								{e.points.points.toLocaleString("en")} pts
							</Num>
						) : null}
					</div>
					<div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
						{e.isPrivate ? (
							<span className="inline-flex shrink-0 items-center gap-1">
								<Lock className="size-3" aria-hidden="true" />
								Only you
							</span>
						) : payers.length === 1 && payers[0] ? (
							<span className="inline-flex shrink-0 items-center gap-1">
								<PersonAvatar memberId={payers[0].id} size={16} ring={false} />
								{payers[0].id === graph.me.memberId
									? "You"
									: payers[0].name.split(" ")[0]}
							</span>
						) : payers.length ? (
							<span className="inline-flex shrink-0 items-center gap-0.5">
								{payers.slice(0, 3).map((p) => (
									<PersonAvatar
										key={p.id}
										memberId={p.id}
										size={16}
										ring={false}
									/>
								))}
							</span>
						) : null}
						{!e.isPrivate && splitN > 0 ? (
							<span className="shrink-0">split {splitN}</span>
						) : null}
						{showWhere ? (
							<span className="flex min-w-0 items-center gap-1 truncate">
								{row.anchor.nodeId &&
								row.anchor.nodeId !== scope?.id &&
								e.target.kind === "node" ? (
									<Crumbs
										nodeIds={row.anchor.nodeId}
										relativeTo={scope?.id ?? null}
									/>
								) : (
									<span className="truncate">{where}</span>
								)}
							</span>
						) : null}
						<span className="ml-auto shrink-0">
							{approx ?? (cashless && e.points ? (e.points.program ?? "") : "")}
						</span>
					</div>
					{e.status !== "paid" ||
					(e.amountMinor !== null && e.homeAmountMinor === null) ? (
						<div className="mt-0.5 text-xs text-muted-foreground">
							<MonoNumbers text={status} />
							{e.amountMinor !== null && e.homeAmountMinor === null
								? " · rate pending"
								: null}
						</div>
					) : null}
				</div>
			</button>
		</li>
	);
}
