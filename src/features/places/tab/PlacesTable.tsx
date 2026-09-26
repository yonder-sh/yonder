/**
 * The Places table (docs/PLACES.md §1): a real spreadsheet. Columns: place
 * (+ city › area), category, one column per member's rating (dot + label),
 * group score, status, when, time needed, media. Columns keep a minimum
 * width and the table scrolls sideways inside its pane, so nothing is ever
 * hidden; the place column stays put while it does.
 *
 * Inline editing: your own rating (a picker, or keys 1–6 on the focused
 * row), time needed and the status pin. Keyboard: ↑/↓ move, Enter opens the
 * drawer, S pins / unpins, D drops, 0 clears your rating.
 */
import { cn } from "cn";
import { ChevronDown, ChevronRight, Split } from "lucide-react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { EditGuard } from "@/components/common/edit-guard";
import { MemberAvatar } from "@/components/common/member";
import { PriorityDot } from "@/components/common/priority-dot";
import { NODE_TYPES, PLACE_CATEGORIES } from "@/lib/domain/taxonomy";
import type { GraphMember } from "@/lib/engine/types";
import { anchorKey } from "@/lib/realtime/cursor-protocol";
import { ids, useFollowState } from "@/lib/realtime/view-ui";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { priorityForKey, ratingsCount } from "../lib/rate";
import { CategorySelect } from "../ui/category-select";
import { mayRate } from "../ui/member-ratings";
import { PriorityPicker } from "../ui/priority";
import { rowReason } from "./bar";
import type { PlaceGroup } from "./grouping";
import type { PlaceRow } from "./model";
import { TimeNeededEditor } from "./TimeNeeded";
import { PLACES_TAB_TESTID } from "./testids";
import { ScoreChip, SplitMark, StatusChip } from "./ui";
import { usePlaceActions } from "./use-place-actions";
import { type PlacesData, useSplitAreas } from "./use-places";

export function categoryLabel(row: PlaceRow): string {
	const n = row.node;
	return n.type === "place"
		? PLACE_CATEGORIES[n.category ?? "other"].label
		: NODE_TYPES[n.type].label;
}

/** A typing target or an open layer owns its keys. */
export function ownsKeys(t: EventTarget | null): boolean {
	const el = t as HTMLElement | null;
	if (!el) return false;
	if (el.isContentEditable) return true;
	if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
	return !!el.closest(
		"[role=dialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper]",
	);
}

/**
 * The row keys shared by the table and the board: 1–6 rate, 0 / Backspace
 * clear, Enter opens, S pins, D drops. True when the key was handled.
 */
export function useRowKeys(threshold: number) {
	const { nav } = useWorkspace();
	const act = usePlaceActions();
	return useCallback(
		(e: KeyboardEvent, row: PlaceRow): boolean => {
			if (e.metaKey || e.ctrlKey || e.altKey) return false;
			const p = priorityForKey(e.key);
			if (p) {
				act.rate(row.id, p);
				return true;
			}
			if (e.key === "0" || e.key === "Backspace") {
				if (row.node.priorities[act.me ?? ""]) act.rate(row.id, null);
				return true;
			}
			if (e.key === "Enter") {
				nav.select({ kind: "node", id: row.id });
				return true;
			}
			if (e.key === "s" || e.key === "S") {
				act.togglePin(row, threshold);
				return true;
			}
			if (e.key === "d" || e.key === "D") {
				act.toggleDropped(row);
				return true;
			}
			return false;
		},
		[act, nav, threshold],
	);
}

const W = {
	place: 280,
	category: 136,
	member: 124,
	score: 76,
	status: 150,
	when: 196,
	time: 104,
	media: 72,
} as const;

