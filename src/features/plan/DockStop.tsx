/**
 * A stop off its day in the Plan's ideas dock (One Yonder: anything without a
 * day is an idea). Its place's own card stands for a place's stop; this card
 * is for the rest (a custom stop, "Laundry"). Drag it onto a day, or + adds
 * it to the day in view, with its time and note.
 */
import { useDraggable } from "@dnd-kit/core";
import { Plus, Timer } from "lucide-react";
import { useEditGuard } from "@/components/common/edit-guard";
import { TypeGlyph } from "@/components/common/glyphs";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { cardTone } from "./card-tone";
import { PLAN_TESTID } from "./testids";
import { itemName, slotOf, usePlanActions } from "./use-plan-actions";

export function DockStop({
	itemId,
	dayId,
}: {
	itemId: string;
	/** The day + adds it to (the one in view); null: no + (drag it). */
	dayId: string | null;
}) {
	const { ix, sel, nav } = useWorkspace();
	const guard = useEditGuard();
	const actions = usePlanActions();
	const item = ix.item(itemId);
	const node = ix.node(item?.nodeId);
	const name = item ? itemName(ix, item) : "";
	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: `dock-stop:${itemId}`,
		disabled: guard.disabled,
		data: {
			type: "item",
			itemId,
			panel: "plan",
			dayId: null,
			unscheduled: true,
			label: name,
		},
	});
	if (!item) return null;
	const selected = sel?.kind === "item" && sel.id === itemId;
	const add = () => {
		if (!dayId) return;
		const last = (ix.itemsByDay.get(dayId) ?? []).at(-1);
		actions.move.mutate({
			itemId,
			dayId,
			...(last ? { afterItemId: last.id } : {}),
			undo: slotOf(ix, itemId),
		});
	};
	return (
		<div
			{...attributes}
			{...listeners}
			ref={setNodeRef}
			role="option"
			aria-selected={selected}
			aria-label={`${name}, ${formatDuration(item.durationMin)}, no day yet`}
			data-testid={PLAN_TESTID.dockStop}
			data-item-id={itemId}
			data-cursor-anchor={`item:${itemId}`}
			data-family={cardTone(node)}
			onClick={() => nav.select({ kind: "item", id: itemId })}
			className={cn(
				"plan-card group/idea flex h-14 w-56 shrink-0 cursor-pointer touch-manipulation items-center gap-2 rounded-lg border border-dashed bg-card px-2 text-sm outline-none select-none hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring",
				selected && "outline-2 outline-primary outline-solid",
				isDragging && "opacity-40",
			)}
		>
			<span
				aria-hidden
				className="plan-icon flex size-8 shrink-0 items-center justify-center rounded-full"
			>
				{node ? (
					<TypeGlyph
						type={node.type}
						category={node.category}
						tinted={false}
						className="size-4 text-current"
					/>
				) : (
					<Timer className="size-4" strokeWidth={1.5} />
				)}
			</span>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate font-medium">{name}</span>
				<span className="truncate text-meta text-muted-foreground tnum">
					{formatDuration(item.durationMin)}
				</span>
			</span>
			{dayId ? (
				<Button
					variant="ghost"
					size="icon-sm"
					className="self-start"
					data-testid={PLAN_TESTID.dockStopAdd}
					aria-label={`Add ${name} to the day`}
					disabled={guard.disabled}
					onClick={(e) => {
						e.stopPropagation();
						add();
					}}
					onPointerDown={(e) => e.stopPropagation()}
				>
					<Plus />
				</Button>
			) : null}
		</div>
	);
}
