import { toast } from "sonner";

/**
 * Deletes, moves and unschedules always offer Undo (SPEC §0 rule 17). The
 * toast stays 8 s; ⌘Z while it shows triggers the same undo (WP-Shell).
 */
export function undoToast(
	label: string,
	undo: () => void | Promise<void>,
	opts: { secondary?: { label: string; onClick: () => void } } = {},
): string | number {
	return toast(label, {
		duration: 8_000,
		action: { label: "Undo", onClick: () => void undo() },
		...(opts.secondary
			? {
					cancel: {
						label: opts.secondary.label,
						onClick: opts.secondary.onClick,
					},
				}
			: {}),
	});
}
