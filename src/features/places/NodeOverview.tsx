/**
 * The inspector Overview of a node (SPEC §12.5 `NodeOverview({ nodeId })`,
 * DESIGN §4.4, SPEC §18.3 WP-Places).
 *
 * - **Place:** in the Places data (`usePlacePanel`), everyone's ratings and
 *   yours, where it fits and nearby ideas (else each member's rating); About:
 *   an editable description, the details list (time needed, address, rating,
 *   website and phone as selectable text, local time), the hours via
 *   WP-Insights' `HoursTable` and More details; then scheduled occurrences and
 *   stay nights, travel in and out, and where it's filed with Re-file. The
 *   name, category, status and actions are the panel's header (InspectorBody).
 * - **Country, region, city, area:** visits ("12–18 Apr · 6 nights · 23
 *   stops" with day links), planned vs scheduled days, place and idea counts,
 *   children, local time, open todos and shopping, `ClimateCard` (WP-Insights),
 *   the days-per-city table for countries and regions, Rate…, and Zoom in;
 *   a rateable one (an area) leads with its ratings and where it fits.
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import {
	BedDouble,
	Check,
	ChevronRight,
	Copy,
	FolderInput,
	MapPin,
	Sparkles,
	Star,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { ModeGlyph, TypeGlyph } from "@/components/common/glyphs";
import { MarkdownText } from "@/components/common/markdown-text";
import { TreePicker } from "@/components/common/tree-picker";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ClimateCard } from "@/features/insights/ClimateCard";
import { HoursTable } from "@/features/insights/HoursTable";
import {
	NODE_TYPES,
	TIME_NEEDED,
	type TimeNeeded,
	timeNeededOf,
} from "@/lib/domain/taxonomy";
import { tzLabel } from "@/lib/engine/time";
import { canMoveUnder } from "@/lib/engine/tree";
import type { GraphNode } from "@/lib/engine/types";
import { humanError } from "@/lib/errors";
import {
	formatDateRange,
	formatDayDate,
	formatDuration,
	formatTime,
} from "@/lib/format";
import { tripKeys } from "@/lib/query/keys";
import { capabilitiesQuery } from "@/lib/query/trip-queries";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { DaysPerCityTable, PlannedDaysLine } from "./DaysPerCityTable";
import {
	ancestorsOf,
	occurrencesOf,
	openListCounts,
	placeCounts,
	placesInside,
	stayNightsOf,
	travelOf,
	unscheduledOf,
	visitsOf,
} from "./lib/node-facts";
import { rateableNodes } from "./lib/rate";
import { useMoveNode, useUpdateNode } from "./mutations";
import { getPlaceMoreDetails } from "./places.functions";
import {
	PlaceFits,
	PlaceRatings,
	PlaceTimeNeeded,
	usePlacePanel,
} from "./tab/PlacePanel";
import { PLACES_TESTID } from "./testids";
import { MemberRatings } from "./ui/member-ratings";
import { ZonePicker } from "./ui/zone-picker";

export function NodeOverview({ nodeId }: { nodeId: string }) {
	const { ix } = useWorkspace();
	const panel = usePlacePanel();
	const node = ix.node(nodeId);
	if (!node)
		return (
			<p className="text-sm text-muted-foreground">This place was removed.</p>
		);
	return (
		<div
			data-testid={TESTID.nodeOverview}
			data-type={node.type}
			className="grid gap-5 text-sm"
		>
			{node.type === "place" ? (
				<PlaceOverview node={node} />
			) : (
				<>
					{panel ? (
						<>
							<PlaceRatings />
							<PlaceFits />
						</>
					) : null}
					<CoarseOverview node={node} />
				</>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Section({
	title,
	children,
	action,
	testId,
}: {
	title: string;
	children: ReactNode;
	action?: ReactNode;
	testId?: string;
}) {
	return (
		<section className="grid gap-1.5" data-testid={testId}>
			<div className="flex items-center gap-2">
				<h3 className="text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
					{title}
				</h3>
				{action ? <div className="ml-auto">{action}</div> : null}
			</div>
			{children}
		</section>
	);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="contents">
			<dt className="pt-px text-xs text-muted-foreground">{label}</dt>
			<dd className="min-w-0 text-[13px] break-words">{children}</dd>
		</div>
	);
}

function CopyText({ text, href }: { text: string; href?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<span className="inline-flex max-w-full items-center gap-1">
			{href ? (
				<a
					href={href}
					target="_blank"
					rel="noopener noreferrer nofollow"
					className="truncate text-primary underline-offset-2 hover:underline select-text"
				>
					{text}
				</a>
			) : (
				<span className="truncate select-text">{text}</span>
			)}
			<button
				type="button"
				aria-label={`Copy ${text}`}
				className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
				onClick={() => {
					void navigator.clipboard?.writeText(text).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1200);
					});
				}}
			>
				{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
			</button>
		</span>
	);
}

function LocalTime({ tz, node }: { tz: string; node: GraphNode }) {
	// The one place that shows the zone NOW, and says so (FB-20); every other
	// label is for the moment it describes.
	const now = Date.now();
	return (
		<span className="inline-flex flex-wrap items-center gap-x-2">
			<span
				className="font-mono text-xs tnum"
				data-testid={PLACES_TESTID.localTimeNow}
			>
				<span className="font-sans text-muted-foreground">Now </span>
				{formatTime(now, tz)} {tzLabel(tz, now)}
			</span>
			<ZonePicker node={node} />
		</span>
	);
}

/**
 * "Rate 11 places in Tokyo" → the Places tab's Rate feed at that scope
 * (docs/PLACES.md §1b). A plain anchor the workspace navigation takes over;
 * hidden in the fixture (the feed needs the live trip).
 */
