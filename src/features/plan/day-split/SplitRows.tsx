/**
 * The stops of "How long in each city?": numbered in travel order under
 * their country (and region) headings, each with its days (− / +), a handle
 * to drag it and a menu to move it up or down, and its places by area. A
 * drag here has its own DndContext (it never reaches the Plan's).
 */
import {
	type Announcements,
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	MouseSensor,
	TouchSensor,
	type UniqueIdentifier,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "cn";
import {
	ArrowDown,
	ArrowUp,
	ChevronRight,
	EllipsisVertical,
	GripVertical,
	Minus,
	Plus,
} from "lucide-react";
import { useMemo, useState } from "react";
import { CategoryIcon } from "@/components/common/glyphs";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PlaceRow } from "@/features/places/tab/model";
import { ScoreChip } from "@/features/places/tab/ui";
import { formatDuration } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import type { DaySplitInfo } from "./DaySplit";
import { headingText, type SplitLine, splitLines } from "./day-split";
import { SPLIT_TESTID as T } from "./testids";

export const NO_FREE_DAY =
	"No free days left. Take one from another city first.";

export type SplitRowView = {
	key: string;
	id: string;
	name: string;
	days: number;
	shortlisted: number;
	notRated: number;
};

/** A city's shortlist by area (the time each needs), then what's left to rate. */
function CityPlaces({
	info,
	cityId,
	className,
}: {
	info: DaySplitInfo;
	cityId: string;
	className?: string;
}) {
	const { nav } = useWorkspace();
	const city = info.cities.find((c) => c.id === cityId);
	if (!city) return null;
	const rowsOf = (ids: readonly string[]) =>
		ids.flatMap((id) => info.rowById.get(id) ?? []);
	const toRate = rowsOf(city.toRateIds);
	const open = (r: PlaceRow) => nav.select({ kind: "node", id: r.id });
	const list = (ids: readonly string[]) => (
		<ul className="grid gap-0.5">
			{rowsOf(ids).map((r) => (
				<li key={r.id}>
					<button
						type="button"
						data-testid={T.splitPlace}
						onClick={() => open(r)}
						className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent"
					>
						{r.node.category ? (
							<CategoryIcon
								category={r.node.category}
								className="size-3.5 text-muted-foreground"
							/>
						) : (
							<span className="size-3.5" />
						)}
						<span className="min-w-0 flex-1 truncate">{r.node.name}</span>
						<span className="shrink-0 font-mono text-xs text-muted-foreground tnum">
							{r.timeMin ? formatDuration(r.timeMin, { compact: true }) : ""}
						</span>
						<ScoreChip score={r.score} size="sm" />
					</button>
				</li>
			))}
		</ul>
	);
	return (
		<div
			data-testid={T.splitPlaces}
			className={cn("grid gap-2 pr-4 pb-3 text-sm", className)}
		>
			{city.shortlistIds.length ? (
				<>
					<p className="text-xs text-muted-foreground">
						About {formatDuration(city.minutes, { compact: true })} of sights on
						the shortlist
					</p>
					{city.areas.length > 1
						? city.areas.map((a) => (
								<div
									key={a.id ?? ""}
									data-testid={T.area}
									className="grid gap-0.5"
								>
									<p className="px-1.5 text-xs font-medium">
										{a.id ? a.name : `Elsewhere in ${city.name}`}
										<span className="font-normal text-muted-foreground">
											{" "}
											· {formatDuration(a.minutes, { compact: true })}
										</span>
									</p>
									{list(a.ids)}
								</div>
							))
						: list(city.shortlistIds)}
				</>
			) : (
				<p className="text-xs text-muted-foreground">
					Nothing shortlisted here yet.
				</p>
			)}
			{toRate.length ? (
				<p className="text-xs text-muted-foreground">
					<span className="font-medium text-foreground">Not rated yet:</span>{" "}
					{toRate.map((r, i) => (
						<span key={r.id}>
							{i ? ", " : ""}
							<button
								type="button"
								onClick={() => open(r)}
								className="cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
							>
								{r.node.name}
							</button>
						</span>
					))}
				</p>
			) : null}
			{city.belowShortlist ? (
				<p className="text-xs text-muted-foreground">
					{city.belowShortlist}{" "}
					{city.belowShortlist === 1 ? "other place" : "other places"} didn't
					make the shortlist.
				</p>
			) : null}
		</div>
	);
}

