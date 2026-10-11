/**
 * `/saved`: everything shared into Yonder or saved from a trip, an inventory
 * for trips to come: by country, then city, then Unsorted, three to a row
 * like Instagram's and TikTok's saved grids. Ones in trips stay (labelled);
 * "Hide ones in trips" hides them (remembered on the device). A tile opens
 * the feed there (`?open=<id>`, in the grid's order); a share opens it on the
 * new item asking "Where is this?" (`&from=share`). Select ticks tiles to
 * move or delete several at once. Shares still waiting on this device
 * (offline, an upload that stopped) are counted above the grid.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, CloudOff, MapPin, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FlagEmoji } from "@/components/common/glyphs";
import { YonderMark } from "@/components/common/yonder-mark";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SaveFromAppsDialog } from "@/features/home/SaveFromAppsDialog";
import { savedPolling, savedQuery } from "./queries";
import { SavedFeed } from "./SavedFeed";
import { SavedTile } from "./SavedTile";
import { SAVED_TESTID } from "./testids";
import type { SavedLink } from "./types";
import { useDeleteSaved } from "./use-delete-saved";
import { useSetWhere } from "./use-set-where";
import { useSharedOnDevice } from "./use-shared-on-device";
import { WhereDialog } from "./WherePicker";
import {
	type CountryGroup,
	gridOrder,
	groupSaved,
	type WhereChoice,
	whereLabel,
} from "./where";

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

const HIDE_KEY = "yonder:saved-hide-in-trips";

/** "Hide ones in trips", remembered on this device. */
export function useHideInTrips(): [boolean, (v: boolean) => void] {
	const [hide, setHide] = useState(() => {
		try {
			return localStorage.getItem(HIDE_KEY) === "1";
		} catch {
			return false;
		}
	});
	const set = (v: boolean) => {
		setHide(v);
		try {
			if (v) localStorage.setItem(HIDE_KEY, "1");
			else localStorage.removeItem(HIDE_KEY);
		} catch {
			// private mode: this visit only
		}
	};
	return [hide, set];
}

/** What the grid shows, in its order (the feed follows it). */
export function gridLinks(
	links: readonly SavedLink[],
	hideInTrips: boolean,
): { groups: CountryGroup[]; order: string[] } {
	const groups = groupSaved(
		hideInTrips ? links.filter((l) => !l.trips.length) : links,
	);
	return { groups, order: gridOrder(groups) };
}

function Tiles({
	items,
	selecting,
	picked,
	onTap,
}: {
	items: readonly SavedLink[];
	selecting: boolean;
	picked: ReadonlySet<string>;
	onTap: (id: string) => void;
}) {
	return (
		<div
			data-testid={SAVED_TESTID.grid}
			className="grid grid-cols-3 gap-0.5 sm:gap-1"
		>
			{items.map((l) => (
				<SavedTile
					key={l.id}
					link={l}
					selecting={selecting}
					selected={picked.has(l.id)}
					onOpen={() => onTap(l.id)}
				/>
			))}
		</div>
	);
}

/**
 * The grid: by country, then city, then Unsorted; three to a row, newest
 * first in each. Select ticks tiles: Move files them under a place, Delete N
 * deletes them in one call (Undo in the toast).
 */
