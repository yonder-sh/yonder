/**
 * The in-app PDF viewer (ADDENDUM §9): the pages the worker rendered
 * (`/media/<id>/page-<n>`, private and same-origin) in a scrolling column
 * with fit-width zoom, a page counter, Download (the original through a
 * presigned GET), "Hide from guests" and Delete. Offline, pages come from the
 * last-trip document cache (≤ 5 MB PDFs). Without rendered pages (poppler
 * missing, an encrypted file) it offers the download only.
 */
import { cn } from "cn";
import { Download, FileText, Minus, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { useEditGuard } from "@/components/common/edit-guard";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { mediaPageUrl, mediaUrl } from "@/lib/media-url";
import { useFollowState } from "@/lib/realtime/view-ui";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { formatBytes } from "../media-kinds";
import { usePublishMedia } from "../media-presence";
import { cachedPageUrl } from "../offline/doc-cache";
import { MEDIA_TESTID } from "../testids";
import type { MediaDto } from "../types";
import { useEscapeOwner } from "./use-escape-owner";
import { VisibilityButton } from "./visibility-button";

const ZOOMS = [0.6, 0.8, 1, 1.25, 1.5, 2] as const;
const isZoom = z.custom<number>((v) =>
	(ZOOMS as readonly unknown[]).includes(v),
);

function Page({
	item,
	n,
	aspect,
}: {
	item: MediaDto;
	n: number;
	aspect: string;
}) {
	const [src, setSrc] = useState(mediaPageUrl(item.id, n));
	const [failed, setFailed] = useState(false);
	return (
		<figure
			data-testid={MEDIA_TESTID.pdfPage}
			data-page={n}
			data-cursor-anchor={`sec:pdf.${n}`}
			className="relative w-full overflow-hidden rounded-[3px] bg-white shadow-float"
			style={{ aspectRatio: aspect }}
		>
			{failed ? (
				<span className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
					Page {n} isn't available offline.
				</span>
			) : (
				<img
					src={src}
					alt={`Page ${n} of ${item.title ?? "the document"}`}
					loading={n <= 2 ? "eager" : "lazy"}
					decoding="async"
					className="absolute inset-0 size-full object-contain"
					onError={async () => {
						// Offline: the last trip's small PDFs are in the document cache.
						const cached = await cachedPageUrl(item.id, n);
						if (cached && cached !== src) setSrc(cached);
						else setFailed(true);
					}}
				/>
			)}
		</figure>
	);
}

export function PdfViewer({
	item,
	onClose,
	onVisibility,
	onDelete,
}: {
	item: MediaDto;
	onClose: () => void;
	/** Omitted (a followed viewer, FB-21c): no "Hide from guests" toggle. */
	onVisibility?: (next: MediaDto["visibility"]) => void;
	/** Omitted (a followed viewer): no Delete. The viewer closes. */
	onDelete?: () => void;
}) {
	const edit = useEditGuard();
	// The zoom travels with my view (the pages follow my scroll).
	const [zoom, setZoom] = useFollowState<number>("media.zoom", 1, isZoom);
	const hidden =
		item.visibility !== "everyone" || item.target.kind === "expense";
	// FB-21c: followers open the same document.
	usePublishMedia({ id: item.id, k: "pdf", hidden });
	useEscapeOwner(onClose);
	const [page, setPage] = useState(1);
	const scroller = useRef<HTMLDivElement>(null);
	const offline = useWorkspace().connection === "offline";
	const pages = item.pages;
	const aspect =
		item.width && item.height ? `${item.width} / ${item.height}` : "1 / 1.414";
	const numbers = useMemo(
		() => Array.from({ length: pages }, (_, i) => i + 1),
		[pages],
	);

	// The page counter follows the scroll.
	useEffect(() => {
		const root = scroller.current;
		if (!root || !pages) return;
		const obs = new IntersectionObserver(
			(entries) => {
				const top = entries
					.filter((e) => e.isIntersecting)
					.sort(
						(a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
					)[0];
				const n = Number(
					(top?.target as HTMLElement | undefined)?.dataset.page,
				);
				if (n) setPage(n);
			},
			{ root, threshold: 0.35 },
		);
		for (const el of root.querySelectorAll("[data-page]")) obs.observe(el);
		return () => obs.disconnect();
	}, [pages]);

	const zi = ZOOMS.indexOf(zoom as (typeof ZOOMS)[number]);
	const meta = [
		item.pageCount
			? `${item.pageCount} ${item.pageCount === 1 ? "page" : "pages"}`
			: null,
		item.sizeBytes ? formatBytes(item.sizeBytes) : null,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent
				data-testid={MEDIA_TESTID.pdfViewer}
				showCloseButton={false}
				className="flex h-[100dvh] max-h-none w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 bg-[#1b1e2b] p-0 text-white sm:h-[92vh] sm:w-[min(960px,94vw)] sm:max-w-none sm:rounded-2xl"
				onKeyDown={(e) => {
					if ((e.key === "+" || e.key === "=") && zi < ZOOMS.length - 1)
						setZoom(ZOOMS[zi + 1] ?? zoom);
					if (e.key === "-" && zi > 0) setZoom(ZOOMS[zi - 1] ?? zoom);
				}}
			>
				<header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-4">
					<FileText
						className="size-4 shrink-0 text-white/60"
						strokeWidth={1.5}
					/>
					<div className="min-w-0 flex-1">
						<DialogTitle className="truncate text-sm font-medium text-white">
							{item.title ?? "Document"}
						</DialogTitle>
						<DialogDescription className="truncate text-[11px] text-white/55 tnum">
							{meta || "PDF"}
						</DialogDescription>
					</div>
					{/* Phones: in the footer by the page counter (no footer without pages). */}
					{onVisibility ? (
						<VisibilityButton
							item={item}
							variant="toolbar"
							onToggle={onVisibility}
							className={pages > 0 ? "hidden sm:inline-flex" : undefined}
						/>
					) : null}
					<Button
						asChild={!offline}
						size="sm"
						variant="ghost"
						disabled={offline}
						title={
							offline ? "Offline — downloads need a connection" : undefined
						}
						className="text-white/90 hover:bg-white/15 hover:text-white"
						data-testid={MEDIA_TESTID.pdfDownload}
					>
						{offline ? (
							<>
								<Download /> <span className="hidden sm:inline">Download</span>
							</>
						) : (
							<a href={`${mediaUrl(item.id, "original")}?download=1`} download>
								<Download /> <span className="hidden sm:inline">Download</span>
							</a>
						)}
					</Button>
					{onDelete ? (
						<Button
							size="icon-sm"
							variant="ghost"
							disabled={edit.disabled}
							title={edit.disabled ? (edit.reason ?? undefined) : "Delete"}
							aria-label="Delete"
							data-testid={MEDIA_TESTID.pdfDelete}
							onClick={() => {
								onClose();
								onDelete();
							}}
							className="text-white/90 hover:bg-white/15 hover:text-white"
						>
							<Trash2 />
						</Button>
					) : null}
					<Button
						size="icon-sm"
						variant="ghost"
						onClick={onClose}
						aria-label="Close"
						className="text-white/90 hover:bg-white/15 hover:text-white"
					>
						<X />
					</Button>
				</header>

				<div
					ref={scroller}
					data-cursor-vis={hidden ? "members" : undefined}
					className="relative min-h-0 flex-1 overflow-auto overscroll-contain"
				>
					{pages > 0 ? (
						<div
							className="mx-auto flex flex-col gap-4 px-3 py-5 sm:px-6"
							style={{
								width: `min(${Math.round(zoom * 100)}%, ${Math.round(zoom * 820)}px)`,
								minWidth: zoom > 1 ? `${Math.round(zoom * 100)}%` : undefined,
							}}
						>
							{numbers.map((n) => (
								<Page key={n} item={item} n={n} aspect={aspect} />
							))}
							{item.pageCount && item.pageCount > pages ? (
								<p className="py-2 text-center text-xs text-white/60">
									Showing the first {pages} of {item.pageCount} pages. Download
									the PDF for the rest.
								</p>
							) : null}
						</div>
					) : (
						<div className="grid h-full place-items-center p-8 text-center">
							{item.status === "processing" ? (
								<div className="flex flex-col items-center gap-3 text-sm text-white/70">
									<Spinner className="size-5" />
									Preparing the preview…
								</div>
							) : (
								<div className="flex max-w-xs flex-col items-center gap-3">
									<FileText className="size-12 text-white/40" strokeWidth={1} />
									<p className="font-display text-[17px] leading-6 font-medium">
										No preview for this PDF.
									</p>
									<Button asChild variant="secondary" size="sm">
										<a
											href={`${mediaUrl(item.id, "original")}?download=1`}
											download
										>
											<Download /> Download
										</a>
									</Button>
								</div>
							)}
						</div>
					)}
				</div>

				{pages > 0 ? (
					<footer className="flex shrink-0 items-center justify-between gap-2 border-t border-white/10 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-4">
						<span
							className="font-mono text-xs text-white/70 tnum"
							aria-live="polite"
						>
							{page} / {item.pageCount ?? pages}
						</span>
						{onVisibility ? (
							<VisibilityButton
								item={item}
								variant="toolbar"
								onToggle={onVisibility}
								className="sm:hidden"
							/>
						) : null}
						<div className="flex items-center gap-1">
							<Button
								size="icon-sm"
								variant="ghost"
								aria-label="Zoom out"
								data-testid={MEDIA_TESTID.pdfZoomOut}
								disabled={zi <= 0}
								onClick={() => setZoom(ZOOMS[zi - 1] ?? zoom)}
								className="text-white/90 hover:bg-white/15 hover:text-white"
							>
								<Minus />
							</Button>
							<button
								type="button"
								onClick={() => setZoom(1)}
								className={cn(
									"h-7 min-w-14 rounded-md px-2 font-mono text-xs text-white/80 tnum hover:bg-white/10",
								)}
								title="Fit width"
							>
								{Math.round(zoom * 100)}%
							</button>
							<Button
								size="icon-sm"
								variant="ghost"
								aria-label="Zoom in"
								data-testid={MEDIA_TESTID.pdfZoomIn}
								disabled={zi >= ZOOMS.length - 1}
								onClick={() => setZoom(ZOOMS[zi + 1] ?? zoom)}
								className="text-white/90 hover:bg-white/15 hover:text-white"
							>
								<Plus />
							</Button>
						</div>
					</footer>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
