/**
 * Where a drop lands in the Plan, as plain data (DESIGN §7.1 "Dragging",
 * SPEC §7.9): the target day (null = Unscheduled) and the neighbour to go
 * after or before, or a refusal with the toast text. The server enforces the
 * same flight-block rules; refusing here saves a round trip and keeps the
 * card where it was.
 */
import type { GraphIndex } from "@/lib/engine/graph-index";

/** What a Plan droppable carries in `data`. */
export type PlanDropData = {
	panel?: string;
	/** The day (or null for Unscheduled). */
	dayId?: string | null;
	/** Set on a card's sortable: dropping onto a card. */
	itemId?: string;
	unscheduled?: boolean;
};

export type DropPlan =
	| {
			ok: true;
			dayId: string | null;
			afterItemId?: string;
			beforeItemId?: string;
	  }
	| { ok: false; reason: "noop" | "flight" | "outside" };

/** Two items that sit next to each other inside one flight chain. */
function insideBlock(
	ix: GraphIndex,
	prevId: string | undefined,
	nextId: string | undefined,
): boolean {
	if (!prevId || !nextId) return false;
	const chain = ix.blockOf(prevId);
	if (!chain) return false;
	const i = chain.indexOf(prevId);
	return i >= 0 && chain[i + 1] === nextId;
}

/**
 * The move or insert a drop means. `activeItemId` is null for a place dragged
 * in from the Outline or Ideas (a new item).
 */
export function planDrop(
	ix: GraphIndex,
	activeItemId: string | null,
	over: PlanDropData | undefined,
): DropPlan {
	if (over?.panel !== "plan") return { ok: false, reason: "outside" };
	const dayId = over.unscheduled ? null : (over.dayId ?? null);
	const full = dayId ? (ix.itemsByDay.get(dayId) ?? []) : ix.unscheduled;
	const active = activeItemId ? ix.item(activeItemId) : undefined;
	const block = activeItemId ? ix.blockOf(activeItemId) : null;
	const moving = new Set(
		block && block.length > 1 ? block : activeItemId ? [activeItemId] : [],
	);
	const list = full.filter((x) => !moving.has(x.id));

	// A flight block never changes day (§7.9 rule 2).
	if (active && block && block.length > 1 && dayId !== active.dayId)
		return { ok: false, reason: "flight" };

	let afterItemId: string | undefined;
	let beforeItemId: string | undefined;
	if (over.itemId && moving.has(over.itemId))
		return { ok: false, reason: "noop" };
	if (over.itemId) {
		const overIdx = full.findIndex((x) => x.id === over.itemId);
		const activeIdx = activeItemId
			? full.findIndex((x) => x.id === activeItemId)
			: -1;
		// Sortable semantics: moving down lands after the card you're over, moving up before it.
		if (activeIdx >= 0 && activeIdx < overIdx) afterItemId = over.itemId;
		else beforeItemId = over.itemId;
	} else {
		afterItemId = list.at(-1)?.id;
	}
	// Resolve to the neighbours in the list without the moving items.
	let prev: string | undefined;
	let next: string | undefined;
	if (afterItemId) {
		const i = list.findIndex((x) => x.id === afterItemId);
		prev = afterItemId;
		next = list[i + 1]?.id;
	} else if (beforeItemId) {
		const i = list.findIndex((x) => x.id === beforeItemId);
		prev = i > 0 ? list[i - 1]?.id : undefined;
		next = beforeItemId;
	}
	if (dayId && insideBlock(ix, prev, next))
		return { ok: false, reason: "flight" };

	// Dropping a card back where it is changes nothing.
	if (active && active.dayId === dayId) {
		const i = full.findIndex((x) => x.id === active.id);
		const curPrev = full[i - 1]?.id;
		const curNext = full[i + 1]?.id;
		if (!moving.has(curPrev ?? "") && prev === curPrev && next === curNext)
			return { ok: false, reason: "noop" };
	}
	return {
		ok: true,
		dayId,
		...(prev ? { afterItemId: prev } : next ? { beforeItemId: next } : {}),
	};
}

/**
 * "Move up" / "Move down" in a card's ⋯ menu (QA MOB-04: reordering without
 * a drag): the drop that swaps the item, or its whole flight block, with the
 * neighbour above or below it in its day (or in Unscheduled). A neighbour
 * that belongs to a flight block is stepped over as a whole, so the result
 * obeys the same rules as a drag.
 */
export function planStep(
	ix: GraphIndex,
	itemId: string,
	dir: "up" | "down",
): DropPlan {
	const item = ix.item(itemId);
	if (!item) return { ok: false, reason: "noop" };
	const list = item.dayId
		? (ix.itemsByDay.get(item.dayId) ?? [])
		: ix.unscheduled;
	const ids = list.map((x) => x.id);
	const block = ix.blockOf(itemId);
	const moving = new Set(block && block.length > 1 ? block : [itemId]);
	const at = ids.flatMap((id, i) => (moving.has(id) ? [i] : []));
	if (!at.length) return { ok: false, reason: "noop" };
	const edge = dir === "up" ? Math.min(...at) - 1 : Math.max(...at) + 1;
	const neighbour = ids[edge];
	if (!neighbour) return { ok: false, reason: "noop" };
	const other = (ix.blockOf(neighbour) ?? []).filter((id) => ids.includes(id));
	const over =
		other.length > 1
			? dir === "up"
				? (other[0] as string)
				: (other.at(-1) as string)
			: neighbour;
	return planDrop(ix, itemId, {
		panel: "plan",
		dayId: item.dayId,
		...(item.dayId ? {} : { unscheduled: true }),
		itemId: over,
	});
}