export function SavedGrid({
	links,
	pending,
	onOpen,
	empty,
	hideInTrips = false,
	onHideInTrips,
}: {
	links: readonly SavedLink[];
	pending: boolean;
	onOpen: (id: string) => void;
	empty: ReactNode;
	hideInTrips?: boolean;
	onHideInTrips?: (v: boolean) => void;
}) {
	// Select: tick tiles, then Move or Delete N.
	const [selecting, setSelecting] = useState(false);
	const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
	const [moving, setMoving] = useState(false);
	const { groups } = useMemo(
		() => gridLinks(links, hideInTrips),
		[links, hideInTrips],
	);
	const shown = groups.reduce((n, g) => n + g.count, 0);
	const anyInTrips = links.some((l) => l.trips.length);
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
	const setWhere = useSetWhere();
	const moveChosen = (c: WhereChoice | null) => {
		const n = chosen.length;
		setMoving(false);
		stopSelecting();
		void setWhere(chosen, c).then(
			(ok) =>
				ok &&
				toast.success(
					`Moved ${n === 1 ? "1 item" : `${n} items`} to ${c ? whereLabel(c) : "Unsorted"}`,
					{ position: "top-center" },
				),
		);
	};
	const tap = (id: string) =>
		selecting
			? setPicked((p) => {
					const next = new Set(p);
					if (!next.delete(id)) next.add(id);
					return next;
				})
			: onOpen(id);
	return (
		<>
			<div className="flex items-baseline justify-between gap-4 px-4 pt-2 pb-3 sm:px-0">
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
							{shown === 1 ? "1 item" : `${shown} items`}
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
			{anyInTrips && onHideInTrips && !selecting ? (
				<div className="flex w-fit items-center gap-2 px-4 pb-3 text-meta text-muted-foreground sm:px-0">
					<Switch
						id="saved-hide-in-trips"
						size="sm"
						data-testid={SAVED_TESTID.hideInTrips}
						checked={hideInTrips}
						onCheckedChange={onHideInTrips}
					/>
					<label htmlFor="saved-hide-in-trips" className="cursor-pointer">
						Hide ones in trips
					</label>
				</div>
			) : null}
			<OnThisDevice />
			{pending ? (
				<div className="grid grid-cols-3 gap-0.5 sm:gap-1">
					{[0, 1, 2].map((i) => (
						<div key={i} className="aspect-[9/16] animate-pulse bg-muted" />
					))}
				</div>
			) : groups.length ? (
				<div className="grid gap-6">
					{groups.map((g) => (
						<section
							key={g.key || "unsorted"}
							data-testid={SAVED_TESTID.section}
							data-country={g.key}
							aria-label={g.label}
							className="grid gap-2"
						>
							<h2 className="flex items-center gap-2 px-4 font-display text-lg leading-6 font-semibold sm:px-0">
								{g.key ? <FlagEmoji code={g.key} className="text-lg" /> : null}
								{g.label}
								<span className="text-sm font-normal text-muted-foreground tnum">
									{g.count}
								</span>
							</h2>
							{g.cities.map((c) =>
								g.key ? (
									<div
										key={c.key}
										data-testid={SAVED_TESTID.sectionCity}
										data-city={c.key}
										className="grid gap-1.5"
									>
										<h3 className="px-4 text-sm font-medium text-muted-foreground sm:px-0">
											{c.label} · <span className="tnum">{c.items.length}</span>
										</h3>
										<Tiles
											items={c.items}
											selecting={selecting}
											picked={picked}
											onTap={tap}
										/>
									</div>
								) : (
									<Tiles
										key={c.key}
										items={c.items}
										selecting={selecting}
										picked={picked}
										onTap={tap}
									/>
								),
							)}
						</section>
					))}
				</div>
			) : links.length ? (
				<p className="mx-4 rounded-2xl border bg-card px-6 py-10 text-center text-sm text-muted-foreground sm:mx-0">
					Everything here is in a trip already.
				</p>
			) : (
				empty
			)}
			{selecting ? (
				<div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur">
					<div className="mx-auto flex max-w-[720px] items-center justify-end gap-2">
						<Button
							variant="outline"
							data-testid={SAVED_TESTID.moveSelected}
							disabled={!chosen.length}
							onClick={() => setMoving(true)}
						>
							<MapPin />
							Move
						</Button>
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
			<WhereDialog
				open={moving}
				onOpenChange={setMoving}
				current={null}
				onPick={moveChosen}
			/>
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
	const [hideInTrips, setHideInTrips] = useHideInTrips();
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
	// The feed in the grid's order (the item opened is in it even when hidden).
	const ordered = useMemo(() => {
		const all = saved.data ?? [];
		const byId = new Map(all.map((l) => [l.id, l]));
		const { order } = gridLinks(all, hideInTrips);
		if (open && byId.has(open) && !order.includes(open)) order.unshift(open);
		return order.flatMap((id) => byId.get(id) ?? []);
	}, [saved.data, hideInTrips, open]);
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
					hideInTrips={hideInTrips}
					onHideInTrips={setHideInTrips}
					empty={
						<div
							data-testid={SAVED_TESTID.empty}
							className="mx-4 grid justify-items-center gap-4 rounded-2xl border bg-card px-6 py-12 text-center sm:mx-0"
						>
							<p className="font-display text-lg leading-6 font-medium">
								Nothing saved yet
							</p>
							<p className="max-w-sm text-sm text-muted-foreground text-balance">
								Share a reel, a TikTok, a Maps place or any link to Yonder. It's
								kept here by place, for this trip or the next.
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
					links={ordered}
					open={open ?? null}
					fromShare={from === "share"}
					onClose={close}
				/>
			) : null}
			<SaveFromAppsDialog open={howOpen} onOpenChange={setHowOpen} />
		</div>
	);
}
