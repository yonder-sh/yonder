/**
 * The timeline card (DESIGN §7.1 "Card"): the time rail on the left (start in
 * ink, end muted, ◆ for a pinned start, a 10px lock when booked for this
 * date, ⁺¹ past midnight), then a hairline card with the crumb, title, local
 * name, category, the note line and, on the right, assignees, bundle icons,
 * at most ONE warning chip (ADDENDUM §10 "fewer badges"), the duration chip
 * and the ⋯ menu. The bottom 6px resizes in 15-minute steps.
 *
 * Marks: a suggested change wraps the card in `ProposalGhost` (dashed, author
 * avatar); the date what-if draws a primary ring; a peer editing it draws a
 * presence rule; a remote change glows once.
 */
import { cn } from "cn";
import {
	ArrowDown,
	ArrowUp,
	BedDouble,
	Coffee,
	EllipsisVertical,
	GripVertical,
	Image as ImageIcon,
	ListTodo,
	Lock,
	ShoppingBag,
	StickyNote,
	Timer,
	TriangleAlert,
	Utensils,
	Wallet,
} from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useContext,
	useRef,
	useState,
} from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { CategoryDot } from "@/components/common/glyphs";
import { MarkdownText } from "@/components/common/markdown-text";
import { MemberAvatar, presenceColor } from "@/components/common/member";
import { ProposalGhost } from "@/components/common/proposal-ghost";
import { DurationInput, TimeInput } from "@/components/common/time";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
	PopoverTrigger as PopoverPrimitiveTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { HoursChip } from "@/features/insights/HoursChip";
import { useDateDraftImpact } from "@/features/insights/use-date-draft-impact";
import { useHoursIssues } from "@/features/insights/use-hours-issues";
import { useNotePreview } from "@/features/notes/use-note-preview";
import { GhostActions } from "@/features/suggest/GhostActions";
import { can } from "@/lib/auth/roles";
import { PLACE_CATEGORIES } from "@/lib/domain/taxonomy";
import { conflictFixes } from "@/lib/engine/suggest";
import { hhmm } from "@/lib/engine/time";
import type { Counts, GraphItem } from "@/lib/engine/types";
import {
	formatDayDate,
	formatDuration,
	formatTime,
	langFor,
} from "@/lib/format";
import { useFormPresence } from "@/lib/realtime/form-presence";
import { useEditingPeer } from "@/lib/realtime/presence";
import { useFollowToggle } from "@/lib/realtime/view-ui";
import { TESTID } from "@/lib/testids";
import { useFlash, useUi } from "@/lib/workspace/ui-store";
import { useProposalMarks } from "@/lib/workspace/use-proposals";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { useMenuHandoff } from "./menu-handoff";
import { PlanUiContext } from "./plan-context";
import { type DropPlan, planStep } from "./plan-drop";
import { setPlanHover } from "./plan-hover";
import { PLAN_TESTID } from "./testids";
import { itemName, slotOf, usePlanActions } from "./use-plan-actions";

/** A click that landed on one of the card's own controls, or in a menu or popover it opened. */
function isControl(target: EventTarget, card: Element): boolean {
	const el = target instanceof Element ? target : null;
	if (!el) return false;
	const hit = el.closest(
		'button, a, input, textarea, select, [role="menuitem"], [role="menuitemcheckbox"], [role="dialog"], [role="menu"], [role="separator"], [role="listbox"]',
	);
	// The title button is the card's own keyboard entry: it selects the card.
	return hit !== null && hit !== card && !hit.hasAttribute("data-card-main");
}

/**
 * A disabled submenu trigger looks and behaves like the other disabled items
 * (the shared `DropdownMenuSubTrigger` has no disabled style, so a viewer's
 * "Move to day ›" read as enabled; QA SHARE-03).
 */
export const DISABLED_SUB_TRIGGER =
	"data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

/** DESIGN §7.1 presets: 15m 30m 45m 1h 1h30 2h 3h, half day, full day. */
export const DURATION_PRESETS = [15, 30, 45, 60, 90, 120, 180, 240, 480];

/** `items.fixed_date` (E2 "Booked for this date"). */
export function isBooked(item: GraphItem): boolean {
	return item.fixedDate === true;
}

/** The glyph of an unlocated block, from its title ("Lunch" → Utensils). */
function BlockGlyph({ title }: { title: string }) {
	const t = title.toLowerCase();
	const Icon = /breakfast|lunch|dinner|brunch|meal|food|eat/.test(t)
		? Utensils
		: /coffee|caf[eé]|tea/.test(t)
			? Coffee
			: /rest|nap|sleep|check.?in|hotel/.test(t)
				? BedDouble
				: Timer;
	return (
		<Icon
			className="size-3.5 shrink-0 text-muted-foreground"
			strokeWidth={1.5}
			aria-hidden
		/>
	);
}

