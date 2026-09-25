/**
 * E3: typical weather for the visit (EXTENSIONS §6), mounted by NodeOverview
 * (WP-Places). A city or area gets one line per visit month from its own
 * 0.25° cell: "Typical October · 23° / 15° · 150 mm · 9 wet days · 5 h sun"
 * (°F in the tooltip). A country, region or the trip root gets a compact
 * table of the visited cities in visit order (≤ 8, then "+3 more"), each from
 * its own cell and visit month, never one centroid line. Places get nothing.
 * Caption: "2016–2025 averages · Weather data by Open-Meteo.com (CC BY 4.0) ·
 * ERA5, Copernicus". Hidden when `getCapabilities().climate` is off.
 */
import { useQuery } from "@tanstack/react-query";
import { CloudSun } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { repAt } from "@/lib/engine/lens";
import type { ScheduleResult } from "@/lib/engine/types";
import { capabilitiesQuery } from "@/lib/query/trip-queries";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import type { ClimateMonth } from "./insights.functions";
import { climateQuery } from "./queries";
import { INSIGHTS_TESTID } from "./testids";
import { Overline } from "./ui";

const MONTH_LONG = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
const MONTH_SHORT = MONTH_LONG.map((m) => m.slice(0, 3));
const MAX_ROWS = 8;

const f = (c: number) => Math.round((c * 9) / 5 + 32);
const deg = (c: number) => `${Math.round(c)}°`;

/** Months (1–12) the visit touches, most days first; else the trip's start month. */
function visitMonths(
	ix: GraphIndex,
	schedule: ScheduleResult,
	nodeId: string | null,
): number[] {
	const days = new Map<string, number>();
	for (const item of ix.ordered) {
		if (!item.nodeId || !item.dayId || !schedule.items[item.id]) continue;
		if (nodeId && !ix.isWithin(item.nodeId, nodeId)) continue;
		const d = ix.day(item.dayId);
		if (d) days.set(d.date, Number(d.date.slice(5, 7)));
	}
	const count = new Map<number, number>();
	for (const m of days.values()) count.set(m, (count.get(m) ?? 0) + 1);
	const months = [...count.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([m]) => m);
	if (months.length) return months;
	const start = ix.trip.startDate;
	return [start ? Number(start.slice(5, 7)) : new Date().getUTCMonth() + 1];
}

