/**
 * Receipts on an expense or one of its payments (ADDENDUM §6/§9: photos and
 * PDFs, "camera receipt in one tap"). For WP-Money to mount in its expense
 * editor and overview: the same tiles, lightbox and PDF viewer as the Media
 * tab. Uploading needs `manageExpenses` (suggester members too), never a link
 * guest; receipts are always hidden from guests and reach only the members
 * who can see the expense (F filters `listTripMedia`).
 */
import { useQueryClient } from "@tanstack/react-query";
import { Camera } from "lucide-react";
import { useMemo, useRef } from "react";
import { toast } from "sonner";
import { useEditGuard } from "@/components/common/edit-guard";
import { Button } from "@/components/ui/button";
import { can, mustRedact } from "@/lib/auth/roles";
import type { AttachmentTarget } from "@/lib/schemas/targets";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { MediaGallery } from "./components/media-gallery";
import { IMAGE_TYPES, PDF_TYPE } from "./media-kinds";
import { useTripMedia } from "./queries";
import { startUploads, useUploads } from "./upload/uploader";
import { useMediaActions } from "./use-media-actions";

export function ReceiptStrip({
	expenseId,
	paymentId,
	label = "Receipts",
}: {
	expenseId: string;
	/** One payment's receipts (a deposit, the final bill); omit for the whole expense. */
	paymentId?: string;
	label?: string;
}) {
	const ws = useWorkspace();
	const qc = useQueryClient();
	const { data } = useTripMedia();
	const actions = useMediaActions(ws.graph.trip.id);
	const input = useRef<HTMLInputElement>(null);
	const me = ws.graph.me;
	const target = useMemo<AttachmentTarget>(
		() =>
			paymentId
				? { kind: "expense", expenseId, paymentId }
				: { kind: "expense", expenseId },
		[expenseId, paymentId],
	);
	const items = useMemo(
		() =>
			data.filter(
				(d) =>
					d.target.kind === "expense" &&
					d.target.expenseId === expenseId &&
					(!paymentId || d.target.paymentId === paymentId),
			),
		[data, expenseId, paymentId],
	);
	const all = useUploads((s) => s.items);
	const uploads = useMemo(
		() =>
			all.filter(
				(u) =>
					u.target.kind === "expense" &&
					u.target.expenseId === expenseId &&
					(!paymentId || u.target.paymentId === paymentId),
			),
		[all, expenseId, paymentId],
	);
	// Receipts are money (`manageExpenses`, suggester members included, never
	// a proposal): the edit guard's read-only/offline reason, then the capability.
	const guard = useEditGuard();
	if (mustRedact({ role: me.role, isGuest: me.isGuest })) return null;
	const allowed = can({ role: me.role, isGuest: me.isGuest }, "manageExpenses");
	const reason = guard.disabled
		? (guard.reason ?? "View only")
		: !allowed
			? "View only"
			: undefined;
	return (
		<section aria-label={label} className="space-y-2">
			<div className="flex items-center gap-2">
				<h3 className="text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
					{label}
				</h3>
				<span className="ml-auto">
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
									label: "the expense",
								});
							e.target.value = "";
						}}
					/>
					<Button
						size="xs"
						variant="outline"
						disabled={!!reason || ws.mode !== "live"}
						title={reason}
						onClick={() => {
							if (reason) toast(reason);
							else input.current?.click();
						}}
					>
						<Camera /> Add receipt
					</Button>
				</span>
			</div>
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
				<p className="text-xs text-muted-foreground">No receipts yet.</p>
			)}
		</section>
	);
}