function RateLink({ node, count }: { node: GraphNode | null; count: number }) {
	const { mode, nav } = useWorkspace();
	if (!count || mode !== "live") return null;
	const opts = { scopeId: node?.id ?? null, patch: { pv: "rate" as const } };
	return (
		<a
			href={nav.hrefPlaces(opts)}
			onClick={(e) => {
				if (e.metaKey || e.ctrlKey || e.shiftKey) return;
				e.preventDefault();
				nav.openPlaces(opts);
			}}
			data-testid={PLACES_TESTID.rateLink}
			className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
		>
			<Star className="size-3" strokeWidth={1.5} />
			Rate {count} {count === 1 ? "place" : "places"}
			{node ? ` in ${node.name}` : ""}
			<ChevronRight className="size-3" />
		</a>
	);
}

// ---------------------------------------------------------------------------
// Place
// ---------------------------------------------------------------------------

function Description({ node }: { node: GraphNode }) {
	const { graph } = useWorkspace();
	const guard = useEditGuard();
	const update = useUpdateNode(graph.trip.id);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(node.description ?? "");
	if (editing)
		return (
			<div className="grid gap-1.5" data-testid={PLACES_TESTID.description}>
				<Textarea
					autoFocus
					value={draft}
					maxLength={500}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="One line: what it is and why it's here"
					className="min-h-16 text-[13px]"
					onKeyDown={(e) => {
						if (e.key === "Escape") setEditing(false);
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
							e.currentTarget.form?.requestSubmit();
					}}
				/>
				<div className="flex justify-end gap-2">
					<Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
						Cancel
					</Button>
					<Button
						size="xs"
						onClick={() => {
							setEditing(false);
							if (draft.trim() === (node.description ?? "").trim()) return;
							update.mutate(
								{ nodeId: node.id, patch: { description: draft.trim() } },
								{ onError: (e) => toast.error(humanError(e)) },
							);
						}}
					>
						Save
					</Button>
				</div>
			</div>
		);
	return (
		<div data-testid={PLACES_TESTID.description}>
			{node.description ? (
				<button
					type="button"
					disabled={guard.disabled}
					onClick={() => {
						setDraft(node.description ?? "");
						setEditing(true);
					}}
					className="w-full rounded-md text-left text-[13px] leading-5 text-foreground/90 enabled:hover:bg-accent/60 disabled:cursor-text"
					title={guard.disabled ? undefined : "Edit description"}
				>
					<MarkdownText md={node.description} />
				</button>
			) : guard.disabled ? null : (
				<button
					type="button"
					onClick={() => {
						setDraft("");
						setEditing(true);
					}}
					className="text-[13px] text-muted-foreground hover:text-foreground"
				>
					Add a description
				</button>
			)}
		</div>
	);
}