function Heading({ line }: { line: Exclude<SplitLine, { kind: "stop" }> }) {
	const country = line.kind === "country";
	return (
		<li
			data-testid={T.heading}
			data-kind={line.kind}
			className={cn(
				"border-t first:border-t-0",
				country
					? "bg-muted/50 px-3 py-1.5 text-[13px] font-semibold"
					: "px-3 pt-2 pb-1 pl-9 text-xs font-medium text-muted-foreground",
			)}
		>
			{headingText(line.name, line.days)}
		</li>
	);
}

function StopRow({
	info,
	row,
	line,
	count,
	unused,
	onStep,
	onMove,
	busy,
	open,
	onToggle,
}: {
	info: DaySplitInfo;
	row: SplitRowView;
	line: Extract<SplitLine, { kind: "stop" }>;
	count: number;
	unused: number;
	onStep: ((index: number, delta: 1 | -1) => void) | null;
	onMove: ((from: number, to: number) => void) | null;
	busy: boolean;
	open: boolean;
	onToggle: () => void;
}) {
	const i = line.index;
	const sort = useSortable({ id: row.key, disabled: !onMove || busy });
	const t = sort.transform;
	return (
		<li
			ref={sort.setNodeRef}
			style={{
				transform: CSS.Translate.toString(t ? { ...t, x: 0 } : null),
				transition: sort.transition,
			}}
			data-testid={T.splitRow}
			data-city={row.id}
			data-days={row.days}
			data-stop={line.stop ?? undefined}
			className={cn(
				"relative border-t bg-card first:border-t-0",
				sort.isDragging && "z-10 shadow-float",
			)}
		>
			<div
				className={cn(
					"flex items-center gap-2 py-2.5 pr-2",
					line.inRegion ? "pl-5" : "pl-2",
				)}
			>
				{onMove ? (
					<button
						type="button"
						ref={sort.setActivatorNodeRef}
						{...sort.attributes}
						{...sort.listeners}
						data-testid={T.handle}
						aria-label={`Drag ${row.name} to change the order`}
						disabled={busy}
						className="flex h-8 w-4 shrink-0 cursor-grab touch-manipulation items-center justify-center rounded text-muted-foreground/60 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
					>
						<GripVertical className="size-3.5" strokeWidth={1.5} aria-hidden />
					</button>
				) : (
					<span className="w-1 shrink-0" />
				)}
				<span
					data-testid={T.stop}
					className={cn(
						"grid size-6 shrink-0 place-items-center rounded-full font-mono text-xs font-semibold tnum",
						line.stop
							? "bg-primary text-primary-foreground"
							: "border border-dashed border-border",
					)}
				>
					{line.stop ?? ""}
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-baseline gap-2">
						<button
							type="button"
							data-testid={T.splitExpand}
							aria-expanded={open}
							title={`${open ? "Hide" : "Show"} the places in ${row.name}`}
							onClick={onToggle}
							className={cn(
								"flex min-w-0 cursor-pointer items-center gap-0.5 text-left text-[15px] font-medium hover:underline",
								!row.days && "text-muted-foreground",
							)}
						>
							<span className="truncate">{row.name}</span>
							<ChevronRight
								aria-hidden
								className={cn(
									"size-3.5 shrink-0 text-muted-foreground transition-transform",
									open && "rotate-90",
								)}
							/>
						</button>
						<span
							className={cn(
								"shrink-0 text-sm",
								!row.days && "text-muted-foreground",
							)}
						>
							<span className="font-mono tnum">{row.days}</span>{" "}
							{row.days === 1 ? "day" : "days"}
						</span>
					</div>
					<span className="block truncate text-xs text-muted-foreground">
						{row.shortlisted} shortlisted
						{row.notRated ? ` · ${row.notRated} not rated yet` : ""}
					</span>
				</div>
				{onStep ? (
					<div className="flex shrink-0 gap-1">
						<Button
							variant="outline"
							size="icon-sm"
							data-testid={T.splitMinus}
							aria-label={`One day less in ${row.name}`}
							disabled={busy || row.days < 1}
							onClick={() => onStep(i, -1)}
						>
							<Minus />
						</Button>
						<Button
							variant="outline"
							size="icon-sm"
							data-testid={T.splitPlus}
							aria-label={`One day more in ${row.name}`}
							title={unused < 1 ? NO_FREE_DAY : undefined}
							disabled={busy || unused < 1}
							onClick={() => onStep(i, 1)}
						>
							<Plus />
						</Button>
					</div>
				) : null}
				{onMove ? (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon-xs"
								data-testid={T.menu}
								aria-label={`Move ${row.name}`}
								disabled={busy}
								className="shrink-0 text-muted-foreground"
							>
								<EllipsisVertical />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem
								data-testid={T.moveUp}
								disabled={i === 0}
								onSelect={() => onMove(i, i - 1)}
							>
								<ArrowUp className="size-4" strokeWidth={1.5} /> Move up
							</DropdownMenuItem>
							<DropdownMenuItem
								data-testid={T.moveDown}
								disabled={i === count - 1}
								onSelect={() => onMove(i, i + 1)}
							>
								<ArrowDown className="size-4" strokeWidth={1.5} /> Move down
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
			</div>
			{open ? (
				<CityPlaces
					info={info}
					cityId={row.id}
					className={line.inRegion ? "pl-[4.75rem]" : "pl-16"}
				/>
			) : null}
		</li>
	);
}

export function SplitRows({
	info,
	rows,
	unused,
	onStep,
	onMove,
	busy,
}: {
	info: DaySplitInfo;
	rows: readonly SplitRowView[];
	unused: number;
	/** Null: read-only (no − / +). */
	onStep: ((index: number, delta: 1 | -1) => void) | null;
	/** Null: no reordering. */
	onMove: ((from: number, to: number) => void) | null;
	busy: boolean;
}) {
	const { ix } = useWorkspace();
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
	const toggle = (id: string) =>
		setOpen((s) => {
			const n = new Set(s);
			if (n.has(id)) n.delete(id);
			else n.add(id);
			return n;
		});
	const lines = useMemo(() => splitLines(ix, rows), [ix, rows]);
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 220, tolerance: 8 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);
	const nameOf = (id: UniqueIdentifier) =>
		rows.find((r) => r.key === id)?.name ?? "the stop";
	const announcements: Announcements = {
		onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}.`,
		onDragOver: ({ active, over }) =>
			over
				? `${nameOf(active.id)} is where ${nameOf(over.id)} was.`
				: undefined,
		onDragEnd: ({ active }) => `${nameOf(active.id)} moved.`,
		onDragCancel: ({ active }) => `Moving ${nameOf(active.id)} was cancelled.`,
	};
	const onDragEnd = (e: DragEndEvent) => {
		const from = rows.findIndex((r) => r.key === e.active.id);
		const to = rows.findIndex((r) => r.key === e.over?.id);
		if (from >= 0 && to >= 0 && from !== to) onMove?.(from, to);
	};
	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			onDragEnd={onDragEnd}
			accessibility={{ announcements }}
		>
			<SortableContext
				items={rows.map((r) => r.key)}
				strategy={verticalListSortingStrategy}
			>
				<ul className="@container overflow-hidden rounded-xl border bg-card">
					{lines.map((l) => {
						if (l.kind !== "stop") return <Heading key={l.key} line={l} />;
						const row = rows[l.index] as SplitRowView;
						return (
							<StopRow
								key={row.key}
								info={info}
								row={row}
								line={l}
								count={rows.length}
								unused={unused}
								onStep={onStep}
								onMove={onMove}
								busy={busy}
								open={open.has(row.key)}
								onToggle={() => toggle(row.key)}
							/>
						);
					})}
				</ul>
			</SortableContext>
		</DndContext>
	);
}
