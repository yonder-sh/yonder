/**
 * A booking's confirmation (One Yonder D12): the PDFs and photos on the stop
 * or leg it is for, the same media attach as places and stops — drop a file
 * here or pick one. PDFs on a stop count as "Confirmation attached". Files
 * attached here are members only and never a cover photo (U001).
 */
import { useQueryClient } from "@tanstack/react-query";
import { Paperclip } from "lucide-react";
import { useMemo, useRef } from "react";
import { toast } from "sonner";
import { useEditGuard } from "@/components/common/edit-guard";
import { Button } from "@/components/ui/button";
import { DropOverlay } from "@/features/media/components/controls";
import { MediaGallery } from "@/features/media/components/media-gallery";
import type { MediaDto } from "@/features/media/media.functions";
import {
	IMAGE_TYPES,
	PDF_TYPE,
	UPLOAD_EDIT_ONLY_REASON,
} from "@/features/media/media-kinds";
import { sameTarget, useTripMedia } from "@/features/media/queries";
import { startUploads, useUploads } from "@/features/media/upload/uploader";
import { useAttachDrop } from "@/features/media/use-attach-drop";
import { useMediaActions } from "@/features/media/use-media-actions";
import type { BundleTarget } from "@/lib/schemas/targets";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { LISTS_TESTID } from "./testids";

/** A confirmation on this stop or leg: one attached here, or a PDF on it. */
export function hasConfirmation(
	media: readonly MediaDto[],
	target: BundleTarget,
): boolean {
	return media.some(
		(m) => (m.confirmation || m.kind === "pdf") && sameTarget(m.target, target),
	);
}

export function BookingConfirmation({
	target,
	label,
}: {
	target: BundleTarget;
	/** "Fuji Excursion 7" for the drop wash and toasts. */
	label: string;
}) {
	const ws = useWorkspace();
	const qc = useQueryClient();
	const { data } = useTripMedia();
	const actions = useMediaActions(ws.graph.trip.id);
	const input = useRef<HTMLInputElement>(null);
	const guard = useEditGuard("edit-only", UPLOAD_EDIT_ONLY_REASON);
	const drop = useAttachDrop(target, { label, confirmation: true });
	const items = useMemo(
		() =>
			data.filter(
				(d) =>
					(d.kind === "pdf" || d.kind === "photo") &&
					sameTarget(d.target, target),
			),
		[data, target],
	);
	const all = useUploads((s) => s.items);
	const uploads = useMemo(
		() => all.filter((u) => sameTarget(u.target, target)),
		[all, target],
	);
	const live = ws.mode === "live";
	return (
		<div
			{...drop.rootProps}
			data-testid={LISTS_TESTID.bookingConfirmation}
			className="relative flex flex-col gap-2"
		>
			{items.length || uploads.length ? (
				<MediaGallery
					compact
					items={items}
					rollupOptions={null}
					uploads={uploads}
					actions={actions}
					headers="never"
				/>
			) : (
				<p
					className={cn(
						"rounded-lg border border-dashed px-3 py-4 text-center text-meta text-muted-foreground",
						!live && "border-transparent px-0 py-0 text-left",
					)}
				>
					{live
						? "Drop the confirmation PDF or a photo here"
						: "No confirmation yet"}
				</p>
			)}
			{live ? (
				<span>
					<input
						ref={input}
						type="file"
						multiple
						accept={[...IMAGE_TYPES, PDF_TYPE, "image/heic", "image/heif"].join(
							",",
						)}
						className="sr-only"
						tabIndex={-1}
						aria-hidden="true"
						onChange={(e) => {
							const files = e.target.files;
							if (files?.length)
								startUploads(files, {
									tripId: ws.graph.trip.id,
									target,
									queryClient: qc,
									label,
									confirmation: true,
								});
							e.target.value = "";
						}}
					/>
					<Button
						size="xs"
						variant="outline"
						disabled={guard.disabled}
						title={guard.reason ?? undefined}
						onClick={() => {
							if (guard.disabled) toast(guard.reason ?? "View only");
							else input.current?.click();
						}}
					>
						<Paperclip /> Attach a file
					</Button>
				</span>
			) : null}
			{drop.isOver ? <DropOverlay label={`Attach to ${label}`} /> : null}
		</div>
	);
}
