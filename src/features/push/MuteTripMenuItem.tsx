/**
 * "Mute notifications" in a trip's menu (Web Push, per trip and person).
 * Accounts only, and only where push is set up on the server.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { type PushSettingsDto, setTripMuted } from "@/functions/push.functions";
import { humanError } from "@/lib/errors";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { PUSH_TESTID } from "./testids";
import { pushSettingsKey, useHasAccount, usePushSettings } from "./use-push";

export function MuteTripMenuItem({
	iconless = false,
}: {
	/** The phone's text-only menu. */
	iconless?: boolean;
} = {}) {
	const { graph, mode } = useWorkspace();
	const live = mode === "live";
	const account = useHasAccount(live);
	const settings = usePushSettings(live && account);
	const qc = useQueryClient();
	const trip = graph.trip;
	const muted = !!settings.data?.mutedTrips.some((t) => t.id === trip.id);
	const toggle = useMutation({
		meta: { silent: true },
		mutationFn: (next: boolean) =>
			setTripMuted({ data: { tripId: trip.id, muted: next } }),
		onMutate: (next) =>
			qc.setQueryData<PushSettingsDto>(pushSettingsKey, (d) =>
				d
					? {
							...d,
							mutedTrips: next
								? [
										...d.mutedTrips,
										{ id: trip.id, name: trip.name, slug: trip.slug },
									]
								: d.mutedTrips.filter((t) => t.id !== trip.id),
						}
					: d,
			),
		onSuccess: (r) =>
			toast(
				r.muted
					? `Notifications muted for ${trip.name}`
					: `Notifications on for ${trip.name}`,
			),
		onError: (e) => {
			toast.error(humanError(e));
			void qc.invalidateQueries({ queryKey: pushSettingsKey });
		},
	});
	if (!live || !account || !settings.data?.publicKey) return null;
	return (
		<DropdownMenuItem
			onSelect={() => toggle.mutate(!muted)}
			data-testid={PUSH_TESTID.muteItem}
			data-muted={muted}
		>
			{iconless ? null : muted ? <Bell /> : <BellOff />}
			{muted ? "Unmute notifications" : "Mute notifications"}
		</DropdownMenuItem>
	);
}
