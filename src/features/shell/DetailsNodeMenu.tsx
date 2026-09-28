/**
 * One Yonder: a place's row actions (the old Outline's ⋯) in the details
 * header. `NodeActions` gives `NodeMenuItems` an Outline UI of its own:
 * Rename edits the title in place (`DetailsNodeTitle`), Add inside… opens
 * the place search under it, and Move… / Delete… bring their dialogs.
 */
import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	DROPDOWN_KIT,
	NodeMenuItems,
	useMenuHandoff,
} from "@/features/outline/NodeMenu";
import {
	DeleteNodeDialog,
	deleteImpact,
	impactLines,
	MoveNodeDialog,
} from "@/features/outline/OutlineDialogs";
import { RenameInput } from "@/features/outline/OutlineRows";
import {
	type OutlineUi,
	OutlineUiProvider,
	useOutlineUi,
} from "@/features/outline/outline-context";
import { useOutlineActions } from "@/features/outline/use-outline-actions";
import type { GraphNode } from "@/lib/engine/types";
import { formatDayDate } from "@/lib/format";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { SHELL_TESTID } from "./testids";

export function NodeActions({
	node,
	children,
}: {
	node: GraphNode;
	children: ReactNode;
}) {
	const { ix, counts } = useWorkspace();
	const actions = useOutlineActions();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const [renaming, setRenaming] = useState(false);
	const [moveId, setMoveId] = useState<string | null>(null);
	const [deleteId, setDeleteId] = useState<string | null>(null);
	const focusedDay = actions.focusedDayId();
	const day = focusedDay ? ix.day(focusedDay) : undefined;
	const focusedDayLabel =
		focusedDay && day
			? `Day ${ix.dayNumber(focusedDay)} · ${formatDayDate(day.date)}`
			: null;
	const ui = useMemo<OutlineUi>(
		() => ({
			actions,
			announce: () => {},
			renamingId: renaming ? node.id : null,
			setRenamingId: (id) => setRenaming(id === node.id),
			addingUnder: null,
			startAddChild: (parentId) =>
				openAddPlace({ mode: "search", parentId: parentId ?? undefined }),
			stopAddChild: () => {},
			requestMove: setMoveId,
			requestDelete: (id) => {
				if (impactLines(deleteImpact(ix, counts, id)).length) setDeleteId(id);
				else actions.remove(id);
			},
			focusedDayLabel,
		}),
		[actions, renaming, node.id, openAddPlace, ix, counts, focusedDayLabel],
	);
	return (
		<OutlineUiProvider value={ui}>
			{children}
			<MoveNodeDialog nodeId={moveId} onClose={() => setMoveId(null)} />
			<DeleteNodeDialog nodeId={deleteId} onClose={() => setDeleteId(null)} />
		</OutlineUiProvider>
	);
}

/** The title, or its rename input after Rename. */
export function DetailsNodeTitle({
	node,
	children,
}: {
	node: GraphNode;
	children: ReactNode;
}) {
	const ui = useOutlineUi();
	return ui.renamingId === node.id ? (
		<RenameInput node={node} className="h-8 text-xl font-semibold" />
	) : (
		children
	);
}

export function DetailsNodeMenu({ node }: { node: GraphNode }) {
	const handoff = useMenuHandoff();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label={`More for ${node.name}`}
					data-testid={SHELL_TESTID.detailsMenu}
					className="-mt-0.5 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<MoreHorizontal className="size-4" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="w-56"
				onCloseAutoFocus={handoff.onCloseAutoFocus}
			>
				<NodeMenuItems
					kit={DROPDOWN_KIT}
					node={node}
					handOff={handoff.handOff}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
