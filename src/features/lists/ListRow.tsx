/**
 * One list row (DESIGN §7.3, EXTENSIONS §7 UX): a foreground checkbox, the
 * text (`MarkdownText`, mention chips with current names), then 12px meta —
 * the source crumb (outside Place view), who it's for, the due chip, ×2 and
 * ¥30,000 — and a ⋯ menu. A second muted line carries candidate shops, where
 * the shop is on the plan (ADDENDUM §10) and a relative rule's anchor.
 *
 * Quick complete: the box is optimistic and silent; the row stays in place,
 * struck through, for 4 s (clicking again reopens) and then folds into
 * "N done". `x` toggles the focused row, `d` opens the date editor; on touch,
 * swipe right completes and left deletes (with Undo). Private rows carry a
 * 12px lock and "Only you" (ADDENDUM §7.2). Fewer badges (ADDENDUM §10): one
 * warning at most — amber only for a real problem (overdue, shop closed).
 */

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "cn";
import {
	CalendarPlus,
	GripVertical,
	Link2,
	Lock,
	MoreHorizontal,
	UserPlus,
	Wallet,
} from "lucide-react";
import { type PointerEvent, type ReactNode, useRef, useState } from "react";
import type { DragData } from "@/components/common/dnd/workspace-dnd";
import { MarkdownText } from "@/components/common/markdown-text";
import { MemberAvatar } from "@/components/common/member";
import { ProposalGhost } from "@/components/common/proposal-ghost";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MentionInput } from "@/features/notes/MentionInput";
import { GhostActions } from "@/features/suggest/GhostActions";
import { can } from "@/lib/auth/roles";
import {
	type DueCtx,
	type DueState,
	dueChipLabel,
	dueState,
	effectiveDue,
} from "@/lib/engine/due";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { ScheduleResult } from "@/lib/engine/types";
import { useFormPresence } from "@/lib/realtime/form-presence";
import type { BundleTarget } from "@/lib/schemas/targets";
import { useUi } from "@/lib/workspace/ui-store";
import { useProposalMarks } from "@/lib/workspace/use-proposals";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { DueEditor } from "./DueEditor";
import { formatPrice, plainOf, toMinorUnits } from "./format";
import {
	itemName,
	type ListGroup,
	legSelTarget,
	placeViewSource,
	shopPlan,
	targetLabel,
} from "./list-model";
import type { ListItemDto } from "./lists.functions";
import { PriceEditor } from "./PriceEditor";
import { AssignPicker, PlacePicker } from "./pickers";
import { isGhost } from "./queries";
import { RowCheckbox } from "./RowCheckbox";
import { LISTS_TESTID } from "./testids";
import type { ListActions } from "./use-list-actions";

export type RowCtx = {
	ix: GraphIndex;
	schedule: ScheduleResult;
	dueCtx: DueCtx;
	now: number;
	scopeId: string | null;
	/** Show where the row hangs (every view but Place). */
	showSource: boolean;
	/** The editing affordances are enabled (useEditGuard). */
	canEdit: boolean;
	/** Why not (tooltip), when disabled. */
	reason: string | null;
	closedIssue?: (itemId: string) => boolean;
};

const SWIPE_PX = 72;

/** What a list row carries while it's dragged (`useDnd().onDrop('list')`). */
export type ListDragData = Extract<DragData, { type: "list" }>;

