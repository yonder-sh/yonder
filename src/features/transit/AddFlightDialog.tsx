/**
 * Add a flight (SPEC §12.5 `AddFlightDialog()`), opened through
 * `useUi().openAddFlight({ dayId?, afterItemId?, target? })` — the Plan's "+"
 * menu, the FAB, a leg's "Flight…". With a pair `target` it saves that leg's
 * flight (`saveFlight`); otherwise it creates the airports, the departure,
 * layover and arrival stops and the flight legs in one go
 * (`createFlightWithAirports`, "+ Connection" for up to four segments).
 */
import { useTripMutation } from "@/components/common/use-trip-mutation";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { mustRedact } from "@/lib/auth/roles";
import { tripKeys } from "@/lib/query/keys";
import { useFormPresence } from "@/lib/realtime/form-presence";
import type { FlightDetails } from "@/lib/schemas/legs";
import { isProposed } from "@/lib/schemas/proposals";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { FlightForm } from "./components/FlightForm";
import { useFlightDefaults } from "./components/FlightSection";
import { createFlightWithAirports, saveFlight } from "./transit.functions";

export function AddFlightDialog() {
	const req = useUi((s) => s.addFlight);
	const close = useUi((s) => s.openAddFlight);
	const ws = useWorkspace();
	const { graph, ix, access, nav } = ws;
	const tripId = graph.trip.id;
	const keys = [
		tripKeys.graph(tripId),
		tripKeys.legs(tripId),
		tripKeys.counts(tripId),
	];
	const create = useTripMutation(
		(v: { segments: FlightDetails[]; bookingRef?: string }) =>
			createFlightWithAirports({
				data: {
					tripId,
					segments: v.segments,
					...(v.bookingRef ? { bookingRef: v.bookingRef } : {}),
					...(req?.afterItemId ? { afterItemId: req.afterItemId } : {}),
					...(req?.dayId ? { dayId: req.dayId } : {}),
				},
			}),
		{ keys, tripId },
	);
	const target = req?.target?.kind === "pair" ? req.target : null;
	const save = useTripMutation(
		(flight: FlightDetails) =>
			saveFlight({
				data: { target: target ?? (req?.target as never), flight },
			}),
		{ keys, tripId },
	);
	const open = req !== null;
	const leg = target
		? ix.legByPair.get(`${target.fromItemId}>${target.toItemId}`)
		: undefined;
	const existing = leg ? ix.legDetails(leg) : null;
	const day = ix.day(
		req?.dayId ?? (req?.afterItemId ? ix.item(req.afterItemId)?.dayId : null),
	);
	// FB-18/19: a pair's flight defaults to its stops' days and airports.
	const pairDefaults = useFlightDefaults(target);
	const redacted = mustRedact({ role: access.role, isGuest: access.isGuest });
	// FB-24: others see "Dennis is editing NH 744" / "Dennis is adding a flight…".
	useFormPresence(
		open
			? {
					k: "flight",
					m: existing?.kind === "flight" ? "edit" : "add",
					t: target
						? `leg:l.${target.fromItemId}.${target.toItemId}`
						: day
							? `dayh:${day.id}`
							: null,
				}
			: null,
	);
	return (
		<Dialog open={open} onOpenChange={(v) => (v ? null : close(null))}>
			<DialogContent
				data-testid={TESTID.addFlightDialog}
				className="max-h-[90dvh] overflow-y-auto sm:max-w-[640px]"
			>
				<DialogHeader>
					<DialogTitle>{target ? "Flight" : "Add a flight"}</DialogTitle>
					<DialogDescription>
						Times are local at each airport. We look up zones and coordinates
						from the airport codes.
					</DialogDescription>
				</DialogHeader>
				{open ? (
					<FlightForm
						multi={!target}
						initial={
							existing?.kind === "flight" ? [existing.flight] : undefined
						}
						key={`${pairDefaults?.fromIata ?? ""}:${pairDefaults?.toIata ?? ""}`}
						defaults={pairDefaults ?? { depDate: day?.date }}
						redacted={redacted}
						members={graph.members}
						stickyActions
						submitting={create.isPending || save.isPending}
						submitLabel={target ? "Save flight" : "Add flight"}
						onCancel={() => close(null)}
						onSubmit={(segments, bookingRef) => {
							if (target) {
								const [f] = segments;
								if (f)
									save.mutate(f, {
										onSuccess: () => {
											close(null);
											nav.select({ kind: "leg", target });
										},
									});
								return;
							}
							create.mutate(
								{ segments, bookingRef },
								{
									onSuccess: (r) => {
										close(null);
										if (!isProposed(r) && r.itemIds[0] && r.itemIds[1])
											nav.select({
												kind: "leg",
												target: {
													kind: "pair",
													fromItemId: r.itemIds[0],
													toItemId: r.itemIds[1],
												},
											});
									},
								},
							);
						}}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
