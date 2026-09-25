/**
 * The dashboard `/` (DESIGN §10.3; EXTENSIONS §1.4, §7, §9): the greeting,
 * the next trip as a hero (cover or RouteSketch, countdown, "Available
 * offline"), Upcoming deadlines, your trips, trips shared with you (role
 * badge "Can view / Can suggest / Can edit"), and past trips.
 *
 * Fewer badges (ADDENDUM §10): a card carries at most one glow dot (unread
 * mentions, else changes) and one warning ("2 overdue"); everything else is
 * muted text. Offline with a saved trip, the dashboard goes straight to it
 * (SPEC §16.4, QA PWA-04).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowRight, Check, Inbox, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/empty-state";
import { FlagEmoji } from "@/components/common/glyphs";
import { AvatarStack } from "@/components/common/member";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { setListItemStatus } from "@/features/lists/lists.functions";
import { warmShareInbox } from "@/features/offline/register-sw";
import {
	readSavedTrips,
	removeTripOffline,
} from "@/features/offline/saved-trips";
import { listShared } from "@/features/offline/share-store";
import { InboxBell } from "@/features/shell/InboxBell";
import { roleLabel } from "@/lib/auth/roles";
import type { Viewer } from "@/lib/auth/viewer";
import { BRAND } from "@/lib/brand";
import { humanError } from "@/lib/errors";
import { formatDateRange, todayIn } from "@/lib/format";
import { MENTION_TOKEN_RE } from "@/lib/notes/mentions";
import { meKeys } from "@/lib/query/keys";
import { useOnline } from "@/lib/realtime/connection";
import { TESTID } from "@/lib/testids";
import { AccountMenu } from "./AccountMenu";
import { CardMenu } from "./CardMenu";
import { DuplicateTripDialog } from "./DuplicateTripDialog";
import { deadlineLabel } from "./deadline-label";
import { heroWhen, isRunning } from "./hero-when";
import { NewTripDialog } from "./NewTripDialog";
import { ProfileDialog } from "./ProfileDialog";
import { myDeadlinesQuery, myTripsQuery } from "./queries";
import { leaveTrip } from "./sharing.functions";
import { TripSketch } from "./TripSketch";
import { HOME_TESTID } from "./testids";
import { rememberZone } from "./today";
import type { MyTrip } from "./types";

function greeting(): string {
	const h = new Date().getHours();
	return h < 5
		? "Good evening"
		: h < 12
			? "Good morning"
			: h < 18
				? "Good afternoon"
				: "Good evening";
}

function Overline({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<h2
			className={cn(
				"mb-3 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase",
				className,
			)}
		>
			{children}
		</h2>
	);
}

/** "1 day", "12 days" (QA HOME-7: never "1 days"). */
export function dayCount(n: number): string {
	return `${n} ${n === 1 ? "day" : "days"}`;
}

function datesText(trip: MyTrip): string {
	return trip.startDate
		? formatDateRange(trip.startDate, trip.endDate, { year: true })
		: "No dates yet";
}

