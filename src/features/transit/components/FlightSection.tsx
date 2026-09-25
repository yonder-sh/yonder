/**
 * Flight mode of the leg editor: the saved flight as a ticket stub with every
 * detail (DESIGN §7.1 "Ticket stub", §8.2; QA FLT-01, FLT-04, FLT-05), "Edit
 * flight", and the form. A conflicting save shows "… changed this flight ·
 * Review theirs · Overwrite" (DESIGN §8.9).
 */
import { Pencil, Plane } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EditGuard } from "@/components/common/edit-guard";
import { MemberAvatar, resolveMember } from "@/components/common/member";
import { useDisplayPrefs } from "@/components/common/time";
import { Button } from "@/components/ui/button";
import {
	flightArrDate,
	flightArrTime,
	flightDepDate,
	flightDepTime,
	flightTimes,
} from "@/lib/engine/flights";
import { hhmm, localDateTimeToEpoch, tzLabel } from "@/lib/engine/time";
import { errorCode } from "@/lib/errors";
import { formatDayDate, formatDuration } from "@/lib/format";
import { useFormPresence } from "@/lib/realtime/form-presence";
import type { FlightDetails } from "@/lib/schemas/legs";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { airportForNode } from "../lib/airports-client";
import { displayFlightNumber } from "../lib/flight";
import { clockText, formatMoney } from "../lib/route-view";
import { TRANSIT_TESTID } from "../testids";
import type { LegEditor } from "../use-leg-editor";
import { Masked } from "./bits";
import { FlightForm, type FlightFormProps } from "./FlightForm";

const CABIN: Record<string, string> = {
	economy: "Economy",
	premium_economy: "Premium economy",
	business: "Business",
	first: "First",
};

