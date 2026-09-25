/**
 * The flight form (DESIGN §8.2; QA FLT-01…06): one or more segments ("+
 * Connection" in the Add flight dialog), each with airline and airport
 * comboboxes (lazy tables), local departure/arrival in each airport's zone
 * with the "6h35 flight" helper, terminal and gate, seats per member, cabin,
 * booking ref, baggage, aircraft, cost, points and fees.
 * Link guests see ref, seats, cost, points and fees as "••" and can't edit
 * them (the server keeps the stored values). Inline validation: "Required",
 * "Unknown airport", "Arrival is before departure". FB-18: only the airports
 * and the departure date are required; without times the helper shows the
 * great-circle estimate.
 */
import { cn } from "cn";
import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { assignableMembers, MemberAvatar } from "@/components/common/member";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	flightArrDate,
	flightArrTime,
	flightDepDate,
	flightDepTime,
	flightTimes,
} from "@/lib/engine/flights";
import {
	hhmm,
	localDateOf,
	localDateTimeToEpoch,
	tzLabel,
} from "@/lib/engine/time";
import type { GraphMember } from "@/lib/engine/types";
import { formatDayDate, formatDuration } from "@/lib/format";
import type { Cabin, FlightDetails } from "@/lib/schemas/legs";
import {
	type AirlineRow,
	type AirportRow,
	loadAirports,
	searchAirlines,
	searchAirports,
} from "../lib/airports-client";
import {
	dstNote,
	type FlightFieldError,
	type Fold,
	flightMinutes,
	normalizeFlightNumber,
	normalizeIata,
	repeatedTime,
	storedFold,
	tightConnection,
	validateFlight,
} from "../lib/flight";
import { TRANSIT_TESTID } from "../testids";
import { AddPersonRow, Masked, SectionLabel, TimeField } from "./bits";
import { CAPS_INPUT, SuggestInput } from "./SuggestInput";

const CABINS: { value: Cabin; label: string }[] = [
	{ value: "economy", label: "Economy" },
	{ value: "premium_economy", label: "Premium economy" },
	{ value: "business", label: "Business" },
	{ value: "first", label: "First" },
];

type Seg = {
	key: string;
	airlineIata: string;
	airlineText: string;
	flightNumber: string;
	fromText: string;
	fromIata: string;
	toText: string;
	toIata: string;
	depDate: string;
	depTime: string;
	arrDate: string;
	arrTime: string;
	/** QA TZ-07: which of a repeated local time ("later" = the second, EST). */
	depFold?: Fold;
	arrFold?: Fold;
	fromTerminal: string;
	fromGate: string;
	toTerminal: string;
	toGate: string;
	cabin: Cabin | "";
	seats: Record<string, string>;
	ref: string;
	baggage: string;
	aircraft: string;
	costAmount: string;
	costCurrency: string;
	pointsProgram: string;
	pointsAmount: string;
	feesAmount: string;
	feesCurrency: string;
	/** Masked values from a redacted graph, sent back as they are. */
	redactedSeats?: FlightDetails["seats"];
};

let n = 0;
const key = () => `f${++n}`;

function segOf(f: FlightDetails | null, d: Partial<Seg> = {}): Seg {
	return {
		key: key(),
		airlineIata: f?.airline?.iata ?? "",
		airlineText: f?.airline
			? `${f.airline.iata ? `${f.airline.iata} · ` : ""}${f.airline.name}`
			: "",
		flightNumber: f?.flightNumber
			? f.flightNumber.replace(/^([A-Z0-9]{2})(\d)/, "$1 $2")
			: "",
		fromText: f?.from.iata ?? "",
		fromIata: f?.from.iata ?? "",
		toText: f?.to.iata ?? "",
		toIata: f?.to.iata ?? "",
		depDate: (f && flightDepDate(f)) ?? "",
		depTime: (f && flightDepTime(f)) ?? "",
		arrDate: (f && flightArrDate(f)) ?? "",
		arrTime: (f && flightArrTime(f)) ?? "",
		depFold: f?.depFold,
		arrFold: f?.arrFold,
		fromTerminal: f?.from.terminal ?? "",
		fromGate: f?.from.gate ?? "",
		toTerminal: f?.to.terminal ?? "",
		toGate: f?.to.gate ?? "",
		cabin: f?.cabin ?? "",
		seats: Object.fromEntries(
			(f?.seats ?? []).flatMap((s) =>
				s.memberId ? [[s.memberId, s.seat]] : [],
			),
		),
		ref: f?.bookingRef ?? "",
		baggage: f?.baggage ?? "",
		aircraft: f?.aircraft ?? "",
		costAmount: f?.cost ? String(f.cost.amount) : "",
		costCurrency: f?.cost?.currency ?? "USD",
		pointsProgram: f?.points?.program ?? "",
		pointsAmount: f?.points ? String(f.points.amount) : "",
		feesAmount: f?.fees ? String(f.fees.amount) : "",
		feesCurrency: f?.fees?.currency ?? f?.cost?.currency ?? "USD",
		redactedSeats: f?.seats,
		...d,
	};
}