/** `[@Maya](mention:…)` → "@Maya" for one-line rows. */
function plain(md: string): string {
	return md
		.replace(MENTION_TOKEN_RE, (_m, label: string) => `@${label}`)
		.replace(/[*_`#>[\]]/g, "");
}

function Flags({ codes, className }: { codes: string[]; className?: string }) {
	if (!codes.length) return null;
	return (
		<span className={cn("flex gap-1 text-sm", className)}>
			{codes.slice(0, 6).map((c) => (
				<FlagEmoji key={c} code={c} />
			))}
		</span>
	);
}

/**
 * The card's quiet status line: one glow dot (unread mentions, else changes),
 * muted counts, and at most one warning ("2 overdue").
 */
function TripChips({ trip }: { trip: MyTrip }) {
	const changes = trip.changesSince ?? 0;
	const review = trip.openProposals ?? 0;
	const overdue = trip.overdue ?? 0;
	const dot = trip.unreadMentions > 0 || changes > 0;
	const parts: { key: string; node: React.ReactNode }[] = [];
	if (trip.unreadMentions > 0)
		parts.push({
			key: "m",
			node: `${trip.unreadMentions} mention${trip.unreadMentions === 1 ? "" : "s"}`,
		});
	if (changes > 0)
		parts.push({
			key: "c",
			node: `${changes >= 100 ? "99+" : changes} change${changes === 1 ? "" : "s"}`,
		});
	if (review > 0) parts.push({ key: "r", node: `${review} to review` });
	if (overdue > 0)
		parts.push({
			key: "o",
			node: <span className="text-warning">{overdue} overdue</span>,
		});
	if (!parts.length) return null;
	return (
		<span
			data-testid={HOME_TESTID.tripCardChip}
			className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground"
		>
			{dot ? (
				<span
					aria-hidden="true"
					className="size-1.5 shrink-0 rounded-full bg-glow"
				/>
			) : null}
			<span className="flex min-w-0 flex-wrap items-center gap-x-1.5 font-mono tnum">
				{parts.map((p, i) => (
					<span key={p.key} className="flex items-center gap-1.5">
						{i ? <span aria-hidden="true">·</span> : null}
						{p.node}
					</span>
				))}
			</span>
		</span>
	);
}

function Cover({
	trip,
	hero,
	className,
}: {
	trip: MyTrip;
	hero?: boolean;
	className?: string;
}) {
	const [broken, setBroken] = useState(false);
	if (trip.coverUrl && !broken)
		return (
			<img
				src={trip.coverUrl}
				alt=""
				loading={hero ? "eager" : "lazy"}
				onError={() => setBroken(true)}
				className={cn("size-full object-cover", className)}
			/>
		);
	return (
		<TripSketch
			seed={trip.id}
			points={trip.routePoints}
			countryCodes={trip.countryCodes}
			glow={hero}
			className={className}
		/>
	);
}

function Hero({
	trip,
	today,
	offline,
	menu,
}: {
	trip: MyTrip;
	today: string | null;
	offline: boolean;
	menu: React.ReactNode;
}) {
	const running = isRunning(trip.startDate, trip.endDate, today);
	const when = heroWhen(trip.startDate, trip.endDate, today);
	return (
		<div
			data-testid={HOME_TESTID.heroCard}
			className="group relative grid grid-cols-1 overflow-hidden rounded-2xl border bg-card transition-colors hover:border-foreground/20 md:h-[280px] md:grid-cols-[2fr_3fr]"
		>
			<div className="relative aspect-[16/9] overflow-hidden border-b md:order-2 md:aspect-auto md:border-b-0 md:border-l">
				<Cover
					trip={trip}
					hero
					className="transition-transform duration-300 group-hover:scale-[1.02]"
				/>
			</div>
			<div className="flex min-w-0 flex-col gap-2 p-5 sm:p-6 md:order-1">
				<div className="flex items-center justify-between gap-2">
					<span className="text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
						{running ? "On the road" : "Next trip"}
					</span>
					<span className="relative z-10">{menu}</span>
				</div>
				<Link
					to="/t/$trip"
					params={{ trip: trip.slug }}
					data-testid={TESTID.tripCard}
					className="text-[28px] leading-[34px] font-semibold text-balance after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
				>
					{trip.name}
				</Link>
				<span className="text-sm">
					{datesText(trip)}
					{trip.dayCount ? (
						<span className="text-muted-foreground">
							{" "}
							· {dayCount(trip.dayCount)}
						</span>
					) : null}
				</span>
				{trip.viaLink || trip.role !== "owner" ? (
					<span className="flex items-center gap-2 text-[13px] text-muted-foreground">
						<span className="rounded-full border px-1.5 text-[11px] leading-[18px]">
							{roleLabel(trip.role)}
						</span>
						{trip.ownerName ? `by ${trip.ownerName}` : null}
					</span>
				) : null}
				{when ? (
					<span
						data-testid={HOME_TESTID.heroWhen}
						className="font-mono text-[13px] text-muted-foreground tnum"
					>
						{when.kind === "countdown"
							? `in ${dayCount(when.days)}`
							: `Day ${when.day}`}
					</span>
				) : null}
				<TripChips trip={trip} />
				<div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-4">
					<span className="flex items-center gap-3">
						<Flags codes={trip.countryCodes} />
						{offline ? (
							<span
								data-testid={HOME_TESTID.offlineChip}
								className="inline-flex h-[22px] items-center gap-1 rounded-full bg-muted px-2 text-[12px] text-muted-foreground"
							>
								<Check className="size-3" /> Available offline
							</span>
						) : null}
					</span>
					<AvatarStack people={trip.members} max={5} size={28} />
				</div>
			</div>
		</div>
	);
}

function TripCard({
	trip,
	shared,
	offline,
	menu,
}: {
	trip: MyTrip;
	shared?: boolean;
	offline: boolean;
	menu: React.ReactNode;
}) {
	return (
		<div className="group relative grid min-w-0 grid-cols-1 gap-3 rounded-2xl">
			<div className="aspect-[16/9] overflow-hidden rounded-xl border transition-colors group-hover:border-foreground/20 sm:aspect-[4/3]">
				<Cover
					trip={trip}
					className="transition-transform duration-300 group-hover:scale-[1.02]"
				/>
			</div>
			<div className="grid gap-1 px-0.5">
				<div className="flex items-start justify-between gap-2">
					<Link
						to="/t/$trip"
						params={{ trip: trip.slug }}
						data-testid={TESTID.tripCard}
						className="min-w-0 text-lg leading-6 font-semibold text-balance after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
					>
						{trip.name}
					</Link>
					<span className="relative z-10 flex shrink-0 items-center gap-1">
						{shared ? (
							<span className="rounded-full border px-1.5 text-[11px] leading-[18px] text-muted-foreground">
								{roleLabel(trip.role)}
							</span>
						) : null}
						{menu}
					</span>
				</div>
				<span className="text-[13px] text-muted-foreground">
					{datesText(trip)}
					{shared && trip.ownerName ? ` · by ${trip.ownerName}` : null}
				</span>
				<TripChips trip={trip} />
				<div className="flex items-center justify-between pt-1">
					<span className="flex items-center gap-2">
						<Flags codes={trip.countryCodes} className="text-[14px]" />
						{offline ? (
							<span className="text-[12px] text-muted-foreground">
								<Check className="inline size-3" /> Offline
							</span>
						) : null}
					</span>
					<AvatarStack people={trip.members} max={4} size={20} />
				</div>
			</div>
		</div>
	);
}

function Deadlines() {
	// "Everyone's" (EXTENSIONS §7): also rows assigned only to others.
	const [everyone, setEveryone] = useState(false);
	const mine = useQuery(myDeadlinesQuery());
	const others = useQuery({
		...myDeadlinesQuery(true),
		enabled: everyone,
		placeholderData: (prev) => prev,
	});
	const q = everyone && others.data ? others : mine;
	const online = useOnline();
	const qc = useQueryClient();
	const [all, setAll] = useState(false);
	const [done, setDone] = useState<Set<string>>(new Set());
	const [now, setNow] = useState<number | null>(null);
	useEffect(() => setNow(Date.now()), []);
	const tick = useMutation({
		mutationFn: (id: string) =>
			setListItemStatus({ data: { id, status: "done" } }),
		onError: (_e, id) =>
			setDone((s) => {
				const n = new Set(s);
				n.delete(id);
				return n;
			}),
		onSettled: () =>
			setTimeout(
				() => void qc.invalidateQueries({ queryKey: meKeys.deadlines }),
				4000,
			),
	});
	const rows = q.data ?? [];
	if ((!rows.length && !everyone) || now === null) return null;
	const shown = all ? rows : rows.slice(0, 5);
	return (
		<section data-testid={HOME_TESTID.deadlines}>
			<div className="mb-3 flex items-center justify-between gap-3">
				<Overline className="mb-0">Upcoming deadlines</Overline>
				<button
					type="button"
					aria-pressed={everyone}
					data-testid={HOME_TESTID.deadlinesEveryone}
					onClick={() => setEveryone((v) => !v)}
					className={cn(
						"rounded-full border px-2.5 text-[12px] leading-6 transition-colors",
						everyone
							? "border-foreground/20 bg-accent text-accent-foreground"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					Everyone's
				</button>
			</div>
			{!rows.length ? (
				<p className="rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
					Nothing due in the next 30 days.
				</p>
			) : null}
			<ul
				className={cn(
					"divide-y rounded-xl border bg-card",
					!rows.length && "hidden",
				)}
			>
				{shown.map((d) => {
					const isDone = done.has(d.listItemId);
					const warn = d.state === "overdue";
					const soon = d.state === "soon" || d.state === "open_now";
					const label = deadlineLabel(d, now);
					return (
						<li
							key={d.listItemId}
							data-testid={HOME_TESTID.deadlineRow}
							className="flex min-h-11 items-center gap-3 px-3 py-1.5"
						>
							<Checkbox
								checked={isDone}
								disabled={!d.canComplete || isDone || !online}
								title={
									!online
										? "Reconnect to edit"
										: !d.canComplete
											? "Only its assignees and editors can tick this"
											: undefined
								}
								data-testid={HOME_TESTID.deadlineCheck}
								aria-label={`Mark “${plain(d.text)}” done`}
								onCheckedChange={() => {
									setDone((s) => new Set(s).add(d.listItemId));
									tick.mutate(d.listItemId);
								}}
							/>
							<span
								className={cn(
									"hidden shrink-0 rounded-full px-2 font-mono text-[12px] leading-[22px] tnum sm:inline",
									warn
										? "text-warning"
										: soon
											? "bg-accent text-accent-foreground"
											: "bg-muted text-muted-foreground",
								)}
							>
								{label}
							</span>
							<span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-2">
								<span
									className={cn(
										"truncate text-sm",
										isDone && "text-muted-foreground line-through",
									)}
								>
									{plain(d.text)}
								</span>
								{/* Phones: the due label and the trip get a line each, so a
								    long label never cuts the trip name to "Asi…" (QA DASH). */}
								<span
									className={cn(
										"truncate font-mono text-[12px] tnum sm:hidden",
										warn ? "text-warning" : "text-muted-foreground",
									)}
								>
									{label}
								</span>
								<span
									data-testid={HOME_TESTID.deadlineTrip}
									title={d.tripName}
									className="truncate text-[12px] text-muted-foreground"
								>
									{d.tripName}
								</span>
							</span>
							<Link
								to="/t/$trip"
								params={{ trip: d.tripSlug }}
								search={
									{
										tab: "lists",
										...(d.sel ? { sel: d.sel } : {}),
									} as never
								}
								aria-label={`Open ${plain(d.text)} in ${d.tripName}`}
								className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
							>
								<ArrowRight className="size-4" />
							</Link>
						</li>
					);
				})}
			</ul>
			{rows.length > 5 ? (
				<button
					type="button"
					onClick={() => setAll((v) => !v)}
					className="mt-2 text-[13px] font-medium text-primary hover:underline"
				>
					{all ? "Show fewer" : `Show all (${rows.length})`}
				</button>
			) : null}
		</section>
	);
}

/** E8: "1 shared item waiting" (entries kept on this device while offline). */
function SharedWaiting() {
	const [count, setCount] = useState(0);
	const [firstId, setFirstId] = useState<string | null>(null);
	useEffect(() => {
		void listShared().then((l) => {
			setCount(l.length);
			setFirstId(l[0]?.id ?? null);
		});
	}, []);
	if (!count || !firstId) return null;
	return (
		<Link
			to="/share"
			search={{ id: firstId } as never}
			data-testid={HOME_TESTID.sharedWaiting}
			className="flex h-11 items-center gap-3 rounded-xl border bg-card px-4 text-sm transition-colors hover:border-foreground/20"
		>
			<Inbox className="size-4 text-muted-foreground" />
			<span className="flex-1">
				{count} shared {count === 1 ? "item" : "items"} waiting
			</span>
			<ArrowRight className="size-4 text-muted-foreground" />
		</Link>
	);
}

/**
 * QA PWA-08: the saved trip is missing from the list on screen (the
 * server-rendered one, which never ran `myTripsQuery`'s client fetch) →
 * ask the server once more; that fetch drops the lost trip's offline copy.
 * A list restored from IndexedDB is never judged (it may be older than the
 * saved trip), only a network answer is.
 */
function useForgetLostTrips(
	list: MyTrip[] | undefined,
	fetching: boolean,
	refetch: () => Promise<unknown>,
) {
	const online = useOnline();
	const checked = useRef<MyTrip[] | undefined>(undefined);
	useEffect(() => {
		if (!list || !online || fetching || checked.current === list) return;
		checked.current = list;
		const ids = new Set(list.map((t) => t.id));
		if (readSavedTrips().some((t) => !ids.has(t.tripId)))
			void refetch().catch(() => {});
	}, [list, fetching, online, refetch]);
}

/** SPEC §16.4: offline with a saved trip → straight to it (no loop). */
function useOfflineRedirect(failed: boolean) {
	useEffect(() => {
		if (typeof window === "undefined") return;
		const offline = !navigator.onLine || failed;
		if (!offline) return;
		if (new URLSearchParams(window.location.search).get("from") === "offline")
			return;
		const saved = readSavedTrips()[0];
		if (saved)
			window.location.replace(
				`/t/${encodeURIComponent(saved.slug)}?from=offline`,
			);
	}, [failed]);
}

export function Dashboard({
	viewer,
	today: firstToday = null,
}: {
	viewer: Viewer;
	/** DASH-03: the server's "today" in the viewer's zone, so SSR splits next / past right. */
	today?: string | null;
}) {
	// DASH-04: a trip shared with me shows up without a reload (a quiet poll
	// while the tab is visible; focus refetches too).
	const trips = useQuery({ ...myTripsQuery(), refetchInterval: 60_000 });
	const qc = useQueryClient();
	// "today" starts as the loader's (SSR: the viewer's zone, DASH-03) and the
	// browser's clock confirms it; the time of day is client-only ("Welcome back").
	const [today, setToday] = useState<string | null>(firstToday);
	const [hello, setHello] = useState("Welcome back");
	const [saved, setSaved] = useState<Set<string>>(new Set());
	const [dup, setDup] = useState<MyTrip | null>(null);
	const [leaving, setLeaving] = useState<MyTrip | null>(null);
	useEffect(() => {
		setToday(todayIn());
		rememberZone();
		setHello(greeting());
		setSaved(new Set(readSavedTrips().map((t) => t.tripId)));
		// E8: a share sent offline later still opens the inbox.
		warmShareInbox();
	}, []);
	const networkFailed =
		trips.isError && !trips.data && humanError(trips.error).startsWith("Can't");
	useOfflineRedirect(networkFailed);
	useForgetLostTrips(trips.data, trips.isFetching, trips.refetch);
	// The "Available offline" marks follow a purge (PWA-08).
	useEffect(() => {
		if (trips.data && !trips.isFetching)
			setSaved(new Set(readSavedTrips().map((t) => t.tripId)));
	}, [trips.data, trips.isFetching]);

	const leave = useMutation({
		mutationFn: (t: MyTrip) => leaveTrip({ data: { tripId: t.id } }),
		onSuccess: async (_r, t) => {
			await removeTripOffline(t.id);
			await qc.invalidateQueries({ queryKey: meKeys.trips });
			toast.success(`You left “${t.name}”`);
		},
	});

	const all = trips.data ?? [];
	const { next, mine, shared, past } = useMemo(() => {
		const isPast = (t: MyTrip) => !!today && !!t.endDate && t.endDate < today;
		const current = all.filter((t) => !isPast(t));
		const next =
			[...current]
				.filter((t) => t.startDate)
				.sort((a, b) =>
					(a.startDate ?? "").localeCompare(b.startDate ?? ""),
				)[0] ?? current[0];
		return {
			next,
			mine: current.filter(
				(t) => !t.viaLink && t.role === "owner" && t.id !== next?.id,
			),
			shared: current.filter(
				(t) => (t.viaLink || t.role !== "owner") && t.id !== next?.id,
			),
			past: all
				.filter(isPast)
				.sort((a, b) => (b.endDate ?? "").localeCompare(a.endDate ?? "")),
		};
	}, [all, today]);

	const menuFor = (t: MyTrip) => (
		<CardMenu
			trip={t}
			onDuplicate={() => setDup(t)}
			onLeave={() => setLeaving(t)}
		/>
	);

	return (
		<div data-testid={TESTID.dashboard} className="min-h-svh bg-background">
			<header className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-4 sm:px-8">
				<Link
					to="/"
					className="flex items-center gap-2 text-primary"
					aria-label={BRAND.name}
				>
					<YonderMark className="size-6" />
					<span className="font-display text-xl font-semibold text-foreground">
						{BRAND.name}
					</span>
				</Link>
				<div className="flex items-center gap-2">
					<InboxBell />
					<AccountMenu viewer={viewer} />
				</div>
			</header>
			<main className="mx-auto grid max-w-[1200px] grid-cols-1 gap-10 px-4 pt-4 pb-16 sm:px-8 sm:pt-6">
				<div className="flex flex-wrap items-center justify-between gap-4">
					<h1 className="font-display text-[26px] leading-8 font-semibold tracking-[-0.02em] sm:text-[32px] sm:leading-[38px]">
						{hello}, {viewer.firstName || viewer.name}
					</h1>
					{all.length ? <NewTripDialog /> : null}
				</div>
				{trips.isPending ? (
					<div className="grid gap-10">
						<Skeleton className="h-[280px] rounded-2xl" />
						<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
							<Skeleton className="aspect-[4/3] rounded-xl" />
							<Skeleton className="hidden aspect-[4/3] rounded-xl sm:block" />
						</div>
					</div>
				) : all.length === 0 ? (
					<>
						<SharedWaiting />
						<EmptyState
							line="Your next trip starts here."
							action={
								<NewTripDialog
									trigger={
										<Button size="lg" data-testid={TESTID.newTripButton}>
											<Plus /> Create your first trip
										</Button>
									}
								/>
							}
							className="py-24"
						/>
					</>
				) : (
					<>
						{next ? (
							<Hero
								trip={next}
								today={today}
								offline={saved.has(next.id)}
								menu={menuFor(next)}
							/>
						) : null}
						<SharedWaiting />
						<Deadlines />
						{mine.length ? (
							<section>
								<Overline>Your trips</Overline>
								<Grid>
									{mine.map((t) => (
										<TripCard
											key={t.id}
											trip={t}
											offline={saved.has(t.id)}
											menu={menuFor(t)}
										/>
									))}
								</Grid>
							</section>
						) : null}
						{shared.length ? (
							<section>
								<Overline>Shared with you</Overline>
								<Grid>
									{shared.map((t) => (
										<TripCard
											key={t.id}
											trip={t}
											shared
											offline={saved.has(t.id)}
											menu={menuFor(t)}
										/>
									))}
								</Grid>
							</section>
						) : null}
						{past.length ? (
							<section>
								<Overline>Past</Overline>
								<ul className="grid gap-2">
									{past.map((t) => (
										<li
											key={t.id}
											className="relative flex h-16 items-center gap-3 rounded-xl border pr-2 pl-4 text-muted-foreground transition-colors hover:border-foreground/20"
										>
											<Link
												to="/t/$trip"
												params={{ trip: t.slug }}
												data-testid={TESTID.tripCard}
												className="min-w-0 flex-1 truncate font-medium after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none"
											>
												{t.name}
											</Link>
											<span className="flex shrink-0 items-center gap-3 text-[13px]">
												<Flags
													codes={t.countryCodes}
													className="hidden sm:flex"
												/>
												{datesText(t)}
											</span>
											<span className="relative z-10 flex size-7 shrink-0 items-center justify-center">
												{menuFor(t)}
											</span>
										</li>
									))}
								</ul>
							</section>
						) : null}
					</>
				)}
			</main>
			<ProfileDialog />
			{dup ? (
				<DuplicateTripDialog
					trip={dup}
					open={!!dup}
					onOpenChange={(v) => !v && setDup(null)}
				/>
			) : null}
			<AlertDialog
				open={!!leaving}
				onOpenChange={(v) => !v && setLeaving(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Leave “{leaving?.name}”?</AlertDialogTitle>
						<AlertDialogDescription>
							It disappears from your trips. Your tags and notes stay, marked as
							a former member. Someone on the trip can add you again.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => leaving && leave.mutate(leaving)}
							className="bg-destructive text-white hover:bg-destructive/90"
						>
							Leave trip
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

function Grid({ children }: { children: React.ReactNode }) {
	return (
		<div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
			{children}
		</div>
	);
}
