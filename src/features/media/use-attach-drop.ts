/**
 * Makes an element a file/link drop target for a bundle (SPEC §12.5
 * `useAttachDrop(target, opts?)`), used by Outline rows, map pins, Plan cards
 * and the inspector. Files upload (edit access), a dropped URL becomes a
 * link (proposable). Spread `rootProps` on the element and draw the
 * "Drop to attach to Shibuya" wash with `isOver` (`<DropOverlay>`).
 *
 * Native HTML5 drag only: the workspace's dnd-kit drags (Outline rows, Plan
 * cards) never carry files or URLs, so the two never collide.
 */
import { useQueryClient } from "@tanstack/react-query";
import {
	type DragEvent,
	type HTMLAttributes,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { useEditGuard } from "@/components/common/edit-guard";
import { mustRedact } from "@/lib/auth/roles";
import { humanError } from "@/lib/errors";
import type { BundleTarget } from "@/lib/schemas/targets";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import { targetName } from "./labels";
import { UPLOAD_EDIT_ONLY_REASON } from "./media-kinds";
import { nearestPlace } from "./nearest";
import { startUploads } from "./upload/uploader";
import { addLinkAndCache } from "./use-media-actions";

export type AttachDropOptions = { disabled?: boolean; label?: string };

function carries(e: DragEvent): boolean {
	const types = [...(e.dataTransfer?.types ?? [])];
	return types.includes("Files") || types.includes("text/uri-list");
}

/** The first http(s) URL in a drop's uri-list or text. */
export function droppedUrl(dt: DataTransfer): string | null {
	const raw = dt.getData("text/uri-list") || dt.getData("text/plain") || "";
	for (const line of raw.split(/\r?\n/)) {
		const s = line.trim();
		if (!s || s.startsWith("#")) continue;
		try {
			const u = new URL(s);
			if (u.protocol === "http:" || u.protocol === "https:") return u.href;
		} catch {
			// not a URL
		}
	}
	return null;
}

export function useAttachDrop(
	target: BundleTarget | null,
	opts?: AttachDropOptions,
): { rootProps: HTMLAttributes<HTMLElement>; isOver: boolean } {
	const ws = useWorkspaceOptional();
	const qc = useQueryClient();
	const { disabled: uploadBlocked, reason: uploadReason } = useEditGuard(
		"edit-only",
		UPLOAD_EDIT_ONLY_REASON,
	);
	const { disabled: linkBlocked, reason: linkReason } = useEditGuard();
	const [isOver, setOver] = useState(false);
	const depth = useRef(0);
	const disabled =
		!target ||
		!ws ||
		ws.mode !== "live" ||
		opts?.disabled === true ||
		(uploadBlocked && linkBlocked);

	const onDragEnter = useCallback((e: DragEvent<HTMLElement>) => {
		if (!carries(e)) return;
		e.preventDefault();
		e.stopPropagation();
		depth.current += 1;
		setOver(true);
	}, []);
	const onDragOver = useCallback((e: DragEvent<HTMLElement>) => {
		if (!carries(e)) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
	}, []);
	const onDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
		if (!carries(e)) return;
		depth.current = Math.max(0, depth.current - 1);
		if (depth.current === 0) setOver(false);
	}, []);
	const onDrop = useCallback(
		(e: DragEvent<HTMLElement>) => {
			if (!carries(e) || !target || !ws) return;
			e.preventDefault();
			e.stopPropagation();
			depth.current = 0;
			setOver(false);
			const label = opts?.label ?? targetName(ws.ix, target);
			const files = e.dataTransfer.files;
			if (files.length) {
				if (uploadBlocked) {
					toast(uploadReason ?? UPLOAD_EDIT_ONLY_REASON);
					return;
				}
				startUploads(files, {
					tripId: ws.graph.trip.id,
					target,
					queryClient: qc,
					label,
					guest: mustRedact(ws.graph.me),
					suggestNear: (gps) => {
						const n = nearestPlace(ws.ix, gps);
						return n && !(target.kind === "node" && target.nodeId === n.id)
							? { nodeId: n.id, name: n.name }
							: null;
					},
				});
				return;
			}
			const url = droppedUrl(e.dataTransfer);
			if (!url) return;
			if (linkBlocked) {
				toast(linkReason ?? "View only");
				return;
			}
			void addLinkAndCache(qc, ws.graph.trip.id, { target, url })
				.then(() => toast(`Link added to ${label}`))
				.catch((err) => toast.error(humanError(err)));
		},
		[
			target,
			ws,
			qc,
			uploadBlocked,
			uploadReason,
			linkBlocked,
			linkReason,
			opts?.label,
		],
	);

	const rootProps = useMemo<HTMLAttributes<HTMLElement>>(
		() => (disabled ? {} : { onDragEnter, onDragOver, onDragLeave, onDrop }),
		[disabled, onDragEnter, onDragOver, onDragLeave, onDrop],
	);
	return { rootProps, isOver: !disabled && isOver };
}
