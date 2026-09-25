/**
 * What every media surface (tab, inspector panel) shares: starting uploads
 * and links for its target, "paste a link anywhere", and a window guard so a
 * file dropped just outside a target doesn't make the browser open it.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useEditGuard } from "@/components/common/edit-guard";
import { mustRedact } from "@/lib/auth/roles";
import { humanError } from "@/lib/errors";
import type { BundleTarget } from "@/lib/schemas/targets";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { targetName } from "./labels";
import { UPLOAD_EDIT_ONLY_REASON } from "./media-kinds";
import { nearestPlace } from "./nearest";
import { startUploads, useUploads } from "./upload/uploader";
import { addLinkAndCache } from "./use-media-actions";

export function useMediaSurface(target: BundleTarget) {
	const ws = useWorkspace();
	const qc = useQueryClient();
	const tripId = ws.graph.trip.id;
	const label = targetName(ws.ix, target);
	const guest = mustRedact(ws.graph.me);
	const upload = useEditGuard("edit-only", UPLOAD_EDIT_ONLY_REASON);
	const link = useEditGuard();
	const key = JSON.stringify(target);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the value identity of `target`.
	const stable = useMemo(() => target, [key]);
	const { disabled: uploadBlocked, reason: uploadReason } = upload;
	const { disabled: linkBlocked, reason: linkReason } = link;

	const uploadFiles = useCallback(
		(files: FileList | File[]) => {
			if (uploadBlocked) {
				toast(uploadReason ?? UPLOAD_EDIT_ONLY_REASON);
				return;
			}
			startUploads(files, {
				tripId,
				target: stable,
				queryClient: qc,
				label,
				guest,
				suggestNear: (gps) => {
					const n = nearestPlace(ws.ix, gps);
					return n && !(stable.kind === "node" && stable.nodeId === n.id)
						? { nodeId: n.id, name: n.name }
						: null;
				},
			});
		},
		[uploadBlocked, uploadReason, tripId, stable, qc, label, guest, ws.ix],
	);

	const addUrl = useCallback(
		async (url: string): Promise<boolean> => {
			if (linkBlocked) {
				toast(linkReason ?? "View only");
				return false;
			}
			const added = await addLinkAndCache(qc, tripId, { target: stable, url });
			if (added) toast(`Link added to ${label}`);
			return true;
		},
		[linkBlocked, linkReason, qc, tripId, stable, label],
	);

	const uploads = useUploads((s) => s.items);
	return { uploadFiles, addUrl, label, uploads, tripId };
}

function editableTarget(el: EventTarget | null): boolean {
	const e = el as HTMLElement | null;
	if (!e) return false;
	return (
		e.isContentEditable ||
		e.tagName === "INPUT" ||
		e.tagName === "TEXTAREA" ||
		e.tagName === "SELECT"
	);
}

/** "Paste a link anywhere" (SPEC §18.3): a URL or image pasted outside a text field attaches here. */
export function usePasteToAttach(
	enabled: boolean,
	onUrl: (url: string) => Promise<boolean>,
	onFiles: (files: File[]) => void,
) {
	useEffect(() => {
		if (!enabled) return;
		const onPaste = (e: ClipboardEvent) => {
			if (editableTarget(e.target) || editableTarget(document.activeElement))
				return;
			if (document.querySelector("[role=dialog]")) return;
			const files = [...(e.clipboardData?.files ?? [])];
			if (files.length) {
				e.preventDefault();
				onFiles(files);
				return;
			}
			const text = e.clipboardData?.getData("text/plain")?.trim() ?? "";
			if (!/^https?:\/\/\S+$/i.test(text)) return;
			e.preventDefault();
			onUrl(text).catch((err) => toast.error(humanError(err)));
		};
		document.addEventListener("paste", onPaste);
		return () => document.removeEventListener("paste", onPaste);
	}, [enabled, onUrl, onFiles]);
}

/** While a media surface is open, a file dropped outside a target is ignored instead of opened. */
export function useWindowDropGuard() {
	useEffect(() => {
		const stop = (e: DragEvent) => {
			if ([...(e.dataTransfer?.types ?? [])].includes("Files"))
				e.preventDefault();
		};
		window.addEventListener("dragover", stop);
		window.addEventListener("drop", stop);
		return () => {
			window.removeEventListener("dragover", stop);
			window.removeEventListener("drop", stop);
		};
	}, []);
}
