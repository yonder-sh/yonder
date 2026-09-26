/**
 * Up to three photos across the top of the inspector (SPEC §12.5
 * `CoverStrip({ target })`, DESIGN §4.4): 96px tall, radius 12, only when
 * there's media. Photos (and video posters) from everything inside the node,
 * in rollup order; a click opens the lightbox there.
 */
import { lazy, Suspense, useMemo, useState } from "react";
import { toast } from "sonner";
import { ThumbhashImage } from "@/components/common/thumbhash-image";
import { defaultLens } from "@/lib/engine/lens";
import { humanError } from "@/lib/errors";
import { mediaUrl } from "@/lib/media-url";
import type { BundleTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { buildGroups } from "./gallery-groups";
import { useDocOfflineSync } from "./offline/MediaOfflineSync";
import { useTripMedia } from "./queries";
import { useMediaActions } from "./use-media-actions";

const MediaLightbox = lazy(() => import("./components/media-lightbox"));

export function CoverStrip({ target }: { target: BundleTarget }) {
	const { ix, schedule, graph, access } = useWorkspace();
	const { data } = useTripMedia();
	const actions = useMediaActions(graph.trip.id);
	useDocOfflineSync();
	const [open, setOpen] = useState<number | null>(null);
	const photos = useMemo(() => {
		if (target.kind !== "node" || !data.length) return [];
		const groups = buildGroups(
			ix,
			schedule,
			data.filter(
				(d) =>
					(d.kind === "photo" || d.kind === "video") &&
					d.hasThumb &&
					d.status === "ready",
			),
			{
				scopeId: target.nodeId,
				lens: defaultLens(ix, target.nodeId),
				includeDescendants: true,
			},
			target.nodeId,
		);
		return groups.flatMap((g) => g.tiles.map((t) => t.item));
	}, [target, data, ix, schedule]);
	if (photos.length === 0) return null;
	const three = photos.slice(0, 3);
	return (
		<div
			data-testid={TESTID.coverStrip}
			className="grid h-24 shrink-0 gap-1 overflow-hidden rounded-t-2xl"
			style={{
				gridTemplateColumns: three
					.map(
						(p) =>
							`${Math.max(0.6, Math.min(1.8, (p.width ?? 4) / (p.height ?? 3)))}fr`,
					)
					.join(" "),
			}}
		>
			{three.map((p, i) => (
				<button
					key={p.id}
					type="button"
					onClick={() => setOpen(i)}
					aria-label={p.caption ? `Open ${p.caption}` : "Open photo"}
					className="relative h-24 cursor-pointer overflow-hidden outline-none first:rounded-tl-2xl last:rounded-tr-2xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
				>
					<ThumbhashImage
						hash={p.thumbhash}
						src={mediaUrl(p.id, "thumb")}
						alt={p.caption ?? ""}
						className="absolute inset-0 size-full"
					/>
				</button>
			))}
			{open !== null ? (
				<Suspense fallback={null}>
					<MediaLightbox
						items={photos}
						index={open}
						onClose={() => setOpen(null)}
						onVisibility={(id, visibility) =>
							actions.visibility.mutate(
								{ id, visibility },
								{ onError: (e) => toast.error(humanError(e)) },
							)
						}
						onDelete={access.mode !== "read" ? actions.deleteItem : undefined}
					/>
				</Suspense>
			) : null}
		</div>
	);
}
