/**
 * The rolled-up gallery (SPEC §8.4, DESIGN §7.2) shared by the Media tab and
 * the inspector: `rollup()` groups under sticky mini-breadcrumbs, a CSS-columns
 * masonry per group, the source of each tile in rollups ("Shibuya › Shibuya
 * Sky", "This visit · Day 4 · 11:42", "Transit · Osaka → Seoul"), uploads in
 * flight, the lightbox (photos, videos, social) and the PDF viewer.
 */
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import {
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useMemo,
	useState,
} from "react";
import { toast } from "sonner";
import { ProposalGhost } from "@/components/common/proposal-ghost";
import { GroupSubhead } from "@/components/common/rollup-toggle";
import { GhostActions } from "@/features/suggest/GhostActions";
import type { ProposalMark } from "@/lib/engine/proposals";
import type { RollupOptions } from "@/lib/engine/rollup";
import { humanError } from "@/lib/errors";
import { tripKeys } from "@/lib/query/keys";
import { anchorKey } from "@/lib/realtime/cursor-protocol";
import { useProposalMarks } from "@/lib/workspace/use-proposals";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { buildGroups, type Tile } from "../gallery-groups";
import { targetName } from "../labels";
import { refreshLinkMeta } from "../media.functions";
import { MEDIA_TESTID } from "../testids";
import type { MediaDto } from "../types";
import {
	cancelUpload,
	dismissUpload,
	releasePreview,
	retryUpload,
	type UploadItem,
	useUploads,
} from "../upload/uploader";
import type { useMediaActions } from "../use-media-actions";
import { inLightbox } from "./lightbox-kinds";
import { MediaTile } from "./media-tile";
import { PdfViewer } from "./pdf-viewer";
import { TileMenu } from "./tile-menu";
import { UploadTile } from "./upload-tile";
import { useVisibilityGuard, VisibilityButton } from "./visibility-button";

const MediaLightbox = lazy(() => import("./media-lightbox"));

/** Unfetched links this tab already asked the server to preview. */
const REFRESHED = new Set<string>();

/** Suggested edits/deletes of an existing tile (E7 marks on `att:<id>`). */
function GhostWrap({
	id,
	actions,
	children,
}: {
	id: string;
	actions?: (lead: ProposalMark) => ReactNode;
	children: ReactNode;
}) {
	const marks = useProposalMarks(`att:${id}`);
	if (!marks.length) return <>{children}</>;
	return (
		<ProposalGhost
			marks={marks}
			actions={actions}
			className="mb-2 break-inside-avoid rounded-lg [&>figure]:mb-0"
		>
			{children}
		</ProposalGhost>
	);
}

function TextSubhead({ text, count }: { text: string; count: number }) {
	return (
		<div className="sticky top-0 z-20 flex h-8 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
			<span className="truncate text-xs text-foreground">{text}</span>
			<span className="font-mono text-xs text-muted-foreground tnum">
				{count}
			</span>
		</div>
	);
}