function add(a: Counts | undefined, b: Counts | undefined) {
	return {
		media:
			(a?.media ?? 0) +
			(a?.links ?? 0) +
			(a?.docs ?? 0) +
			(b?.media ?? 0) +
			(b?.links ?? 0) +
			(b?.docs ?? 0),
		todo: (a?.todoOpen ?? 0) + (b?.todoOpen ?? 0),
		shop: (a?.shopOpen ?? 0) + (b?.shopOpen ?? 0),
		note: !!(a?.hasNote || b?.hasNote),
	};
}

function BundleIcon({
	icon: Icon,
	count,
	label,
	testId,
}: {
	icon: typeof ImageIcon;
	count: number;
	label: string;
	testId?: string;
}) {
	return (
		<span
			role="img"
			aria-label={`${count} ${label}`}
			data-testid={testId}
			className="inline-flex items-center gap-0.5 text-muted-foreground"
		>
			<Icon className="size-3.5" strokeWidth={1.5} aria-hidden />
			{count > 1 ? (
				<span className="font-mono text-[11px] leading-none tnum">{count}</span>
			) : null}
		</span>
	);
}

/** Node + item bundles, only when non-empty (DESIGN §1.4), plus the money wallet. */
function BundleIcons({ item }: { item: GraphItem }) {
	const { counts } = useWorkspace();
	const { money } = useContext(PlanUiContext);
	const c = add(
		counts?.byItem[item.id],
		item.nodeId ? counts?.byNode[item.nodeId] : undefined,
	);
	const wallet = money[`item:${item.id}`] ?? 0;
	if (!c.media && !c.todo && !c.shop && !c.note && !wallet) return null;
	return (
		<span className="hidden items-center gap-1.5 @sm:flex">
			{c.media ? (
				<BundleIcon icon={ImageIcon} count={c.media} label="media" />
			) : null}
			{c.todo ? (
				<BundleIcon icon={ListTodo} count={c.todo} label="open todos" />
			) : null}
			{c.shop ? (
				<BundleIcon icon={ShoppingBag} count={c.shop} label="to buy" />
			) : null}
			{c.note ? <BundleIcon icon={StickyNote} count={1} label="note" /> : null}
			{wallet ? (
				<BundleIcon
					icon={Wallet}
					count={wallet}
					label={wallet === 1 ? "expense" : "expenses"}
					testId={PLAN_TESTID.itemWallet}
				/>
			) : null}
		</span>
	);
}

/**
 * A leg's (flight's, stay's) own bundle, the same icons as a card's (QA
 * LIST-02: "Buy Fuji Excursion seats" on the leg shows as a todo count on its
 * row), plus the money wallet. Nothing when the leg has no row or no content.
 */
export function LegBundleIcons({
	legId,
	className,
}: {
	legId: string | null | undefined;
	className?: string;
}) {
	const { counts } = useWorkspace();
	const { money } = useContext(PlanUiContext);
	if (!legId) return null;
	const c = add(counts?.byLeg[legId], undefined);
	const wallet = money[`leg:${legId}`] ?? 0;
	if (!c.media && !c.todo && !c.shop && !c.note && !wallet) return null;
	return (
		<span
			data-testid={PLAN_TESTID.legBundles}
			className={cn("hidden shrink-0 items-center gap-1.5 @sm:flex", className)}
		>
			{c.media ? (
				<BundleIcon icon={ImageIcon} count={c.media} label="media" />
			) : null}
			{c.todo ? (
				<BundleIcon icon={ListTodo} count={c.todo} label="open todos" />
			) : null}
			{c.shop ? (
				<BundleIcon icon={ShoppingBag} count={c.shop} label="to buy" />
			) : null}
			{c.note ? <BundleIcon icon={StickyNote} count={1} label="note" /> : null}
			{wallet ? (
				<BundleIcon
					icon={Wallet}
					count={wallet}
					label={wallet === 1 ? "expense" : "expenses"}
				/>
			) : null}
		</span>
	);
}

/**
 * ONE warning chip per card: the pin conflict alone ("15m late"), the hours
 * chip alone (WP-Insights' `HoursChip`), or "2 issues" with the list.
 */
