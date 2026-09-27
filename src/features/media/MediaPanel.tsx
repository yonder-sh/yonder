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
 * `section` (the details pane): the target's own items, then "From places in
 * Japan · 20" with See all (the full panel in a dialog).
 */
import { useMemo, useState } from "react";
import { Segmented } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
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

export function MediaPanel({
	target,
	section = false,
}: {
	target: BundleTarget;
	/** The details pane's section: own items first, the rest behind See all. */
	section?: boolean;
}) {
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
	const [seeAll, setSeeAll] = useState(false);
	const viewScope: Scope = section ? "own" : scope;

	const opts = useMemo<RollupOptions | null>(() => {
		if (effective.kind === "node" && viewScope === "all")
			return {
				scopeId: effective.nodeId,
				lens: defaultLens(ix, effective.nodeId),
				includeDescendants: true,
			};
		if (effective.kind === "trip" && viewScope === "all")
			return {
				scopeId: null,
				lens: defaultLens(ix, null),
				includeDescendants: true,
			};
		if (effective.kind === "day" && viewScope === "all" && day)
			return {
				scopeId: null,
				lens: defaultLens(ix, null),
				includeDescendants: true,
				dayRange: { from: day.date, to: day.date },
			};
		return null;
	}, [effective, viewScope, ix, day]);

	const inView = useMemo(() => {
		if (!opts) return data.filter((d) => sameTarget(d.target, effective));
		const ids = new Set(
			buildGroups(ix, schedule, data, opts, opts.scopeId).flatMap((g) =>
				g.tiles.map((t) => t.item.id),
			),
		);
		return data.filter((d) => ids.has(d.id));
	}, [data, opts, effective, ix, schedule]);
	// The section's "From places in Japan · 20": what's inside, not its own.
	const inside = useMemo(() => {
		if (!section || (target.kind !== "node" && target.kind !== "trip"))
			return 0;
		const scopeId = target.kind === "node" ? target.nodeId : null;
		const o: RollupOptions = {
			scopeId,
			lens: defaultLens(ix, scopeId),
			includeDescendants: true,
		};
		const ids = new Set(
			buildGroups(ix, schedule, data, o, scopeId).flatMap((g) =>
				g.tiles.map((t) => t.item.id),
			),
		);
		return data.filter((d) => ids.has(d.id) && !sameTarget(d.target, target))
			.length;
	}, [section, target, ix, schedule, data]);
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
			<Segmented
				label="What to include"
				testId={MEDIA_TESTID.scopeToggle}
				size="sm"
				value={scope}
				onValueChange={(v) => v && setScope(v as Scope)}
				options={[
					{ value: "own", label: "This day" },
					{ value: "all", label: "Everything that day" },
				]}
			/>
		) : name &&
			// FB-12: a node with no children has nothing to choose between.
			offersRollupChoice(ix, target) &&
			!(visitOnly && visitItemId) ? (
			<Segmented
				label="What to include"
				testId={MEDIA_TESTID.scopeToggle}
				size="sm"
				value={scope}
				onValueChange={(v) => v && setScope(v as Scope)}
				options={[
					{
						value: "all",
						label: target.kind === "trip" ? "Everything" : "Everything inside",
					},
					{
						value: "own",
						label: <span className="truncate">Only {name}</span>,
					},
				]}
			/>
		) : null;

	if (section)
		return (
			<div
				{...drop.rootProps}
				data-testid={TESTID.mediaPanel}
				className="relative -mx-1 grid gap-2 px-1"
			>
				<div className="flex flex-wrap items-center gap-2">
					{inView.length === 0 && uploads.length === 0 ? (
						<p
							data-testid={MEDIA_TESTID.empty}
							className="text-meta text-muted-foreground"
						>
							Add a photo, reel or link, or drop files here.
						</p>
					) : null}
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
				{inView.length || uploads.length ? (
					<MediaGallery
						compact
						items={inView}
						rollupOptions={null}
						uploads={uploads}
						actions={actions}
						headers="never"
					/>
				) : null}
				{inside ? (
					<div className="flex items-center gap-2 text-meta text-muted-foreground">
						<span>
							From places in {name} <span className="tnum">· {inside}</span>
						</span>
						<Button
							variant="ghost"
							size="sm"
							data-testid={MEDIA_TESTID.seeAll}
							onClick={() => setSeeAll(true)}
						>
							See all
						</Button>
					</div>
				) : null}
				<Dialog open={seeAll} onOpenChange={setSeeAll}>
					<DialogContent className="max-w-3xl">
						<DialogTitle>Photos &amp; links · {name}</DialogTitle>
						<div className="max-h-[70vh] overflow-y-auto">
							<MediaPanel target={target} />
						</div>
					</DialogContent>
				</Dialog>
				{drop.isOver ? (
					<DropOverlay
						label={dropLabel(ix, effective, visitOnly && !!visitItemId)}
					/>
				) : null}
			</div>
		);

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
					className="py-8 text-center font-display text-body leading-6 font-medium text-muted-foreground"
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
