/** Filing saved items under a place: the grid moves at once, the server follows. */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { normName } from "@/features/home/share-classify";
import { humanError } from "@/lib/errors";
import { meKeys } from "@/lib/query/keys";
import { setSavedPlace } from "./saved.functions";
import type { SavedLink, SavedWhere } from "./types";
import type { WhereChoice } from "./where";

function whereOf(c: WhereChoice | null): SavedWhere | null {
	if (!c) return null;
	return {
		countryCode: c.countryCode,
		city: c.city?.name ?? null,
		cityKey: c.city ? normName(c.city.name) || c.city.name.toLowerCase() : null,
		lat: c.city?.lat ?? null,
		lng: c.city?.lng ?? null,
		at: Date.now(),
	};
}

export function useSetWhere() {
	const qc = useQueryClient();
	return useCallback(
		(ids: readonly string[], c: WhereChoice | null) => {
			const where = whereOf(c);
			qc.setQueryData<SavedLink[]>(meKeys.saved, (list) =>
				list?.map((l) => (ids.includes(l.id) ? { ...l, where } : l)),
			);
			return setSavedPlace({
				data: {
					ids: [...ids],
					where: c
						? {
								countryCode: c.countryCode,
								city: c.city
									? { name: c.city.name, lat: c.city.lat, lng: c.city.lng }
									: null,
							}
						: null,
				},
			})
				.then(() => true)
				.catch((e) => {
					toast.error(humanError(e));
					return false;
				})
				.finally(() => qc.invalidateQueries({ queryKey: meKeys.saved }));
		},
		[qc],
	);
}