export function FlightSummary({
	flight,
	redacted,
	ed,
}: {
	flight: FlightDetails;
	redacted: boolean;
	ed: LegEditor;
}) {
	const members = ed.ws.graph.members;
	useDisplayPrefs(); // re-render on a 12/24 h switch
	// FB-18: the times it knows, else the plan's estimate.
	const t = flightTimes(flight);
	const mins = t.estimate ? null : t.minutes;
	const depDate = flightDepDate(flight) ?? "";
	const arrDate = flightArrDate(flight) ?? depDate;
	// Each end's zone label at its own instant (EDT vs EST, QA TZ-07; FB-20):
	// the time when known, else the plan's, else noon on the flight's date.
	const noon = (date: string, tz: string) =>
		localDateTimeToEpoch(`${date}T12:00`, tz) ?? Date.parse(`${date}T12:00Z`);
	const depAt =
		t.depMs ?? ed.sched?.flight?.depMs ?? noon(depDate, flight.from.tz);
	const arrAt =
		(t.depMs !== null ? t.arrMs : null) ??
		ed.sched?.flight?.arrMs ??
		noon(arrDate, flight.to.tz);
	const nextDay = arrDate > depDate;
	const depTime = flightDepTime(flight);
	const arrTime = flightArrTime(flight);
	const title = [flight.airline?.name, displayFlightNumber(flight.flightNumber)]
		.filter(Boolean)
		.join(" ");
	const facts: [string, React.ReactNode][] = [];
	if (flight.cabin) facts.push(["Cabin", CABIN[flight.cabin] ?? flight.cabin]);
	if (flight.aircraft) facts.push(["Aircraft", flight.aircraft]);
	const term = (a: FlightDetails["from"]) =>
		[
			a.terminal ? `T${a.terminal.replace(/^T/i, "")}` : null,
			a.gate ? `Gate ${a.gate}` : null,
		]
			.filter(Boolean)
			.join(" · ");
	if (flight.bookingRef || redacted)
		facts.push([
			"Booking ref",
			redacted ? (
				<Masked key="masked" />
			) : (
				<span key="ref" className="font-mono tnum">
					{flight.bookingRef}
				</span>
			),
		]);
	if (flight.baggage) facts.push(["Baggage", flight.baggage]);
	if (flight.cost || redacted)
		facts.push([
			"Cost",
			redacted ? (
				<Masked key="masked" />
			) : flight.cost ? (
				formatMoney(flight.cost.amount, flight.cost.currency)
			) : null,
		]);
	if (flight.points && !redacted)
		facts.push([
			"Points",
			`${flight.points.amount.toLocaleString("en")} ${flight.points.program}`,
		]);
	if (flight.fees && !redacted)
		facts.push(["Fees", formatMoney(flight.fees.amount, flight.fees.currency)]);
	return (
		<div data-testid={TRANSIT_TESTID.flightSummary} className="grid gap-3">
			<div className="relative grid grid-cols-[1fr_auto_1fr] items-stretch overflow-hidden rounded-lg border bg-card">
				<div className="grid gap-0.5 p-3">
					<span
						data-testid={TRANSIT_TESTID.flightDepClock}
						className="font-mono text-[15px] leading-5 font-semibold tnum"
					>
						{depTime ? (
							clockText(depTime)
						) : (
							<span className="font-sans text-xs font-normal text-muted-foreground">
								Time TBD
							</span>
						)}
					</span>
					<span className="text-[15px] leading-5 font-semibold tracking-wide">
						{flight.from.iata}
					</span>
					<span className="text-[11px] text-muted-foreground">
						{tzLabel(flight.from.tz, depAt)}
						{term(flight.from) ? ` · ${term(flight.from)}` : ""}
					</span>
				</div>
				<div className="flex flex-col items-center justify-center gap-1 border-x border-dashed px-3 text-muted-foreground">
					<Plane
						className="size-4 text-mode-flight"
						strokeWidth={1.5}
						aria-hidden
					/>
					<span className="font-mono text-[11px] tnum">
						{mins !== null
							? formatDuration(mins, { compact: true })
							: `~${formatDuration(t.minutes, { compact: true })} est.`}
					</span>
				</div>
				<div className="grid gap-0.5 p-3 text-right">
					<span className="font-mono text-[15px] leading-5 font-semibold tnum">
						{arrTime ? (
							clockText(arrTime)
						) : t.arrEstimated && t.arrMs !== null ? (
							`~${clockText(hhmm(t.arrMs, flight.to.tz))}`
						) : (
							<span className="font-sans text-xs font-normal text-muted-foreground">
								Time TBD
							</span>
						)}
						{nextDay ? (
							<sup className="ml-0.5 text-[9px] text-muted-foreground">+1</sup>
						) : null}
					</span>
					<span className="text-[15px] leading-5 font-semibold tracking-wide">
						{flight.to.iata}
					</span>
					<span className="text-[11px] text-muted-foreground">
						{tzLabel(flight.to.tz, arrAt)}
						{term(flight.to) ? ` · ${term(flight.to)}` : ""}
					</span>
				</div>
			</div>
			<p className="text-sm" data-testid={TRANSIT_TESTID.flightLine}>
				<span className="font-medium">{title || "Flight"}</span>
				<span className="text-muted-foreground">
					{" "}
					· {flight.from.iata} → {flight.to.iata}
					{flight.cabin ? ` · ${CABIN[flight.cabin]}` : ""}
					{mins !== null
						? ` · ${formatDuration(mins)}`
						: ` · ~${formatDuration(t.minutes)} est.`}
					{t.untimed ? " · times TBD" : t.arrEstimated ? " · arrival TBD" : ""}
				</span>
			</p>
			<p className="-mt-2 text-xs text-muted-foreground">
				{[
					flight.from.name !== flight.from.iata ||
					flight.to.name !== flight.to.iata
						? `${flight.from.name} → ${flight.to.name}`
						: null,
					depDate ? formatDayDate(depDate, { year: true }) : null,
				]
					.filter(Boolean)
					.join(" · ")}
			</p>
			{facts.length ? (
				<dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
					{facts.map(([k, v]) => (
						<div key={k} className="contents">
							<dt className="text-xs text-muted-foreground">{k}</dt>
							<dd className="min-w-0">{v}</dd>
						</div>
					))}
				</dl>
			) : null}
			{flight.seats.length ? (
				<div className="grid gap-1">
					<span className="text-xs text-muted-foreground">Seats</span>
					<ul className="flex flex-wrap gap-2">
						{flight.seats.map((s, i) => {
							const m = s.memberId ? resolveMember(members, s.memberId) : null;
							return (
								<li
									// biome-ignore lint/suspicious/noArrayIndexKey: seats are positional.
									key={i}
									className="inline-flex items-center gap-1.5 rounded-full bg-muted py-0.5 pr-2 pl-0.5 text-xs"
								>
									{m ? <MemberAvatar user={m} size={16} /> : null}
									<span>{m?.name ?? "Seat"}</span>
									{redacted ? (
										<Masked />
									) : (
										<span className="font-mono font-medium tnum">{s.seat}</span>
									)}
								</li>
							);
						})}
					</ul>
				</div>
			) : null}
		</div>
	);
}