function WarningChip({ item }: { item: GraphItem }) {
	const { ix, schedule } = useWorkspace();
	const issues = useHoursIssues();
	const actions = usePlanActions();
	const guard = useEditGuard();
	const late = schedule.items[item.id]?.late;
	const hours = (issues.byItem[item.id] ?? []).filter(
		(i) => i.severity === "warn",
	);
	// The list being open travels with my view.
	const [open, setOpen] = useFollowToggle("plan.late", item.id);
	if (!late) return <HoursChip itemId={item.id} />;
	const fixes = conflictFixes(ix, schedule, { kind: "item", itemId: item.id });
	const lines: string[] = [
		`Starts ${formatDuration(late.minutes)} late — the plan before it runs past ${item.pinnedStart ?? "the pin"}.`,
		...hours.map((h) => h.label),
	];
	const label = hours.length
		? `${1 + hours.length} issues`
		: `${formatDuration(late.minutes, { compact: true })} late`;
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTriggerChip label={label} />
			<PopoverContent className="w-72 p-3 text-sm" align="end">
				<ul className="grid gap-1.5">
					{lines.map((l) => (
						<li key={l} className="flex gap-2">
							<TriangleAlert
								className="mt-0.5 size-3.5 shrink-0 text-warning"
								strokeWidth={1.5}
								aria-hidden
							/>
							<span>{l}</span>
						</li>
					))}
				</ul>
				{fixes.length ? (
					<div className="mt-3 flex flex-wrap gap-1.5">
						{fixes.map((f) => (
							<Button
								key={`${f.kind}:${"itemId" in f ? f.itemId : f.legId}`}
								size="xs"
								variant="outline"
								disabled={guard.disabled}
								data-testid={PLAN_TESTID.legFix}
								onClick={() => {
									if (f.kind === "shorten")
										actions.update.mutate({
											itemId: f.itemId,
											patch: { durationMin: f.durationMin },
										});
									else if (f.kind === "unpin")
										actions.update.mutate({
											itemId: f.itemId,
											patch: { pinnedStart: null },
										});
								}}
							>
								{f.kind === "shorten"
									? `Shorten ${itemName(ix, ix.item(f.itemId))} to ${formatDuration(f.durationMin, { compact: true })}`
									: f.kind === "unpin"
										? `Unpin ${item.pinnedStart ?? ""}`
										: `Use fastest (${formatDuration(f.durationMin, { compact: true })})`}
							</Button>
						))}
					</div>
				) : null}
			</PopoverContent>
		</Popover>
	);
}

function PopoverTriggerChip({ label }: { label: string }) {
	return (
		<PopoverPrimitiveTrigger asChild>
			<button
				type="button"
				data-testid={TESTID.conflictBadge}
				onClick={(e) => e.stopPropagation()}
				className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border border-warning-hairline bg-warning-wash px-2 text-xs font-medium text-warning"
			>
				<TriangleAlert className="size-3" strokeWidth={1.75} aria-hidden />
				{label}
			</button>
		</PopoverPrimitiveTrigger>
	);
}

/** The pinned-start popover (◆): a time, Pin/Unpin. Its form mounts only while open. */
function PinPopover({
	item,
	open,
	onOpenChange,
	children,
}: {
	item: GraphItem;
	open: boolean;
	onOpenChange: (v: boolean) => void;
	children: ReactNode;
}) {
	// FB-24: "Dennis is editing Shibuya Sky · Start" on the card.
	useFormPresence(
		open ? { k: "item", m: "edit", t: `item:${item.id}`, f: "Start" } : null,
	);
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverAnchor asChild>{children}</PopoverAnchor>
			{open ? (
				<PopoverContent align="start" className="w-64 p-3">
					<PinForm item={item} onDone={() => onOpenChange(false)} />
				</PopoverContent>
			) : null}
		</Popover>
	);
}

function PinForm({ item, onDone }: { item: GraphItem; onDone: () => void }) {
	const { schedule } = useWorkspace();
	const actions = usePlanActions();
	const guard = useEditGuard();
	const [value, setValue] = useState(() => {
		const s = schedule.items[item.id];
		return item.pinnedStart ?? (s ? hhmm(s.start, s.tz) : "09:00");
	});
	return (
		<form
			className="grid gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				if (!/^\d{2}:\d{2}$/.test(value)) return;
				actions.update.mutate({
					itemId: item.id,
					patch: { pinnedStart: value },
				});
				onDone();
			}}
		>
			<p className="text-xs text-muted-foreground">
				A pinned start stays put; the plan flows around it.
			</p>
			<div className="flex items-center gap-2">
				<TimeInput
					value={value}
					onChange={setValue}
					aria-label="Pinned start"
					disabled={guard.disabled}
				/>
				<Button type="submit" size="sm" disabled={guard.disabled}>
					{item.pinnedStart ? "Update" : "Pin"}
				</Button>
			</div>
			{item.pinnedStart ? (
				<Button
					type="button"
					size="sm"
					variant="ghost"
					className="justify-start px-1"
					disabled={guard.disabled}
					onClick={() => {
						actions.update.mutate({
							itemId: item.id,
							patch: { pinnedStart: null },
						});
						onDone();
					}}
				>
					Unpin {item.pinnedStart}
				</Button>
			) : null}
		</form>
	);
}

