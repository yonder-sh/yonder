/**
 * Map controls (DESIGN §5.1): a stack of 32px square buttons (44px on a phone
 * or a touch screen, DESIGN §6 / QA MOB-07) — fit, the layer
 * menu (Map style · Show · Selected days · Legend), the shared place filter
 * (ADDENDUM §10) and zoom ± (hidden on touch). Plus the chips that float over the map
 * (DESIGN §9.4): "Show areas", the active-filter summary, the empty card.
 */
import { cn } from "cn";
import {
	ArrowDownRight,
	CloudOff,
	Layers,
	ListFilter,
	Maximize2,
	Minus,
	Plus,
	Satellite,
	Undo2,
	X,
} from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";
import { EditGuard } from "@/components/common/edit-guard";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	PIN_FAMILIES,
	PLACE_GROUPS,
	type PlaceGroup,
	PRIORITIES,
	PRIORITY_ORDER,
} from "@/lib/domain/taxonomy";
import type { GraphMember } from "@/lib/engine/types";
import { bool, useFollowState } from "@/lib/realtime/view-ui";
import type { Priority } from "@/lib/schemas/enums";
import {
	EMPTY_FILTER,
	isEmptyFilter,
	type WorkspaceFilter,
} from "@/lib/workspace/filter";
import { isActiveFilter } from "@/lib/workspace/filter-match";
import { useUi } from "@/lib/workspace/ui-store";
import type { MapShow } from "./map-data";
import { FLIGHT_GAP, FLIGHT_RULE } from "./map-layers";
import type { LinePalette } from "./palette";
import { MAP_TESTID } from "./testids";

function ControlButton({
	label,
	onClick,
	children,
	testId,
	active,
	...rest
}: {
	label: string;
	onClick?: () => void;
	children: ReactNode;
	testId: string;
	active?: boolean;
} & Record<string, unknown>) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					data-testid={testId}
					onClick={onClick}
					className={cn("yonder-map-ctl", active && "is-active")}
					{...rest}
				>
					{children}
				</button>
			</TooltipTrigger>
			<TooltipContent side="left">{label}</TooltipContent>
		</Tooltip>
	);
}

export type MapControlsProps = {
	variant: "desktop" | "mobile";
	palette: LinePalette;
	style: React.CSSProperties;
	/** Satellite imagery instead of the map (the map is otherwise the app theme's). */
	satellite: boolean;
	setSatellite(on: boolean): void;
	onFit(): void;
	onZoom(delta: 1 | -1): void;
	show: MapShow;
	setShow(patch: Partial<MapShow>): void;
	dayMode: "only" | "dim";
	setDayMode(m: "only" | "dim"): void;
	daysActive: boolean;
	filter: WorkspaceFilter;
	setFilter(f: WorkspaceFilter): void;
	members: readonly GraphMember[];
	meMemberId: string | null;
	/** The filter menu, controlled so the "Filtered" chip can open it. */
	filterOpen?: boolean;
	onFilterOpenChange?(open: boolean): void;
};