/** The IATA code of the airport a node stands for, once the table is loaded. */
function useNodeAirport(nodeId: string | null | undefined): string | null {
	const { ix } = useWorkspace();
	const node = ix.node(nodeId);
	const coord = nodeId ? ix.coordOf(nodeId) : null;
	const [iata, setIata] = useState<string | null>(null);
	const lng = coord?.[0];
	const lat = coord?.[1];
	useEffect(() => {
		let live = true;
		if (!node) {
			setIata(null);
			return;
		}
		void airportForNode(
			node,
			lng !== undefined && lat !== undefined ? [lng, lat] : null,
		).then((a) => live && setIata(a?.iata ?? null));
		return () => {
			live = false;
		};
	}, [node, lng, lat]);
	return iata;
}

/**
 * A new flight's defaults for a pair (FB-18/19): the stops' days as its
 * dates and their airports (IATA code, else the airport within 5 km).
 */
export function useFlightDefaults(
	target: { fromItemId: string; toItemId: string } | null,
): FlightFormProps["defaults"] {
	const { ix } = useWorkspace();
	const fromIata = useNodeAirport(
		target ? ix.item(target.fromItemId)?.nodeId : null,
	);
	const toIata = useNodeAirport(
		target ? ix.item(target.toItemId)?.nodeId : null,
	);
	if (!target) return undefined;
	const dayDate = (itemId: string) => ix.day(ix.item(itemId)?.dayId)?.date;
	return {
		depDate: dayDate(target.fromItemId),
		arrDate: dayDate(target.toItemId),
		fromIata: fromIata ?? undefined,
		toIata: toIata ?? undefined,
	};
}

export function FlightSection({ ed }: { ed: LegEditor }) {
	const { details, leg, redacted, ws, target } = ed;
	const flight = details?.kind === "flight" ? details.flight : null;
	const [editing, setEditing] = useState(!flight);
	const [conflict, setConflict] = useState<null | { flight: FlightDetails }>(
		null,
	);
	const defaults = useFlightDefaults(target.kind === "pair" ? target : null);
	const fromIata = defaults?.fromIata;
	const toIata = defaults?.toIata;
	const save = (f: FlightDetails, overwrite = false) =>
		ed.flight.mutate(
			{
				flight: f,
				...(overwrite
					? {}
					: { expectedUpdatedAt: flight ? leg?.updatedAt : undefined }),
			},
			{
				onSuccess: () => {
					setConflict(null);
					setEditing(false);
				},
				onError: (e) => {
					if (errorCode(e) === "CONFLICT") setConflict({ flight: f });
				},
			},
		);
	// FB-24: while I'm in the flight form, others see "Dennis is editing NH 744 · Seats".
	const formRef = useRef<HTMLDivElement>(null);
	useFormPresence(
		target.kind === "pair" && (editing || !flight)
			? {
					k: "flight",
					m: flight ? "edit" : "add",
					t: `leg:l.${target.fromItemId}.${target.toItemId}`,
				}
			: null,
		formRef,
		{ whileFocused: true },
	);
	if (target.kind !== "pair")
		return (
			<p className="text-sm text-muted-foreground">
				A flight joins two stops. Use Transit or Other for this stay leg.
			</p>
		);
	return (
		<div className="grid gap-3">
			{flight && !editing ? (
				<>
					<FlightSummary flight={flight} redacted={redacted} ed={ed} />
					<EditGuard>
						<Button
							variant="outline"
							size="sm"
							className="w-fit gap-1.5"
							data-testid={TRANSIT_TESTID.flightEdit}
							onClick={() => setEditing(true)}
						>
							<Pencil className="size-3.5" /> Edit flight
						</Button>
					</EditGuard>
				</>
			) : (
				<div ref={formRef} className="contents">
					<FlightForm
						key={`${leg?.updatedAt ?? "new"}:${fromIata ?? ""}:${toIata ?? ""}`}
						initial={flight ? [flight] : undefined}
						defaults={defaults}
						redacted={redacted}
						members={ws.graph.members}
						submitting={ed.flight.isPending}
						onSubmit={([f]) => f && save(f)}
						onCancel={flight ? () => setEditing(false) : undefined}
						conflict={
							conflict
								? {
										onReview: () => {
											setConflict(null);
											setEditing(false);
										},
										onOverwrite: () => save(conflict.flight, true),
									}
								: null
						}
					/>
				</div>
			)}
		</div>
	);
}
