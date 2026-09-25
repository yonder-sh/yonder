/**
 * The Review step's header (docs/PLACES.md §1; the flow, owner 2026-09-25):
 * the view switch (Table · Board · Map), Group by,
 * Sort, search and the shared filter; under it the status pills (All ·
 * Shortlist · Ideas · Scheduled · Dropped · Talk about it) and per-member
 * rating progress ("Audrey 42/78 · rate her unrated"). Everything but the
 * search lives in the URL and is shared by every view. Rate and Schedule
 * are the tab's steps (`PlacesSteps`); "Add a place" and wide mode sit on
 * the steps' bar.
 */
import { cn } from "cn";
import {
	Columns3,
	LayoutGrid,
	Map as MapIcon,
	Plus,
	Search,
	Settings2,
	Sheet,
} from "lucide-react";
import type { ReactNode } from "react";
import { MemberAvatar } from "@/components/common/member";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PlaceFilterButton } from "@/features/outline/FilterMenu";
import { updateTrip } from "@/functions/trips.functions";
import { can } from "@/lib/auth/roles";
import type { TripGraph } from "@/lib/engine/types";
import { tripKeys } from "@/lib/query/keys";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	isShortlistLevel,
	LEVEL_LABEL,
	SHORTLIST_LEVELS,
	type ShortlistBar,
	type ShortlistLevel,
} from "./bar";
import { unratedFilter } from "./entry";
import type { ReviewView } from "./flow";
import {
	GROUP_BYS,
	GROUP_LABEL,
	type GroupBy,
	SORT_BYS,
	SORT_LABEL,
	type SortBy,
} from "./grouping";
import type { PlaceStatus } from "./lifecycle";
import { PersonMenu, personName, RemindButton } from "./RatingPeople";
import { RATING_TESTID } from "./rating-testids";
import { formatScore } from "./score";
import { PLACES_TAB_TESTID } from "./testids";
import type { PlacesData } from "./use-places";

const VIEWS: { v: ReviewView; label: string; icon: typeof Sheet }[] = [
	{ v: "table", label: "Table", icon: Sheet },
	{ v: "board", label: "Board", icon: LayoutGrid },
	{ v: "map", label: "Map", icon: MapIcon },
];

/** "Add a place": the existing add flow (search, links, paste). */
export function AddPlaceButton({
	className,
	label = "Add a place",
	iconOnly = false,
}: {
	className?: string;
	label?: string;
	/** A narrow bar: the plus alone (the label becomes its name). */
	iconOnly?: boolean;
}) {
	const { access } = useWorkspace();
	const openAddPlace = useUi((s) => s.openAddPlace);
	return (
		<Button
			size={iconOnly ? "icon" : "sm"}
			className={cn(iconOnly ? "size-8" : "h-8", className)}
			data-testid={PLACES_TAB_TESTID.addPlace}
			onClick={() => openAddPlace({ mode: "search" })}
			disabled={!access.canEdit}
			aria-label={iconOnly ? label : undefined}
			title={
				access.canEdit
					? iconOnly
						? label
						: undefined
					: (access.reason ?? undefined)
			}
		>
			<Plus />
			{iconOnly ? null : label}
		</Button>
	);
}

/**
 * "Rated: You 12/48 · Audrey 30/48 their unrated · Remind" (the Rate and
 * Review steps); someone left out reads "Maya · not counted". Owners and
 * editors leave someone out, or count them again, from their name.
 */