/** The cities (or areas where no city exists) visited inside a scope, in visit order. */
function visitedCities(
	ix: GraphIndex,
	scopeId: string | null,
): { id: string; month: number }[] {
	const out = new Map<string, Map<number, number>>();
	for (const item of ix.ordered) {
		if (!item.nodeId || !item.dayId) continue;
		const rep = repAt(ix, item.nodeId, "city", null);
		const n = ix.node(rep.id);
		if (!n || (n.type !== "city" && n.type !== "area")) continue;
		if (scopeId && !ix.isWithin(n.id, scopeId)) continue;
		const d = ix.day(item.dayId);
		if (!d) continue;
		const m = Number(d.date.slice(5, 7));
		const byMonth = out.get(n.id) ?? new Map<number, number>();
		byMonth.set(m, (byMonth.get(m) ?? 0) + 1);
		out.set(n.id, byMonth);
	}
	return [...out.entries()].map(([id, byMonth]) => ({
		id,
		month: [...byMonth.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 1,
	}));
}

export function ClimateCard({ nodeId }: { nodeId: string }) {
	const { ix, schedule, graph, mode } = useWorkspace();
	const caps = useQuery({
		...capabilitiesQuery(),
		enabled: mode === "live",
	}).data;
	const node = ix.node(nodeId);
	const isRoot =
		!node && (nodeId === "" || nodeId === "root" || nodeId === graph.trip.id);
	const single = node && (node.type === "city" || node.type === "area");
	const rows =
		!single && (isRoot || (node && node.type !== "place"))
			? visitedCities(ix, node?.id ?? null)
			: [];
	const shown = rows.slice(0, MAX_ROWS);
	const ids = single ? [node.id] : shown.map((r) => r.id);
	const q = useQuery({
		...climateQuery(graph.trip.id, ids),
		enabled: mode === "live" && ids.length > 0 && caps?.climate !== false,
	});
	if (caps?.climate === false) return null;
	if (!single && !rows.length) return null;
	if (node?.type === "place") return null;

	const caption = (
		<p
			data-testid={INSIGHTS_TESTID.climateCaption}
			className="text-[11px] leading-4 text-muted-foreground"
		>
			{q.data?.years ?? "2016–2025"} averages · Weather data by{" "}
			<a
				href="https://open-meteo.com/"
				target="_blank"
				rel="noopener noreferrer"
				className="underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground"
			>
				Open-Meteo.com
			</a>{" "}
			(CC BY 4.0) · ERA5, Copernicus
		</p>
	);
	const unavailable = (
		<p
			data-testid={INSIGHTS_TESTID.climateUnavailable}
			className="text-[13px] text-muted-foreground"
		>
			Climate unavailable right now.
		</p>
	);

	if (single) {
		const months = visitMonths(ix, schedule, node.id).slice(0, 2);
		const data = q.data?.byNode[node.id];
		return (
			<section
				data-testid={TESTID.climateCard}
				data-nodeid={nodeId}
				className="grid gap-2"
			>
				<Overline>Climate</Overline>
				{q.isPending && q.fetchStatus !== "idle" ? (
					<Skeleton className="h-10 w-full rounded-lg" />
				) : !data ? (
					unavailable
				) : (
					<div className="grid gap-2.5">
						{months.map((m) => {
							const c = data[m - 1];
							return c ? <MonthLine key={m} month={m} c={c} /> : null;
						})}
					</div>
				)}
				{data ? caption : null}
			</section>
		);
	}

	const scale = q.data
		? Object.values(q.data.byNode).flatMap((ms) =>
				ms.flatMap((m) => [m.tMinC, m.tMaxC]),
			)
		: [];
	const lo = scale.length ? Math.min(...scale) : 0;
	const hi = scale.length ? Math.max(...scale) : 30;
	return (
		<section
			data-testid={TESTID.climateCard}
			data-nodeid={nodeId}
			className="grid gap-2"
		>
			<Overline>Climate · typical for your visit</Overline>
			{q.isPending && q.fetchStatus !== "idle" ? (
				<div className="grid gap-1.5">
					{shown.map((r) => (
						<Skeleton key={r.id} className="h-6 w-full rounded-md" />
					))}
				</div>
			) : q.isError ? (
				unavailable
			) : (
				<ul className="grid">
					{shown.map((r) => {
						const name = ix.node(r.id)?.name ?? "";
						const c = q.data?.byNode[r.id]?.[r.month - 1];
						return (
							<li
								key={r.id}
								data-testid={INSIGHTS_TESTID.climateRow}
								className="grid grid-cols-[minmax(0,1fr)_2.25rem_4rem_4.5rem_auto] items-center gap-x-2 border-b border-border/60 py-1.5 text-[13px] last:border-b-0 max-sm:grid-cols-[minmax(0,1fr)_2.25rem_4rem_auto]"
							>
								<span className="truncate font-medium">{name}</span>
								<span className="text-muted-foreground">
									{MONTH_SHORT[r.month - 1]}
								</span>
								{c ? (
									<>
										<span
											className="font-mono tnum"
											title={`${f(c.tMaxC)}°F / ${f(c.tMinC)}°F`}
										>
											{deg(c.tMaxC)}/{deg(c.tMinC)}
										</span>
										<RangeBar lo={lo} hi={hi} min={c.tMinC} max={c.tMaxC} />
										<span className="text-right text-[12px] text-muted-foreground">
											<span className="font-mono tnum">
												{Math.round(c.wetDays)}
											</span>{" "}
											wet days
										</span>
									</>
								) : (
									<span className="col-span-3 text-[12px] text-muted-foreground max-sm:col-span-2">
										Unavailable
									</span>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{rows.length > MAX_ROWS ? (
				<p className="text-[12px] text-muted-foreground">
					+{rows.length - MAX_ROWS} more
				</p>
			) : null}
			{q.data ? caption : null}
		</section>
	);
}

function MonthLine({ month, c }: { month: number; c: ClimateMonth }) {
	return (
		<div
			data-testid={INSIGHTS_TESTID.climateLine}
			data-month={month}
			className="flex items-start gap-3"
		>
			<CloudSun
				className="mt-0.5 size-4 shrink-0 text-muted-foreground"
				strokeWidth={1.5}
				aria-hidden
			/>
			<div className="grid min-w-0 gap-0.5">
				<p className="text-[13px] leading-5">
					<span className="text-muted-foreground">
						Typical {MONTH_LONG[month - 1]} ·{" "}
					</span>
					<span
						className="font-semibold tnum"
						title={`${f(c.tMaxC)}°F / ${f(c.tMinC)}°F`}
					>
						{deg(c.tMaxC)} / {deg(c.tMinC)}
					</span>
				</p>
				<p className="text-[12px] leading-4 text-muted-foreground">
					<span className="font-mono tnum">{Math.round(c.precipMm)}</span> mm ·{" "}
					<span className="font-mono tnum">{Math.round(c.wetDays)}</span> wet
					days
					{c.sunHours !== null ? (
						<>
							{" "}
							· <span className="font-mono tnum">{Math.round(c.sunHours)}</span>{" "}
							h sun
						</>
					) : null}
				</p>
			</div>
		</div>
	);
}

/** The month's min–max temperature on the table's shared scale (neutral ink: no meaning in colour). */
function RangeBar({
	lo,
	hi,
	min,
	max,
}: {
	lo: number;
	hi: number;
	min: number;
	max: number;
}) {
	const span = Math.max(1, hi - lo);
	const left = ((min - lo) / span) * 100;
	const width = Math.max(4, ((max - min) / span) * 100);
	return (
		<span
			aria-hidden
			className="relative h-1 w-full rounded-full bg-muted max-sm:hidden"
		>
			<span
				className="absolute inset-y-0 rounded-full bg-foreground/35"
				style={{ left: `${left}%`, width: `${Math.min(100 - left, width)}%` }}
			/>
		</span>
	);
}
