/** Deleting from Saved (the feed's Delete, the grid's Select): one call, then "Deleted from Saved" with Undo. */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { humanError } from "@/lib/errors";
import { meKeys } from "@/lib/query/keys";
import { deleteSavedLinks, restoreSavedLinks } from "./saved.functions";

export function useDeleteSaved() {
	const qc = useQueryClient();
	return useCallback(
		async (
			ids: readonly string[],
			opts: { onUndone?: () => void } = {},
		): Promise<boolean> => {
			try {
				await deleteSavedLinks({ data: { ids: [...ids] } });
			} catch (e) {
				toast.error(humanError(e));
				return false;
			}
			void qc.invalidateQueries({ queryKey: meKeys.saved });
			toast(
				ids.length === 1
					? "Deleted from Saved"
					: `Deleted ${ids.length} from Saved`,
				{
					duration: 6000,
					position: "top-center",
					action: {
						label: "Undo",
						onClick: () =>
							void restoreSavedLinks({ data: { ids: [...ids] } })
								.then(() => {
									opts.onUndone?.();
									return qc.invalidateQueries({ queryKey: meKeys.saved });
								})
								.catch((e) => toast.error(humanError(e))),
					},
				},
			);
			return true;
		},
		[qc],
	);
}
