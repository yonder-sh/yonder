/**
 * The phone's Table (docs/PLACES.md §1, the Phone mockup): the same groups,
 * sort and filters as a list — one row per place with where it is, who
 * rated what (dot + label: a dense list) and the score chip. A tap opens
 * its details.
 */
import { cn } from "cn";
import { MemberAvatar } from "@/components/common/member";
import { PriorityDot } from "@/components/common/priority-dot";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { ratingsCount } from "../lib/rate";
import { rowReason } from "./bar";
import type { PlaceRow } from "./model";
import { PLACES_TAB_TESTID } from "./testids";
import { ScoreChip, SplitMark, StatusChip } from "./ui";
import { type PlacesData, useSplitAreas } from "./use-places";

function Row({ row, data }: { row: PlaceRow; data: PlacesData }) {
	const { sel, nav } = useWorkspace();
	const selected = sel?.kind === "node" && sel.id === row.id;
	const rated = data.allRaters.filter((m) => row.node.priorities[m.id]);
	return (
		<li>
			<button
				type="button"
				data-testid={PLACES_TAB_TESTID.row}
				data-row-id={row.id}
				data-status={row.status}
				data-score={row.score}
				onClick={() => nav.select({ kind: "node", id: row.id })}
				className={cn(
					"flex min-h-14 w-full cursor-pointer items-center gap-3 border-b px-4 py-2 text-left",
					selected ? "bg-accent" : "active:bg-muted",
				)}
			>
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-1.5">
						<span className="truncate text-[15px] font-medium">{row.name}</span>
						{row.split ? <SplitMark /> : null}
					</span>
					<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
						<span className="truncate">{row.where}</span>
						{rated.map((m) => (
							<span
								key={m.id}
								className={cn(
									"inline-flex items-center gap-1",
									!ratingsCount(m) && "opacity-50",
								)}
								title={ratingsCount(m) ? undefined : "Not counted"}
							>
								<MemberAvatar memberId={m.id} size={16} ring={false} />
								<PriorityDot
									priority={row.node.priorities[m.id]}
									className="text-xs text-muted-foreground"
								/>
							</span>
						))}
						{row.status === "shortlist" || row.status === "dropped" ? (
							<StatusChip
								info={row.info}
								reason={rowReason(row, data.bar)}
								className="h-5 text-[11px]"
							/>
						) : null}
					</span>
				</span>
				<ScoreChip score={row.score} />
			</button>
		</li>
	);
}

export function PlacesList({ data }: { data: PlacesData }) {
	const [, toggleSplit] = useSplitAreas();
	return (
		<div
			className="min-h-0 flex-1 overflow-y-auto pb-6"
			data-testid={PLACES_TAB_TESTID.table}
		>
			{data.groups.map((g) => (
				<section key={g.key}>
					{data.state.group === "none" ? null : (
						<header
							data-testid={PLACES_TAB_TESTID.groupHeader}
							className="flex flex-wrap items-baseline gap-x-2 px-4 pt-3 pb-1.5"
						>
							<h3 className="font-display text-base font-semibold">
								{g.label}
							</h3>
							<span className="text-xs text-muted-foreground">
								{g.summary.count} {g.summary.count === 1 ? "place" : "places"}
								{g.summary.musts ? ` · ${g.summary.musts} must` : ""}
							</span>
							{g.canSplit && g.node ? (
								<button
									type="button"
									data-testid={PLACES_TAB_TESTID.splitToggle}
									onClick={() => toggleSplit(g.node?.id ?? "")}
									className="ml-auto h-8 cursor-pointer text-xs font-medium text-primary"
								>
									{g.split ? "Merge areas" : "Split by area"}
								</button>
							) : null}
						</header>
					)}
					{g.subgroups ? (
						g.subgroups.map((s) => (
							<div key={s.key} data-testid={PLACES_TAB_TESTID.subgroup}>
								<h4 className="px-4 pt-2 pb-1 text-[13px] font-semibold">
									{s.label}{" "}
									<span className="font-normal text-muted-foreground">
										· {s.rows.length}
									</span>
								</h4>
								<ul className="border-t">
									{s.rows.map((r) => (
										<Row key={r.id} row={r} data={data} />
									))}
								</ul>
							</div>
						))
					) : (
						<ul className="border-t">
							{g.rows.map((r) => (
								<Row key={r.id} row={r} data={data} />
							))}
						</ul>
					)}
				</section>
			))}
		</div>
	);
}