export function RatingProgress({ data }: { data: PlacesData }) {
	const { nav, access } = useWorkspace();
	const me = access.memberId;
	if (!data.progress.length) return null;
	return (
		<div
			className="flex min-w-0 items-center gap-3 overflow-x-auto text-xs whitespace-nowrap text-muted-foreground [scrollbar-width:none] md:ml-auto"
			data-testid={PLACES_TAB_TESTID.progress}
		>
			<span>Rated:</span>
			{data.progress.map((p) => {
				const mine = p.member.id === me;
				const behind = p.rated < p.total;
				const name = (
					<span className="text-foreground">{personName(p.member, me)}</span>
				);
				if (!p.counted)
					return (
						<span
							key={p.member.id}
							className="inline-flex items-center gap-1"
							data-testid={RATING_TESTID.person}
							data-member={p.member.id}
							data-counted="false"
							title={`${mine ? "Your" : `${personName(p.member, me)}'s`} ratings aren't counted`}
						>
							<MemberAvatar
								memberId={p.member.id}
								size={16}
								ring={false}
								className="opacity-60"
							/>
							<PersonMenu member={p.member}>{name}</PersonMenu>
							<span>· not counted</span>
						</span>
					);
				return (
					<span
						key={p.member.id}
						className="inline-flex items-center gap-1"
						data-member={p.member.id}
						data-testid={RATING_TESTID.person}
						data-counted="true"
					>
						<MemberAvatar memberId={p.member.id} size={16} ring={false} />
						<PersonMenu member={p.member}>{name}</PersonMenu>
						<span className="font-mono tnum">
							{p.rated}/{p.total}
						</span>
						{behind ? (
							<button
								type="button"
								className="cursor-pointer text-primary underline-offset-2 hover:underline"
								onClick={() =>
									nav.setPlaces({
										pv: "rate",
										pst: undefined,
										talk: undefined,
										f: unratedFilter(mine ? "me" : p.member.id),
									})
								}
							>
								{mine ? "rate yours" : "their unrated"}
							</button>
						) : null}
						<RemindButton member={p.member} left={p.total - p.rated} />
					</span>
				);
			})}
		</div>
	);
}

const PILLS: { k: PlaceStatus | null; label: string }[] = [
	{ k: null, label: "All" },
	{ k: "shortlist", label: "Shortlist" },
	{ k: "idea", label: "Ideas" },
	{ k: "scheduled", label: "Scheduled" },
	{ k: "dropped", label: "Dropped" },
];

function Pill({
	on,
	onClick,
	children,
	testid,
	value,
	title,
}: {
	on: boolean;
	onClick: () => void;
	children: ReactNode;
	testid: string;
	value?: string;
	title?: string;
}) {
	return (
		<button
			type="button"
			aria-pressed={on}
			data-testid={testid}
			data-value={value}
			title={title}
			onClick={onClick}
			className={cn(
				"inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
				on
					? "border-primary bg-primary text-primary-foreground"
					: "bg-background text-foreground hover:bg-accent",
			)}
		>
			{children}
		</button>
	);
}

/**
 * "Shortlist a place when the group averages: Want · Between Want and
 * Really want · Really want" (owners and editors), with what that means
 * for the group right now ("With 4 people rating, a place needs +6").
 */
function LevelControl({ bar }: { bar: ShortlistBar }) {
	const { graph, access } = useWorkspace();
	const tripId = graph.trip.id;
	const save = useTripMutation(
		(v: { tripId: string; settings: { shortlistLevel: ShortlistLevel } }) =>
			updateTrip({ data: v }),
		{
			keys: [tripKeys.graph(tripId)],
			optimistic: (qc, v) =>
				qc.setQueryData<TripGraph>(tripKeys.graph(tripId), (g) =>
					g
						? {
								...g,
								trip: {
									...g.trip,
									settings: { ...g.trip.settings, ...v.settings },
								},
							}
						: g,
				),
		},
	);
	const allowed =
		can(access, "tripSettings") && access.mode === "edit" && access.canEdit;
	const people = `${bar.people} ${bar.people === 1 ? "person" : "people"}`;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-7"
					aria-label="Places settings"
					data-testid={PLACES_TAB_TESTID.threshold}
				>
					<Settings2 className="size-4" strokeWidth={1.5} />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 text-sm">
				<p id="shortlist-level-label" className="font-medium">
					Shortlist a place when the group averages:
				</p>
				<RadioGroup
					value={String(bar.level)}
					onValueChange={(v) => {
						const level = Number(v);
						if (!isShortlistLevel(level) || level === bar.level) return;
						save.mutate({ tripId, settings: { shortlistLevel: level } });
					}}
					disabled={!allowed}
					aria-labelledby="shortlist-level-label"
					data-testid={RATING_TESTID.level}
					className="mt-2 gap-1.5"
				>
					{SHORTLIST_LEVELS.map((l) => (
						<Label
							key={l}
							className="flex cursor-pointer items-center gap-2 font-normal"
						>
							<RadioGroupItem
								value={String(l)}
								data-testid={RATING_TESTID.levelOption}
								data-value={l}
							/>
							{LEVEL_LABEL[`${l}`]}
						</Label>
					))}
				</RadioGroup>
				<p className="mt-3 text-xs text-muted-foreground">
					With {people} rating, a place needs{" "}
					<span className="font-mono text-foreground tnum">
						{formatScore(bar.bar)}
					</span>
					. Everyone who has rated at least half the places counts, so the
					shortlist grows with the group.
				</p>
				<p className="mt-1.5 text-xs text-muted-foreground">
					Ratings add up: Must +3, Really want +2, Want +1, Sure 0, Meh −1, Nah
					−2.
				</p>
				{allowed ? null : (
					<p className="mt-2 text-xs text-muted-foreground">
						Owners and editors change this.
					</p>
				)}
			</PopoverContent>
		</Popover>
	);
}

export function PlacesToolbar({
	data,
	q,
	onQ,
	compact,
}: {
	data: PlacesData;
	q: string;
	onQ: (q: string) => void;
	/** A narrow panel: labels shrink to icons. */
	compact: boolean;
}) {
	const { nav } = useWorkspace();
	const { state, counts, bar } = data;
	return (
		<div className="flex shrink-0 flex-col gap-2 border-b px-4 pt-3 pb-2.5">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<ToggleGroup
					type="single"
					size="sm"
					variant="outline"
					value={state.view}
					onValueChange={(v) => v && nav.setPlaces({ pv: v as ReviewView })}
					aria-label="View"
					data-testid={PLACES_TAB_TESTID.viewSwitch}
				>
					{VIEWS.map(({ v, label, icon: Icon }) => (
						<ToggleGroupItem
							key={v}
							value={v}
							aria-label={label}
							data-value={v}
							className="gap-1.5 px-2.5"
						>
							<Icon className="size-3.5" />
							<span className={compact ? "sr-only" : undefined}>{label}</span>
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				{state.view === "map" ? null : (
					<>
						<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
							<span className={compact ? "sr-only" : undefined}>Group</span>
							<Select
								value={state.group}
								onValueChange={(v) => nav.setPlaces({ pg: v as GroupBy })}
							>
								<SelectTrigger
									size="sm"
									className="h-8 min-w-24 gap-1 text-[13px]"
									data-testid={PLACES_TAB_TESTID.groupBy}
									aria-label="Group by"
								>
									<Columns3 className="size-3.5 text-muted-foreground" />
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{GROUP_BYS.map((g) => (
										<SelectItem key={g} value={g} data-value={g}>
											{GROUP_LABEL[g]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
							<span className={compact ? "sr-only" : undefined}>Sort</span>
							<Select
								value={state.sort}
								onValueChange={(v) => nav.setPlaces({ ps: v as SortBy })}
							>
								<SelectTrigger
									size="sm"
									className="h-8 min-w-24 text-[13px]"
									data-testid={PLACES_TAB_TESTID.sortBy}
									aria-label="Sort by"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{SORT_BYS.map((s) => (
										<SelectItem key={s} value={s} data-value={s}>
											{SORT_LABEL[s]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</>
				)}
				<div className="ml-auto flex items-center gap-1.5">
					<div className="relative">
						<Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={q}
							onChange={(e) => onQ(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape" && q) {
									e.stopPropagation();
									onQ("");
								}
							}}
							placeholder="Search places, notes"
							aria-label="Search places"
							data-testid={PLACES_TAB_TESTID.search}
							className={cn("h-8 pl-7 text-[13px]", compact ? "w-36" : "w-52")}
						/>
					</div>
					<PlaceFilterButton align="end" className="size-8" />
					<LevelControl bar={bar} />
				</div>
			</div>
			<div className="flex items-center gap-x-3 gap-y-2 max-md:flex-col max-md:items-stretch md:flex-wrap">
				<div className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0">
					{PILLS.map(({ k, label }) => (
						<Pill
							key={label}
							on={state.status === k}
							value={k ?? "all"}
							testid={PLACES_TAB_TESTID.statusPill}
							onClick={() => nav.setPlaces({ pst: k ?? undefined })}
						>
							{label}
							<span className="font-mono text-xs opacity-75 tnum">
								{k === null ? counts.all : counts[k]}
							</span>
						</Pill>
					))}
					<Pill
						on={state.talk}
						testid={PLACES_TAB_TESTID.talkPill}
						title="Split places: someone is keen, someone isn't"
						onClick={() => nav.setPlaces({ talk: state.talk ? undefined : 1 })}
					>
						Talk about it
						<span className="font-mono text-xs opacity-75 tnum">
							{counts.talk}
						</span>
					</Pill>
				</div>
				<RatingProgress data={data} />
			</div>
		</div>
	);
}
