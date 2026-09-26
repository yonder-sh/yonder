/**
 * "Unscheduled · 8" (DESIGN §7.1): after the last day, collapsible, with a
 * sticky subhead. Cards without times (the rail reads "—") and their duration
 * chips; they count toward no day. Drag them into a day to schedule them, or
 * drag a card here to unschedule it.
 */
import { useDroppable } from "@dnd-kit/core";
import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "cn";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useContext } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { bool, useFollowState } from "@/lib/realtime/view-ui";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { DragGrip, ItemCard } from "./ItemCard";
import { DropIndicatorContext } from "./plan-context";
import { hiddenByWho } from "./plan-rows";
import { PLAN_TESTID } from "./testids";
import { itemName } from "./use-plan-actions";

function UnscheduledRow({ itemId }: { itemId: string }) {
	const { ix } = useWorkspace();
	const guard = useEditGuard();
	const indicator = useContext(DropIndicatorContext);
	const item = ix.item(itemId);
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: itemId,
		data: {
			type: "item",
			itemId,
			panel: "plan",
			dayId: null,
			unscheduled: true,
			label: item ? itemName(ix, item) : "item",
		},
		disabled: guard.disabled,
	});
	if (!item) return null;
	const { onKeyDown, ...pointer } = (listeners ?? {}) as Record<
		string,
		(e: unknown) => void
	>;
	const show = indicator?.itemId === itemId;
	return (
		<li
			ref={setNodeRef}
			style={{ transform: CSS.Translate.toString(transform), transition }}
			className="group/row relative"
		>
			{show && indicator?.where === "before" ? (
				<span
					aria-hidden
					className="absolute right-3 left-[var(--plan-rail-col)] top-0 h-0.5 rounded-full bg-primary"
				/>
			) : null}
			<ItemCard
				item={item}
				compact
				dragListeners={pointer}
				dragging={isDragging}
				grip={
					<DragGrip
						label={itemName(ix, item)}
						attributes={attributes as unknown as Record<string, unknown>}
						onKeyDown={
							onKeyDown as ((e: React.KeyboardEvent) => void) | undefined
						}
						disabled={guard.disabled}
					/>
				}
			/>
		</li>
	);
}

export function UnscheduledSection({
	itemIds,
}: {
	itemIds: readonly string[];
}) {
	const { ix, who } = useWorkspace();
	const [open, setOpen] = useFollowState("plan.unscheduled", true, bool);
	const indicator = useContext(DropIndicatorContext);
	const { setNodeRef, isOver } = useDroppable({
		id: "plan-unscheduled",
		data: {
			panel: "plan",
			dayId: null,
			unscheduled: true,
			kbSkip: true,
			label: "Unscheduled",
		},
	});
	const shown = itemIds.filter((id) => {
		const it = ix.item(id);
		return it && !hiddenByWho(it, who);
	});
	return (
		<section
			ref={setNodeRef}
			aria-label="Unscheduled"
			data-testid={PLAN_TESTID.unscheduled}
			// FB-23: others see a drop into Unscheduled land here.
			data-cursor-anchor="pane:unscheduled"
			className={cn(
				"mt-2 border-t pb-2 transition-colors",
				isOver && "bg-primary/[0.03]",
			)}
		>
			<h3 className="sticky top-0 z-20 flex h-10 items-center bg-background/95 px-4 backdrop-blur">
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen((v) => !v)}
					className="flex items-center gap-1 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase hover:text-foreground"
				>
					{open ? (
						<ChevronDown className="size-3.5" strokeWidth={1.75} />
					) : (
						<ChevronRight className="size-3.5" strokeWidth={1.75} />
					)}
					Unscheduled ·
					<span className="ml-1 font-mono tnum">{shown.length}</span>
				</button>
			</h3>
			{open ? (
				shown.length ? (
					<SortableContext
						id="plan-list:unscheduled"
						items={shown}
						strategy={verticalListSortingStrategy}
					>
						<ol>
							{shown.map((id) => (
								<UnscheduledRow key={id} itemId={id} />
							))}
						</ol>
						<UnscheduledEndDrop />
					</SortableContext>
				) : (
					<p className="px-4 pb-3 text-xs text-muted-foreground">
						Nothing unscheduled.
					</p>
				)
			) : null}
			{indicator && indicator.dayId === null && indicator.itemId === null ? (
				<span
					aria-hidden
					className="mx-3 ml-[var(--plan-rail-col)] block h-0.5 rounded-full bg-primary"
				/>
			) : null}
		</section>
	);
}

/** Below the last unscheduled card: a drop here goes at the end (see DayEndDrop). */
function UnscheduledEndDrop() {
	const { setNodeRef } = useDroppable({
		id: "plan-unscheduled-end",
		data: {
			panel: "plan",
			dayId: null,
			unscheduled: true,
			kbSkip: true,
			label: "the end of Unscheduled",
		},
	});
	return <div ref={setNodeRef} className="h-6" />;
}