export function MapControls(p: MapControlsProps) {
	const filtered = isActiveFilter(p.filter, p.meMemberId);
	// FB-21d: the layer panel being open travels with my view.
	const [layersOpen, setLayersOpen] = useFollowState("map.layers", false, bool);
	return (
		<div
			className={cn(
				"yonder-map-controls",
				p.variant === "mobile" && "is-touch",
			)}
			data-testid={MAP_TESTID.controls}
			style={p.style}
		>
			<ControlButton
				label="Fit to the scope"
				testId={MAP_TESTID.fit}
				onClick={p.onFit}
			>
				<Maximize2 aria-hidden strokeWidth={1.75} />
			</ControlButton>
			<ControlButton
				label="Satellite"
				testId={MAP_TESTID.satellite}
				active={p.satellite}
				aria-pressed={p.satellite}
				onClick={() => p.setSatellite(!p.satellite)}
			>
				<Satellite aria-hidden strokeWidth={1.75} />
			</ControlButton>
			<Popover open={layersOpen} onOpenChange={setLayersOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label="Map layers and legend"
						data-testid={MAP_TESTID.layersButton}
						className="yonder-map-ctl"
					>
						<Layers aria-hidden strokeWidth={1.75} />
					</button>
				</PopoverTrigger>
				<PopoverContent
					side={p.variant === "mobile" ? "bottom" : "left"}
					align={p.variant === "mobile" ? "end" : "end"}
					className="w-72 p-0"
					data-testid={MAP_TESTID.layerMenu}
					aria-label="Map layers and legend"
				>
					<LayerMenu {...p} />
				</PopoverContent>
			</Popover>
			<Popover open={p.filterOpen} onOpenChange={p.onFilterOpenChange}>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label={filtered ? "Filter places (on)" : "Filter places"}
						data-testid={MAP_TESTID.filterButton}
						className={cn("yonder-map-ctl", filtered && "is-active")}
					>
						<ListFilter aria-hidden strokeWidth={1.75} />
						{filtered ? (
							<span className="yonder-map-ctl-dot" aria-hidden />
						) : null}
					</button>
				</PopoverTrigger>
				<PopoverContent
					side={p.variant === "mobile" ? "bottom" : "left"}
					align="end"
					className="w-80 p-0"
					data-testid={MAP_TESTID.filterMenu}
					aria-label="Filter places"
				>
					<FilterMenu
						filter={p.filter}
						setFilter={p.setFilter}
						members={p.members}
						meMemberId={p.meMemberId}
					/>
				</PopoverContent>
			</Popover>
			{p.variant === "desktop" ? (
				<div className="yonder-map-zoom">
					<ControlButton
						label="Zoom in"
						testId={MAP_TESTID.zoomIn}
						onClick={() => p.onZoom(1)}
					>
						<Plus aria-hidden strokeWidth={1.75} />
					</ControlButton>
					<ControlButton
						label="Zoom out"
						testId={MAP_TESTID.zoomOut}
						onClick={() => p.onZoom(-1)}
					>
						<Minus aria-hidden strokeWidth={1.75} />
					</ControlButton>
				</div>
			) : null}
		</div>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="grid gap-2 px-3 py-2.5">
			<p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
				{title}
			</p>
			{children}
		</div>
	);
}

function ShowRow({
	id,
	label,
	checked,
	onChange,
	testId,
	disabled,
	hint,
}: {
	id: string;
	label: string;
	checked: boolean;
	onChange(v: boolean): void;
	testId: string;
	disabled?: boolean;
	hint?: string;
}) {
	return (
		<div className="flex items-center justify-between gap-3">
			<Label htmlFor={id} className="text-[13px] font-normal">
				{label}
				{hint ? (
					<span className="ml-1 text-muted-foreground">{hint}</span>
				) : null}
			</Label>
			<Switch
				id={id}
				checked={checked}
				onCheckedChange={onChange}
				data-testid={testId}
				disabled={disabled}
			/>
		</div>
	);
}

function LayerMenu(p: MapControlsProps) {
	return (
		<div className="max-h-[70vh] overflow-y-auto">
			<Section title="Show">
				<ShowRow
					id="map-show-ideas"
					label="Ideas"
					hint={p.daysActive ? "(hidden for selected days)" : undefined}
					checked={p.show.ideas}
					onChange={(v) => p.setShow({ ideas: v })}
					testId={MAP_TESTID.showIdeas}
				/>
				<ShowRow
					id="map-show-dropped"
					label="Dropped"
					checked={p.show.dropped}
					onChange={(v) => p.setShow({ dropped: v })}
					testId={MAP_TESTID.showDropped}
				/>
				<ShowRow
					id="map-show-stays"
					label="Stays"
					checked={p.show.stays}
					onChange={(v) => p.setShow({ stays: v })}
					testId={MAP_TESTID.showStays}
				/>
			</Section>
			<Separator />
			<Section title="Selected days">
				<ToggleGroup
					type="single"
					size="sm"
					variant="outline"
					value={p.dayMode}
					onValueChange={(v) => {
						if (v === "only" || v === "dim") p.setDayMode(v);
					}}
					data-testid={MAP_TESTID.dayMode}
					className="w-full"
				>
					<ToggleGroupItem value="only" className="flex-1 text-[13px]">
						Only
					</ToggleGroupItem>
					<ToggleGroupItem value="dim" className="flex-1 text-[13px]">
						Dim others
					</ToggleGroupItem>
				</ToggleGroup>
			</Section>
			<Separator />
			<Section title="Legend">
				<Legend palette={p.palette} />
			</Section>
		</div>
	);
}

function LineSample({
	color,
	width,
	dash,
	opacity = 1,
	round,
	casing,
	gap,
	kind,
}: {
	color: string;
	width: number;
	/** Estimates and proposals only (ADDENDUM §10); dots are `0.1 n` + `round`. */
	dash?: string;
	opacity?: number;
	round?: boolean;
	casing?: string;
	/** A double rule (a known flight): `width` per rule, `gap` between them. */
	gap?: number;
	/** `solid`, `dotted`, `dashed` or `double` (for tests). */
	kind: "solid" | "dotted" | "dashed" | "double";
}) {
	const rules = gap ? [6 - (width + gap) / 2, 6 + (width + gap) / 2] : [6];
	const total = gap ? width * 2 + gap : width;
	return (
		<svg
			width="36"
			height="12"
			viewBox="0 0 36 12"
			aria-hidden
			className="shrink-0"
			data-line={kind}
		>
			{casing ? (
				<line
					x1="3"
					y1="6"
					x2="33"
					y2="6"
					stroke={casing}
					strokeWidth={total + 3}
					strokeLinecap="round"
				/>
			) : null}
			{rules.map((y) => (
				<line
					key={y}
					x1="3"
					y1={y}
					x2="33"
					y2={y}
					stroke={color}
					strokeWidth={width}
					strokeDasharray={dash}
					strokeLinecap={round ? "round" : "butt"}
					opacity={opacity}
				/>
			))}
		</svg>
	);
}

/** Line samples and pin shapes, each labelled (QA MAP-08). */
export function Legend({ palette: c }: { palette: LinePalette }) {
	// ADDENDUM §10: dashes are for estimates and proposals only; known legs
	// are solid (a flight a double rule), walks and stays dotted.
	const lines: [string, ReactNode][] = [
		[
			"Walk",
			<LineSample
				key="w"
				kind="dotted"
				color={c.walk}
				width={3}
				dash="0.1 6"
				round
				casing={c.casing}
			/>,
		],
		[
			"Transit",
			<LineSample
				key="t"
				kind="solid"
				color={c.transit}
				width={4}
				casing={c.casing}
			/>,
		],
		[
			"Flight",
			<LineSample
				key="f"
				kind="double"
				color={c.flight}
				width={FLIGHT_RULE}
				gap={FLIGHT_GAP}
				casing={c.casing}
			/>,
		],
		[
			"Taxi, car, ferry…",
			<LineSample
				key="o"
				kind="solid"
				color={c.other}
				width={2.5}
				round
				casing={c.casing}
			/>,
		],
		[
			"Estimate (rail network, no timetable)",
			<LineSample
				key="e"
				kind="dashed"
				color={c.transit}
				width={3}
				dash="6 4"
				opacity={0.9}
				casing={c.casing}
			/>,
		],
		[
			"No travel set yet",
			<LineSample
				key="u"
				kind="dashed"
				color={c.muted}
				width={1.5}
				dash="1.5 4.5"
				opacity={0.6}
			/>,
		],
		[
			"Overnight",
			<LineSample
				key="n"
				kind="dotted"
				color={c.muted}
				width={1.5}
				dash="0.1 4"
				round
				opacity={0.45}
			/>,
		],
		[
			"To your stay",
			<LineSample
				key="s"
				kind="dotted"
				color={c.other}
				width={2}
				dash="0.1 4"
				round
				casing={c.casing}
			/>,
		],
		[
			"Suggested",
			<LineSample
				key="p"
				kind="dashed"
				color="var(--presence-3)"
				width={2}
				dash="4 4"
			/>,
		],
	];
	const pins: [string, ReactNode][] = [
		[
			"Country",
			<span
				key="c"
				className="yonder-legend-pin yonder-pin-face yonder-pin-country"
				style={{ width: 16, height: 16 }}
			/>,
		],
		[
			"Region",
			<span
				key="r"
				className="yonder-legend-pin yonder-pin-face yonder-pin-region"
				style={{ width: 14, height: 14 }}
			/>,
		],
		[
			"City",
			<span
				key="ci"
				className="yonder-legend-pin yonder-pin-face yonder-pin-city"
				style={{ width: 14, height: 14 }}
			/>,
		],
		[
			"Area",
			<span
				key="a"
				className="yonder-legend-pin yonder-pin-face yonder-pin-area"
				style={{ width: 13, height: 13, borderRadius: 4 }}
			/>,
		],
		[
			"Place, coloured by kind",
			<span key="pl" className="flex -space-x-1">
				{(["culture", "food", "nature"] as const).map((f) => (
					<span
						key={f}
						className="yonder-legend-pin yonder-pin-face yonder-pin-place"
						style={{ width: 11, height: 11, background: PIN_FAMILIES[f].hex }}
					/>
				))}
			</span>,
		],
		[
			"Idea, not scheduled",
			<span
				key="h"
				className="yonder-legend-pin yonder-pin-face yonder-pin-idea"
				style={{ width: 13, height: 13 }}
			/>,
		],
		[
			"Several places",
			<span key="cl" className="yonder-cluster is-legend">
				3
			</span>,
		],
	];
	return (
		<div className="grid gap-1.5" data-testid={MAP_TESTID.legend}>
			{lines.map(([label, sample]) => (
				<div key={label} className="flex items-center gap-2.5 text-[12px]">
					{sample}
					<span className="text-foreground">{label}</span>
				</div>
			))}
			<div className="mt-1.5 grid gap-y-1.5">
				{pins.map(([label, sample]) => (
					<div key={label} className="flex items-center gap-2.5 text-[12px]">
						<span className="flex w-9 shrink-0 justify-center">{sample}</span>
						<span className="leading-tight text-foreground">{label}</span>
					</div>
				))}
			</div>
		</div>
	);
}

const ANY = "__any";
const OFF = "__off";

export function FilterMenu({
	filter,
	setFilter,
	members,
	meMemberId,
}: {
	filter: WorkspaceFilter;
	setFilter(f: WorkspaceFilter): void;
	members: readonly GraphMember[];
	meMemberId: string | null;
}) {
	const toggleGroup = (g: PlaceGroup) => {
		const groups = filter.groups.includes(g)
			? filter.groups.filter((x) => x !== g)
			: [...filter.groups, g];
		setFilter({ ...filter, groups });
	};
	const people = members.filter((m) => m.status !== "removed");
	return (
		<div className="grid">
			<div className="flex items-center justify-between px-3 pt-2.5">
				<p className="text-[13px] font-medium">Filter places</p>
				<Button
					variant="ghost"
					size="xs"
					disabled={isEmptyFilter(filter)}
					onClick={() => setFilter(EMPTY_FILTER)}
					data-testid={MAP_TESTID.filterClear}
				>
					Clear
				</Button>
			</div>
			<p className="px-3 pb-1 text-[12px] text-muted-foreground">
				Shared with Ideas and the Outline.
			</p>
			<Section title="Kinds">
				<div className="flex flex-wrap gap-1.5">
					{(Object.keys(PLACE_GROUPS) as PlaceGroup[]).map((g) => {
						const on = filter.groups.includes(g);
						return (
							<button
								key={g}
								type="button"
								aria-pressed={on}
								onClick={() => toggleGroup(g)}
								className={cn(
									"h-7 rounded-full border px-2.5 text-[12px] transition-colors",
									on
										? "border-primary bg-primary text-primary-foreground"
										: "border-border bg-background hover:bg-muted",
								)}
							>
								{PLACE_GROUPS[g]}
							</button>
						);
					})}
				</div>
			</Section>
			<Separator />
			<Section title="Rating">
				<div className="grid grid-cols-[88px_1fr] items-center gap-2 text-[13px]">
					<span className="text-muted-foreground">At least</span>
					<Select
						value={filter.minPriority ?? ANY}
						onValueChange={(v) =>
							setFilter({
								...filter,
								minPriority: v === ANY ? null : (v as Priority),
							})
						}
					>
						<SelectTrigger
							size="sm"
							className="w-full"
							aria-label="Rated at least"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ANY}>Any rating</SelectItem>
							{PRIORITY_ORDER.filter((p) => p !== "nah").map((p) => (
								<SelectItem key={p} value={p}>
									{PRIORITIES[p].label}
									{p !== "must" ? " or higher" : ""}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{filter.minPriority ? (
						<>
							<span className="text-muted-foreground">Rated by</span>
							<Select
								value={filter.priorityOf}
								onValueChange={(v) => setFilter({ ...filter, priorityOf: v })}
							>
								<SelectTrigger
									size="sm"
									className="w-full"
									aria-label="Whose rating"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="max">Anyone (highest)</SelectItem>
									{people.map((m) => (
										<SelectItem key={m.id} value={m.id}>
											{m.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</>
					) : null}
					<span className="text-muted-foreground">Unrated by</span>
					<Select
						value={filter.unratedBy ?? OFF}
						onValueChange={(v) =>
							setFilter({ ...filter, unratedBy: v === OFF ? null : v })
						}
					>
						<SelectTrigger size="sm" className="w-full" aria-label="Unrated by">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={OFF}>Anyone may have rated</SelectItem>
							{meMemberId ? <SelectItem value="me">Me</SelectItem> : null}
							{people
								.filter((m) => m.id !== meMemberId)
								.map((m) => (
									<SelectItem key={m.id} value={m.id}>
										{m.name}
									</SelectItem>
								))}
						</SelectContent>
					</Select>
				</div>
			</Section>
			<Separator />
			<div className="px-3 py-2.5">
				<ShowRow
					id="map-filter-ns"
					label="Not scheduled yet"
					checked={filter.notScheduled}
					onChange={(v) => setFilter({ ...filter, notScheduled: v })}
					testId="map-filter-ns"
				/>
			</div>
		</div>
	);
}

export function FilterChip({
	match,
	total,
	description,
	onClear,
	onOpen,
	style,
}: {
	match: number;
	total: number;
	/** `describeFilter(…)`: "Shopping · Want or higher". */
	description: string | null;
	onClear(): void;
	onOpen?(): void;
	style?: React.CSSProperties;
}) {
	return (
		<div
			className="yonder-map-chip is-filter"
			data-testid={MAP_TESTID.filterChip}
			style={style}
		>
			<button
				type="button"
				className="flex min-w-0 items-center gap-1.5"
				onClick={onOpen}
				aria-label={`Filtered: ${description ?? "places"}, ${match} of ${total} places. Change the filter`}
			>
				<ListFilter
					aria-hidden
					className="size-3.5 shrink-0 text-primary"
					strokeWidth={1.75}
				/>
				<span className="truncate">{description ?? "Filtered"}</span>
				<span className="tnum shrink-0 text-muted-foreground">
					· {match} of {total} places
				</span>
			</button>
			<button
				type="button"
				aria-label="Clear the filter"
				className="-mr-1 shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
				onClick={onClear}
			>
				<X aria-hidden className="size-3.5" />
			</button>
		</div>
	);
}

/**
 * QA GRAN-10: "Everything here is in Japan" when the scope collapses into one
 * pin at this lens, with a one-click finer lens when there is one.
 */
export function OneRepHint({
	text,
	action,
	onAction,
	align = "center",
	style,
}: {
	text: string;
	action: string | null;
	onAction(): void;
	/** `start` on a phone: top-left, clear of the controls. */
	align?: "center" | "start";
	style?: React.CSSProperties;
}) {
	return (
		<div
			className={cn("yonder-map-chip is-hint", align === "start" && "is-start")}
			data-testid={MAP_TESTID.scopeHint}
			role="status"
			style={style}
		>
			<span className="min-w-0 text-muted-foreground">{text}</span>
			{action ? (
				<button
					type="button"
					className="-mr-1.5 flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-medium text-foreground hover:bg-muted"
					onClick={onAction}
				>
					{action}
					<ArrowDownRight aria-hidden className="size-3.5" strokeWidth={1.75} />
				</button>
			) : null}
		</div>
	);
}

/** A tiny external store: the edge tooltip follows the pointer without re-rendering the map. */
export type EdgeTipState = {
	x: number;
	y: number;
	title: string;
	detail: string;
} | null;
export type EdgeTipStore = {
	get(): EdgeTipState;
	set(v: EdgeTipState): void;
	subscribe(fn: () => void): () => void;
};
export function createEdgeTipStore(): EdgeTipStore {
	let v: EdgeTipState = null;
	const subs = new Set<() => void>();
	return {
		get: () => v,
		set: (next) => {
			if (v === next) return;
			v = next;
			for (const fn of subs) fn();
		},
		subscribe: (fn) => {
			subs.add(fn);
			return () => {
				subs.delete(fn);
			};
		},
	};
}

/** Hovering an edge (desktop): "Nakano Broadway → Yodobashi Camera · Transit · 20m · via Lunch". */
export function EdgeTooltip({ store }: { store: EdgeTipStore }) {
	const tip = useSyncExternalStore(store.subscribe, store.get, () => null);
	if (!tip) return null;
	return (
		<div
			className="yonder-edge-tip"
			data-testid={MAP_TESTID.edgeTip}
			role="tooltip"
			style={{ transform: `translate(${tip.x}px, ${tip.y}px)` }}
		>
			<p className="truncate font-medium">{tip.title}</p>
			<p className="truncate text-muted-foreground">{tip.detail}</p>
		</div>
	);
}

export function FinerChip({
	label,
	onClick,
	style,
}: {
	label: string;
	onClick(): void;
	style?: React.CSSProperties;
}) {
	return (
		<button
			type="button"
			className="yonder-map-chip is-finer"
			data-testid={MAP_TESTID.finerChip}
			onClick={onClick}
			style={style}
		>
			<ArrowDownRight aria-hidden className="size-3.5" strokeWidth={1.75} />
			{label}
		</button>
	);
}

/** FB-22: map-following is paused (I moved the map): the way back. */
export function FollowBackChip({
	name,
	onClick,
	style,
}: {
	name: string;
	onClick(): void;
	style?: React.CSSProperties;
}) {
	const first = name.split(" ")[0] || name;
	return (
		<button
			type="button"
			className="yonder-map-chip is-finer"
			data-testid={MAP_TESTID.followChip}
			onClick={onClick}
			style={style}
		>
			<Undo2 aria-hidden className="size-3.5" strokeWidth={1.75} />
			Back to {first}&rsquo;s view
		</button>
	);
}

export function EmptyMapCard({ onAdd }: { onAdd(): void }) {
	// VIS3-09: centred in the part of the map nothing covers (the phone sheet,
	// the floating inspector), the same room the map fits into (`mapPadding`).
	const pad = useUi((s) => s.mapPadding);
	const at = (px: number) => Math.max(24, px);
	return (
		<div
			className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6"
			style={{
				paddingTop: at(pad.top),
				paddingRight: at(pad.right),
				paddingBottom: at(pad.bottom),
				paddingLeft: at(pad.left),
			}}
		>
			<div
				className="pointer-events-auto grid justify-items-center gap-3 rounded-2xl bg-card/95 px-6 py-5 text-center shadow-float backdrop-blur-sm"
				data-testid={MAP_TESTID.empty}
			>
				<p className="text-sm text-muted-foreground">
					Nothing on the map here yet.
				</p>
				<EditGuard>
					<Button size="sm" variant="outline" onClick={onAdd}>
						Add a place
					</Button>
				</EditGuard>
			</div>
		</div>
	);
}

/** QA ERR-06: the basemap couldn't load; the pins and lines still draw on the plain ground. */
export function TilesDownChip({ style }: { style?: React.CSSProperties }) {
	return (
		<div
			className="yonder-map-chip is-tiles-down"
			data-testid={MAP_TESTID.tilesError}
			role="status"
			style={style}
		>
			<CloudOff
				aria-hidden
				className="size-3.5 shrink-0 text-muted-foreground"
				strokeWidth={1.75}
			/>
			<span className="truncate">Map tiles couldn't load</span>
			<span className="hidden shrink-0 text-muted-foreground sm:inline">
				· pins and routes still work
			</span>
		</div>
	);
}