function RatingCell({ row, member }: { row: PlaceRow; member: GraphMember }) {
	const { access } = useWorkspace();
	const act = usePlaceActions();
	const p = row.node.priorities[member.id] ?? null;
	const editable = mayRate(access, member) && member.id === act.me;
	const placeholder = mayRate(access, member) && member.id !== act.me;
	const label = (
		<PriorityDot
			priority={p}
			className={cn("text-[13px]", !ratingsCount(member) && "opacity-50")}
		/>
	);
	if (!editable && !placeholder)
		return <span data-testid={PLACES_TAB_TESTID.ratingCell}>{label}</span>;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: keeps the picker's clicks and keys off the row; the picker is the control
		<span
			data-testid={PLACES_TAB_TESTID.ratingCell}
			data-member={member.id}
			data-mine={editable || undefined}
			onClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => e.stopPropagation()}
		>
			<EditGuard kind={editable ? "rate" : "propose-ok"}>
				<PriorityPicker
					value={p}
					label={`${editable ? "Your" : `${member.name}'s`} rating for ${row.name}`}
					disabled={editable ? !act.canRate : !act.canEdit}
					onChange={(next) => {
						if (editable) act.rate(row.id, next);
						else act.ratePlaceholder(row.id, member.id, next);
					}}
					trigger={
						<span className="inline-flex h-7 items-center rounded-md px-1 hover:bg-accent">
							{label}
						</span>
					}
				/>
			</EditGuard>
		</span>
	);
}

function GroupHeader({
	group,
	cols,
	collapsed,
	onCollapse,
}: {
	group: PlaceGroup<PlaceRow>;
	cols: number;
	collapsed: boolean;
	onCollapse: () => void;
}) {
	const [, toggleSplit] = useSplitAreas();
	const s = group.summary;
	return (
		<tr
			data-testid={PLACES_TAB_TESTID.groupHeader}
			data-group={group.key}
			data-cursor-anchor={`sec:pl.${anchorKey(group.key)}`}
		>
			<th
				colSpan={cols}
				scope="colgroup"
				className="border-b bg-muted/40 p-0 text-left font-normal"
			>
				<div className="sticky left-0 flex w-fit max-w-[100cqw] items-center gap-2 px-3 py-2">
					<button
						type="button"
						onClick={onCollapse}
						aria-expanded={!collapsed}
						aria-label={
							collapsed ? `Show ${group.label}` : `Hide ${group.label}`
						}
						className="grid size-6 cursor-pointer place-items-center rounded text-muted-foreground hover:bg-accent"
					>
						{collapsed ? (
							<ChevronRight className="size-4" />
						) : (
							<ChevronDown className="size-4" />
						)}
					</button>
					<span className="font-display text-[15px] font-semibold whitespace-nowrap">
						{group.label}
					</span>
					{group.note ? (
						<span className="text-xs whitespace-nowrap text-muted-foreground">
							· {group.note}
						</span>
					) : null}
					<span className="text-xs whitespace-nowrap text-muted-foreground">
						{s.count} {s.count === 1 ? "place" : "places"}
						{s.musts ? ` · ${s.musts} must` : ""} · {s.scheduled} scheduled
					</span>
					{group.canSplit && group.node ? (
						<button
							type="button"
							data-testid={PLACES_TAB_TESTID.splitToggle}
							onClick={() => toggleSplit(group.node?.id ?? "")}
							className="ml-2 inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border bg-background px-2 text-xs font-medium whitespace-nowrap text-primary hover:bg-accent"
						>
							<Split className="size-3" />
							{group.split ? "Merge areas" : "Split by area"}
						</button>
					) : null}
				</div>
			</th>
		</tr>
	);
}

/** The place column on a phone: narrower, so a rating or two shows beside it. */
const PLACE_W_NARROW = 168;