/** "YYYY-MM-DDTHH:mm" when both parts are there, else "" (FB-18: times are optional). */
const localOf = (date: string, time: string) =>
	date && time ? `${date}T${time}` : "";

/** QA FLT-02 per segment (by its key); empty when everything is valid. */
function validateSegments(
	segs: readonly Seg[],
	lookup: (iata: string) => { tz: string } | null,
): Record<string, FlightFieldError[]> {
	const errs: Record<string, FlightFieldError[]> = {};
	for (const s of segs) {
		const e = validateFlight(
			{
				flightNumber: s.flightNumber,
				from: s.fromIata || s.fromText,
				to: s.toIata || s.toText,
				depDate: s.depDate,
				depLocal: localOf(s.depDate, s.depTime),
				arrLocal: localOf(s.arrDate, s.arrTime),
				depFold: s.depFold,
				arrFold: s.arrFold,
			},
			lookup,
		);
		if (e.length) errs[s.key] = e;
	}
	return errs;
}

const toNum = (s: string): number | null => {
	const v = Number.parseFloat(s.replace(/,/g, ""));
	return Number.isFinite(v) && v >= 0 ? v : null;
};

export type FlightFormProps = {
	/** Existing segments (leg: one). */
	initial?: FlightDetails[];
	/** Defaults for a new form (dates of the stops' days, their airports). */
	defaults?: {
		depDate?: string;
		arrDate?: string;
		fromIata?: string;
		toIata?: string;
	};
	/** "+ Connection" (the Add flight dialog). */
	multi?: boolean;
	/** Link guests: booking values masked and read-only. */
	redacted?: boolean;
	submitting?: boolean;
	submitLabel?: string;
	/** A stale save (someone else saved first). */
	conflict?: {
		who?: string;
		onReview: () => void;
		onOverwrite: () => void;
	} | null;
	onSubmit: (segments: FlightDetails[], bookingRef?: string) => void;
	onCancel?: () => void;
	members: readonly GraphMember[];
	/** In a padded (p-6) scrolling dialog: keep Cancel/Save in view. */
	stickyActions?: boolean;
};

