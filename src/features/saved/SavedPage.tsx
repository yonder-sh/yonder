/**
 * `/saved`: everything shared into Yonder and not in a trip yet, newest
 * first, three to a row like Instagram's and TikTok's saved grids. A tile
 * opens the feed there (`?open=<id>`); a share opens it straight on the link
 * (`&from=share`, with Later). Select ticks tiles to delete several at once
 * (one call, Undo in the toast). Shares still waiting on this device
 * (offline, an upload that stopped) are counted above the grid.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, CloudOff, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { YonderMark } from "@/components/common/yonder-mark";
import { Button } from "@/components/ui/button";
import { SaveFromAppsDialog } from "@/features/home/SaveFromAppsDialog";
import { savedPolling, savedQuery } from "./queries";
import { SavedFeed } from "./SavedFeed";
import { SavedTile } from "./SavedTile";
import { SAVED_TESTID } from "./testids";
import type { SavedLink } from "./types";
import { useDeleteSaved } from "./use-delete-saved";
import { useSharedOnDevice } from "./use-shared-on-device";

function OnThisDevice() {
	const n = useSharedOnDevice().length;
	if (!n) return null;
	return (
		<p
			data-testid={SAVED_TESTID.waiting}
			className="flex items-center gap-2 px-4 pb-4 text-meta text-muted-foreground sm:px-0"
		>
			<CloudOff className="size-4 shrink-0" />
			{n === 1
				? "1 share on this device goes to Saved when you're back online."
				: `${n} shares on this device go to Saved when you're back online.`}
		</p>
	);
}

/**
 * The grid: three to a row, newest first; Select ticks tiles and Delete N
 * deletes them in one call (Undo in the toast).
 */
export function SavedGrid({
	links,
	pending,
	onOpen,
	empty,
}: {
	links: readonly SavedLink[];
	pending: boolean;
	onOpen: (id: string) => void;
	empty: ReactNode;
}) {
	// Select: tick tiles, then Delete N.
	const [selecting, setSelecting] = useState(false);
	const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
	const live = new Set(links.map((l) => l.id));
	const chosen = [...picked].filter((id) => live.has(id));
	const stopSelecting = () => {
		setSelecting(false);
		setPicked(new Set());
	};
	const deleteSaved = useDeleteSaved();
	const deleteChosen = async () => {
		if (await deleteSaved(chosen)) stopSelecting();
	};
	return (
		<>
			<div className="flex items-baseline justify-between gap-4 px-4 pt-2 pb-4 sm:px-0">
				<h1 className="font-display text-2xl leading-7 font-semibold tracking-[-0.01em]">
					{selecting ? (
						<span data-testid={SAVED_TESTID.selectCount}>
							{chosen.length} selected
						</span>
					) : (
						"Saved"
					)}
				</h1>
				{selecting ? (
					<Button
						variant="ghost"
						size="sm"
						data-testid={SAVED_TESTID.selectCancel}
						onClick={stopSelecting}
					>
						Cancel
					</Button>
				) : links.length ? (
					<span className="flex items-center gap-3">
						<span className="text-meta text-muted-foreground tnum">
							{links.length === 1 ? "1 item" : `${links.length} items`}
						</span>
						<Button
							variant="outline"
							size="sm"
							data-testid={SAVED_TESTID.select}
							onClick={() => setSelecting(true)}
						>
							Select
						</Button>
					</span>
				) : null}
			</div>
			<OnThisDevice />
			{pending ? (
				<div className="grid grid-cols-3 gap-0.5 sm:gap-1">
					{[0, 1, 2].map((i) => (
						<div key={i} className="aspect-[9/16] animate-pulse bg-muted" />
					))}
				</div>
			) : links.length ? (
				<div
					data-testid={SAVED_TESTID.grid}
					className="grid grid-cols-3 gap-0.5 sm:gap-1"
				>
					{links.map((l) => (
						<SavedTile
							key={l.id}
							link={l}
							selecting={selecting}
							selected={picked.has(l.id)}
							onOpen={() =>
								selecting
									? setPicked((p) => {
											const next = new Set(p);
											if (!next.delete(l.id)) next.add(l.id);
											return next;
										})
									: onOpen(l.id)
							}
						/>
					))}
				</div>
			) : (
				empty
			)}
			{selecting ? (
				<div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur">
					<div className="mx-auto flex max-w-[720px] items-center justify-end">
						<Button
							variant="destructive"
							data-testid={SAVED_TESTID.deleteSelected}
							disabled={!chosen.length}
							onClick={() => void deleteChosen()}
						>
							<Trash2 />
							{chosen.length ? `Delete ${chosen.length}` : "Delete"}
						</Button>
					</div>
				</div>
			) : null}
		</>
	);
}

export function SavedPage({ open, from }: { open?: string; from?: "share" }) {
	const navigate = useNavigate();
	const saved = useQuery({
		...savedQuery(),
		refetchInterval: (q) => savedPolling(q.state.data),
	});
	const links = saved.data ?? [];
	const [howOpen, setHowOpen] = useState(false);
	const close = () =>
		void navigate({ to: "/saved", search: {}, replace: true });
	// A link just shared waits for the list that has it; once open, the feed
	// stays while the list changes under it (saved ones leave the list).
	const [shown, setShown] = useState<string | null>(null);
	const ready =
		!!open &&
		!!saved.data &&
		(saved.data.some((l) => l.id === open) || !saved.isFetching);
	useEffect(() => {
		if (ready && open) setShown(open);
	}, [ready, open]);
	const feedReady = !!open && (ready || shown === open);
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
				data-testid={SAVED_TESTID.page}
				className="mx-auto max-w-[720px] pb-16 sm:px-4"
			>
				<SavedGrid
					links={links}
					pending={saved.isPending}
					onOpen={(id) => void navigate({ to: "/saved", search: { open: id } })}
					empty={
						<div
							data-testid={SAVED_TESTID.empty}
							className="mx-4 grid justify-items-center gap-4 rounded-2xl border bg-card px-6 py-12 text-center sm:mx-0"
						>
							<p className="font-display text-lg leading-6 font-medium">
								Nothing saved yet
							</p>
							<p className="max-w-sm text-sm text-muted-foreground text-balance">
								Share a reel, a TikTok, a Maps place or any link to Yonder. It
								waits here until you add it to a trip.
							</p>
							<div className="flex flex-wrap justify-center gap-2">
								<Button onClick={() => setHowOpen(true)}>
									Save from other apps
								</Button>
								<Button asChild variant="outline">
									<Link to="/share">Paste a link</Link>
								</Button>
							</div>
						</div>
					}
				/>
			</main>
			{feedReady && saved.data ? (
				<SavedFeed
					key={open}
					links={saved.data}
					open={open ?? null}
					fromShare={from === "share"}
					onClose={close}
				/>
			) : null}
			<SaveFromAppsDialog open={howOpen} onOpenChange={setHowOpen} />
		</div>
	);
}