const cardSelector = (itemId: string) =>
	`[data-testid="${TESTID.timelineItem}"][data-item-id="${itemId}"]`;

/**
 * Where the keyboard focus goes when a card leaves its place from the ⋯ menu
 * or the Overview (Delete, Unschedule, Move to day; QA A11Y-02: never
 * `<body>`, so the next Tab doesn't restart at the top of the page): the next
 * card's title, else the previous card's, else the day's date. Read now,
 * while the card is still in the list; resolved when the focus moves.
 */
export function focusAfterLeaving(
	itemId: string,
	doc: Document = document,
): () => HTMLElement | null {
	const cards = [
		...doc.querySelectorAll<HTMLElement>(
			`[data-testid="${TESTID.timelineItem}"][data-item-id]`,
		),
	];
	const i = cards.findIndex((c) => c.dataset.itemId === itemId);
	const near = [cards[i + 1], cards[i - 1]]
		.map((c) => c?.dataset.itemId)
		.filter((id): id is string => !!id && id !== itemId);
	const dayId =
		i >= 0
			? (cards[i]
					?.closest(`[data-testid="${PLAN_TESTID.daySection}"]`)
					?.getAttribute("data-day-id") ?? null)
			: null;
	return () => {
		for (const id of near) {
			const el = doc
				.querySelector(cardSelector(id))
				?.querySelector<HTMLElement>("[data-card-main]");
			if (el) return el;
		}
		return dayId
			? (doc
					.querySelector(
						`[data-testid="${PLAN_TESTID.daySection}"][data-day-id="${dayId}"]`,
					)
					?.querySelector<HTMLElement>("[data-day-main]") ?? null)
			: null;
	};
}

/** The ⋯ button of a card, after the Plan re-renders it (Move up / Move down). */
const menuOf = (itemId: string) => () =>
	document
		.querySelector(cardSelector(itemId))
		?.querySelector<HTMLElement>(`[data-testid="${PLAN_TESTID.itemMenu}"]`) ??
	null;

/**
 * Focuses `find()` now and keeps it there for a moment while the Plan
 * re-renders (an optimistic delete or reorder can remount the element that
 * had it). Stops as soon as something else takes the focus on purpose.
 */
export function focusWhenReady(find: () => HTMLElement | null, ms = 600): void {
	if (typeof document === "undefined") return;
	const until = Date.now() + ms;
	let mine: HTMLElement | null = null;
	const tick = () => {
		const active = document.activeElement;
		const lost =
			!active || active === document.body || !(active as Node).isConnected;
		if (mine === null || lost) {
			const el = find();
			if (el) {
				el.focus();
				mine = el;
			}
		} else if (active !== mine) return;
		if (Date.now() < until) requestAnimationFrame(tick);
	};
	tick();
}

/**
 * The ⋯ menu of a card (and of an Unscheduled row). Its content mounts on the
 * first open: 300 cards × a day list each would otherwise be built on every
 * render (QA PERF-05).
 */
export function ItemMenu({
	item,
	onPin,
	className,
}: {
	item: GraphItem;
	onPin?: () => void;
	className?: string;
}) {
	const { ix } = useWorkspace();
	const [armed, setArmed] = useState(false);
	const [open, setOpen] = useState(false);
	const name = itemName(ix, item);
	return (
		<DropdownMenu
			open={open}
			onOpenChange={(v) => {
				if (v) setArmed(true);
				setOpen(v);
			}}
		>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={`More for ${name}`}
					data-testid={PLAN_TESTID.itemMenu}
					onClick={(e) => e.stopPropagation()}
					className={cn("shrink-0 text-muted-foreground", className)}
				>
					<EllipsisVertical />
				</Button>
			</DropdownMenuTrigger>
			{armed ? (
				<ItemMenuContent
					item={item}
					name={name}
					{...(onPin ? { onPin } : {})}
				/>
			) : null}
		</DropdownMenu>
	);
}

