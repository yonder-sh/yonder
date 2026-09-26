/**
 * The inspector's Media tab (SPEC §12.5 `MediaPanel({ target })`, §8.4,
 * DESIGN §4.4):
 * - a node: "Everything inside Tokyo" by default, or "Only Tokyo";
 * - a located item (the inspector passes its node): the node's bundle with a
 *   "This visit only" switch that moves to the item's own bundle;
 * - a day: "This day", or "Everything that day" (every item and leg of it);
 * - the trip: everything, or only the trip's own;
 * - a leg or an unlocated item: its own bundle.
 * Uploads, links and drops attach to what's shown ("…to this visit").
 */
import { useMemo, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { offersRollupChoice } from "@/features/shell/bundle-target";
import { defaultLens } from "@/lib/engine/lens";
import type { RollupOptions } from "@/lib/engine/rollup";
import {
	bool,
	oneOf,
	useFollowState,
	useFollowValue,
} from "@/lib/realtime/view-ui";
import type { BundleTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	AddMediaButton,
	DropOverlay,
	FilterChips,
} from "./components/controls";
import { MediaGallery } from "./components/media-gallery";
import { buildGroups } from "./gallery-groups";
import { dropLabel } from "./labels";
import { filterOf, MEDIA_FILTERS, type MediaFilter } from "./media-kinds";
import { useDocOfflineSync } from "./offline/MediaOfflineSync";
import { sameTarget, useTripMedia } from "./queries";
import { MEDIA_TESTID } from "./testids";
import { useAttachDrop } from "./use-attach-drop";
import { useMediaActions } from "./use-media-actions";
import { useMediaSurface, useWindowDropGuard } from "./use-media-surface";

type Scope = "all" | "own";
const isScope = oneOf<Scope>(["all", "own"]);
const isFilter = oneOf<MediaFilter | "all">([...MEDIA_FILTERS, "all"]);

export function MediaPanel({ target }: { target: BundleTarget }) {
	const ws = useWorkspace();
	const { ix, sel, schedule, graph } = ws;
	const { data } = useTripMedia();
	const actions = useMediaActions(graph.trip.id);
	useDocOfflineSync();
	useWindowDropGuard();
	// FB-21d: the inspector's media scope and filter travel with my view.
	const [scope, setScope] = useFollowState<Scope>(
		"media.scope",
		target.kind === "node" || target.kind === "trip" ? "all" : "own",
		isScope,
	);
	const [visitOnly, setVisitOnly] = useFollowState("media.visit", false, bool);
	const [filter, setFilter] = useState<MediaFilter | null>(null);
	useFollowValue(
		"media.filter",
		filter ?? "all",
		(v) => setFilter(v === "all" ? null : v),
		isFilter,
	);

	// A located item selected in the Plan: the inspector hands us its node.
	const visitItemId =
		sel?.kind === "item" &&
		target.kind === "node" &&
		ix.item(sel.id)?.nodeId === target.nodeId
			? sel.id
			: null;
	const effective: BundleTarget =
		visitOnly && visitItemId ? { kind: "item", itemId: visitItemId } : target;
	const day = target.kind === "day" ? ix.day(target.dayId) : undefined;

	const opts = useMemo<RollupOptions | null>(() => {
		if (effective.kind === "node" && scope === "all")
			return {
				scopeId: effective.nodeId,
				lens: defaultLens(ix, effective.nodeId),
				includeDescendants: true,
			};
		if (effective.kind === "trip" && scope === "all")
			return {
				scopeId: null,
				lens: defaultLens(ix, null),
				includeDescendants: true,
			};
		if (effective.kind === "day" && scope === "all" && day)
			return {
				scopeId: null,
				lens: defaultLens(ix, null),
				includeDescendants: true,
				dayRange: { from: day.date, to: day.date },
			};
		return null;
	}, [effective, scope, ix, day]);

	const inView = useMemo(() => {
		if (!opts) return data.filter((d) => sameTarget(d.target, effective));
		const ids = new Set(
			buildGroups(ix, schedule, data, opts, opts.scopeId).flatMap((g) =>
				g.tiles.map((t) => t.item.id),
			),
		);
		return data.filter((d) => ids.has(d.id));
	}, [data, opts, effective, ix, schedule]);
	const available = useMemo(
		() => new Set<MediaFilter>(inView.map((d) => filterOf(d.kind))),
		[inView],
	);
	const shown = filter
		? inView.filter((d) => filterOf(d.kind) === filter)
		: inView;

	const surface = useMediaSurface(effective);
	const drop = useAttachDrop(effective, { label: surface.label });
	const uploads = surface.uploads.filter((u) =>
		sameTarget(u.target, effective),
	);

	const name =
		target.kind === "node"
			? (ix.node(target.nodeId)?.name ?? "this place")
			: target.kind === "trip"
				? "the trip"
				: null;
	const toggle =
		target.kind === "day" ? (
			<ToggleGroup
				type="single"
				size="sm"
				variant="outline"
				value={scope}
				onValueChange={(v) => v && setScope(v as Scope)}
				className="h-7"
				aria-label="What to include"
				data-testid={MEDIA_TESTID.scopeToggle}
			>
				<ToggleGroupItem value="own" className="h-7 px-2.5 text-xs">
					This day
				</ToggleGroupItem>
				<ToggleGroupItem value="all" className="h-7 px-2.5 text-xs">
					Everything that day
				</ToggleGroupItem>
			</ToggleGroup>
		) : name &&
			// FB-12: a node with no children has nothing to choose between.
			offersRollupChoice(ix, target) &&
			!(visitOnly && visitItemId) ? (
			<ToggleGroup
				type="single"
				size="sm"
				variant="outline"
				value={scope}
				onValueChange={(v) => v && setScope(v as Scope)}
				className="h-7"
				aria-label="What to include"
				data-testid={MEDIA_TESTID.scopeToggle}
			>
				<ToggleGroupItem value="all" className="h-7 px-2.5 text-xs">
					{target.kind === "trip" ? "Everything" : "Everything inside"}
				</ToggleGroupItem>
				<ToggleGroupItem value="own" className="h-7 max-w-40 px-2.5 text-xs">
					<span className="truncate">Only {name}</span>
				</ToggleGroupItem>
			</ToggleGroup>
		) : null;

	return (
		<div
			{...drop.rootProps}
			data-testid={TESTID.mediaPanel}
			className="relative -mx-1 min-h-40 px-1"
		>
			<div className="mb-2 flex flex-wrap items-center gap-2">
				{toggle}
				{visitItemId ? (
					<span className="flex items-center gap-2 text-xs text-muted-foreground">
						<Switch
							id="media-visit-only"
							checked={visitOnly}
							onCheckedChange={setVisitOnly}
						/>
						<label htmlFor="media-visit-only">This visit only</label>
					</span>
				) : null}
				<span className="ml-auto">
					<AddMediaButton
						compact
						onFiles={surface.uploadFiles}
						onLink={surface.addUrl}
					/>
				</span>
			</div>
			<FilterChips
				value={filter}
				onChange={setFilter}
				available={available}
				className="mb-2"
			/>
			{inView.length === 0 && uploads.length === 0 ? (
				<p
					data-testid={MEDIA_TESTID.empty}
					className="py-8 text-center font-display text-[15px] leading-6 font-medium text-muted-foreground"
				>
					No photos, videos, PDFs or links{" "}
					{visitOnly && visitItemId
						? "on this visit"
						: name
							? `in ${name}`
							: "here"}{" "}
					yet.
				</p>
			) : (
				<MediaGallery
					compact
					items={shown}
					rollupOptions={opts}
					uploads={uploads}
					actions={actions}
					headers="never"
				/>
			)}
			{drop.isOver ? (
				<DropOverlay
					label={dropLabel(ix, effective, visitOnly && !!visitItemId)}
				/>
			) : null}
		</div>
	);
}
