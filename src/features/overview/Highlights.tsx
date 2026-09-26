/**
 * docs/OVERVIEW.md §6 "Highlights mosaic": the group's top-rated places with
 * a photo, up to six (after the trip: the most-photographed first, as a
 * collage). Without photos it falls back to the group's favourites by score.
 * A tile opens the place (selected in the Plan).
 */
import { cn } from "cn";
import { ThumbhashImage } from "@/components/common/thumbhash-image";
import type { MediaDto } from "@/features/media/media.functions";
import { ScoreChip } from "@/features/places/tab/ui";
import { mediaUrl } from "@/lib/media-url";
import { copyAnchorId } from "@/lib/realtime/cursor-protocol";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	favourites,
	type HighlightCandidate,
	pickHighlights,
} from "./lib/highlights";
import { OVERVIEW_TESTID } from "./testids";

export function Highlights({
	candidates,
	covers,
	after,
	className,
}: {
	candidates: HighlightCandidate[];
	covers: Map<string, MediaDto>;
	after: boolean;
	className?: string;
}) {
	const { nav } = useWorkspace();
	const tiles = pickHighlights(candidates, { after });
	const favs = favourites(candidates, after || !tiles.length ? 3 : 0);
	if (!tiles.length && !favs.length) return null;
	return (
		<section
			data-testid={OVERVIEW_TESTID.highlights}
			data-cursor-anchor="sec:ov.highlights"
			className={cn("flex min-w-0 flex-col gap-3", className)}
		>
			<h2 className="font-display text-[22px] font-semibold">
				{after && tiles.length ? "The trip in pictures" : "Highlights"}
			</h2>
			{tiles.length ? (
				<div
					className={cn(
						"grid gap-1.5 overflow-hidden rounded-2xl",
						after
							? "grid-cols-3 auto-rows-[92px] sm:auto-rows-[120px]"
							: "grid-cols-2",
					)}
				>
					{tiles.map((h, i) => {
						const cover = covers.get(h.id);
						const big = after && i === 0 && tiles.length >= 4;
						return (
							<button
								key={h.id}
								type="button"
								data-testid={OVERVIEW_TESTID.highlight}
								data-cursor-anchor={`place:${h.id}`}
								onClick={() => nav.select({ kind: "node", id: h.id })}
								className={cn(
									"group relative block min-w-0 overflow-hidden bg-muted text-left",
									after ? "" : "aspect-[4/3] rounded-xl",
									big && "col-span-2 row-span-2",
								)}
							>
								{cover ? (
									<ThumbhashImage
										hash={cover.thumbhash}
										src={mediaUrl(cover.id, big ? "display" : "thumb")}
										alt={h.name}
										className="absolute inset-0 size-full transition-transform duration-300 group-hover:scale-[1.03]"
									/>
								) : null}
								<span className="absolute inset-x-0 bottom-0 truncate bg-linear-to-b from-transparent to-black/75 px-2.5 pt-5 pb-2 text-xs font-semibold text-white">
									{h.name}
								</span>
							</button>
						);
					})}
				</div>
			) : null}
			{favs.length ? (
				<div data-testid={OVERVIEW_TESTID.favourites}>
					<h3 className="mb-2 text-[11px] font-semibold tracking-[.08em] text-muted-foreground uppercase">
						The group's favourites
					</h3>
					<ol className="flex flex-col">
						{favs.map((f, i) => (
							<li key={f.id}>
								<button
									type="button"
									// A second drawing of a place the tiles may show too.
									data-cursor-anchor={copyAnchorId(`place:${f.id}`, "fav")}
									onClick={() => nav.select({ kind: "node", id: f.id })}
									className="flex w-full min-w-0 items-center gap-3 rounded-md px-1 py-1.5 text-left text-[15px] hover:bg-accent/60"
								>
									<span className="w-4 font-mono text-sm text-muted-foreground tnum">
										{i + 1}
									</span>
									<span className="min-w-0 flex-1 truncate">{f.name}</span>
									<ScoreChip score={f.score} />
								</button>
							</li>
						))}
					</ol>
				</div>
			) : null}
		</section>
	);
}
