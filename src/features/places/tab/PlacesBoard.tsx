/**
 * The Places board (docs/PLACES.md §1): cards with a cover (the first photo,
 * or a category-toned placeholder), name, area, category, group score, who
 * rated what, when and time needed. The same groups, sort and filters as
 * the table; the same row keys on a focused card.
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { Film, ImageIcon } from "lucide-react";
import { type CSSProperties, useMemo } from "react";
import { CategoryIcon } from "@/components/common/glyphs";
import { MemberAvatar } from "@/components/common/member";
import { ThumbhashImage } from "@/components/common/thumbhash-image";
import type { MediaDto } from "@/features/media/media.functions";
import { tripMediaQuery } from "@/features/media/queries";
import { PIN_FAMILIES, PLACE_CATEGORIES } from "@/lib/domain/taxonomy";
import { formatDuration } from "@/lib/format";
import { mediaUrl } from "@/lib/media-url";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { ratingsCount } from "../lib/rate";
import { rowReason } from "./bar";
import type { PlaceRow } from "./model";
import { categoryLabel, ownsKeys, useRowKeys } from "./PlacesTable";
import { PLACES_TAB_TESTID } from "./testids";
import { RatingDot, ScoreChip, SplitMark, StatusChip } from "./ui";
import { type PlacesData, useSplitAreas } from "./use-places";

/** Each place's cover: its first ready photo (or video poster), by position. */
export function useCovers(): Map<string, MediaDto> {
	const { graph, ix, mode } = useWorkspace();
	const media = useQuery({
		...tripMediaQuery(graph.trip.id),
		enabled: mode === "live",
	}).data;
	return useMemo(() => {
		const out = new Map<string, MediaDto>();
		for (const m of media ?? []) {
			if (m.status !== "ready" || !m.hasThumb) continue;
			if (m.kind !== "photo" && m.kind !== "video") continue;
			const t = m.target;
			const owner =
				t.kind === "node"
					? t.nodeId
					: t.kind === "item"
						? ix.item(t.itemId)?.nodeId
						: undefined;
			if (!owner) continue;
			const have = out.get(owner);
			if (!have || m.position < have.position) out.set(owner, m);
		}
		return out;
	}, [media, ix]);
}

/** A category-toned cover when a place has no photo. */
export function CoverPlaceholder({
	row,
	className,
}: {
	row: PlaceRow;
	className?: string;
}) {
	const cat = row.node.type === "place" ? (row.node.category ?? "other") : null;
	const hex = cat ? PIN_FAMILIES[PLACE_CATEGORIES[cat].family].hex : "#7c6b5d";
	return (
		<div
			aria-hidden="true"
			className={cn(
				"grid place-items-center bg-(--tone)/15 text-(--tone) dark:bg-(--tone)/25",
				className,
			)}
			style={{ "--tone": hex } as CSSProperties}
		>
			{cat ? (
				<CategoryIcon category={cat} className="size-7 opacity-70" />
			) : (
				<ImageIcon className="size-7 opacity-50" strokeWidth={1.5} />
			)}
		</div>
	);
}

