/**
 * The editable days-per-city table (ADDENDUM §10 "Still to plan"; WP-Shell
 * mounts it in the trip overview's panel, NodeOverview shows it for countries
 * and regions): planned days per city (`details.plannedDays`, the sheet's
 * Cities "Days"), the days the timeline spends there, and the unallocated
 * total against the trip's length.
 *
 *   <DaysPerCityTable />                 whole trip, with the unallocated total
 *   <DaysPerCityTable scopeId={japan} /> one country or region
 */
import { cn } from "cn";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useEditGuard } from "@/components/common/edit-guard";
import { FlagEmoji } from "@/components/common/glyphs";
import type { GraphNode } from "@/lib/engine/types";
import { humanError } from "@/lib/errors";
import { copyAnchorId } from "@/lib/realtime/cursor-protocol";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { cityDayTable, formatDays, parseDays } from "./lib/days";
import { useUpdateNode } from "./mutations";
import { PLACES_TESTID } from "./testids";

function PlannedInput({
	node,
	label,
	className,
}: {
	node: GraphNode;
	label: string;
	className?: string;
}) {
	const { graph } = useWorkspace();
	const guard = useEditGuard();
	const update = useUpdateNode(graph.trip.id);
	const stored = node.details.plannedDays ?? null;
	const [draft, setDraft] = useState(stored === null ? "" : formatDays(stored));
	const [bad, setBad] = useState(false);
	useEffect(() => {
		setDraft(stored === null ? "" : formatDays(stored));
	}, [stored]);
	const commit = () => {
		const v = parseDays(draft);
		if (v === "invalid") {
			setBad(true);
			return;
		}
		setBad(false);
		// An emptied field clears the planned days (a `null` deletes the key).
		if (v === stored) return;
		update.mutate(
			{ nodeId: node.id, patch: { details: { plannedDays: v } } },
			{ onError: (e) => toast.error(humanError(e)) },
		);
	};
	return (
		<input
			data-testid={PLACES_TESTID.daysInput}
			aria-label={label}
			inputMode="decimal"
			disabled={guard.disabled}
			title={guard.reason ?? undefined}
			value={draft}
			placeholder="–"
			onChange={(e) => {
				setDraft(e.target.value);
				setBad(false);
			}}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") {
					setDraft(stored === null ? "" : formatDays(stored));
					e.currentTarget.blur();
				}
			}}
			className={cn(
				"h-7 w-12 rounded-md border border-transparent bg-transparent px-1.5 text-right font-mono text-[13px] tnum outline-none hover:border-input focus:border-ring focus:bg-background disabled:hover:border-transparent",
				bad && "border-destructive",
				className,
			)}
		/>
	);
}

/** "[4] planned · 3 scheduled" for one city (the node overview's Days row). */
export function PlannedDaysLine({ node }: { node: GraphNode }) {
	const { ix, schedule } = useWorkspace();
	const table = cityDayTable(ix, schedule, null);
	const row = table.rows.find((r) => r.nodeId === node.id);
	const scheduled = row?.scheduled ?? 0;
	return (
		<span
			className="-my-1 flex items-center gap-1 text-[13px] text-muted-foreground"
			data-testid={PLACES_TESTID.plannedDays}
		>
			<PlannedInput
				node={node}
				label={`Planned days in ${node.name}`}
				className="-ml-1.5 border-border text-left text-foreground"
			/>
			planned ·{" "}
			<span className="font-mono tnum text-foreground">{scheduled}</span>{" "}
			scheduled
		</span>
	);
}