function ItemMenuContent({
	item,
	name,
	onPin,
}: {
	item: GraphItem;
	name: string;
	onPin?: () => void;
}) {
	const { ix, graph, mode } = useWorkspace();
	const actions = usePlanActions();
	const guard = useEditGuard();
	const openAddExpense = useUi((s) => s.openAddExpense);
	const money = mode === "live" && can(graph.me, "manageExpenses");
	const booked = isBooked(item);
	// An item that opens another surface (the pin popover) opens it once the
	// menu has gone and keeps the focus there (FB-07).
	const menu = useMenuHandoff();
	const handOff = menu.handOff;
	// Where the focus goes once the menu closes, when its ⋯ trigger is about
	// to move or disappear (QA A11Y-02).
	const refocus = useRef<(() => HTMLElement | null) | null>(null);
	const leaving = (fn: () => void) => () => {
		refocus.current = focusAfterLeaving(item.id);
		fn();
	};
	// QA MOB-04: reordering without a drag.
	const up = planStep(ix, item.id, "up");
	const down = planStep(ix, item.id, "down");
	const step = (plan: DropPlan) => () => {
		if (!plan.ok) return;
		refocus.current = menuOf(item.id);
		actions.move.mutate({
			itemId: item.id,
			dayId: plan.dayId,
			...(plan.afterItemId ? { afterItemId: plan.afterItemId } : {}),
			...(plan.beforeItemId ? { beforeItemId: plan.beforeItemId } : {}),
			undo: slotOf(ix, item.id),
		});
	};
	return (
		<DropdownMenuContent
			onCloseAutoFocus={(e) => {
				const find = refocus.current;
				if (find) {
					refocus.current = null;
					e.preventDefault();
					focusWhenReady(find);
					return;
				}
				menu.onCloseAutoFocus(e);
			}}
			align="end"
			className="w-56"
			onClick={(e) => e.stopPropagation()}
		>
			<DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
				{name}
			</DropdownMenuLabel>
			{item.dayId && onPin ? (
				<DropdownMenuItem disabled={guard.disabled} onSelect={handOff(onPin)}>
					{item.pinnedStart
						? `Pinned at ${item.pinnedStart}…`
						: "Pin start time…"}
				</DropdownMenuItem>
			) : null}
			{item.pinnedStart ? (
				<DropdownMenuItem
					disabled={guard.disabled}
					onSelect={() =>
						actions.update.mutate({
							itemId: item.id,
							patch: { pinnedStart: null },
						})
					}
				>
					Unpin
				</DropdownMenuItem>
			) : null}
			{item.dayId ? (
				<DropdownMenuCheckboxItem
					checked={booked}
					disabled={guard.disabled}
					data-testid={PLAN_TESTID.itemBooked}
					onCheckedChange={(v) =>
						actions.update.mutate({
							itemId: item.id,
							patch: { fixedDate: v === true },
						})
					}
				>
					Booked for this date
				</DropdownMenuCheckboxItem>
			) : null}
			{money ? (
				<DropdownMenuItem
					onSelect={() =>
						openAddExpense({
							target: { kind: "item", itemId: item.id },
							title: name,
						})
					}
				>
					<Wallet className="size-4" strokeWidth={1.5} /> Add expense
				</DropdownMenuItem>
			) : null}
			<DropdownMenuSeparator />
			<DropdownMenuItem
				disabled={guard.disabled || !up.ok}
				data-testid={PLAN_TESTID.itemMoveUp}
				onSelect={step(up)}
			>
				<ArrowUp className="size-4" strokeWidth={1.5} /> Move up
			</DropdownMenuItem>
			<DropdownMenuItem
				disabled={guard.disabled || !down.ok}
				data-testid={PLAN_TESTID.itemMoveDown}
				onSelect={step(down)}
			>
				<ArrowDown className="size-4" strokeWidth={1.5} /> Move down
			</DropdownMenuItem>
			<DropdownMenuSub>
				<DropdownMenuSubTrigger
					disabled={guard.disabled}
					className={DISABLED_SUB_TRIGGER}
				>
					{item.dayId ? "Move to day" : "Schedule on"}
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent className="max-h-72 overflow-y-auto">
					{ix.days.map((d) => (
						<DropdownMenuItem
							key={d.id}
							disabled={d.id === item.dayId}
							onSelect={leaving(() => actions.moveToDay(item.id, d.id))}
						>
							<span className="font-mono text-xs text-muted-foreground tnum">
								D{ix.dayNumber(d.id)}
							</span>
							{formatDayDate(d.date)}
							{d.title ? (
								<span className="truncate text-muted-foreground">
									· {d.title}
								</span>
							) : null}
						</DropdownMenuItem>
					))}
				</DropdownMenuSubContent>
			</DropdownMenuSub>
			{item.dayId ? (
				<DropdownMenuItem
					disabled={guard.disabled}
					onSelect={leaving(() => actions.unschedule(item.id))}
				>
					Unschedule
				</DropdownMenuItem>
			) : null}
			<DropdownMenuSeparator />
			<DropdownMenuItem
				variant="destructive"
				disabled={guard.disabled}
				onSelect={leaving(() => actions.deleteItem(item.id))}
			>
				Delete
			</DropdownMenuItem>
		</DropdownMenuContent>
	);
}

