/**
 * The tile ⋯ menu (DESIGN §7.2): Edit caption, Move to…, Set as cover, Hide
 * from guests, Download, Refresh preview, Delete (with Undo). Every edit
 * item goes through `useEditGuard` (disabled with the reason, never hidden).
 */
import {
	Download,
	FolderInput,
	ImageUp,
	Lock,
	LockOpen,
	MoreHorizontal,
	PencilLine,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useEditGuard } from "@/components/common/edit-guard";
import { TreePicker } from "@/components/common/tree-picker";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { can } from "@/lib/auth/roles";
import { humanError } from "@/lib/errors";
import { mediaUrl } from "@/lib/media-url";
import type { AttachmentTarget } from "@/lib/schemas/targets";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { targetName } from "../labels";
import { UPLOAD_EDIT_ONLY_REASON } from "../media-kinds";
import { MEDIA_TESTID } from "../testids";
import type { MediaDto } from "../types";
import type { useMediaActions } from "../use-media-actions";
import { EscapeOwner } from "./use-escape-owner";
import { useVisibilityGuard } from "./visibility-button";

type Actions = ReturnType<typeof useMediaActions>;

export function TileMenu({
	item,
	actions,
}: {
	item: MediaDto;
	actions: Actions;
}) {
	const ws = useWorkspace();
	const edit = useEditGuard();
	const editOnly = useEditGuard("edit-only", UPLOAD_EDIT_ONLY_REASON);
	const vis = useVisibilityGuard();
	const [dialog, setDialog] = useState<"caption" | "move" | null>(null);
	const [draft, setDraft] = useState(item.caption ?? "");
	const [dest, setDest] = useState<string | null>(
		item.target.kind === "node" ? item.target.nodeId : null,
	);
	const me = ws.graph.me;
	const canCover =
		can({ role: me.role, isGuest: me.isGuest }, "tripSettings") &&
		ws.access.canEdit &&
		(item.kind === "photo" || item.kind === "video") &&
		item.visibility === "everyone";
	const isCover = ws.graph.trip.coverAttachmentId === item.id;
	const downloadable =
		item.kind === "photo" || item.kind === "video" || item.kind === "pdf";
	const refreshable =
		(item.kind === "link" || item.kind === "embed") &&
		(item.fetch === "unfetched" || item.fetch === "failed");
	const hidden = item.visibility === "members";
	const receipt = item.target.kind === "expense";
	const reason = (g: { disabled: boolean; reason: string | null }) =>
		g.disabled && g.reason ? g.reason : undefined;

	return (
		<>
			<DropdownMenu modal={false}>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						data-testid={MEDIA_TESTID.tileMenu}
						aria-label="More actions"
						onClick={(e) => e.stopPropagation()}
						className="grid size-7 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm outline-none hover:bg-black/75 focus-visible:ring-2 focus-visible:ring-ring"
					>
						<MoreHorizontal className="size-4" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-52">
					<DropdownMenuItem
						disabled={edit.disabled}
						title={reason(edit)}
						onSelect={() => {
							setDraft(item.caption ?? "");
							setDialog("caption");
						}}
					>
						<PencilLine /> {item.caption ? "Edit caption" : "Add caption"}
					</DropdownMenuItem>
					{!receipt ? (
						<DropdownMenuItem
							disabled={edit.disabled}
							title={reason(edit)}
							onSelect={() => {
								setDest(
									item.target.kind === "node" ? item.target.nodeId : null,
								);
								setDialog("move");
							}}
						>
							<FolderInput /> Move to…
						</DropdownMenuItem>
					) : null}
					{canCover ? (
						<DropdownMenuItem
							onSelect={() =>
								actions.cover.mutate({ id: isCover ? null : item.id })
							}
						>
							<ImageUp />{" "}
							{isCover ? "Remove as trip cover" : "Set as trip cover"}
						</DropdownMenuItem>
					) : null}
					{vis.show && !receipt ? (
						<DropdownMenuItem
							disabled={vis.disabled}
							title={vis.reason ?? undefined}
							onSelect={() =>
								actions.visibility.mutate({
									id: item.id,
									visibility: hidden ? "everyone" : "members",
								})
							}
						>
							{hidden ? <LockOpen /> : <Lock />}
							{hidden ? "Show to guests" : "Hide from guests"}
						</DropdownMenuItem>
					) : null}
					{downloadable ? (
						<DropdownMenuItem asChild>
							<a href={`${mediaUrl(item.id, "original")}?download=1`} download>
								<Download /> Download
							</a>
						</DropdownMenuItem>
					) : null}
					{refreshable ? (
						<DropdownMenuItem
							disabled={editOnly.disabled}
							title={reason(editOnly)}
							onSelect={() =>
								actions.refresh.mutate(
									{ id: item.id },
									{ onError: (e) => toast.error(humanError(e)) },
								)
							}
						>
							<RefreshCw /> Refresh preview
						</DropdownMenuItem>
					) : null}
					<DropdownMenuSeparator />
					<DropdownMenuItem
						variant="destructive"
						disabled={edit.disabled}
						title={reason(edit)}
						onSelect={() => actions.deleteItem(item)}
					>
						<Trash2 /> Delete
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<Dialog
				open={dialog === "caption"}
				onOpenChange={(o) => !o && setDialog(null)}
			>
				<DialogContent
					className="sm:max-w-md"
					onClick={(e) => e.stopPropagation()}
				>
					<EscapeOwner onEscape={() => setDialog(null)} />
					<DialogHeader>
						<DialogTitle>
							{item.caption ? "Edit caption" : "Add a caption"}
						</DialogTitle>
						<DialogDescription>
							Short Markdown: emphasis and links work.
						</DialogDescription>
					</DialogHeader>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							actions.caption.mutate(
								{ id: item.id, caption: draft.trim() || null },
								{ onError: (err) => toast.error(humanError(err)) },
							);
							setDialog(null);
						}}
						className="grid gap-4"
					>
						<Textarea
							data-testid={MEDIA_TESTID.captionInput}
							value={draft}
							maxLength={2000}
							rows={3}
							autoFocus
							onChange={(e) => setDraft(e.target.value)}
							placeholder="Sunrise from the pagoda steps"
						/>
						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								onClick={() => setDialog(null)}
							>
								Cancel
							</Button>
							<Button type="submit" data-testid={MEDIA_TESTID.captionSave}>
								Save
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			<Dialog
				open={dialog === "move"}
				onOpenChange={(o) => !o && setDialog(null)}
			>
				<DialogContent
					className="sm:max-w-md"
					onClick={(e) => e.stopPropagation()}
				>
					<EscapeOwner onEscape={() => setDialog(null)} />
					<DialogHeader>
						<DialogTitle>Move to…</DialogTitle>
						<DialogDescription>
							Now on {targetName(ws.ix, item.target)}. Pick a place, or the trip
							itself.
						</DialogDescription>
					</DialogHeader>
					<TreePicker
						value={dest}
						onChange={setDest}
						allowRoot
						placeholder="Choose a place…"
					/>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setDialog(null)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							onClick={() => {
								const to: AttachmentTarget = dest
									? { kind: "node", nodeId: dest }
									: { kind: "trip" };
								actions.move.mutate(
									{
										id: item.id,
										target: to,
										from: item.target,
										label: targetName(ws.ix, to),
									},
									{ onError: (err) => toast.error(humanError(err)) },
								);
								setDialog(null);
							}}
						>
							Move
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
