/**
 * The leg editor (SPEC §12.5 `LegOverview({ target })`, DESIGN §8.2) for
 * pair, stay and overnight targets: the summary line, the mode control
 * (Walk · Transit · Flight · Other), travellers, and the panel of the chosen
 * mode — walk (source, "Set time", "Reset to 12m"), transit (options, the
 * Japan note with "Open in Google Maps" and the N02 attribution, the custom
 * route builder, reserved times and booking), flight (ticket stub and the
 * full form) and other (kind chips, minutes, label). An overnight pair with
 * no mode offers "Set a stay…" and "Add transit…". The ⋯ menu has "Add
 * expense" (and "Add as expense" when a cost or booking is set).
 *
 * Every edit affordance goes through `useEditGuard` (viewers see it disabled
 * with the reason; suggesters' saves become proposals; provider fetches are
 * edit-only). Link guests see booking refs, seats and costs as "••".
 */
import { BedDouble, MoreHorizontal, Receipt, TrainFront } from "lucide-react";
import { useEffect, useState } from "react";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { LegSummary } from "@/components/common/leg-summary";
import {
	AvatarStack,
	MemberPicker,
	resolveMember,
} from "@/components/common/member";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { setDayStay } from "@/functions/days.functions";
import { can } from "@/lib/auth/roles";
import { railEstimateMin } from "@/lib/engine/suggest";
import { tripKeys } from "@/lib/query/keys";
import type { LegMode } from "@/lib/schemas/enums";
import type { LegTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { GoogleMapsLink } from "./components/bits";
import { FlightSection } from "./components/FlightSection";
import { ModeControl } from "./components/ModeControl";
import { OtherPanel } from "./components/OtherPanel";
import { TransitPanel } from "./components/TransitPanel";
import { WalkPanel } from "./components/WalkPanel";
import { mapsTravelMode } from "./lib/endpoints";
import { withFlightTime } from "./lib/flight";
import { currencyDecimals, fastestRideOf } from "./lib/route-view";
import { TRANSIT_TESTID } from "./testids";
import { type LegEditor, useLegEditor } from "./use-leg-editor";

export function LegOverview({ target }: { target: LegTarget }) {
	const ed = useLegEditor(target);
	const { leg, sched, ws } = ed;
	const { ix } = ws;
	const overnight =
		target.kind === "pair" &&
		ix.boundaryKind(target.fromItemId, target.toItemId) === "overnight";
	const [uiMode, setUiMode] = useState<LegMode | null>(leg?.mode ?? null);
	// Follow remote changes of the stored mode.
	useEffect(() => setUiMode(leg?.mode ?? null), [leg?.mode]);
	const guard = useEditGuard();
	const [addingTransit, setAddingTransit] = useState(false);

	const choose = (mode: LegMode) => {
		setUiMode(mode);
		if (mode === leg?.mode) return;
		if (mode === "flight") return; // the form saves it (a flight needs details)
		if (mode === "walk") {
			const est =
				sched?.suggestion?.mode === "walk"
					? sched.suggestion.estimateMin
					: null;
			ed.patch.mutate(
				{
					patch: {
						mode: "walk",
						durationMin: est ?? leg?.durationMin ?? sched?.minutes ?? null,
						estimateMin: est ?? leg?.estimateMin ?? null,
						source: "estimate",
						isEdited: false,
					},
				},
				{
					onSuccess: () => {
						if (ed.live && ws.access.mode === "edit") ed.walk.mutate();
					},
				},
			);
			return;
		}
		// The minutes, source and distance of another mode never carry over:
		// a 78-minute OSRM walk round a lake isn't a 78-minute "osrm" train
		// with 5.9 km on it (QA MT-06 residual). Until the options choose a
		// ride, the leg counts the rail estimate for the distance (SPEC §9.3).
		if (mode === "transit") {
			// Options fetched before (a walk switched back to transit): the
			// fastest ride is chosen again, as a fresh fetch would.
			const ride = fastestRideOf(ed.alternatives);
			if (ride) {
				ed.patch.mutate({
					patch: {
						mode: "transit",
						durationMin: ride.durationMin,
						estimateMin: ride.durationMin,
						source: ride.source,
						isEdited: ride.source === "manual",
						distanceM: null,
						details: { kind: "transit", route: ride, chosenId: ride.id },
					},
				});
				return;
			}
			const s = sched?.suggestion;
			const est =
				s?.mode === "transit"
					? s.estimateMin
					: s?.distanceKm != null
						? railEstimateMin(s.distanceKm)
						: null;
			const own = leg?.mode ? null : leg;
			ed.patch.mutate({
				patch: {
					mode: "transit",
					durationMin: own?.durationMin ?? est ?? sched?.minutes ?? null,
					estimateMin: est ?? own?.estimateMin ?? null,
					source: own?.source ?? "estimate",
					...(leg?.mode ? { isEdited: false } : {}),
					distanceM: null,
				},
			});
			return;
		}
		ed.patch.mutate({
			patch: {
				mode: "other",
				durationMin: leg?.durationMin ?? sched?.minutes ?? 15,
				source: "manual",
				isEdited: true,
				distanceM: null,
				details: { kind: "other", otherKind: "taxi" },
			},
		});
	};

	const showOvernight =
		overnight && !leg?.mode && !addingTransit && uiMode === null;

	return (
		<div data-testid={TESTID.legOverview} className="grid gap-4 text-sm">
			<div className="flex items-start gap-2">
				<div
					data-testid={TESTID.leg}
					className="flex min-w-0 flex-1 items-center gap-2"
				>
					<LegSummary leg={leg} schedule={withFlightTime(leg, sched)} />
				</div>
				<LegMenu ed={ed} />
			</div>
			{showOvernight ? (
				<OvernightPanel ed={ed} onAddTransit={() => setAddingTransit(true)} />
			) : (
				<>
					<ModeControl
						value={uiMode}
						onChange={choose}
						disabled={guard.disabled}
						reason={guard.reason}
						allowed={
							target.kind === "stay"
								? ["walk", "transit", "other"]
								: ["walk", "transit", "flight", "other"]
						}
					/>
					{target.kind === "pair" && uiMode !== null ? (
						<Travellers ed={ed} />
					) : null}
					{uiMode === "walk" ? <WalkPanel ed={ed} /> : null}
					{uiMode === "transit" ? <TransitPanel ed={ed} /> : null}
					{uiMode === "flight" ? <FlightSection ed={ed} /> : null}
					{uiMode === "other" ? <OtherPanel ed={ed} /> : null}
					{uiMode === null ? <UnsetHint ed={ed} /> : null}
				</>
			)}
		</div>
	);
}

function UnsetHint({ ed }: { ed: LegEditor }) {
	const s = ed.sched?.suggestion;
	// FB-03: an unset leg links to Google Maps in its suggested mode.
	const mapsMode = mapsTravelMode(null, s?.mode ?? null);
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
			<p className="text-xs text-muted-foreground">
				{s?.mode
					? `Not set yet — counted as ${s.label.replace(/\?$/, "")} until you choose.`
					: "Not set yet. Choose how you get there."}
			</p>
			{mapsMode ? (
				<GoogleMapsLink ends={ed.ends} mode={mapsMode} className="ml-auto" />
			) : null}
		</div>
	);
}