export function PlacesTable({
	data,
	narrow = false,
}: {
	data: PlacesData;
	/** A phone: the same table, scrolled both ways, with a narrower place column. */
	narrow?: boolean;
}) {
	const placeW = narrow ? PLACE_W_NARROW : W.place;
	const { sel, nav } = useWorkspace();
	const act = usePlaceActions();
	const onRowKey = useRowKeys(data.threshold);
	// Hidden groups travel with my view (a follower's hide with mine).
	const [closedKeys, setClosedKeys] = useFollowState<string[]>(
		"places.closed",
		[],
		ids,
	);
	const collapsed = useMemo(() => new Set(closedKeys), [closedKeys]);
	const [focused, setFocused] = useState<string | null>(null);
	const body = useRef<HTMLTableSectionElement>(null);
	const selId = sel?.kind === "node" ? sel.id : null;
	// Everyone who rates: a left-out person's column stays, dimmed.
	const members = data.allRaters;
	const cols = 7 + members.length;
	const width =
		placeW +
		W.category +
		W.member * members.length +
		W.score +
		W.status +
		W.when +
		W.time +
		W.media;

	// The drawer's place keeps the keyboard focus row (Enter from elsewhere).
	useEffect(() => {
		if (selId) setFocused(selId);
	}, [selId]);

	const rows: PlaceRow[] = [];
	for (const g of data.groups)
		if (!collapsed.has(g.key))
			for (const r of g.subgroups ? g.subgroups.flatMap((s) => s.rows) : g.rows)
				rows.push(r);
	const tabStop =
		focused && rows.some((r) => r.id === focused)
			? focused
			: (rows[0]?.id ?? null);

	const focusRow = (id: string | undefined) => {
		if (!id) return;
		setFocused(id);
		const el = body.current?.querySelector<HTMLElement>(
			`[data-row-id="${id}"]`,
		);
		if (!el) return;
		// Keep the sideways scroll where it is; only bring the row into view vertically.
		el.focus({ preventScroll: true });
		const box = el.closest<HTMLElement>("[data-scroll-y]");
		if (!box) return;
		const r = el.getBoundingClientRect();
		const b = box.getBoundingClientRect();
		const head = 36;
		if (r.top < b.top + head) box.scrollTop -= b.top + head - r.top;
		else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTableSectionElement>) => {
		if (ownsKeys(e.target)) return;
		const el = (e.target as HTMLElement).closest<HTMLElement>("[data-row-id]");
		const id = el?.dataset.rowId;
		const at = id ? rows.findIndex((r) => r.id === id) : -1;
		const row = rows[at];
		if (!row) return;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			focusRow(rows[at + (e.key === "ArrowDown" ? 1 : -1)]?.id);
			return;
		}
		if (onRowKey(e, row)) e.preventDefault();
	};

	const renderRow = (r: PlaceRow) => {
		const selected = r.id === selId;
		return (
			<tr
				key={r.id}
				data-testid={PLACES_TAB_TESTID.row}
				data-row-id={r.id}
				data-status={r.status}
				data-score={r.score}
				data-cursor-anchor={`place:${r.id}`}
				aria-selected={selected}
				tabIndex={tabStop === r.id ? 0 : -1}
				onFocus={() => setFocused(r.id)}
				// A click focuses the row without scrolling the table sideways.
				onMouseDown={(e) => {
					if (!(e.target as HTMLElement).closest("button,a,input"))
						e.preventDefault();
				}}
				onClick={() => {
					focusRow(r.id);
					nav.select({ kind: "node", id: r.id });
				}}
				className={cn(
					"group/row h-12 cursor-pointer border-b text-[13px] outline-none",
					"focus-visible:bg-accent/60",
					selected ? "bg-accent" : "hover:bg-muted/40",
				)}
			>
				<td
					className={cn(
						"sticky left-0 z-[1] border-r bg-background px-3 py-1.5",
						selected
							? "bg-accent shadow-[inset_3px_0_0_var(--primary)]"
							: "group-hover/row:bg-muted",
						"group-focus-visible/row:bg-accent",
					)}
				>
					<div className="flex min-w-0 items-center gap-2">
						<div className="min-w-0 flex-1">
							<div className="truncate text-sm font-medium">{r.name}</div>
							<div className="truncate text-xs text-muted-foreground">
								{r.where || "—"}
							</div>
						</div>
						{r.split ? <SplitMark /> : null}
					</div>
				</td>
				{r.node.type === "place" ? (
					// Changeable in place; the row keeps its own click and keys.
					<td
						className="px-1.5 text-muted-foreground"
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => e.stopPropagation()}
					>
						<CategorySelect
							node={r.node}
							className="max-w-full text-[13px] text-muted-foreground"
						/>
					</td>
				) : (
					<td className="truncate px-3 text-muted-foreground">
						{categoryLabel(r)}
					</td>
				)}
				{members.map((m) => (
					<td key={m.id} className="px-2">
						<RatingCell row={r} member={m} />
					</td>
				))}
				<td className="px-3">
					<ScoreChip score={r.score} />
				</td>
				<td className="px-2">
					{r.status === "scheduled" ? (
						<StatusChip info={r.info} reason={rowReason(r, data.bar)} />
					) : (
						<button
							type="button"
							disabled={!act.canEdit}
							title={
								r.info.pinned
									? "Pinned on the shortlist (S to unpin)"
									: r.status === "shortlist"
										? "Suggested by its score (S to unpin)"
										: r.status === "dropped"
											? "Dropped (D to bring back)"
											: "S to pin on the shortlist"
							}
							onClick={(e) => {
								e.stopPropagation();
								act.togglePin(r, data.threshold);
							}}
							className="cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
						>
							<StatusChip info={r.info} reason={rowReason(r, data.bar)} />
						</button>
					)}
				</td>
				<td className="truncate px-3 text-muted-foreground">{r.when}</td>
				<td className="px-2">
					<TimeNeededEditor
						row={r}
						disabled={!act.canEdit}
						onSet={(m) => act.setTime(r, m)}
					/>
				</td>
				<td className="px-3 text-right font-mono tnum text-muted-foreground">
					{r.media || "—"}
				</td>
			</tr>
		);
	};

	return (
		<div
			className="min-h-0 flex-1 overflow-auto [container-type:inline-size]"
			data-testid={PLACES_TAB_TESTID.tableScroll}
			data-scroll-y=""
		>
			<table
				data-testid={PLACES_TAB_TESTID.table}
				className="table-fixed border-separate border-spacing-0"
				style={{ width: `max(100%, ${width}px)` }}
			>
				<colgroup>
					<col style={{ width: undefined, minWidth: placeW }} />
					<col style={{ width: W.category }} />
					{members.map((m) => (
						<col key={m.id} style={{ width: W.member }} />
					))}
					<col style={{ width: W.score }} />
					<col style={{ width: W.status }} />
					<col style={{ width: W.when }} />
					<col style={{ width: W.time }} />
					<col style={{ width: W.media }} />
				</colgroup>
				<thead className="sticky top-0 z-[2] bg-background">
					<tr className="h-9 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
						<th
							scope="col"
							className="sticky left-0 z-[1] border-r border-b bg-background px-3"
							style={{ minWidth: placeW }}
						>
							Place
						</th>
						<th scope="col" className="border-b px-3">
							Category
						</th>
						{members.map((m) => (
							<th
								key={m.id}
								scope="col"
								className={cn(
									"border-b px-2",
									!ratingsCount(m) && "text-muted-foreground/70",
								)}
								title={
									ratingsCount(m)
										? undefined
										: `Not counted: ${m.firstName ?? m.name}'s ratings are left out`
								}
							>
								<span className="inline-flex max-w-full items-center gap-1.5">
									<MemberAvatar memberId={m.id} size={16} ring={false} />
									<span className="truncate">
										{m.id === act.me ? "You" : (m.firstName ?? m.name)}
									</span>
								</span>
							</th>
						))}
						<th scope="col" className="border-b px-3">
							Score
						</th>
						<th scope="col" className="border-b px-2">
							Status
						</th>
						<th scope="col" className="border-b px-3">
							When
						</th>
						<th scope="col" className="border-b px-2">
							Time
						</th>
						<th scope="col" className="border-b px-3 text-right">
							Media
						</th>
					</tr>
				</thead>
				<tbody ref={body} onKeyDown={onKeyDown}>
					{data.groups.map((g) => {
						const closed = collapsed.has(g.key);
						const toggle = () =>
							setClosedKeys((c) =>
								c.includes(g.key)
									? c.filter((k) => k !== g.key)
									: [...c, g.key],
							);
						const header =
							data.state.group === "none" ? null : (
								<GroupHeader
									key={`h:${g.key}`}
									group={g}
									cols={cols}
									collapsed={closed}
									onCollapse={toggle}
								/>
							);
						if (closed) return header;
						if (!g.subgroups) return [header, ...g.rows.map(renderRow)];
						return [
							header,
							...g.subgroups.flatMap((s) => [
								<tr
									key={`s:${g.key}:${s.key}`}
									data-testid={PLACES_TAB_TESTID.subgroup}
								>
									<th
										colSpan={cols}
										scope="rowgroup"
										className="border-b bg-background p-0 text-left text-[13px] font-semibold"
									>
										<span className="sticky left-0 inline-block px-4 py-1.5 pl-11">
											{s.label}
											<span className="font-normal text-muted-foreground">
												{" "}
												· {s.rows.length}
											</span>
										</span>
									</th>
								</tr>,
								...s.rows.map(renderRow),
							]),
						];
					})}
				</tbody>
			</table>
		</div>
	);
}