/** The bottom-edge resize: 15-minute steps, a live "1h 15m" tooltip, commit on release. */
function useResize(item: GraphItem, disabled: boolean) {
	const actions = usePlanActions();
	const [preview, setPreview] = useState<number | null>(null);
	const start = useRef<{ y: number; min: number } | null>(null);
	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			if (disabled) return;
			e.stopPropagation();
			e.preventDefault();
			(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
			start.current = { y: e.clientY, min: item.durationMin };
			setPreview(item.durationMin);
		},
		[disabled, item.durationMin],
	);
	const onPointerMove = useCallback((e: React.PointerEvent) => {
		if (!start.current) return;
		const steps = Math.round((e.clientY - start.current.y) / 10);
		setPreview(Math.max(15, Math.min(4320, start.current.min + steps * 15)));
	}, []);
	const onPointerUp = useCallback(() => {
		const s = start.current;
		start.current = null;
		setPreview((p) => {
			if (s && p !== null && p !== s.min)
				actions.update.mutate({ itemId: item.id, patch: { durationMin: p } });
			return null;
		});
	}, [actions.update, item.id]);
	return { preview, onPointerDown, onPointerMove, onPointerUp };
}

export type ItemCardProps = {
	item: GraphItem;
	/** The crumb above the title ("Ginza ›"), when the parent changed. */
	crumbNodeId?: string | null;
	compact?: boolean;
	/** dnd-kit's pointer listeners (the card drags; the grip carries the keyboard). */
	dragListeners?: Record<string, unknown>;
	grip?: ReactNode;
	dragging?: boolean;
	overlay?: boolean;
};

