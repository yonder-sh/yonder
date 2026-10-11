/**
 * `/trash` (owner, 2026-10-11): the account's deleted uploads, newest first,
 * three to a row like Saved. Each tile says how many days are left; a tap
 * opens it (where it was, where Restore puts it, Delete forever). Select
 * ticks tiles to restore or delete several (Restore has Undo; deleting for
 * good asks first). Empty trash deletes everything. Trash counts toward
 * storage until it's gone.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	Check,
	FileText,
	Image as ImageIcon,
	Play,
	RotateCcw,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ThumbhashImage } from "@/components/common/thumbhash-image";
import { undoToast } from "@/components/common/undo-toast";
import { YonderMark } from "@/components/common/yonder-mark";
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
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { formatBytes } from "@/features/media/media-kinds";
import { getStorageUsage } from "@/functions/storage.functions";
import { humanError } from "@/lib/errors";
import { meKeys } from "@/lib/query/keys";
import { cn } from "@/lib/utils";
import { daysLeft, daysLeftLabel, restoreLabel } from "./lib";
import { TRASH_TESTID } from "./testids";
import {
	deleteTrashItems,
	emptyTrashItems,
	listTrashItems,
	restoreTrashItems,
	retrashItems,
} from "./trash.functions";
import { TRASH_DAYS, type TrashItem } from "./types";

export const trashQuery = () => ({
	queryKey: meKeys.trash,
	queryFn: (): Promise<TrashItem[]> => listTrashItems(),
});

const plural = (n: number, one: string) =>
	n === 1 ? `1 ${one}` : `${n} ${one}s`;

/** Restore (Undo puts them back) and Delete forever, then the lists refresh. */
function useTrashActions() {
	const qc = useQueryClient();
	const refresh = () =>
		Promise.all(
			[meKeys.trash, meKeys.saved, meKeys.storage, ["trip"]].map((queryKey) =>
				qc.invalidateQueries({ queryKey }),
			),
		);
	const restore = async (items: readonly TrashItem[]): Promise<boolean> => {
		try {
			const done = await restoreTrashItems({
				data: { ids: items.map((i) => i.id) },
			});
			void refresh();
			const undo = done.flatMap((d) =>
				d.id ? [{ id: d.id, trashedAt: d.trashedAt }] : [],
			);
			const one = items.length === 1 ? items[0] : null;
			const label = `Restored ${plural(done.length, "item")}`;
			const description = one ? restoreLabel(one) : null;
			if (undo.length)
				undoToast(
					label,
					() =>
						retrashItems({ data: { items: undo } })
							.then(() => void refresh())
							.catch((e) => void toast.error(humanError(e))),
					{ description },
				);
			else toast.success(label, { description });
			return true;
		} catch (e) {
			toast.error(humanError(e));
			void refresh();
			return false;
		}
	};
	const remove = async (ids: readonly string[] | "all"): Promise<boolean> => {
		try {
			const { count } =
				ids === "all"
					? await emptyTrashItems()
					: await deleteTrashItems({ data: { ids: [...ids] } });
			toast.success(`Deleted ${plural(count, "item")} for good`);
			return true;
		} catch (e) {
			toast.error(humanError(e));
			return false;
		} finally {
			void refresh();
		}
	};
	return { restore, remove };
}

function KindMark({ kind, className }: { kind: string; className?: string }) {
	const Icon = kind === "pdf" ? FileText : kind === "video" ? Play : ImageIcon;
	return <Icon className={className} aria-hidden />;
}

export function TrashTile({
	item,
	onOpen,
	selecting = false,
	selected = false,
	now,
}: {
	item: TrashItem;
	onOpen: () => void;
	selecting?: boolean;
	selected?: boolean;
	now?: number;
}) {
	const left = daysLeft(item.trashedAt, now);
	return (
		<button
			type="button"
			data-testid={TRASH_TESTID.tile}
			data-trash={item.id}
			data-selected={selecting ? selected : undefined}
			onClick={onOpen}
			aria-label={`${item.name ?? item.kind}, from ${item.from}, ${daysLeftLabel(item.trashedAt, now)}`}
			{...(selecting ? { "aria-pressed": selected } : {})}
			className="group relative aspect-square w-full cursor-pointer overflow-hidden bg-muted text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
		>
			{item.thumb ? (
				<ThumbhashImage
					hash={item.thumbhash}
					src={item.thumb}
					alt=""
					className="absolute inset-0 size-full opacity-80 [&_img]:size-full [&_img]:object-cover"
				/>
			) : (
				<span className="absolute inset-0 grid place-items-center bg-gradient-to-b from-muted to-accent/60">
					<KindMark kind={item.kind} className="size-9 text-foreground/25" />
				</span>
			)}
			<span
				data-testid={TRASH_TESTID.daysLeft}
				className={cn(
					"absolute top-1.5 left-1.5 inline-flex h-5 items-center rounded-full px-1.5 text-2xs font-medium text-white backdrop-blur-sm tnum",
					left <= 3 ? "bg-destructive/85" : "bg-black/60",
				)}
			>
				{left === 0 ? "Today" : `${left}d`}
			</span>
			{item.kind === "video" && !selecting ? (
				<Play
					className="absolute top-2 right-2 size-3.5 text-white drop-shadow"
					fill="currentColor"
					strokeWidth={0}
				/>
			) : null}
			{selecting ? (
				<span
					aria-hidden
					className={cn(
						"absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full border-2 border-white shadow",
						selected ? "bg-primary text-primary-foreground" : "bg-black/30",
					)}
				>
					{selected ? <Check className="size-3.5" strokeWidth={3} /> : null}
				</span>
			) : null}
			{selecting && selected ? (
				<span aria-hidden className="absolute inset-0 bg-white/25" />
			) : null}
			<span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/35 to-transparent px-2 pt-6 pb-1.5">
				<span className="line-clamp-1 text-2xs leading-snug font-medium text-white/90">
					{item.from}
				</span>
			</span>
		</button>
	);
}