export function ListRow({
	row,
	ctx,
	lingering,
	glow,
	onToggle,
	actions,
	sortable = false,
	boardId = "",
	placeGroup,
}: {
	row: ListItemDto;
	ctx: RowCtx;
	/** Just ticked: stays in place, struck through, for 4 s. */
	lingering: boolean;
	/** The first "open now" row of its group gets the one glow dot. */
	glow: boolean;
	onToggle: (row: ListItemDto) => void;
	actions: ListActions;
	/** Place view: the row drags (by its grip) to reorder or move to another place. */
	sortable?: boolean;
	boardId?: string;
	/**
	 * Place view: the group the row sits in. A row that doesn't hang on the
	 * group's own place/day gets its source crumb (QA ROLL-05).
	 */
	placeGroup?: Pick<ListGroup, "repId" | "dayId" | "groupKind">;
}) {
	const ws = useWorkspace();
	const { access, graph } = ws;
	const openAddExpense = useUi((s) => s.openAddExpense);
	const marks = useProposalMarks(`list:${row.id}`);
	const ghost = isGhost(row);
	const marked = marks.length > 0;
	const editable = ctx.canEdit && !ghost;
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(row.text);
	const [noteOpen, setNoteOpen] = useState(false);
	const [noteDraft, setNoteDraft] = useState(row.note ?? "");
	const [dueOpen, setDueOpen] = useState(false);
	const rowEl = useRef<HTMLLIElement | null>(null);
	const [assignOpen, setAssignOpen] = useState(false);
	const [moveOpen, setMoveOpen] = useState(false);
	const [shopOpen, setShopOpen] = useState(false);
	const [priceOpen, setPriceOpen] = useState(false);
	// FB-24: "Dennis is editing Book the ryokan · Due" on this row; a private
	// row (a gift) shows nothing.
	const formField = editing
		? "Text"
		: noteOpen
			? "Note"
			: dueOpen
				? "Due"
				: priceOpen
					? "Price"
					: assignOpen
						? "Who"
						: moveOpen || shopOpen
							? "Place"
							: null;
	useFormPresence(
		formField && !ghost
			? {
					k: "list",
					m: "edit",
					t: `list:${row.id}`,
					f: formField,
					private: row.isPrivate,
				}
			: null,
	);
	const [dx, setDx] = useState(0);
	const start = useRef<{ x: number; y: number; id: number } | null>(null);

	const done = row.status !== "open";
	const due = effectiveDue(row, ctx.dueCtx);
	const state: DueState = dueState(due, ctx.now, row.status);
	const tbd = !due && !!row.dueRule;
	const plan =
		row.list === "shopping"
			? shopPlan(ctx.ix, ctx.schedule, row, ctx.closedIssue)
			: null;
	const closed = plan?.kind === "scheduled" && plan.closed;
	const overdue = state === "overdue";
	const label = plainOf(row.text);
	const drag = useSortable({
		id: `list:${boardId}:${row.id}`,
		data: {
			type: "list",
			listItemId: row.id,
			label,
			panel: "lists",
			target: row.target,
			list: row.list,
			board: boardId,
		} satisfies ListDragData,
		disabled:
			!sortable || !ctx.canEdit || isGhost(row) || row.status !== "open",
	});
	const canMoney =
		!access.isGuest && can(access, "manageExpenses") && ws.mode === "live";

	const addExpense = () => {
		const currency = row.priceCurrency ?? undefined;
		// Gift privacy (ADDENDUM §10): an expense from a private item starts private.
		openAddExpense({
			target: row.target,
			title: label.slice(0, 120),
			category: "shopping",
			listItemId: row.id,
			...(row.priceAmount != null && currency
				? {
						amountMinor: toMinorUnits(row.priceAmount, currency),
						currency,
					}
				: {}),
			isPrivate: row.isPrivate,
		});
	};

	// Touch swipe: right completes, left deletes (with Undo).
	const onPointerDown = (e: PointerEvent) => {
		if (e.pointerType !== "touch" || !editable) return;
		start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
	};
	const onPointerMove = (e: PointerEvent) => {
		const s = start.current;
		if (!s || s.id !== e.pointerId) return;
		const ddx = e.clientX - s.x;
		if (Math.abs(e.clientY - s.y) > 24 && Math.abs(ddx) < 24) {
			start.current = null;
			setDx(0);
			return;
		}
		setDx(Math.max(-120, Math.min(120, ddx)));
	};
	const onPointerUp = () => {
		if (!start.current) return;
		start.current = null;
		if (dx > SWIPE_PX) onToggle(row);
		else if (dx < -SWIPE_PX) actions.remove(row.id, label);
		setDx(0);
	};

	const saveText = () => {
		const text = draft.trim();
		setEditing(false);
		if (text && text !== row.text) actions.update(row.id, { text });
		else setDraft(row.text);
	};

	const assignees = row.assigneeIds;
	// Muted lines under the text, one fact each (they truncate, never wrap mid-fact).
	const lines: { key: string; node: ReactNode }[] = [];
	const own =
		(row.target.kind === "trip" && ctx.scopeId === null) ||
		(row.target.kind === "node" && row.target.nodeId === ctx.scopeId);
	const inGroup = placeGroup
		? placeViewSource(ctx.ix, row.target, placeGroup, ctx.scopeId)
		: null;
	if ((ctx.showSource && !own) || inGroup) {
		// The source crumb jumps there (QA ROLL-05): a place becomes the scope;
		// a visit, a leg or a day is selected.
		const t = row.target;
		const leg = t.kind === "leg" ? legSelTarget(ctx.ix, t.legId) : null;
		const go =
			t.kind === "node"
				? () => ws.nav.zoomTo(t.nodeId)
				: t.kind === "item"
					? () => ws.nav.select({ kind: "item", id: t.itemId })
					: t.kind === "day"
						? () => ws.nav.select({ kind: "day", id: t.dayId })
						: leg
							? () => ws.nav.select({ kind: "leg", target: leg })
							: null;
		const text = inGroup ?? targetLabel(ctx.ix, t, ctx.scopeId);
		lines.push({
			key: "src",
			node: go ? (
				<button
					type="button"
					data-testid={LISTS_TESTID.rowSource}
					onClick={go}
					className="max-w-full truncate text-left hover:text-foreground hover:underline hover:underline-offset-2"
				>
					{text}
				</button>
			) : (
				<span>{text}</span>
			),
		});
	}
	const primaryShop = row.target.kind === "node" ? row.target.nodeId : null;
	const extraShops = row.extraTargetNodeIds.filter((n) => n !== primaryShop);
	if (extraShops.length && row.list === "shopping") {
		const names = [
			primaryShop ? ctx.ix.node(primaryShop)?.name : null,
			...extraShops.map((n) => ctx.ix.node(n)?.name),
		].filter(Boolean);
		lines.push({ key: "shops", node: <span>{names.join(" or ")}</span> });
	}
	if (plan && plan.kind !== "none")
		lines.push({
			key: "plan",
			node: (
				<span
					data-testid={LISTS_TESTID.shopPlan}
					data-kind={closed ? "closed" : plan.kind}
					className={cn(closed && !overdue && "text-warning")}
				>
					{plan.kind === "scheduled" ? (
						<>
							{closed
								? `Closed Day ${plan.dayNumber}`
								: `Day ${plan.dayNumber}`}
							{" · "}
							{plan.place}
							{plan.time && !closed ? (
								<span className="ml-1 font-mono tnum">{plan.time}</span>
							) : null}
						</>
					) : (
						plan.label
					)}
				</span>
			),
		});
	if (row.dueRule) {
		const r = row.dueRule;
		const n = r.kind === "days" ? r.days : r.months;
		const unit = r.kind === "days" ? "day" : "month";
		lines.push({
			key: "rule",
			node: (
				<span className="inline-flex max-w-full items-center gap-1">
					<Link2 className="size-3 shrink-0" strokeWidth={1.5} />
					<span className="truncate">
						{r.kind === "months" && r.dayOfMonth
							? `The ${r.dayOfMonth}${ordinal(r.dayOfMonth)}, `
							: ""}
						{n} {unit}
						{n === 1 ? "" : "s"} before {itemName(ctx.ix, r.itemId)}
					</span>
				</span>
			),
		});
	}

	return (
		<li
			ref={(el) => {
				drag.setNodeRef(el);
				rowEl.current = el;
			}}
			data-testid={LISTS_TESTID.row}
			data-id={row.id}
			data-status={row.status}
			data-state={state}
			data-private={row.isPrivate ? "" : undefined}
			// FB-17: live cursors anchor to the row; a private row (only I see it)
			// never shares where my cursor is.
			data-cursor-anchor={ghost ? undefined : `list:${row.id}`}
			data-cursor-vis={row.isPrivate ? "private" : undefined}
			data-ghost={ghost ? "" : undefined}
			aria-label={label}
			onKeyDown={(e) => {
				// Keys act on the row whose checkbox has the focus (never inside a field).
				const t = e.target as HTMLElement;
				if (!editable || t.getAttribute("role") !== "checkbox") return;
				if (e.key === "x") {
					e.preventDefault();
					onToggle(row);
				} else if (e.key === "d") {
					e.preventDefault();
					setDueOpen(true);
				} else if (e.key === "Enter") {
					e.preventDefault();
					setEditing(true);
				}
			}}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			style={
				dx
					? { transform: `translateX(${dx}px)` }
					: drag.transform && !drag.isDragging
						? {
								transform: CSS.Translate.toString(drag.transform),
								transition: drag.transition,
							}
						: undefined
			}
			className={cn(
				"group/row relative bg-background text-sm outline-none",
				drag.isDragging && "opacity-40",
				"min-h-11 md:min-h-9 hover:bg-accent/40 has-[[role=checkbox]:focus-visible]:bg-accent/50",
				dx === 0 && "transition-transform duration-150",
			)}
		>
			{overdue ? (
				<span
					aria-hidden
					className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-warning-hairline"
				/>
			) : null}
			{sortable && editable && row.status === "open" ? (
				<button
					type="button"
					ref={drag.setActivatorNodeRef}
					{...drag.attributes}
					{...drag.listeners}
					aria-label={`Move ${label}`}
					data-testid={LISTS_TESTID.rowGrip}
					className="absolute top-2 left-0.5 flex h-5 w-3.5 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 max-md:hidden"
				>
					<GripVertical className="size-3.5" strokeWidth={1.5} />
				</button>
			) : null}
			{/* A suggestion on this row: the dashed ghost, inset so its avatar fits. */}
			<ProposalGhost
				marks={marks}
				className={marked ? "mx-3 mt-2.5 mb-1" : undefined}
				actions={
					access.canReview
						? (lead) => <GhostActions proposalId={lead.proposalId} />
						: undefined
				}
			>
				<div
					className={cn(
						"flex flex-wrap items-start gap-x-3 gap-y-0.5 py-1.5",
						marked ? "px-1" : "px-4",
						ghost && "opacity-80",
					)}
				>
					<RowCheckbox
						data-testid={LISTS_TESTID.rowCheck}
						checked={row.status === "done"}
						disabled={!editable}
						onCheckedChange={() => onToggle(row)}
						aria-label={
							row.list === "shopping" ? `Bought: ${label}` : `Done: ${label}`
						}
					/>
					<div className="min-w-0 flex-1 basis-40">
						{editing ? (
							<MentionInput
								value={draft}
								onChange={setDraft}
								onSubmit={saveText}
								onCancel={() => {
									setDraft(row.text);
									setEditing(false);
								}}
								onBlur={saveText}
								autoFocus
								ariaLabel="Edit the text"
								className="py-0.5"
							/>
						) : (
							// The marks after the text wrap below it instead of squeezing it,
							// and an @mention chip never breaks inside (a gift row with a
							// lock, a note, an assignee, a due chip and a price).
							<div
								data-testid={LISTS_TESTID.rowTextLine}
								className="flex min-w-0 flex-wrap items-baseline gap-x-1.5"
							>
								<button
									type="button"
									data-testid={LISTS_TESTID.rowText}
									disabled={!editable}
									onClick={() => setEditing(true)}
									className={cn(
										"min-w-0 max-w-full cursor-text text-left leading-5 disabled:cursor-default [&_[data-mention]]:whitespace-nowrap",
										done && "text-muted-foreground line-through",
									)}
								>
									<MarkdownText md={row.text} inline />
								</button>
								{row.isPrivate ? (
									<span
										data-testid={LISTS_TESTID.privateMark}
										title="Only you can see this"
										className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
									>
										<Lock className="size-3" strokeWidth={1.5} />
										<span className="max-md:sr-only">Only you</span>
									</span>
								) : null}
								{row.status === "skipped" ? (
									<span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
										skipped
									</span>
								) : null}
								{row.note && !noteOpen ? (
									<button
										type="button"
										onClick={() => setNoteOpen(true)}
										className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
										aria-label="Show the note"
									>
										· note
									</button>
								) : null}
							</div>
						)}
						{lines.length ? (
							<div className="mt-0.5 flex min-w-0 flex-col text-xs leading-4 text-muted-foreground">
								{lines.map((l) => (
									<div key={l.key} className="truncate">
										{l.node}
									</div>
								))}
							</div>
						) : null}
						{noteOpen ? (
							<div className="mt-1">
								{editable ? (
									<div className="flex flex-col gap-1.5">
										<MentionInput
											multiline
											value={noteDraft}
											onChange={setNoteDraft}
											placeholder="Add a note… Markdown works."
											onSubmit={(v) => {
												actions.update(row.id, { note: v.trim() ? v : null });
												setNoteOpen(false);
											}}
											onCancel={() => {
												setNoteDraft(row.note ?? "");
												setNoteOpen(false);
											}}
											autoFocus={!row.note}
											ariaLabel="Note"
										/>
										<div className="flex justify-end gap-1">
											<Button
												variant="ghost"
												size="xs"
												onClick={() => {
													setNoteDraft(row.note ?? "");
													setNoteOpen(false);
												}}
											>
												Cancel
											</Button>
											<Button
												size="xs"
												onClick={() => {
													actions.update(row.id, {
														note: noteDraft.trim() ? noteDraft : null,
													});
													setNoteOpen(false);
												}}
											>
												Save note
											</Button>
										</div>
									</div>
								) : row.note ? (
									<MarkdownText
										md={row.note}
										className="text-[13px] text-muted-foreground"
									/>
								) : null}
							</div>
						) : null}
						{lingering && row.list === "shopping" && canMoney ? (
							<Button
								variant="ghost"
								size="xs"
								data-testid={LISTS_TESTID.boughtExpense}
								className="-ml-2 mt-0.5 h-6 text-primary"
								onClick={addExpense}
							>
								<Wallet /> Add expense
							</Button>
						) : null}
					</div>
					<div className="ml-auto flex shrink-0 items-center gap-2 pt-0.5 text-xs text-muted-foreground">
						<AssignPicker
							open={assignOpen}
							onOpenChange={setAssignOpen}
							// The button hides on narrow boards (⋯ › Assign… opens it there):
							// hang the list from a wrapper that is always laid out (FB-06).
							asAnchor="wrap"
							value={assignees}
							onChange={(ids) => actions.setAssignees(row.id, ids)}
						>
							<button
								type="button"
								data-testid={LISTS_TESTID.rowAssign}
								disabled={!editable}
								aria-label={
									assignees.length ? "Change who it's for" : "Assign someone"
								}
								className={cn(
									"flex items-center -space-x-1 rounded-full disabled:cursor-default",
									!assignees.length &&
										// Narrow boards keep this in the ⋯ menu ("Assign…").
										"opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 max-md:hidden @max-md:hidden",
								)}
							>
								{assignees.length ? (
									assignees
										.slice(0, 3)
										.map((id) => (
											<MemberAvatar key={id} memberId={id} size={16} />
										))
								) : (
									<UserPlus className="size-3.5" strokeWidth={1.5} />
								)}
							</button>
						</AssignPicker>
						<DueEditor
							row={row}
							rowRef={rowEl}
							open={dueOpen}
							onOpenChange={setDueOpen}
							onSave={(p) => actions.update(row.id, p)}
						>
							<span>
								<DueChip
									due={due}
									state={state}
									tbd={tbd}
									glow={glow}
									now={ctx.now}
									onClick={editable ? () => setDueOpen(true) : undefined}
								/>
							</span>
						</DueEditor>
						<PriceEditor
							row={row}
							open={priceOpen}
							onOpenChange={setPriceOpen}
							onSave={(p) => actions.update(row.id, p)}
						>
							<button
								type="button"
								disabled={!editable || row.list !== "shopping"}
								onClick={() => setPriceOpen(true)}
								aria-label="Quantity and budget"
								className="inline-flex items-center gap-2 rounded font-mono tnum disabled:cursor-default"
							>
								{row.quantity ? <span>×{row.quantity}</span> : null}
								{row.priceAmount != null ? (
									<span>{formatPrice(row.priceAmount, row.priceCurrency)}</span>
								) : null}
							</button>
						</PriceEditor>
						<RowMenu
							row={row}
							editable={editable}
							canMoney={canMoney}
							actions={actions}
							onDate={() => setDueOpen(true)}
							onAssign={() => setAssignOpen(true)}
							onMove={() => setMoveOpen(true)}
							onShops={() => setShopOpen(true)}
							onPrice={() => setPriceOpen(true)}
							onNote={() => setNoteOpen(true)}
							onExpense={addExpense}
							canPrivate={
								row.mine === true &&
								!access.isGuest &&
								!!access.memberId &&
								!ghost
							}
							proposing={access.mode === "suggest"}
							myUserId={graph.me.userId}
						/>
						<PlacePicker
							open={moveOpen}
							onOpenChange={setMoveOpen}
							asAnchor
							value={row.target.kind === "node" ? row.target.nodeId : null}
							allowRoot
							onPick={(nodeId) => {
								setMoveOpen(false);
								const target: BundleTarget = nodeId
									? { kind: "node", nodeId }
									: { kind: "trip" };
								actions.move(row.id, { target });
							}}
						>
							<span className="absolute right-4 bottom-0 size-0" />
						</PlacePicker>
						<PlacePicker
							open={shopOpen}
							onOpenChange={setShopOpen}
							asAnchor
							value={null}
							placeholder="Add a shop that sells it…"
							exclude={[
								...row.extraTargetNodeIds,
								...(row.target.kind === "node" ? [row.target.nodeId] : []),
							]}
							onPick={(nodeId) => {
								setShopOpen(false);
								if (nodeId)
									actions.setTargets(row.id, [
										...row.extraTargetNodeIds,
										nodeId,
									]);
							}}
						>
							<span className="absolute right-4 bottom-0 size-0" />
						</PlacePicker>
					</div>
				</div>
			</ProposalGhost>
		</li>
	);
}