export function MediaGallery({
	items,
	rollupOptions,
	uploads,
	actions,
	compact = false,
	headers = "auto",
	className,
}: {
	items: readonly MediaDto[];
	/** Null: one plain group of `items` in order (a single target). */
	rollupOptions: RollupOptions | null;
	uploads: readonly UploadItem[];
	actions: ReturnType<typeof useMediaActions>;
	/** The inspector: two columns, tighter padding. */
	compact?: boolean;
	/** Group headers: always, never, or only when there's more than one group. */
	headers?: "always" | "never" | "auto";
	className?: string;
}) {
	const ws = useWorkspace();
	const qc = useQueryClient();
	const vis = useVisibilityGuard();
	const withMenu = ws.access.mode !== "read" || vis.show;
	const canDelete = ws.access.mode !== "read";
	const groups = useMemo(
		() =>
			rollupOptions
				? buildGroups(
						ws.ix,
						ws.schedule,
						items,
						rollupOptions,
						rollupOptions.scopeId,
					)
				: [
						{
							key: "single",
							header: null,
							tiles: items.map((item) => ({ item, source: null })),
						},
					],
		[ws.ix, ws.schedule, items, rollupOptions],
	);
	const ordered = useMemo(() => groups.flatMap((g) => g.tiles), [groups]);
	const slides = useMemo(
		() => ordered.filter((t) => inLightbox(t.item)),
		[ordered],
	);
	const lightboxItems = useMemo(() => slides.map((t) => t.item), [slides]);
	const sources = useMemo(
		() =>
			Object.fromEntries(
				ordered
					.filter((t) => t.source)
					.map((t) => [t.item.id, t.source as string]),
			),
		[ordered],
	);
	const [lightbox, setLightbox] = useState<number | null>(null);
	const [pdf, setPdf] = useState<string | null>(null);
	const pdfItem = pdf ? items.find((i) => i.id === pdf) : undefined;

	// Local previews go once the worker's thumb exists.
	const previews = useUploads((s) => s.previews);
	useEffect(() => {
		for (const i of items)
			if (i.hasThumb && previews[i.id]) releasePreview(i.id);
	}, [items, previews]);

	// Imported links arrive `unfetched` (SPEC §13.4 refreshLinkMeta): the first
	// editor who sees one fetches its preview — a few at a time, once per session.
	const canFetch =
		ws.mode === "live" && ws.access.mode === "edit" && ws.access.canEdit;
	useEffect(() => {
		if (!canFetch) return;
		const todo = items
			.filter(
				(i) =>
					(i.kind === "link" || i.kind === "embed") &&
					i.fetch === "unfetched" &&
					i.status === "ready" &&
					!REFRESHED.has(i.id),
			)
			.slice(0, 5);
		for (const i of todo) {
			REFRESHED.add(i.id);
			void refreshLinkMeta({ data: { id: i.id } })
				.then(() =>
					qc.invalidateQueries({ queryKey: tripKeys.media(ws.graph.trip.id) }),
				)
				.catch(() => {});
		}
	}, [canFetch, items, qc, ws.graph.trip.id]);

	const setVisibility = (id: string, visibility: MediaDto["visibility"]) =>
		actions.visibility.mutate(
			{ id, visibility },
			{ onError: (e) => toast.error(humanError(e)) },
		);

	const open = (item: MediaDto) => {
		if (item.kind === "pdf") setPdf(item.id);
		else {
			const i = slides.findIndex((t) => t.item.id === item.id);
			if (i >= 0) setLightbox(i);
		}
	};

	const showHeaders =
		headers === "always" ||
		(headers === "auto" &&
			(groups.length > 1 ||
				(groups[0]?.header?.kind === "rep" &&
					groups[0].header.repId !== (rollupOptions?.scopeId ?? null))));

	const columns = compact
		? "columns-2 gap-2"
		: "columns-2 gap-2 @min-[640px]:columns-3 @min-[980px]:columns-4";

	const review = ws.access.canReview
		? (lead: ProposalMark) => <GhostActions proposalId={lead.proposalId} />
		: undefined;
	const tile = (t: Tile) =>
		t.item.proposed ? (
			// A suggested link (E7): dashed in its author's colour, no menu yet.
			<ProposalGhost
				key={t.item.id}
				marks={[t.item.proposed]}
				actions={review}
				className="mb-2 break-inside-avoid rounded-lg [&>figure]:mb-0"
			>
				<MediaTile
					item={t.item}
					source={t.source}
					onOpen={() => open(t.item)}
				/>
			</ProposalGhost>
		) : (
			<GhostWrap key={t.item.id} id={t.item.id} actions={review}>
				<MediaTile
					item={t.item}
					source={t.source}
					onOpen={() => open(t.item)}
					menu={
						withMenu ? <TileMenu item={t.item} actions={actions} /> : undefined
					}
					lock={
						vis.show && t.item.target.kind !== "expense" ? (
							<VisibilityButton
								item={t.item}
								onToggle={(next) => setVisibility(t.item.id, next)}
							/>
						) : undefined
					}
				/>
			</GhostWrap>
		);

	return (
		<div className={cn("@container", className)}>
			{uploads.length ? (
				<div className={cn(compact ? "pb-2" : "px-4 pt-3 pb-1")}>
					<div className={columns}>
						{uploads.map((u) => (
							<UploadTile
								key={u.key}
								item={u}
								onCancel={() => cancelUpload(u.key)}
								onDismiss={() => dismissUpload(u.key)}
								onRetry={() =>
									retryUpload(u.key, {
										queryClient: qc,
										label: targetName(ws.ix, u.target),
									})
								}
							/>
						))}
					</div>
				</div>
			) : null}
			{groups.map((g) => (
				<section
					key={g.key}
					data-testid={MEDIA_TESTID.group}
					data-group={g.key}
					data-cursor-anchor={`sec:media.${anchorKey(g.key)}`}
					aria-label={
						g.header?.kind === "text"
							? g.header.text
							: (ws.ix.node(g.header?.repId)?.name ?? ws.ix.trip.name)
					}
				>
					{showHeaders && g.header ? (
						g.header.kind === "rep" ? (
							<GroupSubhead
								repId={g.header.repId}
								count={g.header.count}
								onZoom={
									g.header.repId && g.header.repId !== ws.scope?.id
										? () =>
												ws.nav.zoomIn(
													g.header?.kind === "rep"
														? (g.header.repId as string)
														: "",
												)
										: undefined
								}
							/>
						) : (
							<TextSubhead text={g.header.text} count={g.header.count} />
						)
					) : null}
					<div className={cn(compact ? "pt-2" : "px-4 pt-3 pb-2")}>
						<div className={columns}>{g.tiles.map(tile)}</div>
					</div>
				</section>
			))}
			{lightbox !== null && lightboxItems.length ? (
				<Suspense fallback={null}>
					<MediaLightbox
						items={lightboxItems}
						sources={sources}
						index={lightbox}
						onClose={() => setLightbox(null)}
						onVisibility={setVisibility}
						onDelete={canDelete ? actions.deleteItem : undefined}
					/>
				</Suspense>
			) : null}
			{pdfItem ? (
				<PdfViewer
					item={pdfItem}
					onClose={() => setPdf(null)}
					onVisibility={(next) => setVisibility(pdfItem.id, next)}
					onDelete={canDelete ? () => actions.deleteItem(pdfItem) : undefined}
				/>
			) : null}
		</div>
	);
}