export function ItemCard({
	item,
	crumbNodeId,
	compact,
	dragListeners,
	grip,
	dragging,
	overlay,
}: ItemCardProps) {
	const { ix, schedule, sel, nav, access } = useWorkspace();
	const s = schedule.items[item.id];
	const node = ix.node(item.nodeId);
	const selected = sel?.kind === "item" && sel.id === item.id;
	const marks = useProposalMarks(`item:${item.id}`);
	const impact = useDateDraftImpact();
	const peer = useEditingPeer("item", item.id);
	const flash = useFlash(item.id);
	const actions = usePlanActions();
	const guard = useEditGuard();
	const [pinOpen, setPinOpen] = useState(false);
	const resize = useResize(item, guard.disabled || !item.dayId);
	const nodeNote = useNotePreview(
		node ? { kind: "node", nodeId: node.id } : null,
	);
	const title = itemName(ix, item);
	const unlocated = !node;
	const booked = isBooked(item);
	const cat =
		node?.type === "place" && node.category
			? PLACE_CATEGORIES[node.category]
			: null;
	const noteLine = item.note?.split("\n").find((l) => l.trim()) ?? null;
	const whatIf = impact?.items.has(item.id) ?? false;
	const durationShown = resize.preview ?? item.durationMin;
	const endShown =
		s && resize.preview !== null
			? new Date(s.start.getTime() + resize.preview * 60_000)
			: s?.end;

	const card = (
		// The card is a plain box that selects on click; its keyboard and screen
		// reader entry is the title button (QA A11Y-01: no role=button around the
		// card's own buttons). Hovering it lights its pin on the map (MAP-07).
		// biome-ignore lint/a11y/noStaticElementInteractions: the title button is the keyboard entry
		// biome-ignore lint/a11y/useKeyWithClickEvents: the title button is the keyboard entry
		<div
			{...(dragListeners as object)}
			// FB-17: live cursors anchor to the card (fractions of its box).
			data-cursor-anchor={overlay ? undefined : `item:${item.id}`}
			onClick={(e) => {
				// Clicks on the card's own controls (and their portalled menus) don't select it.
				if (e.defaultPrevented || isControl(e.target, e.currentTarget)) return;
				nav.select({ kind: "item", id: item.id });
			}}
			onDoubleClick={() =>
				item.nodeId && nav.select({ kind: "node", id: item.nodeId })
			}
			onMouseEnter={() => setPlanHover({ kind: "item", id: item.id }, true)}
			onMouseLeave={() => setPlanHover({ kind: "item", id: item.id }, false)}
			className={cn(
				"group/card relative flex min-w-0 flex-1 cursor-pointer touch-manipulation items-center gap-3 rounded-lg border bg-card px-3 text-left transition-[border-color,box-shadow] select-none",
				"hover:border-foreground/20 has-[[data-card-main]:focus-visible]:ring-2 has-[[data-card-main]:focus-visible]:ring-ring",
				compact || unlocated ? "min-h-10 py-1.5" : "min-h-14 py-2",
				// A block of time: quieter, not dashed (dashes mean estimates, ADDENDUM §10).
				unlocated && "bg-muted/35",
				selected
					? "outline-2 outline-offset-0 outline-primary outline-solid"
					: "outline-none",
				whatIf && !selected && "ring-2 ring-primary/70",
				flash && "plan-glow",
				dragging && "border-dashed opacity-40",
				overlay && "scale-[1.02] shadow-float",
			)}
			style={
				{
					...(flash
						? {
								"--glow-color": `color-mix(in oklab, ${presenceColor(flash.color)} 35%, transparent)`,
							}
						: {}),
					...(peer
						? { boxShadow: `inset 2px 0 0 ${presenceColor(peer.user.color)}` }
						: {}),
				} as CSSProperties
			}
		>
			<div className="min-w-0 flex-1">
				{crumbNodeId && !compact ? (
					<div className="truncate text-[11px] leading-4 text-muted-foreground">
						{ix.node(crumbNodeId)?.name} ›
					</div>
				) : null}
				<div className="flex min-w-0 items-center gap-1.5">
					{unlocated ? <BlockGlyph title={title} /> : null}
					<button
						type="button"
						data-card-main=""
						aria-current={selected || undefined}
						tabIndex={overlay ? -1 : undefined}
						className="min-w-0 cursor-[inherit] truncate text-left text-sm leading-5 font-medium outline-none"
					>
						{title}
					</button>
					{node?.localName && !compact ? (
						<span
							lang={langFor(
								node.countryCode ??
									ix.path(node.id).find((n) => n.countryCode)?.countryCode,
							)}
							className="hidden truncate text-[13px] text-muted-foreground @xs:inline"
						>
							{node.localName}
						</span>
					) : null}
					{cat && node?.category ? (
						<span className="hidden shrink-0 items-center gap-1 @md:inline-flex">
							<CategoryDot category={node.category} />
							{!compact ? (
								<span className="text-xs text-muted-foreground">
									{cat.label}
								</span>
							) : null}
						</span>
					) : null}
				</div>
				{!compact && (noteLine || (!item.note && nodeNote)) ? (
					<div
						data-testid={PLAN_TESTID.itemNote}
						className="truncate text-xs leading-4 text-muted-foreground"
					>
						{noteLine ? (
							<MarkdownText md={noteLine} inline />
						) : (
							<span className="italic">{nodeNote}</span>
						)}
					</div>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				{item.assigneeIds.length ? (
					<span className="hidden -space-x-1 @xs:flex">
						{item.assigneeIds.slice(0, 3).map((id) => (
							<MemberAvatar key={id} memberId={id} size={20} />
						))}
					</span>
				) : null}
				<BundleIcons item={item} />
				<WarningChip item={item} />
				<span data-testid={PLAN_TESTID.itemDuration}>
					<DurationInput
						value={durationShown}
						presets={DURATION_PRESETS}
						disabled={guard.disabled}
						onChange={(m) =>
							actions.update.mutate({
								itemId: item.id,
								patch: { durationMin: m },
							})
						}
						className="bg-muted/60"
					/>
				</span>
				{overlay ? null : (
					<ItemMenu
						item={item}
						onPin={() => setPinOpen(true)}
						className="opacity-60 group-hover/card:opacity-100 focus-visible:opacity-100"
					/>
				)}
			</div>
			{peer ? (
				<span className="absolute -top-2 -right-2">
					<MemberAvatar
						user={{ ...peer.user, userId: peer.user.id }}
						size={16}
					/>
				</span>
			) : null}
			{item.dayId && !overlay && !guard.disabled ? (
				<Tooltip open={resize.preview !== null}>
					<TooltipTrigger asChild>
						{/* biome-ignore lint/a11y/useSemanticElements: a focusable splitter (aria-valuenow) is not an <hr> */}
						<div
							role="separator"
							tabIndex={0}
							aria-orientation="horizontal"
							aria-label={`Duration of ${title}`}
							aria-valuenow={durationShown}
							aria-valuemin={15}
							aria-valuemax={4320}
							aria-valuetext={formatDuration(durationShown)}
							data-testid={PLAN_TESTID.itemResize}
							onPointerDown={resize.onPointerDown}
							onPointerMove={resize.onPointerMove}
							onPointerUp={resize.onPointerUp}
							onPointerCancel={resize.onPointerUp}
							onTouchStart={(e) => e.stopPropagation()}
							onKeyDown={(e) => {
								if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
								e.preventDefault();
								e.stopPropagation();
								const m = Math.max(
									15,
									item.durationMin + (e.key === "ArrowDown" ? 15 : -15),
								);
								if (m !== item.durationMin)
									actions.update.mutate({
										itemId: item.id,
										patch: { durationMin: m },
									});
							}}
							className="absolute inset-x-3 bottom-0 h-1.5 cursor-row-resize rounded-full outline-none focus-visible:bg-ring/60"
						/>
					</TooltipTrigger>
					<TooltipContent side="bottom" className="font-mono">
						{formatDuration(durationShown)}
					</TooltipContent>
				</Tooltip>
			) : null}
		</div>
	);

	const rail = (
		<div className="relative flex w-[var(--plan-rail-col)] shrink-0 items-stretch">
			{grip}
			<PinPopover item={item} open={pinOpen} onOpenChange={setPinOpen}>
				<button
					type="button"
					disabled={!item.dayId || guard.disabled}
					onClick={(e) => {
						e.stopPropagation();
						setPinOpen(true);
					}}
					aria-label={
						item.pinnedStart
							? `Pinned at ${item.pinnedStart}`
							: "Pin start time"
					}
					className="ml-auto flex flex-col items-end justify-center rounded-md pr-3 text-right font-mono text-[12px] leading-4 tnum outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
				>
					{s ? (
						<>
							<span className="flex items-center gap-1 text-[13px] text-foreground">
								{booked ? (
									<Lock
										className="size-2.5 text-muted-foreground"
										strokeWidth={2}
										aria-label="Booked for this date"
										data-testid={PLAN_TESTID.itemBooked}
									/>
								) : null}
								{s.pinned ? (
									<span
										role="img"
										aria-label="pinned"
										className="text-[8px] text-primary"
									>
										◆
									</span>
								) : null}
								<span data-testid={TESTID.itemStart}>
									{formatTime(s.start, s.tz)}
								</span>
								{s.startsNextDay ? (
									<sup className="text-[9px] text-muted-foreground">+1</sup>
								) : null}
							</span>
							<span className="text-muted-foreground">
								<span data-testid={TESTID.itemEnd}>
									{formatTime(endShown ?? s.end, s.tz)}
								</span>
								{s.endsNextDay ? <sup className="text-[9px]">+1</sup> : null}
							</span>
						</>
					) : (
						<span className="text-muted-foreground">—</span>
					)}
				</button>
			</PinPopover>
		</div>
	);

	return (
		<div
			data-testid={overlay ? undefined : TESTID.timelineItem}
			data-item-id={item.id}
			className="flex items-stretch py-1 pr-3"
		>
			{rail}
			{marks.length ? (
				<ProposalGhost
					marks={marks}
					className="flex min-w-0 flex-1"
					actions={
						access.canReview
							? (lead) => <GhostActions proposalId={lead.proposalId} />
							: undefined
					}
				>
					{card}
				</ProposalGhost>
			) : (
				card
			)}
		</div>
	);
}

/** The grip that carries the keyboard drag (Space to lift, arrows, Space to drop). */
export function DragGrip({
	label,
	attributes,
	onKeyDown,
	disabled,
}: {
	label: string;
	attributes: Record<string, unknown>;
	onKeyDown?: (e: React.KeyboardEvent) => void;
	disabled?: boolean;
}) {
	if (disabled) return null;
	return (
		<button
			type="button"
			{...(attributes as object)}
			aria-label={`Move ${label}`}
			onKeyDown={onKeyDown}
			onClick={(e) => e.stopPropagation()}
			className="absolute top-1/2 left-0.5 flex h-8 w-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 opacity-0 outline-none group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
		>
			<GripVertical className="size-3.5" strokeWidth={1.5} aria-hidden />
		</button>
	);
}