function ordinal(n: number): string {
	if (n % 100 >= 11 && n % 100 <= 13) return "th";
	return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

/**
 * The due chip (mono 12): amber only when overdue (a real problem); the
 * neutral/primary tint when due soon (ADDENDUM §10); one glow dot per group
 * for "Open now" (DESIGN §1.2); "Date TBD" for a rule whose item isn't on a day.
 */
function DueChip({
	due,
	state,
	tbd,
	glow,
	now,
	onClick,
}: {
	due: ReturnType<typeof effectiveDue>;
	state: DueState;
	tbd: boolean;
	glow: boolean;
	now: number;
	onClick?: () => void;
}) {
	if (!due && !tbd) {
		return onClick ? (
			<button
				type="button"
				onClick={onClick}
				aria-label="Set a date"
				className="rounded-full p-0.5 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 max-md:hidden @max-md:hidden"
			>
				<CalendarPlus className="size-3.5" strokeWidth={1.5} />
			</button>
		) : null;
	}
	const text = tbd ? "Date TBD" : due ? dueChipLabel(due, state, now) : "";
	const Tag = onClick ? "button" : "span";
	return (
		<Tag
			{...(onClick ? { type: "button" as const, onClick } : {})}
			data-testid={LISTS_TESTID.dueChip}
			data-state={tbd ? "tbd" : state}
			title={
				due && state !== "later" && state !== "none" ? due.label : undefined
			}
			className={cn(
				"inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 font-mono text-xs whitespace-nowrap tnum",
				state === "overdue" && "text-warning",
				(state === "today" || state === "soon") && "bg-primary/10 text-primary",
				state === "open_now" && "bg-muted text-foreground",
				(state === "later" || state === "none" || tbd) &&
					"text-muted-foreground",
			)}
		>
			{state === "open_now" && glow ? (
				<span
					aria-hidden
					className="size-1.5 rounded-full bg-glow shadow-[0_0_0_3px_color-mix(in_oklab,var(--glow)_30%,transparent)]"
				/>
			) : null}
			{text}
		</Tag>
	);
}

function RowMenu({
	row,
	editable,
	canMoney,
	canPrivate,
	proposing,
	actions,
	onDate,
	onAssign,
	onMove,
	onShops,
	onPrice,
	onNote,
	onExpense,
}: {
	row: ListItemDto;
	editable: boolean;
	canMoney: boolean;
	canPrivate: boolean;
	/** Edits become suggestions (a suggester, suggest mode). */
	proposing: boolean;
	myUserId: string;
	actions: ListActions;
	onDate: () => void;
	onAssign: () => void;
	onMove: () => void;
	onShops: () => void;
	onPrice: () => void;
	onNote: () => void;
	onExpense: () => void;
}) {
	const label = plainOf(row.text);
	// Popovers open once the menu has fully closed (else its dismissal closes them).
	const pending = useRef<(() => void) | null>(null);
	const after = (fn: () => void) => () => {
		pending.current = fn;
	};
	if (!editable && !row.note) return <span className="w-6" />;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					data-testid={LISTS_TESTID.rowMenu}
					aria-label={`More for ${label}`}
					className="rounded-md p-0.5 text-muted-foreground opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100 max-md:opacity-100"
				>
					<MoreHorizontal className="size-4" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="w-52"
				onCloseAutoFocus={(e) => {
					e.preventDefault();
					const fn = pending.current;
					pending.current = null;
					if (fn) setTimeout(fn, 0);
				}}
			>
				{editable ? (
					<>
						<DropdownMenuItem onSelect={after(onDate)}>
							Set date…<DropdownMenuShortcut>D</DropdownMenuShortcut>
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={after(onAssign)}>
							{row.list === "shopping" ? "For…" : "Assign…"}
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={after(onNote)}>
							{row.note ? "Edit note" : "Add note"}
						</DropdownMenuItem>
						{row.list === "shopping" ? (
							<DropdownMenuItem onSelect={after(onPrice)}>
								Quantity & budget…
							</DropdownMenuItem>
						) : null}
						{row.list === "shopping" ? (
							<DropdownMenuItem onSelect={after(onShops)}>
								Candidate shops…
							</DropdownMenuItem>
						) : null}
						{row.list === "shopping" && row.extraTargetNodeIds.length ? (
							<DropdownMenuItem onSelect={() => actions.setTargets(row.id, [])}>
								Clear candidate shops
							</DropdownMenuItem>
						) : null}
						<DropdownMenuItem onSelect={after(onMove)}>
							Move to…
						</DropdownMenuItem>
						{/* Sharing publishes it: a suggestion unless you may edit (QA
						    SEC-R3-01). Nothing private can be suggested, so no
						    "Make private" while suggesting. */}
						{canPrivate && (row.isPrivate || !proposing) ? (
							<DropdownMenuItem
								onSelect={() =>
									row.isPrivate && proposing
										? actions.suggestShare(row)
										: actions.update(row.id, { isPrivate: !row.isPrivate })
								}
							>
								{!row.isPrivate
									? "Make private (only me)"
									: proposing
										? "Suggest sharing with the trip"
										: "Share with the trip"}
							</DropdownMenuItem>
						) : null}
						{row.list === "shopping" && canMoney ? (
							<DropdownMenuItem onSelect={after(onExpense)}>
								Add expense…
							</DropdownMenuItem>
						) : null}
						<DropdownMenuSeparator />
						{row.status === "skipped" ? (
							<DropdownMenuItem
								onSelect={() => actions.setStatus(row.id, "open")}
							>
								Reopen
							</DropdownMenuItem>
						) : (
							<DropdownMenuItem onSelect={() => actions.skip(row)}>
								Skip
							</DropdownMenuItem>
						)}
						<DropdownMenuItem
							variant="destructive"
							onSelect={() => actions.remove(row.id, label)}
						>
							Delete
						</DropdownMenuItem>
					</>
				) : (
					<DropdownMenuItem onSelect={after(onNote)}>
						Show note
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