export function DaysPerCityTable({
	scopeId = null,
	compact = false,
	className,
}: {
	scopeId?: string | null;
	compact?: boolean;
	className?: string;
}) {
	const { ix, schedule, nav } = useWorkspace();
	const table = cityDayTable(ix, schedule, scopeId);
	if (!table.rows.length)
		return (
			<p className="text-[13px] text-muted-foreground">No cities here yet.</p>
		);
	// Group by country, in outline order.
	const groups: { country: GraphNode | null; rows: typeof table.rows }[] = [];
	for (const r of table.rows) {
		const country = r.countryId ? (ix.node(r.countryId) ?? null) : null;
		const last = groups.at(-1);
		if (last && last.country?.id === country?.id) last.rows.push(r);
		else groups.push({ country, rows: [r] });
	}
	const showCountries = groups.length > 1 || scopeId === null;
	const over = table.unallocated < 0;
	return (
		<div
			className={cn("grid gap-1", className)}
			data-testid={PLACES_TESTID.daysTable}
		>
			<table className="w-full border-collapse text-[13px]">
				<thead>
					<tr className="text-[11px] tracking-[.06em] text-muted-foreground uppercase">
						<th className="py-1 text-left font-semibold">City</th>
						<th className="w-16 py-1 pl-2 text-right font-semibold">Planned</th>
						<th className="w-20 py-1 pl-2 text-right font-semibold">
							Scheduled
						</th>
					</tr>
				</thead>
				<tbody>
					{groups.map((g) => {
						const planned = g.rows.reduce((s, r) => s + (r.planned ?? 0), 0);
						const scheduled = g.rows.reduce((s, r) => s + r.scheduled, 0);
						return [
							showCountries && g.country ? (
								<tr
									key={`c-${g.country.id}`}
									data-cursor-anchor={`sec:dpc.${g.country.id}`}
									className="border-t"
								>
									<td className="pt-2 pb-0.5 font-medium">
										<span className="inline-flex items-center gap-1.5">
											<FlagEmoji code={g.country.countryCode} />
											{g.country.name}
										</span>
									</td>
									<td className="pt-2 pb-0.5 text-right font-mono text-xs tnum text-muted-foreground">
										{formatDays(planned)}
									</td>
									<td className="pt-2 pb-0.5 text-right font-mono text-xs tnum text-muted-foreground">
										{scheduled}
									</td>
								</tr>
							) : null,
							...g.rows.map((r) => {
								const node = ix.node(r.nodeId);
								if (!node) return null;
								const diff = r.planned !== null && r.scheduled !== r.planned;
								return (
									<tr
										key={r.nodeId}
										data-testid={PLACES_TESTID.daysRow}
										data-node={r.nodeId}
										// The table's drawing of the city (the Plan's day split has its own).
										data-cursor-anchor={copyAnchorId(`city:${r.nodeId}`, "t")}
										className="group"
									>
										<td className={cn("py-0.5", showCountries && "pl-5")}>
											<button
												type="button"
												onClick={() =>
													nav.select({ kind: "node", id: r.nodeId })
												}
												className="max-w-full truncate text-left hover:underline"
											>
												{r.name}
											</button>
										</td>
										<td className="py-0.5 text-right">
											<PlannedInput
												node={node}
												label={`Planned days in ${r.name}`}
											/>
										</td>
										<td
											className={cn(
												"py-0.5 pr-1 text-right font-mono tnum",
												diff ? "text-foreground" : "text-muted-foreground",
											)}
											title={
												diff
													? `${r.scheduled} scheduled vs ${formatDays(r.planned)} planned`
													: undefined
											}
										>
											{r.scheduled}
										</td>
									</tr>
								);
							}),
						];
					})}
				</tbody>
			</table>
			{scopeId === null ? (
				<p
					data-testid={PLACES_TESTID.daysUnallocated}
					className={cn(
						"mt-1 flex items-baseline justify-between gap-2 border-t pt-2 text-[13px]",
						over && "text-warning",
					)}
				>
					<span>
						{over ? "Over-allocated" : "Unallocated"}{" "}
						<span className="font-mono tnum font-medium">
							{formatDays(Math.abs(table.unallocated))}
						</span>{" "}
						{Math.abs(table.unallocated) === 1 ? "day" : "days"}
					</span>
					<span className="text-xs text-muted-foreground">
						<span className="font-mono tnum">
							{formatDays(table.plannedTotal)}
						</span>{" "}
						planned of <span className="font-mono tnum">{table.tripDays}</span>{" "}
						trip days
					</span>
				</p>
			) : compact ? null : (
				<p className="mt-1 border-t pt-2 text-xs text-muted-foreground">
					<span className="font-mono tnum">
						{formatDays(table.plannedTotal)}
					</span>{" "}
					planned ·{" "}
					<span className="font-mono tnum">{table.scheduledTotal}</span>{" "}
					scheduled
				</p>
			)}
		</div>
	);
}