function TimeNeededSelect({ node }: { node: GraphNode }) {
	const { graph } = useWorkspace();
	const guard = useEditGuard();
	const update = useUpdateNode(graph.trip.id);
	const bucket = timeNeededOf(node.timeNeededMin);
	return (
		<Select
			value={bucket ?? ""}
			disabled={guard.disabled}
			onValueChange={(v) =>
				update.mutate(
					{
						nodeId: node.id,
						patch: { timeNeededMin: TIME_NEEDED[v as TimeNeeded].minutes },
					},
					{ onError: (e) => toast.error(humanError(e)) },
				)
			}
		>
			<SelectTrigger
				size="sm"
				aria-label="Time needed"
				className="h-7 w-fit gap-1.5 border-none px-1.5 shadow-none"
			>
				<SelectValue
					placeholder={
						node.timeNeededMin ? formatDuration(node.timeNeededMin) : "Not set"
					}
				/>
			</SelectTrigger>
			<SelectContent>
				{Object.entries(TIME_NEEDED).map(([k, t]) => (
					<SelectItem key={k} value={k}>
						{t.label}
						<span className="font-mono text-xs text-muted-foreground">
							{t.short}
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function MoreDetails({ node }: { node: GraphNode }) {
	const caps = useQuery(capabilitiesQuery()).data;
	const { graph } = useWorkspace();
	const run = useTripMutation(
		() => getPlaceMoreDetails({ data: { nodeId: node.id } }),
		{ keys: [tripKeys.graph(graph.trip.id)] },
	);
	if (!caps?.google || !node.googlePlaceId) return null;
	const fetched = node.details.enterpriseFetchedAt;
	return (
		<EditGuard kind="edit-only" reason="Suggesters can't fetch place details">
			<Button
				size="xs"
				variant="ghost"
				data-testid={PLACES_TESTID.moreDetails}
				disabled={run.isPending}
				onClick={() =>
					run.mutate(undefined, {
						onError: (e) => toast.error(humanError(e)),
					})
				}
			>
				<Sparkles />
				{fetched ? "Refresh details" : "More details"}
			</Button>
		</EditGuard>
	);
}

function PlaceOverview({ node }: { node: GraphNode }) {
	const ws = useWorkspace();
	const { ix, schedule, nav, graph } = ws;
	const panel = usePlacePanel();
	const guard = useEditGuard();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const move = useMoveNode(graph.trip.id);
	const tz = ix.tzOf(node.id);
	const occurrences = occurrencesOf(ix, node.id);
	const unscheduled = unscheduledOf(ix, node.id);
	const nights = stayNightsOf(ix, node.id);
	const d = node.details;
	const first = occurrences[0];
	const travel = first ? travelOf(ix, schedule, first.id) : [];
	const rating =
		typeof d.rating === "number"
			? `${d.rating.toFixed(1)}${d.ratingCount ? ` · ${compact(d.ratingCount)}` : ""}`
			: null;
	return (
		<>
			{panel ? (
				<>
					<PlaceRatings />
					<PlaceFits />
				</>
			) : (
				<Section title="Priority">
					<MemberRatings node={node} />
				</Section>
			)}

			<Section title="About" testId={PLACES_TESTID.about}>
				<Description node={node} />
				<dl className="mt-1 grid grid-cols-[88px_1fr] items-baseline gap-x-3 gap-y-2">
					<Row label="Time needed">
						{panel ? (
							<PlaceTimeNeeded />
						) : (
							<span className="-ml-1.5 inline-flex">
								<TimeNeededSelect node={node} />
							</span>
						)}
					</Row>
					{node.address ? (
						<Row label="Address">
							<CopyText text={node.address} />
						</Row>
					) : null}
					{node.lat === null || node.lng === null ? (
						<Row label="Location">
							<EditGuard>
								<Button
									size="xs"
									variant="outline"
									data-testid={PLACES_TESTID.setLocation}
									onClick={() =>
										openAddPlace({ mode: "locate", nodeId: node.id })
									}
								>
									<MapPin />
									Set location…
								</Button>
							</EditGuard>
						</Row>
					) : null}
					{rating ? (
						<Row label="Rating">
							<span className="font-mono text-xs tnum">{rating}</span>
						</Row>
					) : null}
					{d.website ? (
						<Row label="Website">
							<CopyText
								text={d.website
									.replace(/^https?:\/\/(www\.)?/, "")
									.replace(/\/$/, "")}
								href={d.website}
							/>
						</Row>
					) : null}
					{d.phone ? (
						<Row label="Phone">
							<CopyText text={d.phone} />
						</Row>
					) : null}
					{d.priceLevel ? (
						<Row label="Price">
							<span className="text-xs">{priceLabel(d.priceLevel)}</span>
						</Row>
					) : null}
					<Row label="Local time">
						<LocalTime tz={tz} node={node} />
					</Row>
				</dl>

				{/* WP-Insights' week grid carries its own heading, source line
			    ("From the sheet: …", "Google · 3 Sep") and Edit/Confirm. */}
				<div className="mt-3">
					<HoursTable nodeId={node.id} />
				</div>
				<MoreDetails node={node} />
			</Section>

			{occurrences.length || unscheduled.length || nights.length ? (
				<Section title="Scheduled">
					<ul className="grid gap-0.5">
						{occurrences.slice(0, 12).map((it) => {
							const s = schedule.items[it.id];
							const day = ix.day(it.dayId);
							return (
								<li key={it.id}>
									<button
										type="button"
										data-testid={PLACES_TESTID.occurrence}
										className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[13px] hover:bg-accent"
										onClick={() => nav.select({ kind: "item", id: it.id })}
									>
										<span className="font-medium">
											Day {day ? ix.dayNumber(day.id) : "?"}
										</span>
										<span className="text-muted-foreground">
											{day ? formatDayDate(day.date) : ""}
										</span>
										<span className="ml-auto font-mono text-xs tnum text-muted-foreground">
											{s ? formatTime(s.start, s.tz) : ""}
											{" · "}
											{formatDuration(it.durationMin)}
										</span>
									</button>
								</li>
							);
						})}
						{unscheduled.map((it) => (
							<li key={it.id}>
								<button
									type="button"
									className="w-full rounded px-1 py-0.5 text-left text-[13px] text-muted-foreground hover:bg-accent"
									onClick={() => nav.select({ kind: "item", id: it.id })}
								>
									Unscheduled · {formatDuration(it.durationMin)}
								</button>
							</li>
						))}
						{nights.map((day) => (
							<li key={day.id}>
								<button
									type="button"
									className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[13px] hover:bg-accent"
									onClick={() => nav.select({ kind: "day", id: day.id })}
								>
									<BedDouble
										className="size-3.5 text-mode-other"
										strokeWidth={1.5}
									/>
									Stay · night of Day {ix.dayNumber(day.id)}
									<span className="ml-auto text-xs text-muted-foreground">
										{formatDayDate(day.date)}
									</span>
								</button>
							</li>
						))}
					</ul>
				</Section>
			) : null}

			{travel.length ? (
				<Section title="Travel">
					<ul className="grid gap-0.5">
						{travel.map((h) => {
							const other = ix.node(h.otherNodeId)?.name ?? "the previous stop";
							return (
								<li key={`${h.fromItemId}>${h.toItemId}`}>
									<button
										type="button"
										className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[13px] hover:bg-accent"
										onClick={() =>
											nav.select({
												kind: "leg",
												target: {
													kind: "pair",
													fromItemId: h.fromItemId,
													toItemId: h.toItemId,
												},
											})
										}
									>
										<span className="w-7 text-xs text-muted-foreground">
											{h.dir === "in" ? "In" : "Out"}
										</span>
										{h.leg?.mode ? <ModeGlyph mode={h.leg.mode} /> : null}
										<span className="min-w-0 flex-1 truncate">
											{h.leg?.mode ? `${h.leg.mode} ` : ""}
											{h.minutes !== null ? (
												<span className="font-mono text-xs tnum">
													{formatDuration(h.minutes)}
													{h.estimate ? " est." : ""}
												</span>
											) : null}
											{h.dir === "in" ? " from " : " to "}
											{other}
											{h.leg?.mode ? null : (
												<span className="text-muted-foreground">
													{" "}
													· no mode yet
												</span>
											)}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				</Section>
			) : null}

			<Section title="Filed under">
				<div className="flex min-w-0 items-center gap-2">
					<span className="min-w-0 flex-1 truncate text-[13px]">
						{ancestorsOf(ix, node.id)
							.map((n) => n.name)
							.join(" › ") || "Top level"}
					</span>
					<TreePicker
						value={node.parentId}
						allowRoot={false}
						filter={(n) => n.type !== "place" || n.id === node.parentId}
						disabledReason={(n) =>
							n.id === node.id || ix.isWithin(n.id, node.id)
								? "A place can't go inside itself"
								: canMoveUnder(ix, node.id, n.id)
									? null
									: `A place can't go inside a ${n.type}`
						}
						onChange={(parentId) => {
							if (!parentId || parentId === node.parentId) return;
							move.mutate(
								{ nodeId: node.id, parentId },
								{ onError: (e) => toast.error(humanError(e)) },
							);
						}}
						trigger={
							<Button
								size="xs"
								variant="ghost"
								disabled={guard.disabled}
								data-testid={PLACES_TESTID.refile}
							>
								<FolderInput />
								Re-file
							</Button>
						}
					/>
				</div>
			</Section>
		</>
	);
}

function compact(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
	return String(n);
}

function priceLabel(level: string): string {
	const map: Record<string, string> = {
		PRICE_LEVEL_FREE: "Free",
		PRICE_LEVEL_INEXPENSIVE: "¥",
		PRICE_LEVEL_MODERATE: "¥¥",
		PRICE_LEVEL_EXPENSIVE: "¥¥¥",
		PRICE_LEVEL_VERY_EXPENSIVE: "¥¥¥¥",
	};
	return map[level] ?? level;
}

// ---------------------------------------------------------------------------
// Country / region / city / area
// ---------------------------------------------------------------------------

function CoarseOverview({ node }: { node: GraphNode }) {
	const { ix, nav, counts, graph } = useWorkspace();
	const visits = visitsOf(ix, node.id);
	const children = ix.children(node.id);
	const pc = placeCounts(ix, node.id);
	const lists = openListCounts(ix, counts, node.id);
	const tz = ix.tzOf(node.id);
	// The Rate screen's set: proposal ghosts aren't rated until accepted.
	const liveIds = useMemo(
		() => new Set(graph.nodes.map((n) => n.id)),
		[graph.nodes],
	);
	const rateable = rateableNodes(ix, node.id, { liveIds }).length;
	const showTable = node.type === "country" || node.type === "region";
	return (
		<>
			{node.description ? (
				<MarkdownText md={node.description} className="text-[13px]" />
			) : null}

			<Section title="Visits" testId={PLACES_TESTID.visits}>
				{visits.length ? (
					<ul className="grid gap-0.5">
						{visits.map((v) => {
							const firstDay = v.days[0];
							const lastDay = v.days.at(-1);
							if (!firstDay || !lastDay) return null;
							return (
								<li
									key={firstDay.id}
									className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]"
								>
									<span className="font-medium">
										{formatDateRange(firstDay.date, lastDay.date)}
									</span>
									<span className="text-muted-foreground">
										{v.nights
											? `${v.nights} ${v.nights === 1 ? "night" : "nights"} · `
											: ""}
										{v.stops} {v.stops === 1 ? "stop" : "stops"}
									</span>
									<span className="flex flex-wrap gap-1">
										{v.days.map((d) => (
											<button
												key={d.id}
												type="button"
												onClick={() => nav.select({ kind: "day", id: d.id })}
												className="rounded-full bg-muted px-1.5 font-mono text-[11px] tnum text-muted-foreground hover:bg-accent hover:text-foreground"
												title={formatDayDate(d.date)}
											>
												D{ix.dayNumber(d.id)}
											</button>
										))}
									</span>
								</li>
							);
						})}
					</ul>
				) : (
					<p className="text-[13px] text-muted-foreground">
						Not on the plan yet.
					</p>
				)}
			</Section>

			<dl className="grid grid-cols-[88px_1fr] items-baseline gap-x-3 gap-y-2">
				{node.type === "city" || node.details.plannedDays !== undefined ? (
					<Row label="Days">
						<PlannedDaysLine node={node} />
					</Row>
				) : null}
				<Row label="Places">
					<span className="text-[13px]">
						<span className="font-mono tnum">{pc.places}</span>{" "}
						{pc.places === 1 ? "place" : "places"}
						{pc.ideas ? (
							<>
								{" · "}
								<span className="font-mono tnum">{pc.ideas}</span>{" "}
								{pc.ideas === 1 ? "idea" : "ideas"}
							</>
						) : null}
					</span>
				</Row>
				<Row label="Local time">
					<LocalTime tz={tz} node={node} />
				</Row>
				{lists.todo || lists.shop ? (
					<Row label="Lists">
						<button
							type="button"
							className="text-[13px] text-primary hover:underline"
							onClick={() => {
								nav.zoomTo(node.id);
								nav.setTab("lists");
							}}
						>
							{lists.todo
								? `${lists.todo} open ${lists.todo === 1 ? "to-do" : "to-dos"}`
								: ""}
							{lists.todo && lists.shop ? " · " : ""}
							{lists.shop ? `${lists.shop} to buy` : ""}
						</button>
					</Row>
				) : null}
			</dl>

			{children.length ? (
				<Section title="Inside" testId={PLACES_TESTID.children}>
					<ul className="grid gap-0.5">
						{children.map((c) => {
							const n = c.type === "place" ? 0 : placesInside(ix, c.id);
							return (
								<li key={c.id}>
									<button
										type="button"
										onClick={() => nav.select({ kind: "node", id: c.id })}
										onDoubleClick={() => nav.zoomIn(c.id)}
										className={cn(
											"flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-accent",
											ix.isDropped(c.id) &&
												"text-muted-foreground line-through",
										)}
									>
										<TypeGlyph type={c.type} category={c.category} />
										<span className="min-w-0 flex-1 truncate text-[13px]">
											{c.name}
										</span>
										{c.type !== "place" ? (
											<span className="text-xs text-muted-foreground">
												{NODE_TYPES[c.type].label.toLowerCase()}
												{n ? (
													<>
														{" · "}
														<span className="font-mono tnum">{n}</span>
													</>
												) : null}
											</span>
										) : null}
									</button>
								</li>
							);
						})}
					</ul>
				</Section>
			) : null}

			{node.type === "city" || node.type === "area" ? (
				<ClimateCard nodeId={node.id} />
			) : null}
			{showTable ? (
				<>
					<ClimateCard nodeId={node.id} />
					<Section title="Days per city">
						<DaysPerCityTable scopeId={node.id} compact />
					</Section>
				</>
			) : null}

			<div className="flex flex-wrap items-center gap-3">
				<Button
					className="w-fit"
					onClick={() => nav.zoomIn(node.id)}
					data-testid={PLACES_TESTID.zoomIn}
				>
					Zoom in
				</Button>
				<RateLink node={node} count={rateable} />
			</div>
		</>
	);
}
