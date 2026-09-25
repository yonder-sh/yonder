/**
 * The activity view the digest line links to (EXTENSIONS §9): what changed
 * since I last looked, grouped by person (`buildDigest`: "added 3 places in
 * Kyoto: …"), then the trip's recent activity. A line that points at
 * something still in the trip selects it. Opened from the digest banner and
 * the inspector's recent-activity footer.
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { useMemo, useState } from "react";
import { presenceColor } from "@/components/common/member";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { buildDigest, type DigestLine } from "@/lib/engine/digest";
import { activityQuery, tripDigestQuery } from "@/lib/query/trip-queries";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { type EntityRefs, selForRefs } from "./activity-sel";
import { timeAgo } from "./inbox-model";
import { useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";

/** A digest line's refs (items first, like `selForRefs`) as one ref set. */
function refsOfLine(refs: DigestLine["refs"]): EntityRefs {
	const out: EntityRefs = {};
	for (const r of refs) {
		if (r.kind === "item") out.itemId ??= r.id;
		if (r.kind === "node") out.nodeId ??= r.id;
		if (r.kind === "leg") out.legId ??= r.id;
		if (r.kind === "day") out.dayId ??= r.id;
	}
	return out;
}

/** Stable keys for lines (text + refs, numbered when two lines are identical). */
function lineKeys(lines: DigestLine[]): [string, DigestLine][] {
	const seen = new Map<string, number>();
	return lines.map((l) => {
		const base = `${l.text}|${l.refs.map((r) => r.id).join(",")}`;
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		return [`${base}#${n}`, l];
	});
}

export function ActivityDialog() {
	const open = useShell((s) => s.activityOpen);
	const setOpen = useShell((s) => s.setActivityOpen);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				data-testid={SHELL_TESTID.activityDialog}
				className="flex max-h-[min(640px,85svh)] flex-col gap-0 p-0 sm:max-w-[520px]"
			>
				<DialogHeader className="border-b px-5 pt-5 pb-3">
					<DialogTitle>What changed</DialogTitle>
					<DialogDescription>
						Other people's changes since you last looked, then everything
						recent.
					</DialogDescription>
				</DialogHeader>
				{open ? <ActivityBody onPick={() => setOpen(false)} /> : null}
			</DialogContent>
		</Dialog>
	);
}

function ActivityBody({ onPick }: { onPick(): void }) {
	const { graph, ix, mode, nav } = useWorkspace();
	const live = mode === "live";
	const digest = useQuery({
		...tripDigestQuery(graph.trip.id),
		enabled: live,
	}).data;
	const recent = useQuery({
		...activityQuery(graph.trip.id),
		enabled: live,
	});
	const [now] = useState(() => Date.now());
	const groups = useMemo(
		() =>
			digest ? buildDigest(digest.rows, ix, { meUserId: graph.me.userId }) : [],
		[digest, ix, graph.me.userId],
	);
	const colorOf = (userId: string | null) =>
		graph.members.find((m) => m.userId === userId)?.color ?? null;
	const pick = (refs: EntityRefs) => {
		const sel = selForRefs(ix, refs);
		if (!sel) return;
		onPick();
		nav.select(sel);
	};
	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
			{groups.length ? (
				<section className="mb-5">
					<h3 className="mb-2 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
						Since you last looked
					</h3>
					<ul className="grid gap-3">
						{groups.map((g) => (
							<li key={g.actorUserId ?? g.actorName}>
								<p className="flex items-center gap-2 text-sm font-medium">
									<span
										aria-hidden="true"
										className="size-2 rounded-full"
										style={{
											backgroundColor: presenceColor(colorOf(g.actorUserId)),
										}}
									/>
									{g.actorName}
								</p>
								<ul className="mt-1 grid gap-0.5 pl-4">
									{lineKeys(g.lines).map(([key, l]) => {
										const refs = refsOfLine(l.refs);
										const sel = selForRefs(ix, refs);
										return (
											<li key={key}>
												<button
													type="button"
													disabled={!sel}
													onClick={() => pick(refs)}
													className={cn(
														"text-left text-[13px] text-muted-foreground",
														sel &&
															"hover:text-foreground hover:underline underline-offset-2",
													)}
												>
													{l.text}
												</button>
											</li>
										);
									})}
									{g.more ? (
										<li className="text-xs text-muted-foreground">
											+{g.more} more
										</li>
									) : null}
								</ul>
							</li>
						))}
					</ul>
				</section>
			) : null}
			<section>
				<h3 className="mb-2 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
					Recent
				</h3>
				{recent.isPending && live ? (
					<div className="grid gap-2" aria-busy="true">
						{[0, 1, 2, 3].map((i) => (
							<div key={i} className="h-5 animate-pulse rounded bg-muted" />
						))}
					</div>
				) : recent.data?.length ? (
					<ul className="grid gap-1.5">
						{recent.data.map((a) => {
							const sel = selForRefs(ix, a);
							return (
								<li
									key={a.id}
									className="flex items-baseline gap-2 text-[13px]"
								>
									<span
										aria-hidden="true"
										className="size-1.5 shrink-0 translate-y-[-1px] rounded-full"
										style={{ backgroundColor: presenceColor(a.actorColor) }}
									/>
									<button
										type="button"
										disabled={!sel}
										onClick={() => pick(a)}
										className={cn(
											"min-w-0 flex-1 text-left",
											sel && "hover:underline underline-offset-2",
										)}
									>
										<span className="font-medium">{a.actorName}</span>{" "}
										<span className="text-muted-foreground">{a.summary}</span>
									</button>
									<span className="shrink-0 font-mono text-[11px] text-muted-foreground tnum">
										{timeAgo(a.at, now)}
									</span>
								</li>
							);
						})}
					</ul>
				) : (
					<p className="text-sm text-muted-foreground">Nothing yet.</p>
				)}
			</section>
		</div>
	);
}
