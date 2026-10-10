/**
 * `/saved`: everything shared into Yonder and not in a trip yet, newest
 * first, three to a row like Instagram's and TikTok's saved grids. A tile
 * opens the feed there (`?open=<id>`); a share opens it straight on the link
 * (`&from=share`, with Later). Shares still on this device (offline, or
 * photos from another app) show above the grid.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, CloudOff } from "lucide-react";
import { useEffect, useState } from "react";
import { YonderMark } from "@/components/common/yonder-mark";
import { Button } from "@/components/ui/button";
import { SaveFromAppsDialog } from "@/features/home/SaveFromAppsDialog";
import { savedPolling, savedQuery } from "./queries";
import { SavedFeed } from "./SavedFeed";
import { SavedTile } from "./SavedTile";
import { SAVED_TESTID } from "./testids";
import { useSharedOnDevice } from "./use-shared-on-device";

function OnThisDevice() {
	const list = useSharedOnDevice();
	const files = list.filter((e) => e.files.length);
	const links = list.length - files.length;
	if (!list.length) return null;
	return (
		<div
			data-testid={SAVED_TESTID.waiting}
			className="grid gap-2 px-4 pb-4 sm:px-0"
		>
			{links ? (
				<p className="flex items-center gap-2 text-meta text-muted-foreground">
					<CloudOff className="size-4 shrink-0" />
					{links === 1
						? "1 link on this device goes to Saved when you're back online."
						: `${links} links on this device go to Saved when you're back online.`}
				</p>
			) : null}
			{files[0] ? (
				<Link
					to="/share"
					search={{ id: files[0].id } as never}
					className="flex h-11 items-center gap-3 rounded-xl border bg-card px-4 text-sm transition-colors hover:border-foreground/20"
				>
					<span className="flex-1">
						{files.length === 1
							? "1 photo share to save"
							: `${files.length} photo shares to save`}
					</span>
					<ArrowRight className="size-4 text-muted-foreground" />
				</Link>
			) : null}
		</div>
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
				<div className="flex items-baseline justify-between gap-4 px-4 pt-2 pb-4 sm:px-0">
					<h1 className="font-display text-2xl leading-7 font-semibold tracking-[-0.01em]">
						Saved
					</h1>
					{links.length ? (
						<span className="text-meta text-muted-foreground tnum">
							{links.length === 1 ? "1 link" : `${links.length} links`}
						</span>
					) : null}
				</div>
				<OnThisDevice />
				{saved.isPending ? (
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
								onOpen={() =>
									void navigate({ to: "/saved", search: { open: l.id } })
								}
							/>
						))}
					</div>
				) : (
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
				)}
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