/** One item: where it was, where Restore puts it, Delete forever. */
function TrashDetail({
	item,
	onClose,
	onRestore,
	onDelete,
}: {
	item: TrashItem | null;
	onClose: () => void;
	onRestore: (it: TrashItem) => void;
	onDelete: (it: TrashItem) => void;
}) {
	return (
		<Dialog open={!!item} onOpenChange={(v) => !v && onClose()}>
			<DialogContent
				data-testid={TRASH_TESTID.detail}
				className="sm:max-w-[400px]"
			>
				{item ? (
					<>
						<DialogHeader>
							<DialogTitle className="truncate">
								{item.name ??
									(item.kind === "pdf"
										? "PDF"
										: item.kind === "video"
											? "Video"
											: "Photo")}
							</DialogTitle>
							<DialogDescription>
								From {item.from}
								{item.count > 1 ? ` · ${item.count} files` : ""} ·{" "}
								{formatBytes(item.sizeBytes)} ·{" "}
								{daysLeftLabel(item.trashedAt).toLowerCase()}
							</DialogDescription>
						</DialogHeader>
						{item.thumb ? (
							<ThumbhashImage
								hash={item.thumbhash}
								src={item.thumb}
								alt=""
								className="max-h-64 rounded-lg [&_img]:max-h-64 [&_img]:object-contain"
							/>
						) : null}
						<p className="text-meta text-muted-foreground">
							Restore: {restoreLabel(item)}
						</p>
						<DialogFooter className="gap-2">
							<Button
								variant="outline"
								data-testid={TRASH_TESTID.deleteForever}
								onClick={() => onDelete(item)}
							>
								<Trash2 /> Delete forever
							</Button>
							<Button
								data-testid={TRASH_TESTID.restore}
								disabled={!item.restoreTo}
								onClick={() => onRestore(item)}
							>
								<RotateCcw /> Restore
							</Button>
						</DialogFooter>
					</>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

/** "Delete forever?" / "Empty trash?". */
function ConfirmDelete({
	ask,
	onCancel,
	onConfirm,
}: {
	ask: { title: string; body: string; action: string } | null;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	return (
		<AlertDialog open={!!ask} onOpenChange={(v) => !v && onCancel()}>
			<AlertDialogContent data-testid={TRASH_TESTID.confirm}>
				<AlertDialogHeader>
					<AlertDialogTitle>{ask?.title}</AlertDialogTitle>
					<AlertDialogDescription>{ask?.body}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction variant="destructive" onClick={onConfirm}>
						{ask?.action}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/** The storage note: Trash counts until it's gone. */
function TrashNote({ items }: { items: readonly TrashItem[] }) {
	const usage = useQuery({
		queryKey: meKeys.storage,
		queryFn: () => getStorageUsage(),
	});
	const total = items.reduce((n, i) => n + i.sizeBytes, 0);
	const u = usage.data;
	return (
		<div
			data-testid={TRASH_TESTID.note}
			className="grid gap-0.5 px-4 pb-4 text-meta text-muted-foreground sm:px-0"
		>
			<p>
				Photos, videos and PDFs you uploaded stay here {TRASH_DAYS} days after
				they're deleted, then they're gone for good. Until then they count
				toward your storage.
			</p>
			{items.length && u ? (
				<p className="tnum">
					{formatBytes(total)} in Trash · {formatBytes(u.usedBytes)} of{" "}
					{formatBytes(u.quotaBytes)} used
				</p>
			) : null}
		</div>
	);
}

/** The grid with Select, the detail dialog and the confirms. */
export function TrashGrid({
	items,
	pending,
}: {
	items: readonly TrashItem[];
	pending: boolean;
}) {
	const { restore, remove } = useTrashActions();
	const [selecting, setSelecting] = useState(false);
	const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
	const [open, setOpen] = useState<TrashItem | null>(null);
	const [ask, setAsk] = useState<{
		ids: readonly string[] | "all";
		title: string;
		body: string;
		action: string;
	} | null>(null);
	const byId = new Map(items.map((i) => [i.id, i]));
	const chosen = [...picked].flatMap((id) => byId.get(id) ?? []);
	const restorable = chosen.filter((i) => i.restoreTo);
	const stopSelecting = () => {
		setSelecting(false);
		setPicked(new Set());
	};
	const tap = (it: TrashItem) =>
		selecting
			? setPicked((p) => {
					const next = new Set(p);
					if (!next.delete(it.id)) next.add(it.id);
					return next;
				})
			: setOpen(it);
	const askDelete = (ids: readonly string[]) =>
		setAsk({
			ids,
			title:
				ids.length === 1
					? "Delete forever?"
					: `Delete ${ids.length} items forever?`,
			body: "This can't be undone. The space it takes is freed.",
			action: "Delete forever",
		});
	return (
		<>
			<div className="flex items-baseline justify-between gap-4 px-4 pt-2 pb-3 sm:px-0">
				<h1 className="font-display text-2xl leading-7 font-semibold tracking-[-0.01em]">
					{selecting ? (
						<span data-testid={TRASH_TESTID.selectCount}>
							{chosen.length} selected
						</span>
					) : (
						"Trash"
					)}
				</h1>
				{selecting ? (
					<Button
						variant="ghost"
						size="sm"
						data-testid={TRASH_TESTID.selectCancel}
						onClick={stopSelecting}
					>
						Cancel
					</Button>
				) : items.length ? (
					<span className="flex items-center gap-2">
						<Button
							variant="ghost"
							size="sm"
							className="text-destructive"
							data-testid={TRASH_TESTID.emptyTrash}
							onClick={() =>
								setAsk({
									ids: "all",
									title: "Empty trash?",
									body: `${plural(items.length, "item")} will be deleted for good. This can't be undone.`,
									action: "Empty trash",
								})
							}
						>
							Empty trash
						</Button>
						<Button
							variant="outline"
							size="sm"
							data-testid={TRASH_TESTID.select}
							onClick={() => setSelecting(true)}
						>
							Select
						</Button>
					</span>
				) : null}
			</div>
			<TrashNote items={items} />
			{pending ? (
				<div className="grid grid-cols-3 gap-0.5 sm:gap-1">
					{[0, 1, 2].map((i) => (
						<div key={i} className="aspect-square animate-pulse bg-muted" />
					))}
				</div>
			) : items.length ? (
				<div
					data-testid={TRASH_TESTID.grid}
					className="grid grid-cols-3 gap-0.5 sm:gap-1"
				>
					{items.map((it) => (
						<TrashTile
							key={it.id}
							item={it}
							selecting={selecting}
							selected={picked.has(it.id)}
							onOpen={() => tap(it)}
						/>
					))}
				</div>
			) : (
				<div
					data-testid={TRASH_TESTID.empty}
					className="mx-4 grid justify-items-center gap-2 rounded-2xl border bg-card px-6 py-12 text-center sm:mx-0"
				>
					<Trash2 className="size-6 text-muted-foreground" />
					<p className="font-display text-lg leading-6 font-medium">
						Trash is empty
					</p>
				</div>
			)}
			{selecting ? (
				<div
					data-bottom-bar=""
					className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur"
				>
					<div className="mx-auto flex max-w-[720px] items-center justify-end gap-2">
						<Button
							variant="outline"
							data-testid={TRASH_TESTID.restoreSelected}
							disabled={!restorable.length}
							onClick={() =>
								void restore(restorable).then((ok) => ok && stopSelecting())
							}
						>
							<RotateCcw />
							{restorable.length ? `Restore ${restorable.length}` : "Restore"}
						</Button>
						<Button
							variant="destructive"
							data-testid={TRASH_TESTID.deleteSelected}
							disabled={!chosen.length}
							onClick={() => askDelete(chosen.map((i) => i.id))}
						>
							<Trash2 />
							{chosen.length ? `Delete ${chosen.length}` : "Delete"}
						</Button>
					</div>
				</div>
			) : null}
			<TrashDetail
				item={open}
				onClose={() => setOpen(null)}
				onRestore={(it) => {
					setOpen(null);
					void restore([it]);
				}}
				onDelete={(it) => {
					setOpen(null);
					askDelete([it.id]);
				}}
			/>
			<ConfirmDelete
				ask={ask}
				onCancel={() => setAsk(null)}
				onConfirm={() => {
					const ids = ask?.ids;
					setAsk(null);
					if (ids) void remove(ids).then((ok) => ok && stopSelecting());
				}}
			/>
		</>
	);
}

export function TrashPage() {
	const trash = useQuery(trashQuery());
	return (
		<div className="min-h-svh bg-background">
			<header className="mx-auto flex h-14 max-w-[720px] items-center justify-between px-4">
				<Link
					to="/dashboard"
					className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft className="size-4" /> Your trips
				</Link>
				<YonderMark className="size-5 text-primary" />
			</header>
			<main
				data-testid={TRASH_TESTID.page}
				className="mx-auto max-w-[720px] pb-24 sm:px-4"
			>
				<TrashGrid items={trash.data ?? []} pending={trash.isPending} />
			</main>
		</div>
	);
}
