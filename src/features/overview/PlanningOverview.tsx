/**
 * The Overview while planning (One Yonder D01): a compact dark hero (the
 * phase, the name, the dates, who's here, the numbers; the globe on the
 * right), then what's next for you, the group's favourites and where things
 * stand. The page (OverviewTab) puts the route strip under the hero and
 * what's coming up beside the rest.
 */
import { ArrowRight, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { MemberAvatar } from "@/components/common/member";
import { ThumbhashImage } from "@/components/common/thumbhash-image";
import { RatingPill } from "@/components/kit";
import { Button } from "@/components/ui/button";
import type { MediaDto } from "@/features/media/media.functions";
import { CoverPlaceholder } from "@/features/places/tab/PlacesBoard";
import { mediaUrl } from "@/lib/media-url";
import { usePeers } from "@/lib/realtime/presence";
import { cn } from "@/lib/utils";
import { ratingOf } from "@/lib/workspace/filter-match";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import type { HighlightCandidate } from "./lib/highlights";
import { favourites } from "./lib/highlights";
import type { Standing, StandingKey } from "./lib/standing";
import { dateLine, PhaseChip, Stats, Title } from "./PhaseHeader";
import { ShareButton } from "./share/ShareButton";
import { OVERVIEW_TESTID } from "./testids";
import type { OverviewData } from "./use-overview";
import { useStandingNav } from "./WhereThingsStand";

export function PlanningHero({
	data,
	globe,
	firstDate,
	lastDate,
}: {
	data: OverviewData;
	/** The globe, sized to fill its box. */
	globe: ReactNode;
	firstDate: string | null;
	lastDate: string | null;
}) {
	const { graph } = useWorkspace();
	return (
		<div className="dark relative h-[360px] overflow-hidden bg-(--basemap-space) text-white">
			<div className="absolute inset-y-0 right-0 w-[46%]">{globe}</div>
			<span
				aria-hidden
				className="pointer-events-none absolute inset-y-0 right-[calc(46%-10rem)] w-40 bg-linear-to-r from-(--basemap-space) to-transparent"
			/>
			<div className="absolute top-6 right-6 z-[2]">
				<ShareButton variant="toolbar" slug={graph.trip.slug} />
			</div>
			<div
				data-testid={OVERVIEW_TESTID.header}
				data-phase={data.phase.kind}
				data-cursor-anchor="sec:ov.head"
				className="pointer-events-none relative z-[2] flex h-full max-w-[60%] flex-col justify-end gap-3 px-6 pb-10 [&_a,&_button]:pointer-events-auto"
			>
				<PhaseChip phase={data.phase} lastDate={lastDate} />
				<Title size="band">{graph.trip.name}</Title>
				<p className="text-lg text-white/70">{dateLine(firstDate, lastDate)}</p>
				<HereNow />
				<Stats data={data} cols={3} after={false} row />
			</div>
		</div>
	);
}

const firstNameOf = (name: string) => name.split(/\s+/)[0] ?? name;

/** The members, the ones here now marked, and "Audrey and Maya are here now". */
function HereNow() {
	const { graph, access } = useWorkspace();
	const peers = usePeers();
	const here = new Set(
		peers.map((p) => p.user.memberId).filter((id): id is string => !!id),
	);
	const members = graph.members.filter(
		(m) => m.status === "active" || m.status === "invited",
	);
	if (members.length < 2) return null;
	const names = graph.members
		.filter((m) => here.has(m.id) && m.id !== access.memberId)
		.map((m) => m.firstName ?? firstNameOf(m.name));
	const line =
		names.length === 0
			? null
			: names.length === 1
				? `${names[0]} is here now`
				: `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are here now`;
	return (
		<div className="flex items-center gap-2.5">
			<span className="flex items-center gap-1">
				{members.slice(0, 6).map((m) => (
					<span
						key={m.id}
						className={cn(
							"relative",
							!here.has(m.id) && m.id !== access.memberId && "opacity-60",
						)}
					>
						<MemberAvatar memberId={m.id} size={28} />
					</span>
				))}
			</span>
			{line ? <span className="text-sm text-white/70">{line}</span> : null}
		</div>
	);
}

const NEXT_TITLE: Record<StandingKey, (s: Standing) => string> = {
	places: () => "Add the places you'd like to see",
	rating: (s) =>
		s.myLeft
			? `Rate the ${s.myLeft} ${s.myLeft === 1 ? "place" : "places"} you haven't yet`
			: "Get everyone's ratings in",
	cities: () => "Decide how long you stay in each city",
	days: () => "Put your favourites on days",
	stays: () => "Add where you sleep",
};

/** D01's "Next for you": the first open step with its action, and what comes after it. */
export function NextForYou({ standing }: { standing: Standing }) {
	const { open, action } = useStandingNav(standing);
	const [later, setLater] = useState<ReadonlySet<StandingKey>>(new Set());
	const todo = standing.lines.filter((l) => !l.done);
	const line = todo.find((l) => !later.has(l.key)) ?? null;
	if (!line) return null;
	const act = action(line.key) ?? { label: "Open", run: open[line.key] };
	const after = todo.filter((l) => l.key !== line.key).slice(0, 3);
	const detail = line.detail.charAt(0).toUpperCase() + line.detail.slice(1);
	return (
		<section
			data-testid={OVERVIEW_TESTID.next}
			data-key={line.key}
			data-cursor-anchor="sec:ov.next"
			aria-label="Next for you"
			className="flex flex-wrap gap-5 rounded-2xl border bg-card px-5 py-4"
		>
			<div className="flex min-w-60 flex-1 flex-col gap-2">
				<span className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
					<span aria-hidden className="size-2 rounded-full bg-glow" />
					Next for you
				</span>
				<h2 className="font-display text-xl leading-7 font-semibold">
					{NEXT_TITLE[line.key](standing)}
				</h2>
				<p className="text-sm text-muted-foreground">{detail}</p>
				<div className="flex flex-wrap gap-2 pt-1.5">
					<Button onClick={act.run} data-testid={OVERVIEW_TESTID.nextAction}>
						{act.label}
						<ArrowRight />
					</Button>
					{todo.length > 1 ? (
						<Button
							variant="ghost"
							onClick={() => setLater((s) => new Set([...s, line.key]))}
						>
							Not now
						</Button>
					) : null}
				</div>
			</div>
			{after.length ? (
				<div className="flex w-56 flex-col gap-1.5 border-l pl-5 max-sm:w-full max-sm:border-t max-sm:border-l-0 max-sm:pt-3 max-sm:pl-0">
					<span className="text-xs font-semibold text-muted-foreground">
						After that
					</span>
					{after.map((l) => (
						<button
							key={l.key}
							type="button"
							onClick={open[l.key]}
							className="flex cursor-pointer items-start gap-1.5 rounded text-left text-meta hover:text-primary"
						>
							<ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
							{NEXT_TITLE[l.key](standing)}
						</button>
					))}
				</div>
			) : null}
		</section>
	);
}

/** D01's "The group's favourites": up to six, with a photo, where and the group's rating. */
export function Favourites({
	candidates,
	covers,
	total,
}: {
	candidates: HighlightCandidate[];
	covers: Map<string, MediaDto>;
	/** On the shortlist, for "See all N". */
	total: number;
}) {
	const { ix, nav } = useWorkspace();
	const top = favourites(candidates, 6);
	if (!top.length) return null;
	return (
		<section
			data-testid={OVERVIEW_TESTID.favourites}
			data-cursor-anchor="sec:ov.favourites"
			className="flex min-w-0 flex-col gap-2.5"
		>
			<div className="flex items-baseline gap-2">
				<h2 className="font-display text-lg font-semibold">
					The group's favourites
				</h2>
				<button
					type="button"
					onClick={() =>
						nav.openPlaces({
							scopeId: null,
							patch: { pv: "table", pst: "shortlist" },
						})
					}
					className="ml-auto cursor-pointer text-meta font-semibold text-primary hover:underline"
				>
					See all {Math.max(total, top.length)}
				</button>
			</div>
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
				{top.map((f) => {
					const cover = covers.get(f.id);
					const node = ix.node(f.id);
					// Its city, else where it's filed (Mt. Fuji).
					const city = node
						? (ix.hierarchy.nearestOfType(node.id, "city")?.name ??
							ix.node(node.parentId)?.name)
						: undefined;
					const rating = node ? ratingOf(node, "max") : null;
					return (
						<button
							key={f.id}
							type="button"
							data-testid={OVERVIEW_TESTID.highlight}
							data-cursor-anchor={`place:${f.id}`}
							onClick={() => nav.select({ kind: "node", id: f.id })}
							className="group relative aspect-[16/10] min-w-0 cursor-pointer overflow-hidden rounded-xl bg-muted text-left"
						>
							{cover ? (
								<ThumbhashImage
									hash={cover.thumbhash}
									src={mediaUrl(cover.id, "thumb")}
									alt=""
									className="absolute inset-0 size-full transition-transform duration-300 group-hover:scale-[1.03]"
								/>
							) : node ? (
								<CoverPlaceholder
									node={node}
									className="absolute inset-0 pb-8"
								/>
							) : null}
							{rating ? (
								<RatingPill
									level={rating}
									size="sm"
									className="absolute top-2 right-2"
								/>
							) : null}
							<span className="absolute inset-x-0 bottom-0 flex flex-col bg-linear-to-b from-transparent to-black/75 px-3 pt-6 pb-2.5 text-white">
								<span className="truncate text-sm font-semibold">{f.name}</span>
								{city ? (
									<span className="truncate text-xs text-white/80">{city}</span>
								) : null}
							</span>
						</button>
					);
				})}
			</div>
		</section>
	);
}