function Card({
	row,
	cover,
	data,
	onKey,
}: {
	row: PlaceRow;
	cover: MediaDto | undefined;
	data: PlacesData;
	onKey: ReturnType<typeof useRowKeys>;
}) {
	const { sel, nav, access } = useWorkspace();
	const selected = sel?.kind === "node" && sel.id === row.id;
	const rated = data.allRaters.filter((m) => row.node.priorities[m.id]);
	return (
		<button
			type="button"
			data-testid={PLACES_TAB_TESTID.card}
			data-row-id={row.id}
			data-status={row.status}
			aria-pressed={selected}
			onClick={() => nav.select({ kind: "node", id: row.id })}
			onKeyDown={(e) => {
				if (ownsKeys(e.target)) return;
				if (e.key === "Enter" || e.key === " ") return;
				if (onKey(e, row)) e.preventDefault();
			}}
			className={cn(
				"group flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-card text-left transition-shadow outline-none hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring",
				selected && "ring-2 ring-primary ring-offset-1 ring-offset-background",
			)}
		>
			<div className="relative h-28 w-full shrink-0 overflow-hidden">
				{cover ? (
					<ThumbhashImage
						hash={cover.thumbhash}
						src={mediaUrl(cover.id, "thumb")}
						alt=""
						className="absolute inset-0 size-full"
					/>
				) : (
					<CoverPlaceholder row={row} className="absolute inset-0" />
				)}
				<span className="absolute bottom-2 left-2">
					<StatusChip
						info={row.info}
						reason={rowReason(row, data.bar)}
						className="shadow-sm"
					/>
				</span>
				{row.media ? (
					<span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-md bg-background/85 px-1.5 py-0.5 font-mono text-[11px] tnum text-foreground">
						{cover?.kind === "video" ? <Film className="size-3" /> : null}
						{row.media} media
					</span>
				) : null}
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5 p-3">
				<div className="flex items-start gap-2">
					<span className="min-w-0 flex-1 text-[15px] leading-tight font-semibold">
						{row.name}
					</span>
					{row.split ? <SplitMark /> : null}
				</div>
				<span className="truncate text-xs text-muted-foreground">
					{[row.where, categoryLabel(row)].filter(Boolean).join(" · ")}
				</span>
				<div className="flex min-w-0 items-center gap-2">
					<ScoreChip score={row.score} />
					{rated.length ? (
						<span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
							{rated.map((m) => {
								const p = row.node.priorities[m.id];
								return p ? (
									<span
										key={m.id}
										className={cn(
											"inline-flex shrink-0 items-center gap-0.5",
											!ratingsCount(m) && "opacity-50",
										)}
										title={`${m.id === access.memberId ? "You" : m.name}: ${p}${ratingsCount(m) ? "" : " (not counted)"}`}
									>
										<MemberAvatar memberId={m.id} size={16} ring={false} />
										<RatingDot priority={p} />
									</span>
								) : null;
							})}
						</span>
					) : (
						<span className="text-xs text-muted-foreground">Not rated</span>
					)}
				</div>
				<span className="mt-auto truncate text-xs text-muted-foreground">
					{row.when}
					{" · "}
					<span className="font-mono tnum">
						{row.timeMin === null ? "not set" : formatDuration(row.timeMin)}
					</span>
				</span>
			</div>
		</button>
	);
}

export function PlacesBoard({ data }: { data: PlacesData }) {
	const covers = useCovers();
	const onKey = useRowKeys(data.threshold);
	const [, toggleSplit] = useSplitAreas();
	const grid = (rows: PlaceRow[]) => (
		<div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
			{rows.map((r) => (
				<Card
					key={r.id}
					row={r}
					cover={covers.get(r.id)}
					data={data}
					onKey={onKey}
				/>
			))}
		</div>
	);
	return (
		<div
			className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-8"
			data-testid={PLACES_TAB_TESTID.board}
		>
			{data.groups.map((g) => (
				<section key={g.key} className="mb-6" data-group={g.key}>
					{data.state.group === "none" ? null : (
						<header
							className="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1"
							data-testid={PLACES_TAB_TESTID.groupHeader}
						>
							<h3 className="font-display text-lg font-semibold">{g.label}</h3>
							{g.note ? (
								<span className="text-xs text-muted-foreground">
									· {g.note}
								</span>
							) : null}
							<span className="text-xs text-muted-foreground">
								{g.summary.count} {g.summary.count === 1 ? "place" : "places"}
								{g.summary.musts ? ` · ${g.summary.musts} must` : ""} ·{" "}
								{g.summary.scheduled} scheduled
							</span>
							{g.canSplit && g.node ? (
								<button
									type="button"
									data-testid={PLACES_TAB_TESTID.splitToggle}
									onClick={() => toggleSplit(g.node?.id ?? "")}
									className="inline-flex h-6 cursor-pointer items-center rounded-md border bg-background px-2 text-xs font-medium text-primary hover:bg-accent"
								>
									{g.split ? "Merge areas" : "Split by area"}
								</button>
							) : null}
						</header>
					)}
					{g.subgroups
						? g.subgroups.map((s) => (
								<div
									key={s.key}
									className="mb-4"
									data-testid={PLACES_TAB_TESTID.subgroup}
								>
									<h4 className="mb-2 text-sm font-semibold">
										{s.label}{" "}
										<span className="font-normal text-muted-foreground">
											· {s.rows.length}
										</span>
									</h4>
									{grid(s.rows)}
								</div>
							))
						: grid(g.rows)}
				</section>
			))}
		</div>
	);
}
