/**
 * Organize places (One Yonder): the trip's whole tree, one click from the
 * Where picker, for what the Outline sidebar used to do: rename, change type,
 * move, drag to reorder or re-file, add inside, drop or restore, delete. It
 * is the Outline itself, in a dialog.
 */

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Outline } from "@/features/outline/Outline";
import { SHELL_TESTID } from "./testids";

export function OrganizePlaces({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				data-testid={SHELL_TESTID.organizePlaces}
				className="flex h-[min(80vh,44rem)] max-w-xl flex-col gap-0 p-0"
			>
				<DialogHeader className="border-b px-4 pt-4 pb-3">
					<DialogTitle>Organize places</DialogTitle>
					<DialogDescription>
						Drag a row to move it, or use its ⋯ menu to rename, move, mark not
						going or delete.
					</DialogDescription>
				</DialogHeader>
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
					<Outline />
				</div>
			</DialogContent>
		</Dialog>
	);
}
