/**
 * The Outline's two dialogs:
 * - **Move…** (SPEC §18.3): a `TreePicker` of every place, the invalid parents
 *   greyed with the rank rule's reason ("A city can't go inside a place").
 * - **Delete…** (QA HIER-09): lists what goes with the place (places inside,
 *   plan items, notes, media, list items) before deleting; the toast's Undo
 *   restores all of it (`restoreNode`). A place with nothing attached is
 *   deleted straight away, with the same Undo.
 */
import { TreePicker } from "@/components/common/tree-picker";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { TripCounts } from "@/lib/engine/types";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { keepEscape } from "./OutlineRows";
import { useOutlineUi } from "./outline-context";
import { OUTLINE_TESTID } from "./testids";
import { moveBlocker } from "./tree-rows";

export type DeleteImpact = {
	places: number;
	items: number;
	notes: number;
	media: number;
	lists: number;
};

/** What deleting `nodeId` takes with it (its subtree's items and bundles). */
export function deleteImpact(
	ix: GraphIndex,
	counts: TripCounts | undefined,
	nodeId: string,
): DeleteImpact {
	const subtree = ix.outline.filter((n) => ix.isWithin(n.id, nodeId));
	const ids = new Set(subtree.map((n) => n.id));
	const items = ix.graph.items.filter((i) => i.nodeId && ids.has(i.nodeId));
	let notes = 0;
	let media = 0;
	let lists = 0;
	for (const id of ids) {
		const c = counts?.byNode[id];
		if (!c) continue;
		if (c.hasNote) notes++;
		media += c.media + c.links + c.docs;
		lists += c.todo + c.shop;
	}
	return { places: ids.size - 1, items: items.length, notes, media, lists };
}

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

export function impactLines(i: DeleteImpact): string[] {
	const out: string[] = [];
	if (i.places) out.push(`${plural(i.places, "place")} inside`);
	if (i.items) out.push(`${plural(i.items, "item")} on the plan`);
	if (i.notes) out.push(i.notes === 1 ? "Notes" : `Notes on ${i.notes} places`);
	if (i.media) out.push(plural(i.media, "photo or link", "photos and links"));
	if (i.lists) out.push(plural(i.lists, "list item"));
	return out;
}

export function DeleteNodeDialog({
	nodeId,
	onClose,
}: {
	nodeId: string | null;
	onClose(): void;
}) {
	const { ix, counts } = useWorkspace();
	const ui = useOutlineUi();
	const node = nodeId ? ix.node(nodeId) : undefined;
	const lines = node ? impactLines(deleteImpact(ix, counts, node.id)) : [];
	return (
		<AlertDialog open={!!node} onOpenChange={(o) => !o && onClose()}>
			<AlertDialogContent
				data-testid={OUTLINE_TESTID.deleteDialog}
				onEscapeKeyDown={keepEscape}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete {node?.name}?</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div className="grid gap-2 text-sm text-muted-foreground">
							<p>This also removes:</p>
							<ul className="grid gap-1 pl-4 text-foreground">
								{lines.map((l) => (
									<li key={l} className="list-disc">
										{l}
									</li>
								))}
							</ul>
							<p>You can undo this right after.</p>
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						data-testid={OUTLINE_TESTID.deleteConfirm}
						onClick={() => {
							if (node) ui.actions.remove(node.id);
							onClose();
						}}
					>
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

export function MoveNodeDialog({
	nodeId,
	onClose,
}: {
	nodeId: string | null;
	onClose(): void;
}) {
	const { ix } = useWorkspace();
	const ui = useOutlineUi();
	const node = nodeId ? ix.node(nodeId) : undefined;
	return (
		<Dialog open={!!node} onOpenChange={(o) => !o && onClose()}>
			<DialogContent
				className="sm:max-w-sm"
				data-testid={OUTLINE_TESTID.moveDialog}
				onEscapeKeyDown={keepEscape}
			>
				<DialogHeader>
					<DialogTitle>Move {node?.name}</DialogTitle>
					<DialogDescription>
						Choose where it goes. Everything inside moves with it.
					</DialogDescription>
				</DialogHeader>
				{node ? (
					<TreePicker
						value={node.parentId}
						allowRoot
						placeholder="Choose a place…"
						filter={(n) =>
							n.status !== "dropped" && !ix.isWithin(n.id, node.id)
						}
						disabledReason={(n) =>
							n.id === node.parentId ? null : moveBlocker(ix, node.id, n.id)
						}
						onChange={(parentId) => {
							if (parentId !== node.parentId)
								ui.actions.move({ nodeId: node.id, parentId });
							onClose();
						}}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
