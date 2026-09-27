/**
 * Everything saved in a place (or the trip), from the details' "See all"
 * (SPEC §12.5, DESIGN §7.2, ADDENDUM §9; the Media tab until One Yonder):
 * photos, videos, social posts, guide links and documents inside it, filtered
 * by `mf`, grouped by place with a masonry per group and zoom-in headers.
 * Drop files or paste a link anywhere to add to the place.
 */

import { useMemo } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { defaultLens } from "@/lib/engine/lens";
import type { RollupOptions } from "@/lib/engine/rollup";
import type { BundleTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	AddMediaButton,
	DropOverlay,
	FilterChips,
} from "./components/controls";
import { MediaGallery } from "./components/media-gallery";
import { buildGroups } from "./gallery-groups";
import { dropLabel } from "./labels";
import { FILTER_LABEL, filterOf, type MediaFilter } from "./media-kinds";
import { useDocOfflineSync } from "./offline/MediaOfflineSync";
import { useTripMedia } from "./queries";
import { MEDIA_TESTID } from "./testids";
import { useAttachDrop } from "./use-attach-drop";
import { useMediaActions } from "./use-media-actions";
import { useMediaFilter } from "./use-media-filter";
import {
	useMediaSurface,
	usePasteToAttach,
	useWindowDropGuard,
} from "./use-media-surface";

export function MediaAll({
	target,
	view = false,
}: {
	target: BundleTarget;
	/** The centre view (`tab=media`): the lens, days and "Only" of the URL. */
	view?: boolean;
}) {
	const ws = useWorkspace();
	const { graph, ix, model, schedule, lens, only, days } = ws;
	const { data, isLoading } = useTripMedia();
	const actions = useMediaActions(graph.trip.id);
	const [mf, setMf] = useMediaFilter();
	useDocOfflineSync();
	useWindowDropGuard();

	const scopeId = target.kind === "node" ? target.nodeId : null;
	const surface = useMediaSurface(target);
	const drop = useAttachDrop(target, { label: surface.label });
	usePasteToAttach(ws.mode === "live", surface.addUrl, surface.uploadFiles);

	const opts = useMemo<RollupOptions>(
		() =>
			view
				? {
						scopeId,
						lens,
						includeDescendants: !only,
						dayRange: days,
						model,
					}
				: {
						scopeId,
						lens: defaultLens(ix, scopeId),
						includeDescendants: true,
						model,
					},
		[view, scopeId, ix, model, lens, only, days],
	);
	// What the rollup shows before the kind filter (for the chips and the empty state).
	const inView = useMemo(() => {
		const ids = new Set(
			buildGroups(ix, schedule, data, opts, opts.scopeId).flatMap((g) =>
				g.tiles.map((t) => t.item.id),
			),
		);
		return data.filter((d) => ids.has(d.id));
	}, [ix, schedule, data, opts]);
	const available = useMemo(
		() => new Set<MediaFilter>(inView.map((d) => filterOf(d.kind))),
		[inView],
	);
	const shown = useMemo(
		() => (mf ? inView.filter((d) => filterOf(d.kind) === mf) : inView),
		[inView, mf],
	);
	const uploads = surface.uploads.filter((u) => u.tripId === graph.trip.id);
	const where = (scopeId ? ix.node(scopeId)?.name : null) ?? graph.trip.name;

	return (
		<div
			{...drop.rootProps}
			data-testid={TESTID.mediaTab}
			className="@container relative flex min-h-full flex-col"
		>
			<div className="flex min-h-11 items-start gap-2 px-4 py-2">
				<FilterChips
					value={mf}
					onChange={setMf}
					available={available}
					className="min-h-7 flex-1"
				/>
				<span className="hidden self-center text-xs text-muted-foreground @min-[760px]:inline">
					Drop files or paste a link anywhere
				</span>
				<AddMediaButton onFiles={surface.uploadFiles} onLink={surface.addUrl} />
			</div>
			{isLoading ? (
				<div className="grid grid-cols-2 gap-2 px-4 pt-2 @min-[640px]:grid-cols-3">
					{[0, 1, 2, 3].map((i) => (
						<Skeleton
							key={i}
							className={cn("rounded-lg", i % 2 ? "h-44" : "h-32")}
						/>
					))}
				</div>
			) : inView.length === 0 && uploads.length === 0 ? (
				<div data-testid={MEDIA_TESTID.empty} className="flex flex-1 flex-col">
					<EmptyState
						line={`No photos, videos, PDFs or links in ${where} yet.`}
						action={
							<AddMediaButton
								onFiles={surface.uploadFiles}
								onLink={surface.addUrl}
							/>
						}
					/>
				</div>
			) : shown.length === 0 && uploads.length === 0 ? (
				<EmptyState
					line={`No ${FILTER_LABEL[mf ?? "photos"].toLowerCase()} in ${where}.`}
					action={
						<button
							type="button"
							onClick={() => setMf(null)}
							className="text-sm font-medium text-primary underline-offset-4 hover:underline"
						>
							Show everything
						</button>
					}
				/>
			) : (
				<MediaGallery
					items={shown}
					rollupOptions={opts}
					uploads={uploads}
					actions={actions}
					className="pb-6"
				/>
			)}
			{drop.isOver ? <DropOverlay label={dropLabel(ix, target)} /> : null}
		</div>
	);
}