/** Travellers (DESIGN §8.2): members only; flights default them from the seats. */
function Travellers({ ed }: { ed: LegEditor }) {
	const { leg, ws } = ed;
	const guard = useEditGuard();
	const ids = leg?.assigneeIds ?? [];
	const people = ids
		.map((id) => resolveMember(ws.graph.members, id))
		.filter((m): m is NonNullable<typeof m> => !!m);
	return (
		<div
			data-testid={TRANSIT_TESTID.travellers}
			className="flex items-center gap-2"
		>
			<span className="text-xs text-muted-foreground">Travellers</span>
			<MemberPicker
				value={ids}
				disabled={guard.disabled}
				onChange={(memberIds) => ed.travellers.mutate(memberIds)}
				trigger={
					<Button
						variant="ghost"
						size="sm"
						className="h-7 gap-1.5 px-1.5"
						aria-label="Choose travellers"
						disabled={guard.disabled}
					>
						{people.length ? (
							<AvatarStack people={people} size={20} max={5} />
						) : (
							<span className="text-xs text-muted-foreground">Everyone</span>
						)}
					</Button>
				}
			/>
		</div>
	);
}

/** "No travel between these days." → Set a stay… / Add transit… */
function OvernightPanel({
	ed,
	onAddTransit,
}: {
	ed: LegEditor;
	onAddTransit: () => void;
}) {
	const { ws, target } = ed;
	const { ix, graph } = ws;
	const fromItem =
		target.kind === "pair" ? ix.item(target.fromItemId) : undefined;
	const dayId = fromItem?.dayId ?? null;
	const stays = graph.nodes
		.filter((n) => n.type === "place" && n.status !== "dropped")
		.sort(
			(a, b) =>
				Number(b.category === "lodging") - Number(a.category === "lodging") ||
				a.name.localeCompare(b.name),
		)
		.slice(0, 60);
	const stay = useTripMutation(
		(nodeId: string) =>
			setDayStay({ data: { fromDayId: dayId as string, nodeId } }),
		{ keys: [tripKeys.graph(graph.trip.id)], tripId: graph.trip.id },
	);
	return (
		<div data-testid={TRANSIT_TESTID.overnight} className="grid gap-3">
			<p className="flex items-center gap-2 text-muted-foreground">
				<BedDouble className="size-4" strokeWidth={1.5} />
				No travel between these days.
			</p>
			<div className="flex flex-wrap items-center gap-2">
				{dayId ? (
					<EditGuard>
						<Select onValueChange={(v) => stay.mutate(v)}>
							<SelectTrigger
								data-testid={TRANSIT_TESTID.overnightSetStay}
								className="h-8 w-44"
								aria-label="Set a stay"
							>
								<SelectValue placeholder="Set a stay…" />
							</SelectTrigger>
							<SelectContent>
								{stays.map((n) => (
									<SelectItem key={n.id} value={n.id}>
										{n.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</EditGuard>
				) : null}
				<EditGuard>
					<Button
						variant="outline"
						size="sm"
						className="gap-1.5"
						data-testid={TRANSIT_TESTID.overnightAddTransit}
						onClick={onAddTransit}
					>
						<TrainFront className="size-3.5" strokeWidth={1.5} /> Add transit…
					</Button>
				</EditGuard>
			</div>
		</div>
	);
}

/** Leg ⋯: "Add expense", and "Add as expense" when a cost or booking is set (EXTENSIONS §1.4). */
function LegMenu({ ed }: { ed: LegEditor }) {
	const { ws, details, leg, redacted } = ed;
	const openAddExpense = useUi((s) => s.openAddExpense);
	const mayMoney =
		ws.mode === "live" &&
		!ws.access.isGuest &&
		can({ role: ws.access.role, isGuest: ws.access.isGuest }, "manageExpenses");
	if (!mayMoney) return null;
	const cost =
		details?.kind === "flight" && !redacted ? details.flight.cost : undefined;
	const booked =
		(details?.kind === "transit" && !!details.booking) ||
		(details?.kind === "flight" && !!details.flight.bookingRef);
	const title = (() => {
		if (details?.kind === "flight") {
			const f = details.flight;
			return `${f.airline?.name ?? "Flight"} ${f.flightNumber ?? ""} ${f.from.iata}→${f.to.iata}`
				.replace(/\s+/g, " ")
				.trim();
		}
		if (details?.kind === "transit")
			return details.booking?.trainNumber ?? details.route?.label ?? "Transit";
		return leg?.mode === "other" ? "Taxi" : "Transport";
	})();
	const open = async (asExpense: boolean) => {
		const legId = await ed.ensure();
		openAddExpense({
			target: { kind: "leg", legId },
			title: title.slice(0, 120),
			category: "transport",
			...(asExpense && cost
				? {
						amountMinor: Math.round(
							cost.amount * 10 ** currencyDecimals(cost.currency),
						),
						currency: cost.currency,
					}
				: {}),
		});
	};
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-7 shrink-0"
					aria-label="Leg actions"
					data-testid={TRANSIT_TESTID.legMenu}
				>
					<MoreHorizontal className="size-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onSelect={() => void open(false)}>
					<Receipt className="size-4" /> Add expense
				</DropdownMenuItem>
				{cost || booked ? (
					<DropdownMenuItem onSelect={() => void open(true)}>
						<Receipt className="size-4" /> Add as expense
					</DropdownMenuItem>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