export function FlightForm({
	initial,
	defaults,
	multi,
	redacted,
	submitting,
	submitLabel = "Save flight",
	conflict,
	onSubmit,
	onCancel,
	members: allMembers,
	stickyActions,
}: FlightFormProps) {
	const guard = useEditGuard();
	const members = assignableMembers(allMembers);
	const [segs, setSegs] = useState<Seg[]>(() =>
		initial?.length
			? initial.map((f) => segOf(f))
			: [
					segOf(null, {
						depDate: defaults?.depDate ?? "",
						arrDate: defaults?.arrDate ?? defaults?.depDate ?? "",
						fromText: defaults?.fromIata ?? "",
						fromIata: defaults?.fromIata ?? "",
						toText: defaults?.toIata ?? "",
						toIata: defaults?.toIata ?? "",
					}),
				],
	);
	const [airports, setAirports] = useState<Map<string, AirportRow> | null>(
		null,
	);
	const [submitErrors, setSubmitErrors] = useState<
		Record<string, FlightFieldError[]>
	>({});
	/** A save was refused: from then on, errors follow the fields (QA MT-15). */
	const [checked, setChecked] = useState(false);
	const [sharedRef, setSharedRef] = useState(initial?.[0]?.bookingRef ?? "");
	useEffect(() => {
		let live = true;
		void loadAirports().then((a) => live && setAirports(a.byIata));
		return () => {
			live = false;
		};
	}, []);
	const known = (iata: string) => airports?.get(normalizeIata(iata)) ?? null;
	const disabled = guard.disabled || !!submitting;
	const up = (k: string, p: Partial<Seg>) =>
		setSegs((xs) => xs.map((s) => (s.key === k ? { ...s, ...p } : s)));

	const toDetails = (
		s: Seg,
		lookup: (iata: string) => AirportRow | null = known,
	): FlightDetails | null => {
		const from = lookup(s.fromIata || s.fromText);
		const to = lookup(s.toIata || s.toText);
		if (!from || !to) return null;
		const airport = (a: AirportRow, terminal: string, gate: string) => ({
			iata: a.iata,
			name: a.name,
			city: a.city,
			country: a.country,
			tz: a.tz,
			lat: a.lat,
			lng: a.lng,
			...(terminal.trim() ? { terminal: terminal.trim().slice(0, 20) } : {}),
			...(gate.trim() ? { gate: gate.trim().slice(0, 20) } : {}),
		});
		const cost = toNum(s.costAmount);
		const points = toNum(s.pointsAmount);
		const fees = toNum(s.feesAmount);
		const airlineName = s.airlineText.replace(/^[A-Z0-9]{2} · /, "").trim();
		const depLocal = localOf(s.depDate, s.depTime);
		const arrLocal = localOf(s.arrDate, s.arrTime);
		const f: FlightDetails = {
			flightNumber: normalizeFlightNumber(s.flightNumber) ?? undefined,
			from: airport(from, s.fromTerminal, s.fromGate),
			to: airport(to, s.toTerminal, s.toGate),
			// FB-18: the dates always, the times when known.
			depDate: s.depDate,
			...(s.arrDate ? { arrDate: s.arrDate } : {}),
			...(depLocal ? { depLocal } : {}),
			...(depLocal && arrLocal ? { arrLocal } : {}),
			seats: redacted
				? (s.redactedSeats ?? [])
				: members
						.filter((m) => s.seats[m.id]?.trim())
						.map((m) => ({
							memberId: m.id,
							seat: (s.seats[m.id] ?? "").trim().toUpperCase().slice(0, 20),
						})),
		};
		if (airlineName || s.airlineIata)
			f.airline = {
				...(s.airlineIata ? { iata: s.airlineIata } : {}),
				name: (airlineName || s.airlineIata).slice(0, 200),
			};
		const depFold = f.depLocal
			? storedFold(f.depLocal, from.tz, s.depFold)
			: undefined;
		const arrFold = f.arrLocal
			? storedFold(f.arrLocal, to.tz, s.arrFold)
			: undefined;
		if (!f.flightNumber) delete f.flightNumber;
		if (depFold) f.depFold = depFold;
		if (arrFold) f.arrFold = arrFold;
		if (s.cabin) f.cabin = s.cabin;
		if (!redacted) {
			const ref = (multi ? sharedRef : s.ref).trim().toUpperCase();
			if (ref) f.bookingRef = ref.slice(0, 40);
			if (cost !== null)
				f.cost = {
					amount: cost,
					currency: s.costCurrency.toUpperCase().slice(0, 3),
				};
			if (points !== null && s.pointsProgram.trim())
				f.points = {
					amount: points,
					program: s.pointsProgram.trim().slice(0, 80),
				};
			if (fees !== null)
				f.fees = {
					amount: fees,
					currency: s.feesCurrency.toUpperCase().slice(0, 3),
				};
		}
		if (s.baggage.trim()) f.baggage = s.baggage.trim().slice(0, 200);
		if (s.aircraft.trim()) f.aircraft = s.aircraft.trim().slice(0, 100);
		return f;
	};

	// Once a save was refused, errors are recomputed as the fields change, so a
	// fixed field ("JFKK" → JFK, a flight number typed in) clears at once.
	const liveErrors = useMemo(
		() =>
			checked && airports
				? validateSegments(
						segs,
						(iata) => airports.get(normalizeIata(iata)) ?? null,
					)
				: null,
		[checked, airports, segs],
	);
	const errors = liveErrors ?? submitErrors;

	const submit = async () => {
		// The airport table is a lazy chunk: validate against it once it's there.
		const { byIata } = await loadAirports();
		const lookup = (iata: string) => byIata.get(normalizeIata(iata)) ?? null;
		const errs = validateSegments(segs, lookup);
		setSubmitErrors(errs);
		if (Object.keys(errs).length) {
			setChecked(true);
			return;
		}
		const out = segs
			.map((s) => toDetails(s, lookup))
			.filter((f): f is FlightDetails => !!f);
		if (out.length !== segs.length) return;
		onSubmit(
			out,
			multi && !redacted && sharedRef.trim()
				? sharedRef.trim().toUpperCase()
				: undefined,
		);
	};

	const errorOf = (s: Seg, field: FlightFieldError["field"]) =>
		errors[s.key]?.find((e) => e.field === field)?.message;

	return (
		<div
			data-testid={TRANSIT_TESTID.flightForm}
			className="@container grid gap-4"
		>
			{segs.map((s, i) => {
				const from = known(s.fromIata || s.fromText);
				const to = known(s.toIata || s.toText);
				const mins =
					from && to && s.depDate && s.depTime && s.arrDate && s.arrTime
						? flightMinutes(
								{
									local: `${s.depDate}T${s.depTime}`,
									tz: from.tz,
									fold: s.depFold,
								},
								{
									local: `${s.arrDate}T${s.arrTime}`,
									tz: to.tz,
									fold: s.arrFold,
								},
							)
						: null;
				const prev = i > 0 ? segs[i - 1] : undefined;
				const prevDetails = prev ? toDetails(prev) : null;
				const cur = toDetails(s);
				const layover =
					prevDetails && cur ? tightConnection(prevDetails, cur) : null;
				return (
					<div key={s.key} className="grid gap-3">
						{layover ? (
							<div className="flex h-9 items-center justify-center gap-2 rounded-md bg-hatch text-[11px] text-muted-foreground">
								Layover {formatDuration(layover.minutes)} ·{" "}
								{prevDetails?.to.iata}
								{layover.tight ? (
									<span className="rounded-full bg-warning-wash px-1.5 text-warning">
										Tight connection
									</span>
								) : null}
							</div>
						) : null}
						<fieldset
							data-testid={TRANSIT_TESTID.flightSegment}
							className="grid gap-3 rounded-lg border bg-background/60 p-3"
						>
							<legend className="sr-only">Flight {i + 1}</legend>
							{segs.length > 1 ? (
								<SectionLabel
									action={
										<Button
											variant="ghost"
											size="icon"
											className="size-6"
											aria-label={`Remove flight ${i + 1}`}
											data-testid={TRANSIT_TESTID.flightRemoveSegment}
											disabled={disabled}
											onClick={() =>
												setSegs((xs) => xs.filter((x) => x.key !== s.key))
											}
										>
											<X className="size-3.5" />
										</Button>
									}
								>
									Flight {i + 1}
								</SectionLabel>
							) : null}
							<div className="grid grid-cols-[1fr_6.5rem] gap-3">
								<Row label="Airline">
									<SuggestInput<AirlineRow>
										value={s.airlineText}
										aria-label="Airline"
										testId={TRANSIT_TESTID.flightAirline}
										itemTestId={TRANSIT_TESTID.airlineOption}
										caps
										placeholder="Search airlines"
										disabled={disabled}
										onChange={(t) =>
											up(s.key, { airlineText: t, airlineIata: "" })
										}
										load={(q) => searchAirlines(q)}
										itemKey={(a) => a.iata}
										renderItem={(a) => (
											<span className="flex items-center gap-2">
												<span className="w-7 font-mono text-xs font-semibold">
													{a.iata}
												</span>
												<span className="truncate">{a.name}</span>
											</span>
										)}
										onPick={(a) => {
											const num = s.flightNumber.replace(
												/^[A-Z0-9]{2}\s?/i,
												"",
											);
											up(s.key, {
												airlineIata: a.iata,
												airlineText: `${a.iata} · ${a.name}`,
												flightNumber: s.flightNumber
													? s.flightNumber
													: `${a.iata} ${num}`.trim(),
											});
										}}
									/>
								</Row>
								<Row label="Flight no." error={errorOf(s, "flightNumber")}>
									<Input
										data-testid={TRANSIT_TESTID.flightNumber}
										aria-label="Flight number"
										{...CAPS_INPUT}
										aria-invalid={!!errorOf(s, "flightNumber") || undefined}
										value={s.flightNumber}
										maxLength={12}
										placeholder="e.g. NH 9"
										disabled={disabled}
										onChange={(e) =>
											up(s.key, { flightNumber: e.target.value.toUpperCase() })
										}
										onBlur={() => {
											const nn = normalizeFlightNumber(s.flightNumber);
											if (nn)
												up(s.key, {
													flightNumber: nn.replace(
														/^([A-Z0-9]{2})(\d)/,
														"$1 $2",
													),
												});
										}}
										className="h-8 font-mono uppercase tnum placeholder:font-sans placeholder:normal-case"
									/>
								</Row>
							</div>
							<div className="grid gap-3 @lg:grid-cols-2">
								<AirportRowFields
									side="From"
									seg={s}
									text={s.fromText}
									airport={from}
									error={errorOf(s, "from")}
									disabled={disabled}
									date={s.depDate}
									time={s.depTime}
									fold={s.depFold}
									onFold={(depFold) => up(s.key, { depFold })}
									dateError={errorOf(s, "depLocal")}
									terminal={s.fromTerminal}
									gate={s.fromGate}
									testIds={{
										airport: TRANSIT_TESTID.flightFrom,
										date: TRANSIT_TESTID.flightDepDate,
										time: TRANSIT_TESTID.flightDepTime,
										terminal: TRANSIT_TESTID.flightFromTerminal,
										gate: TRANSIT_TESTID.flightFromGate,
									}}
									onText={(t) =>
										up(s.key, { fromText: t.toUpperCase(), fromIata: "" })
									}
									onPick={(a) =>
										up(s.key, { fromText: a.iata, fromIata: a.iata })
									}
									onDate={(v) =>
										up(s.key, {
											depDate: v,
											...(s.arrDate ? {} : { arrDate: v }),
										})
									}
									onTime={(v) => up(s.key, { depTime: v })}
									onTerminal={(v) => up(s.key, { fromTerminal: v })}
									onGate={(v) => up(s.key, { fromGate: v })}
								/>
								<AirportRowFields
									side="To"
									seg={s}
									text={s.toText}
									airport={to}
									error={errorOf(s, "to")}
									disabled={disabled}
									date={s.arrDate}
									time={s.arrTime}
									fold={s.arrFold}
									onFold={(arrFold) => up(s.key, { arrFold })}
									dateError={errorOf(s, "arrLocal")}
									terminal={s.toTerminal}
									gate={s.toGate}
									testIds={{
										airport: TRANSIT_TESTID.flightTo,
										date: TRANSIT_TESTID.flightArrDate,
										time: TRANSIT_TESTID.flightArrTime,
										terminal: TRANSIT_TESTID.flightToTerminal,
										gate: TRANSIT_TESTID.flightToGate,
									}}
									onText={(t) =>
										up(s.key, { toText: t.toUpperCase(), toIata: "" })
									}
									onPick={(a) => up(s.key, { toText: a.iata, toIata: a.iata })}
									onDate={(v) => up(s.key, { arrDate: v })}
									onTime={(v) => up(s.key, { arrTime: v })}
									onTerminal={(v) => up(s.key, { toTerminal: v })}
									onGate={(v) => up(s.key, { toGate: v })}
								/>
							</div>
							<p
								data-testid={TRANSIT_TESTID.flightDuration}
								className={cn(
									"-mt-1 font-mono text-xs tnum",
									mins !== null && mins <= 0
										? "text-destructive"
										: "text-muted-foreground",
								)}
							>
								{mins !== null
									? mins > 0
										? `${formatDuration(mins)} flight`
										: "Arrival is before departure"
									: from && to
										? estimateText(s, from, to)
										: " "}
							</p>
							<div className="grid grid-cols-2 gap-3">
								<Row label="Cabin">
									<Select
										value={s.cabin}
										disabled={disabled}
										onValueChange={(v) => up(s.key, { cabin: v as Cabin })}
									>
										<SelectTrigger
											data-testid={TRANSIT_TESTID.flightCabin}
											className="h-8 w-full"
											aria-label="Cabin"
										>
											<SelectValue placeholder="Cabin" />
										</SelectTrigger>
										<SelectContent>
											{CABINS.map((c) => (
												<SelectItem key={c.value} value={c.value}>
													{c.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</Row>
								<Row label="Aircraft">
									<Input
										data-testid={TRANSIT_TESTID.flightAircraft}
										aria-label="Aircraft"
										value={s.aircraft}
										maxLength={100}
										placeholder="Optional"
										disabled={disabled}
										onChange={(e) => up(s.key, { aircraft: e.target.value })}
										className="h-8"
									/>
								</Row>
							</div>
							{members.length ? (
								<Row label="Seats">
									<div className="grid gap-1.5">
										{members.map((m) => (
											<div key={m.id} className="flex items-center gap-2">
												<MemberAvatar user={m} size={20} />
												<span className="min-w-0 flex-1 truncate text-sm">
													{m.name}
												</span>
												{redacted ? (
													<Masked />
												) : (
													<Input
														data-testid={TRANSIT_TESTID.flightSeat}
														data-member={m.id}
														aria-label={`Seat for ${m.name}`}
														{...CAPS_INPUT}
														value={s.seats[m.id] ?? ""}
														maxLength={20}
														placeholder="Seat"
														disabled={disabled}
														onChange={(e) =>
															up(s.key, {
																seats: {
																	...s.seats,
																	[m.id]: e.target.value.toUpperCase(),
																},
															})
														}
														className="h-8 w-20 font-mono uppercase tnum placeholder:font-sans placeholder:normal-case"
													/>
												)}
											</div>
										))}
										{redacted ? null : <AddPersonRow disabled={disabled} />}
									</div>
								</Row>
							) : null}
							<div className="grid grid-cols-2 gap-3">
								{multi ? null : (
									<Row label="Booking ref">
										{redacted ? (
											<Masked />
										) : (
											<Input
												data-testid={TRANSIT_TESTID.flightRef}
												aria-label="Booking ref"
												{...CAPS_INPUT}
												value={s.ref}
												maxLength={40}
												placeholder="Optional"
												disabled={disabled}
												onChange={(e) =>
													up(s.key, { ref: e.target.value.toUpperCase() })
												}
												className="h-8 font-mono uppercase tnum placeholder:font-sans placeholder:normal-case"
											/>
										)}
									</Row>
								)}
								<Row label="Baggage">
									<Input
										data-testid={TRANSIT_TESTID.flightBaggage}
										aria-label="Baggage"
										value={s.baggage}
										maxLength={200}
										placeholder="Optional"
										disabled={disabled}
										onChange={(e) => up(s.key, { baggage: e.target.value })}
										className="h-8"
									/>
								</Row>
							</div>
							<div className="grid gap-3 @lg:grid-cols-3">
								<Row label="Cost">
									{redacted ? (
										<Masked />
									) : (
										<div className="flex gap-1">
											<Input
												data-testid={TRANSIT_TESTID.flightCostCurrency}
												aria-label="Cost currency"
												{...CAPS_INPUT}
												value={s.costCurrency}
												maxLength={3}
												disabled={disabled}
												onChange={(e) =>
													up(s.key, {
														costCurrency: e.target.value.toUpperCase(),
													})
												}
												className="h-8 w-16 shrink-0 font-mono uppercase"
											/>
											<Input
												data-testid={TRANSIT_TESTID.flightCostAmount}
												aria-label="Cost amount"
												placeholder="Amount"
												inputMode="decimal"
												value={s.costAmount}
												disabled={disabled}
												onChange={(e) =>
													up(s.key, { costAmount: e.target.value })
												}
												className="h-8 min-w-0 font-mono tnum placeholder:font-sans"
											/>
										</div>
									)}
								</Row>
								<Row label="Points">
									{redacted ? (
										<Masked />
									) : (
										<div className="flex gap-1">
											<Input
												data-testid={TRANSIT_TESTID.flightPointsProgram}
												aria-label="Points program"
												placeholder="Program"
												value={s.pointsProgram}
												maxLength={80}
												disabled={disabled}
												onChange={(e) =>
													up(s.key, { pointsProgram: e.target.value })
												}
												className="h-8 min-w-0 flex-1"
											/>
											<Input
												data-testid={TRANSIT_TESTID.flightPointsAmount}
												aria-label="Points"
												placeholder="Points"
												inputMode="numeric"
												value={s.pointsAmount}
												disabled={disabled}
												onChange={(e) =>
													up(s.key, { pointsAmount: e.target.value })
												}
												className="h-8 w-20 shrink-0 font-mono tnum placeholder:font-sans"
											/>
										</div>
									)}
								</Row>
								<Row label="Fees">
									{redacted ? (
										<Masked />
									) : (
										<Input
											data-testid={TRANSIT_TESTID.flightFeesAmount}
											aria-label={`Fees (${s.feesCurrency})`}
											inputMode="decimal"
											value={s.feesAmount}
											placeholder={`Taxes and fees (${s.feesCurrency || "USD"})`}
											disabled={disabled}
											onChange={(e) =>
												up(s.key, { feesAmount: e.target.value })
											}
											className="h-8 font-mono tnum placeholder:font-sans"
										/>
									)}
								</Row>
							</div>
						</fieldset>
					</div>
				);
			})}
			{multi ? (
				<div className="grid gap-3">
					<Button
						variant="ghost"
						size="sm"
						className="h-8 w-fit gap-1.5 px-2"
						data-testid={TRANSIT_TESTID.flightAddConnection}
						disabled={disabled || segs.length >= 4}
						onClick={() => {
							const last = segs.at(-1);
							setSegs((xs) => [
								...xs,
								segOf(null, {
									fromText: last?.toIata || last?.toText || "",
									fromIata: last?.toIata ?? "",
									depDate: last?.arrDate ?? "",
									arrDate: last?.arrDate ?? "",
									cabin: last?.cabin ?? "",
									airlineIata: last?.airlineIata ?? "",
									airlineText: last?.airlineText ?? "",
								}),
							]);
						}}
					>
						<Plus className="size-4" /> Connection
					</Button>
					<Row label="Booking ref">
						{redacted ? (
							<Masked />
						) : (
							<Input
								data-testid={TRANSIT_TESTID.flightRef}
								aria-label="Booking ref"
								{...CAPS_INPUT}
								value={sharedRef}
								maxLength={40}
								placeholder="Optional"
								disabled={disabled}
								onChange={(e) => setSharedRef(e.target.value.toUpperCase())}
								className="h-8 w-40 font-mono uppercase tnum placeholder:font-sans placeholder:normal-case"
							/>
						)}
					</Row>
				</div>
			) : null}
			{conflict ? (
				<div
					data-testid={TRANSIT_TESTID.flightConflict}
					className="flex flex-wrap items-center gap-2 rounded-md bg-warning-wash px-3 py-2 text-xs"
				>
					<span className="text-warning">
						{conflict.who
							? `${conflict.who} changed this flight`
							: "This flight changed"}
					</span>
					<Button
						variant="ghost"
						size="sm"
						className="h-6 px-2 text-xs"
						onClick={conflict.onReview}
					>
						Review theirs
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className="h-6 px-2 text-xs"
						onClick={conflict.onOverwrite}
					>
						Overwrite
					</Button>
				</div>
			) : null}
			<div
				className={cn(
					"flex justify-end gap-2",
					stickyActions &&
						"sticky -bottom-6 z-10 -mx-6 -mb-6 border-t bg-background px-6 py-3",
				)}
			>
				{onCancel ? (
					<Button variant="ghost" size="sm" onClick={onCancel}>
						Cancel
					</Button>
				) : null}
				<Button
					size="sm"
					data-testid={TRANSIT_TESTID.flightSave}
					disabled={disabled}
					onClick={() => void submit()}
				>
					{submitting ? "Saving…" : submitLabel}
				</Button>
			</div>
		</div>
	);
}

/**
 * FB-18: without both times, the great-circle estimate ("~14h 5m flight
 * est."), and with only the departure the arrival it implies.
 */
function estimateText(s: Seg, from: AirportRow, to: AirportRow): string {
	const t = flightTimes({
		from,
		to,
		depLocal: localOf(s.depDate, s.depTime) || undefined,
		depFold: s.depFold,
	});
	const est = `~${formatDuration(t.minutes)} flight est.`;
	if (t.arrMs === null) return `${est} · add times when you know them`;
	return `${est} · arrives ~${hhmm(t.arrMs, to.tz)} ${tzLabel(to.tz, t.arrMs)}${localDateOf(t.arrMs, to.tz) !== s.depDate ? ` (${formatDayDate(localDateOf(t.arrMs, to.tz))})` : ""}`;
}

function Row({
	label,
	error,
	children,
	field,
}: {
	label: string;
	error?: string;
	children: React.ReactNode;
	field?: string;
}) {
	return (
		<div className="grid min-w-0 gap-1">
			<span className="text-xs text-muted-foreground">{label}</span>
			{children}
			{error ? (
				<span
					data-testid={TRANSIT_TESTID.flightError}
					data-field={field}
					role="alert"
					className="text-xs text-destructive"
				>
					{error}
				</span>
			) : null}
		</div>
	);
}

function AirportRowFields({
	side,
	seg,
	text,
	airport,
	error,
	disabled,
	date,
	time,
	fold,
	onFold,
	dateError,
	terminal,
	gate,
	testIds,
	onText,
	onPick,
	onDate,
	onTime,
	onTerminal,
	onGate,
}: {
	side: "From" | "To";
	seg: Seg;
	text: string;
	airport: AirportRow | null;
	error?: string;
	disabled?: boolean;
	date: string;
	time: string;
	fold?: Fold;
	onFold: (fold: Fold | undefined) => void;
	dateError?: string;
	terminal: string;
	gate: string;
	testIds: {
		airport: string;
		date: string;
		time: string;
		terminal: string;
		gate: string;
	};
	onText: (t: string) => void;
	onPick: (a: AirportRow) => void;
	onDate: (v: string) => void;
	onTime: (v: string) => void;
	onTerminal: (v: string) => void;
	onGate: (v: string) => void;
}) {
	// FB-20: zone labels for this flight's own date (the other end's while
	// this one is empty); only a form with no date at all reads today's.
	const labelDate = date || seg.depDate || seg.arrDate;
	const at = useMemo(
		() => (labelDate ? Date.parse(`${labelDate}T12:00:00Z`) : Date.now()),
		[labelDate],
	);
	const repeated = airport ? repeatedTime(date, time, airport.tz) : null;
	return (
		<div className="grid min-w-0 gap-2">
			<Row label={side} error={error} field={side === "From" ? "from" : "to"}>
				<SuggestInput<AirportRow>
					value={text}
					aria-label={`${side} airport`}
					testId={testIds.airport}
					itemTestId={TRANSIT_TESTID.airportOption}
					caps
					placeholder="Code or city"
					disabled={disabled}
					inputClassName="font-mono uppercase placeholder:font-sans placeholder:normal-case"
					onChange={onText}
					load={(q) => searchAirports(q)}
					itemKey={(a) => a.iata}
					renderItem={(a) => (
						<span className="flex items-center gap-2">
							<span className="w-9 font-mono text-xs font-semibold">
								{a.iata}
							</span>
							<span className="min-w-0 flex-1 truncate">
								{a.city} · {a.name}
							</span>
							<span className="font-mono text-[11px] text-muted-foreground">
								{tzLabel(a.tz, at)}
							</span>
						</span>
					)}
					onPick={onPick}
				/>
			</Row>
			{airport ? (
				<p className="-mt-1 truncate text-xs text-muted-foreground">
					{airport.name} ·{" "}
					{tzLabel(
						airport.tz,
						(time &&
							localDateTimeToEpoch(`${date}T${time}`, airport.tz, fold)) ||
							at,
					)}
				</p>
			) : null}
			<div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-1">
				<Input
					type="date"
					data-testid={testIds.date}
					aria-label={`${side === "From" ? "Departure" : "Arrival"} date`}
					value={date}
					disabled={disabled}
					onChange={(e) => onDate(e.target.value)}
					className="h-8 min-w-0 font-mono tnum"
				/>
				<TimeField
					testId={testIds.time}
					label={`${side === "From" ? "Departure" : "Arrival"} time`}
					value={time}
					disabled={disabled}
					onChange={onTime}
					className="w-full"
				/>
			</div>
			{airport && !dateError && repeated ? (
				<div
					data-testid={TRANSIT_TESTID.flightDstNote}
					className="grid gap-1 text-xs text-warning"
				>
					<span>
						{time} happens twice on {repeated.day} (clocks go back). Which one?
					</span>
					<div
						role="radiogroup"
						aria-label={`${side === "From" ? "Departure" : "Arrival"} ${time}`}
						className="flex flex-wrap gap-1"
					>
						{(
							[
								[undefined, repeated.first],
								["later", repeated.second],
							] as const
						).map(([value, label]) => {
							const on = (fold === "later") === (value === "later");
							return (
								<Button
									key={label}
									type="button"
									role="radio"
									aria-checked={on}
									data-testid={TRANSIT_TESTID.flightFold}
									data-fold={value ?? "earlier"}
									variant={on ? "secondary" : "ghost"}
									size="sm"
									disabled={disabled}
									className="h-7 px-2 font-mono text-xs tnum"
									onClick={() => onFold(value)}
								>
									{time} {label}
								</Button>
							);
						})}
					</div>
				</div>
			) : airport && !dateError && dstNote(date, time, airport.tz) ? (
				<p
					data-testid={TRANSIT_TESTID.flightDstNote}
					className="text-xs text-warning"
				>
					{dstNote(date, time, airport.tz)}
				</p>
			) : null}
			{dateError ? (
				<span
					data-testid={TRANSIT_TESTID.flightError}
					role="alert"
					className="text-xs text-destructive"
				>
					{dateError}
				</span>
			) : null}
			<div className="grid grid-cols-2 gap-1">
				<InputGroup className="h-8">
					<InputGroupAddon className="pr-0 text-xs font-normal">
						Terminal
					</InputGroupAddon>
					<InputGroupInput
						data-testid={testIds.terminal}
						aria-label={`${side} terminal`}
						{...CAPS_INPUT}
						placeholder="–"
						value={terminal}
						maxLength={20}
						disabled={disabled}
						onChange={(e) => onTerminal(e.target.value)}
						className="font-mono tnum"
					/>
				</InputGroup>
				<InputGroup className="h-8">
					<InputGroupAddon className="pr-0 text-xs font-normal">
						Gate
					</InputGroupAddon>
					<InputGroupInput
						data-testid={testIds.gate}
						aria-label={`${side} gate`}
						{...CAPS_INPUT}
						placeholder="–"
						value={gate}
						maxLength={20}
						disabled={disabled}
						onChange={(e) => onGate(e.target.value)}
						className="font-mono tnum"
					/>
				</InputGroup>
			</div>
		</div>
	);
}
