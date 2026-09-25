/**
 * E1: the week grid in NodeOverview (WP-Places mounts it): Mon–Sun in 13px
 * mono (the visit's weekdays bold, today with a dot), holidays, exceptions,
 * the rules in words ("Closed 2nd Tue · Last entry 60 min before close"), the
 * source line and Edit. Sheet hours offer "Confirm" (opens the editor
 * prefilled; saving stores them as manual). OpenStreetMap hours say so,
 * with a link to the OSM object and the ODbL attribution. Empty: "Hours
 * unknown." + Add hours (+ Fetch with a Google key); an OSM tag the model
 * couldn't read shows there, quoted. Open `node.hours` suggestions show above
 * the grid as dashed rows in the author's colour, naming what changes (the
 * week only when it differs, plus special dates, rules and the note:
 * "Closed Tue 5 Oct 2027"); reviewing them is WP-Suggest's `ProposalBar`; a
 * click opens the suggestion.
 *
 * Viewers (`access.mode === 'read'`) see the hours but no Edit, Confirm, Add
 * or Fetch (QA HRS-08, SHARE-03); a writer who is offline still sees them,
 * disabled, with the reason (SPEC §0 rule 17).
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { Check, Download, PencilLine } from "lucide-react";
import { useEditGuard } from "@/components/common/edit-guard";
import { MemberAvatar, presenceColor } from "@/components/common/member";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { Button } from "@/components/ui/button";
import {
	effectiveHours,
	isNoteOnlyHours,
	shortDate,
	weekdayOf,
} from "@/lib/engine/hours";
import { localDateOf } from "@/lib/engine/time";
import { todayIn } from "@/lib/format";
import { tripKeys } from "@/lib/query/keys";
import { capabilitiesQuery } from "@/lib/query/trip-queries";
import { OpeningHours } from "@/lib/schemas/hours";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	hoursDiff,
	hoursDiffText,
	rangeText,
	rulesInWords,
	sourceLabel,
	weekRows,
} from "./hours-format";
import { fetchOpeningHours } from "./insights.functions";
import { OsmHoursSource } from "./OsmHoursSource";
import { INSIGHTS_TESTID } from "./testids";
import { Overline } from "./ui";

export function HoursTable({ nodeId }: { nodeId: string }) {
	const { ix, graph, schedule, mode, proposals, nav, access } = useWorkspace();
	const openHoursEditor = useUi((s) => s.openHoursEditor);
	const guard = useEditGuard();
	const fetchGuard = useEditGuard("edit-only", "Suggesters can't fetch hours");
	const caps = useQuery({
		...capabilitiesQuery(),
		enabled: mode === "live",
	}).data;
	const tripId = graph.trip.id;
	const fetchHours = useTripMutation(
		(v: { tripId: string; nodeIds: string[] }) =>
			fetchOpeningHours({ data: v }),
		{ keys: [tripKeys.graph(tripId)] },
	);
	const node = ix.node(nodeId);
	if (!node) return null;
	const found = effectiveHours(node, graph.trip.settings);
	// OSM hours that are only the raw tag say nothing about any day.
	const osmNote =
		found?.source === "osm" && isNoteOnlyHours(found.hours)
			? found.hours
			: null;
	const eh = osmNote ? null : found;
	const raw = node.details?.openHoursText?.trim() || null;
	// Only places (and anything that carries hours) get a table.
	if (!eh && !raw && !osmNote && node.type !== "place") return null;

	const tz = ix.tzOf(node.id);
	const today = weekdayOf(todayIn(tz));
	const visitDays = new Set<number>();
	for (const [, items] of ix.itemsByDay)
		for (const item of items) {
			if (!item.nodeId || !ix.isWithin(item.nodeId, node.id)) continue;
			const s = schedule.items[item.id];
			if (s) visitDays.add(weekdayOf(localDateOf(s.start, tz)));
		}
	const canFetch =
		!!caps?.google && !!node.googlePlaceId && eh?.source !== "manual";
	const suggested = proposals.list.filter(
		(p) =>
			p.status === "open" && p.op === "node.hours" && p.entityId === nodeId,
	);
	const edit = () => openHoursEditor({ nodeId: node.id });
	const readOnly = access.mode === "read";

	return (
		<section
			data-testid={TESTID.hoursTable}
			data-nodeid={nodeId}
			data-source={found?.source ?? "none"}
			className="grid gap-2"
		>
			<div className="flex items-center justify-between gap-2">
				<Overline>Opening hours</Overline>
				{eh && !readOnly ? (
					<Button
						variant="ghost"
						size="sm"
						data-testid={INSIGHTS_TESTID.hoursTableEdit}
						disabled={guard.disabled}
						title={guard.reason ?? undefined}
						onClick={edit}
						className="-mr-2 h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
					>
						<PencilLine className="size-3.5" strokeWidth={1.75} aria-hidden />
						Edit
					</Button>
				) : null}
			</div>
			{suggested.length ? (
				<ul
					data-testid={INSIGHTS_TESTID.hoursSuggested}
					className="grid gap-1.5"
				>
					{suggested.map((p) => {
						const parsed = OpeningHours.nullable().safeParse(p.payload.hours);
						const hours = parsed.success ? parsed.data : undefined;
						// Only what changes against the hours shown now (COLLAB-R2-08).
						const diff = hours ? hoursDiff(eh?.hours, hours) : null;
						const rows = diff?.week ?? [];
						const changes = diff?.changes ?? [];
						const text =
							hours === null
								? "Remove these hours"
								: diff
									? hoursDiffText(diff)
									: "New hours";
						return (
							<li key={p.id}>
								<button
									type="button"
									onClick={() => nav.select({ kind: "proposal", id: p.id })}
									aria-description={`Suggested by ${p.author.name}: ${text}`}
									style={{ borderColor: presenceColor(p.author.color) }}
									className="grid w-full gap-1 rounded-lg border-[1.5px] border-dashed px-2.5 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
								>
									<span className="flex items-center gap-1.5 text-[12px] leading-4 text-muted-foreground">
										<MemberAvatar
											size={16}
											ring={false}
											user={{
												name: p.author.name,
												color: p.author.color,
												memberId: p.author.memberId,
												guest: p.author.isGuest,
											}}
										/>
										<span className="min-w-0 truncate">
											{p.author.name} suggests
										</span>
										<span
											className={cn(
												"ml-auto shrink-0",
												access.canReview
													? "font-medium text-primary"
													: "text-muted-foreground",
											)}
										>
											{access.canReview ? "Review" : "Waiting for review"}
										</span>
									</span>
									{rows.length ? (
										<span className="grid grid-cols-[calc(5rem-11.5px)_1fr] text-[13px] leading-5">
											{rows.map((r) => (
												<span key={r.days} className="contents">
													<span className="text-muted-foreground">
														{r.days}
													</span>
													<span
														className={cn(
															"font-mono tnum",
															r.state === "closed" && "text-muted-foreground",
														)}
													>
														{r.text}
													</span>
												</span>
											))}
										</span>
									) : null}
									{changes.length ? (
										<span
											data-testid={INSIGHTS_TESTID.hoursSuggestedChange}
											className="grid text-[13px] leading-5"
										>
											{changes.map((c) => (
												<span
													key={`${c.removed ? "-" : "+"}${c.text}`}
													data-removed={c.removed || undefined}
													className={cn(
														c.removed &&
															"text-muted-foreground line-through decoration-muted-foreground/60",
													)}
												>
													{c.removed ? (
														<span className="sr-only">Removes </span>
													) : null}
													{c.text}
												</span>
											))}
										</span>
									) : null}
									{!rows.length && !changes.length ? (
										<span className="text-[13px] leading-5">{text}</span>
									) : null}
								</button>
							</li>
						);
					})}
				</ul>
			) : null}
			{eh ? (
				<>
					<dl className="grid grid-cols-[5rem_1fr] gap-y-0.5 text-[13px] leading-[22px]">
						{weekRows(eh.hours).map((r) => {
							const visit = r.day <= 6 && visitDays.has(r.day);
							const isToday = r.day === today;
							return (
								<div
									key={r.day}
									data-testid={INSIGHTS_TESTID.hoursTableRow}
									data-day={r.day}
									data-visit={visit || undefined}
									className="contents"
								>
									<dt
										className={cn(
											"flex items-center gap-1.5",
											visit
												? "font-semibold text-foreground"
												: "text-muted-foreground",
										)}
									>
										{r.label}
										{isToday ? (
											<span
												title="Today"
												className="size-1.5 rounded-full bg-glow"
											>
												<span className="sr-only">(today)</span>
											</span>
										) : null}
									</dt>
									<dd
										className={cn(
											"font-mono tnum",
											r.state === "closed" || r.state === "unknown"
												? "text-muted-foreground"
												: "text-foreground",
											visit && "font-semibold",
										)}
									>
										{r.text}
										{r.lastEntry ? (
											<span className="ml-2 font-sans text-[12px] font-normal text-muted-foreground">
												last entry {r.lastEntry}
											</span>
										) : null}
									</dd>
								</div>
							);
						})}
					</dl>
					{eh.hours.exceptions?.length ? (
						<ul className="grid gap-0.5 text-[12px] leading-4 text-muted-foreground">
							{eh.hours.exceptions.map((e) => (
								<li key={e.date}>
									<span className="font-mono text-foreground tnum">
										{shortDate(e.date)}
									</span>
									{" · "}
									{e.closed || !e.periods?.length
										? "Closed"
										: e.periods.map(rangeText).join(", ")}
									{e.label ? ` · ${e.label}` : ""}
								</li>
							))}
						</ul>
					) : null}
					{rulesInWords(eh).length ? (
						<p
							data-testid={INSIGHTS_TESTID.hoursRules}
							className="text-[12px] leading-4 text-muted-foreground"
						>
							{rulesInWords(eh).join(" · ")}
						</p>
					) : null}
					{eh.hours.note ? (
						<p className="text-[12px] leading-4 text-muted-foreground">
							{eh.hours.note}
						</p>
					) : null}
					<SourceLine
						label={
							eh.source === "osm" ? (
								<OsmHoursSource node={node} updatedAt={eh.hours.updatedAt} />
							) : (
								sourceLabel(eh)
							)
						}
						raw={eh.source === "sheet" ? (eh.raw ?? null) : null}
						medium={eh.confidence === "medium"}
						action={
							readOnly ? null : eh.source === "sheet" ? (
								<button
									type="button"
									data-testid={INSIGHTS_TESTID.hoursTableConfirm}
									disabled={guard.disabled}
									title={guard.reason ?? undefined}
									onClick={edit}
									className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
								>
									<Check className="size-3" strokeWidth={2} aria-hidden />
									Confirm
								</button>
							) : canFetch ? (
								<FetchButton
									pending={fetchHours.isPending}
									disabled={fetchGuard.disabled}
									reason={fetchGuard.reason}
									onClick={() =>
										fetchHours.mutate({ tripId, nodeIds: [node.id] })
									}
								/>
							) : null
						}
					/>
				</>
			) : (
				<div className="grid gap-2">
					<p className="font-display text-[15px] leading-6 font-medium">
						Hours unknown.
					</p>
					{raw ? (
						<SourceLine
							label="From the sheet"
							raw={raw}
							medium={false}
							action={null}
						/>
					) : null}
					{osmNote ? (
						<SourceLine
							label={<OsmHoursSource node={node} quote={osmNote.note} />}
							raw={null}
							medium={false}
							action={null}
						/>
					) : null}
					{readOnly ? null : (
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="outline"
								data-testid={INSIGHTS_TESTID.hoursTableAdd}
								disabled={guard.disabled}
								title={guard.reason ?? undefined}
								onClick={edit}
								className="h-8"
							>
								Add hours
							</Button>
							{canFetch ? (
								<Button
									size="sm"
									variant="ghost"
									data-testid={INSIGHTS_TESTID.hoursFetch}
									disabled={fetchGuard.disabled || fetchHours.isPending}
									title={fetchGuard.reason ?? undefined}
									onClick={() =>
										fetchHours.mutate({ tripId, nodeIds: [node.id] })
									}
									className="h-8 gap-1"
								>
									<Download
										className="size-3.5"
										strokeWidth={1.75}
										aria-hidden
									/>
									{fetchHours.isPending ? "Fetching…" : "Fetch from Google"}
								</Button>
							) : null}
						</div>
					)}
				</div>
			)}
		</section>
	);
}

function SourceLine({
	label,
	raw,
	medium,
	action,
}: {
	label: React.ReactNode;
	raw: string | null;
	medium: boolean;
	action: React.ReactNode;
}) {
	return (
		<p
			data-testid={INSIGHTS_TESTID.hoursSource}
			className="text-[12px] leading-4 text-muted-foreground"
		>
			{label}
			{raw ? (
				<>
					: “<span className="italic">{raw}</span>”
				</>
			) : null}
			{medium ? " · approximate" : ""}
			{action ? <> · {action}</> : null}
		</p>
	);
}

function FetchButton({
	pending,
	disabled,
	reason,
	onClick,
}: {
	pending: boolean;
	disabled: boolean;
	reason: string | null;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			data-testid={INSIGHTS_TESTID.hoursFetch}
			disabled={disabled || pending}
			title={reason ?? undefined}
			onClick={onClick}
			className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
		>
			<Download className="size-3" strokeWidth={1.75} aria-hidden />
			{pending ? "Fetching…" : "Refresh"}
		</button>
	);
}
