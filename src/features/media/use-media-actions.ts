/**
 * Every media write the UI makes, through `useTripMutation` (optimistic where
 * it helps, the keys it changes, Undo after deletes; SPEC §0 rule 17).
 */
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { undoToast } from "@/components/common/undo-toast";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { updateTrip } from "@/functions/trips.functions";
import { humanError } from "@/lib/errors";
import { tripKeys } from "@/lib/query/keys";
import type { AttachmentVisibility } from "@/lib/schemas/enums";
import { isProposed } from "@/lib/schemas/proposals";
import type { AttachmentTarget, BundleTarget } from "@/lib/schemas/targets";
import {
	addLink,
	deleteAttachment,
	type MediaDto,
	refreshLinkMeta,
	restoreAttachment,
	setAttachmentVisibility,
	updateAttachment,
} from "./media.functions";

/**
 * `addLink` outside a hook (drops on Outline rows and pins): adds the new
 * tile to the cache and refreshes counts. A proposal result (suggest mode)
 * refreshes the proposals instead.
 */
export async function addLinkAndCache(
	qc: QueryClient,
	tripId: string,
	v: { target: BundleTarget; url: string; caption?: string },
): Promise<boolean> {
	const r = await addLink({ data: { tripId, ...v } });
	if (isProposed(r)) {
		await qc.invalidateQueries({ queryKey: tripKeys.proposals(tripId) });
		toast(`Suggested — ${r.proposed.summary}`);
		return false;
	}
	qc.setQueryData(tripKeys.media(tripId), (xs?: MediaDto[]) =>
		xs ? [...xs.filter((x) => x.id !== r.id), r] : [r],
	);
	await qc.invalidateQueries({ queryKey: tripKeys.counts(tripId) });
	return true;
}

const KIND_WORD: Record<MediaDto["kind"], string> = {
	photo: "Photo",
	video: "Video",
	embed: "Video link",
	link: "Link",
	pdf: "PDF",
};

export function useMediaActions(tripId: string) {
	const qc = useQueryClient();
	const media = tripKeys.media(tripId);
	const counts = tripKeys.counts(tripId);
	const activity = tripKeys.activity(tripId);
	const patchRow = (id: string, p: Partial<MediaDto>) =>
		qc.setQueryData(media, (xs?: MediaDto[]) =>
			xs?.map((x) => (x.id === id ? { ...x, ...p } : x)),
		);

	const link = useTripMutation(
		(v: { target: BundleTarget; url: string; caption?: string }) =>
			addLink({ data: { tripId, ...v } }),
		{
			keys: [media, counts, activity],
			tripId,
			onSuccess: (dto) => {
				qc.setQueryData(media, (xs?: MediaDto[]) =>
					xs ? [...xs.filter((x) => x.id !== dto.id), dto] : [dto],
				);
			},
		},
	);

	const caption = useTripMutation(
		(v: { id: string; caption: string | null }) =>
			updateAttachment({ data: v }),
		{
			keys: [media],
			tripId,
			optimistic: (_qc, v) => patchRow(v.id, { caption: v.caption }),
		},
	);

	const move = useTripMutation(
		(v: {
			id: string;
			target: AttachmentTarget;
			from: AttachmentTarget;
			label: string;
		}) => updateAttachment({ data: { id: v.id, target: v.target } }),
		{
			keys: [media, counts],
			tripId,
			optimistic: (_qc, v) => patchRow(v.id, { target: v.target }),
			onSuccess: (_r, v) =>
				undoToast(`Moved to ${v.label}`, async () => {
					await updateAttachment({ data: { id: v.id, target: v.from } });
					await qc.invalidateQueries({ queryKey: media });
				}),
		},
	);

	const remove = useTripMutation(
		(v: { id: string; kind: MediaDto["kind"] }) =>
			deleteAttachment({ data: { id: v.id } }),
		{
			keys: [media, counts],
			tripId,
			optimistic: (_qc, v) =>
				qc.setQueryData(media, (xs?: MediaDto[]) =>
					xs?.filter((x) => x.id !== v.id),
				),
			onSuccess: (_r, v) =>
				undoToast(`${KIND_WORD[v.kind]} deleted`, async () => {
					try {
						await restoreAttachment({ data: { id: v.id } });
					} catch (e) {
						toast.error(humanError(e));
					}
					await Promise.all([
						qc.invalidateQueries({ queryKey: media }),
						qc.invalidateQueries({ queryKey: counts }),
					]);
				}),
		},
	);

	const visibility = useTripMutation(
		(v: { id: string; visibility: AttachmentVisibility }) =>
			setAttachmentVisibility({ data: v }),
		{
			keys: [media, counts],
			optimistic: (_qc, v) => patchRow(v.id, { visibility: v.visibility }),
			onSuccess: (_r, v) =>
				toast(
					v.visibility === "members"
						? "Hidden from guests"
						: "Guests can see this again",
					{ id: `vis-${v.id}` },
				),
		},
	);

	const cover = useTripMutation(
		(v: { id: string | null }) =>
			updateTrip({ data: { tripId, coverAttachmentId: v.id } }),
		{
			keys: [tripKeys.graph(tripId), ["me", "trips"]],
			onSuccess: (_r, v) =>
				toast(v.id ? "Set as the trip cover" : "Cover removed"),
		},
	);

	const refresh = useTripMutation(
		(v: { id: string }) => refreshLinkMeta({ data: v }),
		{
			keys: [media],
			optimistic: (_qc, v) => patchRow(v.id, { status: "processing" }),
		},
	);

	return useMemo(
		() => ({
			link,
			caption,
			move,
			remove,
			/** Delete with the "… deleted · Undo" toast; a failure says why. */
			deleteItem: (m: Pick<MediaDto, "id" | "kind">) =>
				remove.mutate(
					{ id: m.id, kind: m.kind },
					{ onError: (e) => toast.error(humanError(e)) },
				),
			visibility,
			cover,
			refresh,
		}),
		[link, caption, move, remove, visibility, cover, refresh],
	);
}
