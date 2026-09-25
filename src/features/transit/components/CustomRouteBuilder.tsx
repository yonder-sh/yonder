/**
 * The custom route builder (DESIGN §8.2; ADDENDUM §5; QA TR-07, TR-11): works
 * for every transit leg, anywhere, with or without a provider.
 *
 * - Steps: mode, line (with a colour swatch), from, to, depart, minutes;
 *   "+ Step". In Japan, stations and lines autocomplete from the N02 rail
 *   network (Japanese, English, station numbers), and picking both stations
 *   fills the minutes, the line and the real track shape.
 * - "Just a duration" collapses it to one minutes field.
 * - "Reserved: departs …" pins the leg's own times (`details.fixed`) with
 *   "Be at the platform N min before" and "Then N min to the next stop"
 *   (defaulting to the steps before and after the ride).
 * - Booking (collapsible): ref, train number, class, car, seats per member.
 *   Link guests see ref and seats masked and can't change them.
 */
import { cn } from "cn";
import { ChevronDown, Plus, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { assignableMembers, MemberAvatar } from "@/components/common/member";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	addMinutes,
	localDateOf,
	localDateTimeToEpoch,
	tzLabel,
} from "@/lib/engine/time";
import { formatDuration } from "@/lib/format";
import type {
	FixedTimes,
	LineString,
	SegmentMode,
	TransitBooking,
	TransitRoute,
	TransitSegment,
} from "@/lib/schemas/legs";
import { mergeRide, stationLabel } from "../lib/custom-route";
import { TRANSIT_TESTID } from "../testids";
import { railRide, searchRail } from "../transit.functions";
import type { LegEditor } from "../use-leg-editor";
import { AddPersonRow, Masked, SectionLabel, TimeField } from "./bits";
import { SuggestInput } from "./SuggestInput";

type StepMode = SegmentMode | "taxi";

type Station = { name: string; lat?: number; lng?: number };

type Step = {
	key: string;
	mode: StepMode;
	line: string;
	lineShort?: string;
	lineKey?: string;
	agency?: string;
	color?: string;
	textColor?: string;
	from: Station;
	to: Station;
	depart: string;
	minutes: string;
	/** The minutes came from the rail network (overwritten on a new pick). */
	autoMinutes?: boolean;
	stopCount?: number;
	geometry?: LineString;
};

const STEP_MODES: { value: StepMode; label: string }[] = [
	{ value: "train", label: "Train" },
	{ value: "high_speed", label: "Shinkansen / high-speed" },
	{ value: "subway", label: "Subway" },
	{ value: "bus", label: "Bus" },
	{ value: "tram", label: "Tram" },
	{ value: "ferry", label: "Ferry" },
	{ value: "cable", label: "Cable car" },
	{ value: "walk", label: "Walk" },
	{ value: "taxi", label: "Taxi / car" },
];

/** 12 presets (DESIGN §8.2) + hex. */
const SWATCHES = [
	"#E5171F",
	"#F15A22",
	"#FF9500",
	"#FFD400",
	"#9ACD32",
	"#00AB84",
	"#009BBF",
	"#0072BC",
	"#4F54BC",
	"#8F76D6",
	"#B6007A",
	"#5C6375",
];

const RIDE = (m: StepMode) => m !== "walk" && m !== "taxi";

let seq = 0;
const newKey = () => `s${++seq}`;

const contrastText = (hex: string) => {
	const v = [1, 3, 5].map(
		(i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255,
	);
	const l = 0.2126 * (v[0] ?? 0) + 0.7152 * (v[1] ?? 0) + 0.0722 * (v[2] ?? 0);
	return l > 0.55 ? "#181D2F" : "#FFFFFF";
};

function stepFromSegment(s: TransitSegment): Step {
	return {
		key: newKey(),
		mode:
			s.mode === "other" && s.vehicleType === "TAXI"
				? "taxi"
				: (s.mode as StepMode),
		line: s.lineName ?? "",
		lineShort: s.lineShort,
		agency: s.agency,
		color: s.color,
		textColor: s.textColor,
		from: { name: s.from?.name ?? "", lat: s.from?.lat, lng: s.from?.lng },
		to: { name: s.to?.name ?? "", lat: s.to?.lat, lng: s.to?.lng },
		depart: "",
		minutes: String(s.durationMin),
		stopCount: s.stopCount,
		geometry: s.geometry,
	};
}

const emptyStep = (mode: StepMode = "train"): Step => ({
	key: newKey(),
	mode,
	line: "",
	from: { name: "" },
	to: { name: "" },
	depart: "",
	minutes: "",
});

const num = (s: string) => {
	const n = Number.parseInt(s, 10);
	return Number.isFinite(n) && n >= 0 ? n : 0;
};

export function CustomRouteBuilder({
	ed,
	editing,
	onDone,
}: {
	ed: LegEditor;
	/** The manual route being edited, or null for a new one. */
	editing: TransitRoute | null;
	onDone: () => void;
}) {
	const { ends, details, sched, redacted } = ed;
	const guard = useEditGuard();
	const members = assignableMembers(ed.ws.graph.members);
	const fromTz = ends.from?.tz ?? ed.ws.ix.defaultTz;
	const toTz = ends.to?.tz ?? fromTz;
	const transit = details?.kind === "transit" ? details : null;
	const isChosenEdit =
		!!editing && (transit?.chosenId ?? transit?.route?.id) === editing.id;

	const [label, setLabel] = useState(editing?.label ?? "");
	const [durationOnly, setDurationOnly] = useState(
		editing ? editing.segments.length === 0 : false,
	);
	const [total, setTotal] = useState(
		editing ? String(editing.durationMin) : String(sched?.minutes ?? ""),
	);
	const [steps, setSteps] = useState<Step[]>(() =>
		editing?.segments.length
			? editing.segments.map(stepFromSegment)
			: [emptyStep("train")],
	);
	// FB-20: the leg's own time (zone labels at that moment), else its day.
	const fromDay =
		ed.target.kind === "pair"
			? ed.ws.ix.day(ed.ws.ix.item(ed.target.fromItemId)?.dayId)?.date
			: ed.ws.ix.day(ed.target.dayId)?.date;
	const startMs =
		sched?.start.getTime() ??
		(fromDay ? Date.parse(`${fromDay}T12:00:00Z`) : Date.now());
	const fixed = isChosenEdit || !editing ? transit?.fixed : undefined;
	const [reserved, setReserved] = useState(!!fixed);
	const [depDate, setDepDate] = useState(
		fixed?.departLocal.slice(0, 10) ?? localDateOf(startMs, fromTz),
	);
	const [depTime, setDepTime] = useState(fixed?.departLocal.slice(11) ?? "");
	const [arrDate, setArrDate] = useState(
		fixed?.arriveLocal.slice(0, 10) ?? localDateOf(startMs, toTz),
	);
	const [arrTime, setArrTime] = useState(fixed?.arriveLocal.slice(11) ?? "");
	const booking = isChosenEdit || !editing ? transit?.booking : undefined;
	const [bookingOpen, setBookingOpen] = useState(!!booking);
	const [ref, setRef] = useState(booking?.ref ?? "");
	const [train, setTrain] = useState(booking?.trainNumber ?? "");
	const [cls, setCls] = useState(booking?.class ?? "");
	const [car, setCar] = useState(booking?.car ?? "");
	const [seats, setSeats] = useState<Record<string, string>>(() =>
		Object.fromEntries(
			(booking?.seats ?? []).flatMap((s) =>
				s.memberId ? [[s.memberId, s.seat]] : [],
			),
		),
	);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const ids = {
		label: useId(),
		total: useId(),
		access: useId(),
		egress: useId(),
		durationOnly: useId(),
		reserved: useId(),
	};

	const firstRide = steps.findIndex((s) => RIDE(s.mode));
	const lastRide =
		steps.length - 1 - [...steps].reverse().findIndex((s) => RIDE(s.mode));
	const beforeMin = steps
		.slice(0, Math.max(0, firstRide))
		.reduce((t, s) => t + num(s.minutes), 0);
	const afterMin =
		firstRide >= 0
			? steps.slice(lastRide + 1).reduce((t, s) => t + num(s.minutes), 0)
			: 0;
	const [access, setAccess] = useState(fixed ? String(fixed.accessMin) : "");
	const [egress, setEgress] = useState(fixed ? String(fixed.egressMin) : "");
	const sum = steps.reduce((t, s) => t + num(s.minutes), 0);
	const reservedMinutes = useMemo(() => {
		if (!reserved || !depTime || !arrTime) return null;
		const a = localDateTimeToEpoch(`${depDate}T${depTime}`, fromTz);
		const b = localDateTimeToEpoch(`${arrDate}T${arrTime}`, toTz);
		return a !== null && b !== null ? Math.round((b - a) / 60_000) : null;
	}, [reserved, depDate, depTime, arrDate, arrTime, fromTz, toTz]);

	const update = (key: string, patch: Partial<Step>) =>
		setSteps((xs) => xs.map((s) => (s.key === key ? { ...s, ...patch } : s)));

	const fillRide = async (step: Step, from: Station, to: Station) => {
		if (!RIDE(step.mode) || from.lat === undefined || to.lat === undefined)
			return;
		if (from.lng === undefined || to.lng === undefined) return;
		try {
			const r = await railRide({
				data: {
					tripId: ed.tripId,
					from: { name: from.name, lat: from.lat, lng: from.lng },
					to: { name: to.name, lat: to.lat, lng: to.lng },
					...(step.lineKey ? { line: step.lineKey } : {}),
				},
			});
			if (!r) return;
			// Minutes, stops and track from the network; a typed line name
			// keeps its own chip (QA MT-05).
			setSteps((xs) =>
				xs.map((s) => (s.key === step.key ? mergeRide(s, r) : s)),
			);
		} catch {
			// The look-up is a convenience; typing stays possible.
		}
	};

	const stationLoader =
		(near?: { lat: number; lng: number }, line?: string) => async (q: string) =>
			(
				await searchRail({
					data: {
						tripId: ed.tripId,
						q,
						...(near ? { near } : {}),
						...(line ? { line } : {}),
					},
				})
			).stations;

	const build = (): {
		route: TransitRoute;
		fixed: FixedTimes | null;
	} | null => {
		const durationMin = durationOnly
			? num(total)
			: reservedMinutes !== null && reserved
				? Math.max(sum, beforeMin + reservedMinutes + afterMin)
				: sum;
		if (!durationMin) {
			setError("Add the minutes (or reserved times).");
			return null;
		}
		const segments: TransitSegment[] = durationOnly
			? []
			: steps.map((s) => {
					const seg: TransitSegment = {
						mode: s.mode === "taxi" ? "other" : s.mode,
						durationMin: num(s.minutes),
					};
					if (s.mode === "taxi") seg.vehicleType = "TAXI";
					if (s.line.trim()) seg.lineName = s.line.trim().slice(0, 200);
					if (s.lineShort) seg.lineShort = s.lineShort.slice(0, 40);
					else if (s.line.trim() && s.line.trim().length <= 40)
						seg.lineShort = s.line.trim();
					if (s.agency) seg.agency = s.agency;
					if (s.color) {
						seg.color = s.color;
						seg.textColor = s.textColor ?? contrastText(s.color);
					}
					if (s.from.name.trim())
						seg.from = {
							name: s.from.name.trim().slice(0, 200),
							...(s.from.lat !== undefined && s.from.lng !== undefined
								? { lat: s.from.lat, lng: s.from.lng }
								: {}),
						};
					if (s.to.name.trim())
						seg.to = {
							name: s.to.name.trim().slice(0, 200),
							...(s.to.lat !== undefined && s.to.lng !== undefined
								? { lat: s.to.lat, lng: s.to.lng }
								: {}),
						};
					if (s.stopCount !== undefined) seg.stopCount = s.stopCount;
					if (s.geometry) seg.geometry = s.geometry;
					if (s.depart) {
						const at = localDateTimeToEpoch(`${depDate}T${s.depart}`, fromTz);
						if (at !== null) {
							seg.departAt = new Date(at).toISOString();
							seg.arriveAt = new Date(
								addMinutes(at, num(s.minutes)),
							).toISOString();
						}
					}
					return seg;
				});
		if (reserved && !durationOnly && firstRide >= 0 && depTime && arrTime) {
			const ride = segments[firstRide];
			const a = localDateTimeToEpoch(`${depDate}T${depTime}`, fromTz);
			const b = localDateTimeToEpoch(`${arrDate}T${arrTime}`, toTz);
			if (ride && a !== null && b !== null) {
				ride.departAt = new Date(a).toISOString();
				ride.arriveAt = new Date(b).toISOString();
				ride.durationMin = Math.max(
					ride.durationMin,
					Math.round((b - a) / 60_000),
				);
			}
		}
		const coords = segments.flatMap((s) => s.geometry?.coordinates ?? []);
		const route: TransitRoute = {
			id: editing?.id ?? `m:${crypto.randomUUID()}`,
			source: "manual",
			durationMin,
			walkMin: segments
				.filter((s) => s.mode === "walk")
				.reduce((t, s) => t + s.durationMin, 0),
			transfers: Math.max(
				0,
				segments.filter((s) => s.mode !== "walk" && s.mode !== "other").length -
					1,
			),
			segments,
			...(label.trim() ? { label: label.trim().slice(0, 80) } : {}),
			...(coords.length >= 2
				? {
						geometry: {
							type: "LineString",
							coordinates: coords.slice(0, 2000),
						},
					}
				: {}),
		};
		let fixedOut: FixedTimes | null = null;
		if (reserved) {
			if (!depTime || !arrTime) {
				setError("Add the reserved departure and arrival times.");
				return null;
			}
			if (reservedMinutes === null || reservedMinutes <= 0) {
				setError("Arrival is before departure.");
				return null;
			}
			fixedOut = {
				departLocal: `${depDate}T${depTime}`,
				arriveLocal: `${arrDate}T${arrTime}`,
				fromTz,
				toTz,
				accessMin: Math.min(180, access === "" ? beforeMin || 10 : num(access)),
				egressMin: Math.min(180, egress === "" ? afterMin : num(egress)),
			};
		}
		return { route, fixed: fixedOut };
	};

	const bookingValue = (): TransitBooking | null => {
		const out: TransitBooking = {
			// Link guests send the masked seats back: the server keeps the real ones (§11.3).
			seats: redacted
				? (booking?.seats ?? [])
				: members
						.filter((m) => seats[m.id]?.trim())
						.map((m) => ({
							memberId: m.id,
							seat: (seats[m.id] ?? "").trim().slice(0, 20),
						})),
		};
		if (ref.trim()) out.ref = ref.trim().toUpperCase().slice(0, 40);
		if (train.trim()) out.trainNumber = train.trim().slice(0, 40);
		if (cls.trim()) out.class = cls.trim().slice(0, 40);
		if (car.trim()) out.car = car.trim().slice(0, 20);
		const empty =
			!out.ref &&
			!out.trainNumber &&
			!out.class &&
			!out.car &&
			!out.seats.length;
		return empty ? null : out;
	};

	const save = async () => {
		setError(null);
		const built = build();
		if (!built) return;
		setSaving(true);
		try {
			if (editing)
				await ed.updateRoute.mutateAsync({
					routeId: editing.id,
					route: built.route,
					expectedUpdatedAt: ed.leg?.updatedAt,
				});
			else await ed.saveRoute.mutateAsync(built.route);
			const nextBooking = bookingOpen ? bookingValue() : (booking ?? null);
			const bookingChanged =
				JSON.stringify(nextBooking ?? null) !== JSON.stringify(booking ?? null);
			const fixedChanged =
				JSON.stringify(built.fixed) !== JSON.stringify(fixed ?? null);
			if (fixedChanged || bookingChanged)
				await ed.saveDetails.mutateAsync({
					...(fixedChanged ? { fixed: built.fixed } : {}),
					...(bookingChanged ? { booking: nextBooking } : {}),
				});
			onDone();
		} catch {
			// The toast already explains (global mutation handler).
		} finally {
			setSaving(false);
		}
	};

	const nearFrom = ends.from
		? { lat: ends.from.lat, lng: ends.from.lng }
		: undefined;
	const nearTo = ends.to ? { lat: ends.to.lat, lng: ends.to.lng } : undefined;
	const japan = ed.japan;
	const disabled = guard.disabled || saving;

	return (
		<div
			data-testid={TRANSIT_TESTID.customRoute}
			className="grid gap-3 rounded-xl border bg-card p-3 shadow-float"
		>
			<SectionLabel>
				{editing ? "Edit custom route" : "Custom route"}
			</SectionLabel>
			<div className="grid gap-1.5">
				<Label
					htmlFor={ids.label}
					className="text-xs font-normal text-muted-foreground"
				>
					Name
				</Label>
				<Input
					id={ids.label}
					data-testid={TRANSIT_TESTID.customRouteLabel}
					value={label}
					maxLength={80}
					disabled={disabled}
					placeholder="Optional, e.g. Fuji Excursion 7"
					className="h-8"
					onChange={(e) => setLabel(e.target.value)}
				/>
			</div>
			<div className="flex items-center justify-between gap-2 text-sm">
				<Label htmlFor={ids.durationOnly} className="font-normal">
					Just a duration
				</Label>
				<Switch
					id={ids.durationOnly}
					data-testid={TRANSIT_TESTID.customRouteDurationOnly}
					checked={durationOnly}
					disabled={disabled}
					onCheckedChange={setDurationOnly}
				/>
			</div>
			{durationOnly ? (
				<div className="flex items-center gap-2">
					<Label
						htmlFor={ids.total}
						className="text-xs font-normal text-muted-foreground"
					>
						Minutes
					</Label>
					<Input
						id={ids.total}
						data-testid={TRANSIT_TESTID.customRouteMinutes}
						inputMode="numeric"
						value={total}
						disabled={disabled}
						onChange={(e) =>
							setTotal(e.target.value.replace(/\D/g, "").slice(0, 4))
						}
						className="h-8 w-24 font-mono tnum"
					/>
					{num(total) ? (
						<span className="font-mono text-xs text-muted-foreground tnum">
							{formatDuration(num(total))}
						</span>
					) : null}
				</div>
			) : (
				<ol className="grid gap-2">
					{steps.map((s, i) => (
						<li
							key={s.key}
							data-testid={TRANSIT_TESTID.customRouteStep}
							className="grid gap-2 rounded-lg border bg-background/60 p-2"
						>
							<div className="flex items-center gap-2">
								<span className="w-4 font-mono text-[11px] text-muted-foreground tnum">
									{i + 1}
								</span>
								<Select
									value={s.mode}
									disabled={disabled}
									onValueChange={(v) => update(s.key, { mode: v as StepMode })}
								>
									<SelectTrigger
										data-testid={TRANSIT_TESTID.customRouteStepMode}
										className="h-8 flex-1"
										aria-label={`Step ${i + 1} mode`}
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{STEP_MODES.map((m) => (
											<SelectItem key={m.value} value={m.value}>
												{m.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Input
									data-testid={TRANSIT_TESTID.customRouteStepMinutes}
									aria-label={`Step ${i + 1} minutes`}
									inputMode="numeric"
									placeholder="min"
									value={s.minutes}
									disabled={disabled}
									onChange={(e) =>
										update(s.key, {
											minutes: e.target.value.replace(/\D/g, "").slice(0, 4),
											autoMinutes: false,
										})
									}
									className="h-8 w-16 font-mono tnum"
								/>
								{steps.length > 1 ? (
									<Button
										variant="ghost"
										size="icon"
										className="size-7"
										aria-label={`Remove step ${i + 1}`}
										disabled={disabled}
										onClick={() =>
											setSteps((xs) => xs.filter((x) => x.key !== s.key))
										}
									>
										<X className="size-3.5" />
									</Button>
								) : null}
							</div>
							{RIDE(s.mode) ? (
								<>
									<div className="flex items-center gap-2 pl-6">
										<ColorSwatch
											value={s.color}
											disabled={disabled}
											onChange={(c) =>
												update(s.key, {
													color: c,
													textColor: c ? contrastText(c) : undefined,
												})
											}
										/>
										<SuggestInput
											className="flex-1"
											value={s.line}
											aria-label={`Step ${i + 1} line`}
											testId={TRANSIT_TESTID.customRouteStepLine}
											placeholder={
												japan ? "Line — e.g. Chuo, 中央線" : "Line or train"
											}
											disabled={disabled}
											onChange={(line) =>
												update(s.key, {
													line,
													lineKey: undefined,
													lineShort: undefined,
												})
											}
											load={
												japan
													? async (q) =>
															(
																await searchRail({
																	data: { tripId: ed.tripId, q },
																})
															).lines
													: () => []
											}
											itemKey={(l) => l.key}
											renderItem={(l) => (
												<span className="flex items-center gap-2">
													<span
														className="size-2.5 shrink-0 rounded-full"
														style={{
															backgroundColor: l.color ?? "var(--mode-transit)",
														}}
													/>
													<span className="truncate">{l.nameEn ?? l.name}</span>
													<span
														lang="ja"
														className="truncate text-xs text-muted-foreground"
													>
														{l.name} · {l.operator}
													</span>
												</span>
											)}
											onPick={(l) =>
												update(s.key, {
													line: l.nameEn ?? l.name,
													lineShort: l.short,
													lineKey: l.key,
													agency: l.operatorEn ?? l.operator,
													...(l.color
														? { color: l.color, textColor: l.textColor }
														: {}),
												})
											}
										/>
									</div>
									<div className="grid grid-cols-2 gap-2 pl-6">
										<StationField
											japan={japan}
											value={s.from}
											label={`Step ${i + 1} from`}
											testId={TRANSIT_TESTID.customRouteStepFrom}
											placeholder={
												i === 0 && ends.from
													? `From (${ends.from.name})`
													: "From"
											}
											disabled={disabled}
											load={stationLoader(
												i === 0 ? nearFrom : undefined,
												s.lineKey,
											)}
											onChange={(from) => update(s.key, { from })}
											onPick={(from) => {
												update(s.key, { from });
												if (s.to.lat !== undefined)
													void fillRide({ ...s, from }, from, s.to);
											}}
										/>
										<StationField
											japan={japan}
											value={s.to}
											label={`Step ${i + 1} to`}
											testId={TRANSIT_TESTID.customRouteStepTo}
											placeholder={
												i === steps.length - 1 && ends.to
													? `To (${ends.to.name})`
													: "To"
											}
											disabled={disabled}
											load={stationLoader(
												i === steps.length - 1 ? nearTo : undefined,
												s.lineKey,
											)}
											onChange={(to) => update(s.key, { to })}
											onPick={(to) => {
												update(s.key, { to });
												if (s.from.lat !== undefined)
													void fillRide({ ...s, to }, s.from, to);
											}}
										/>
									</div>
									<div className="flex items-center gap-2 pl-6">
										<span className="text-xs text-muted-foreground">
											Departs
										</span>
										<TimeField
											label={`Step ${i + 1} departs`}
											testId={TRANSIT_TESTID.customRouteStepDepart}
											value={s.depart}
											disabled={disabled}
											onChange={(depart) => update(s.key, { depart })}
										/>
										{s.stopCount ? (
											<span className="text-xs text-muted-foreground">
												{s.stopCount} stops
											</span>
										) : null}
									</div>
								</>
							) : null}
						</li>
					))}
				</ol>
			)}
			{durationOnly ? null : (
				<div className="flex items-center justify-between">
					<Button
						variant="ghost"
						size="sm"
						className="h-7 gap-1 px-2 text-xs"
						data-testid={TRANSIT_TESTID.customRouteAddStep}
						disabled={disabled || steps.length >= 12}
						onClick={() => {
							const prev = steps.at(-1);
							const next = emptyStep(
								prev && RIDE(prev.mode) ? "walk" : "train",
							);
							if (prev?.to.name) next.from = prev.to;
							setSteps((xs) => [...xs, next]);
						}}
					>
						<Plus className="size-3.5" /> Step
					</Button>
					<span className="font-mono text-xs text-muted-foreground tnum">
						{sum ? formatDuration(sum) : ""}
					</span>
				</div>
			)}

			<div className="grid gap-2 border-t pt-3">
				<div className="flex items-center justify-between gap-2 text-sm">
					<Label htmlFor={ids.reserved} className="font-normal">
						Reserved departure
					</Label>
					<Switch
						id={ids.reserved}
						data-testid={TRANSIT_TESTID.customRouteReserved}
						checked={reserved}
						disabled={disabled}
						onCheckedChange={(on) => {
							setReserved(on);
							if (on && !depTime) {
								const ride = steps[firstRide];
								if (ride?.depart) setDepTime(ride.depart);
							}
						}}
					/>
				</div>
				{reserved ? (
					<div className="grid gap-2">
						<div className="grid grid-cols-[4rem_minmax(0,1fr)_auto] items-center gap-2">
							<span className="text-xs text-muted-foreground">Departs</span>
							<Input
								type="date"
								data-testid={TRANSIT_TESTID.customRouteDepartDate}
								aria-label="Departure date"
								value={depDate}
								disabled={disabled}
								onChange={(e) => {
									setDepDate(e.target.value);
									if (!arrTime) setArrDate(e.target.value);
								}}
								className="h-8 font-mono tnum"
							/>
							<TimeField
								testId={TRANSIT_TESTID.customRouteDepartTime}
								label="Departure time"
								value={depTime}
								disabled={disabled}
								onChange={setDepTime}
							/>
							<span className="text-xs text-muted-foreground">Arrives</span>
							<Input
								type="date"
								data-testid={TRANSIT_TESTID.customRouteArriveDate}
								aria-label="Arrival date"
								value={arrDate}
								disabled={disabled}
								onChange={(e) => setArrDate(e.target.value)}
								className="h-8 font-mono tnum"
							/>
							<TimeField
								testId={TRANSIT_TESTID.customRouteArriveTime}
								label="Arrival time"
								value={arrTime}
								disabled={disabled}
								onChange={setArrTime}
							/>
						</div>
						<p className="text-xs text-muted-foreground">
							{fromTz === toTz
								? `Local time (${ends.from ? zoneShort(fromTz, startMs) : fromTz})`
								: `Departs in ${zoneShort(fromTz, startMs)}, arrives in ${zoneShort(toTz, startMs)}`}
							{reservedMinutes && reservedMinutes > 0
								? ` · ${formatDuration(reservedMinutes)} on board`
								: ""}
						</p>
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
							<label htmlFor={ids.access}>Be at the platform</label>
							<Input
								id={ids.access}
								data-testid={TRANSIT_TESTID.customRouteAccess}
								inputMode="numeric"
								value={access}
								placeholder={String(beforeMin || 10)}
								disabled={disabled}
								onChange={(e) =>
									setAccess(e.target.value.replace(/\D/g, "").slice(0, 3))
								}
								className="h-7 w-14 font-mono tnum"
							/>
							<span>min before</span>
						</div>
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
							<label htmlFor={ids.egress}>Then</label>
							<Input
								id={ids.egress}
								data-testid={TRANSIT_TESTID.customRouteEgress}
								inputMode="numeric"
								value={egress}
								placeholder={String(afterMin)}
								disabled={disabled}
								onChange={(e) =>
									setEgress(e.target.value.replace(/\D/g, "").slice(0, 3))
								}
								className="h-7 w-14 font-mono tnum"
							/>
							<span>min to the next stop</span>
						</div>
					</div>
				) : null}
			</div>

			<Collapsible open={bookingOpen} onOpenChange={setBookingOpen}>
				<CollapsibleTrigger
					data-testid={TRANSIT_TESTID.customRouteBooking}
					className="flex w-full items-center justify-between rounded-md border-t pt-3 text-sm"
				>
					<span>Booking</span>
					<ChevronDown
						className={cn(
							"size-4 text-muted-foreground transition-transform",
							bookingOpen && "rotate-180",
						)}
					/>
				</CollapsibleTrigger>
				<CollapsibleContent className="grid gap-2 pt-2">
					<Field label="Ref">
						{redacted ? (
							<Masked />
						) : (
							<Input
								data-testid={TRANSIT_TESTID.bookingRef}
								value={ref}
								maxLength={40}
								disabled={disabled}
								onChange={(e) => setRef(e.target.value.toUpperCase())}
								className="h-8 font-mono uppercase tnum placeholder:font-sans placeholder:normal-case"
								placeholder="Optional"
							/>
						)}
					</Field>
					<Field label="Train no.">
						<Input
							data-testid={TRANSIT_TESTID.bookingTrain}
							value={train}
							maxLength={40}
							disabled={disabled}
							onChange={(e) => setTrain(e.target.value)}
							className="h-8"
							placeholder="Optional"
						/>
					</Field>
					<div className="grid grid-cols-2 gap-2">
						<Field label="Class">
							<Input
								data-testid={TRANSIT_TESTID.bookingClass}
								value={cls}
								maxLength={40}
								disabled={disabled}
								onChange={(e) => setCls(e.target.value)}
								className="h-8"
								placeholder="e.g. Green car"
							/>
						</Field>
						<Field label="Car">
							<Input
								data-testid={TRANSIT_TESTID.bookingCar}
								value={car}
								maxLength={20}
								disabled={disabled}
								onChange={(e) => setCar(e.target.value)}
								className="h-8 font-mono tnum placeholder:font-sans"
								placeholder="–"
							/>
						</Field>
					</div>
					{members.length ? (
						<div className="grid gap-1.5">
							<span className="text-xs text-muted-foreground">Seats</span>
							{members.map((m) => (
								<div key={m.id} className="flex items-center gap-2">
									<MemberAvatar user={m} size={20} />
									<span className="w-24 truncate text-sm">{m.name}</span>
									{redacted ? (
										<Masked />
									) : (
										<Input
											data-testid={TRANSIT_TESTID.bookingSeat}
											data-member={m.id}
											aria-label={`Seat for ${m.name}`}
											value={seats[m.id] ?? ""}
											maxLength={20}
											disabled={disabled}
											onChange={(e) =>
												setSeats((x) => ({
													...x,
													[m.id]: e.target.value.toUpperCase(),
												}))
											}
											className="h-8 w-24 font-mono uppercase tnum placeholder:font-sans placeholder:normal-case"
											placeholder="Seat"
										/>
									)}
								</div>
							))}
							{redacted ? null : <AddPersonRow disabled={disabled} />}
						</div>
					) : null}
				</CollapsibleContent>
			</Collapsible>

			{error ? (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			) : null}
			<div className="flex justify-end gap-2">
				<Button
					variant="ghost"
					size="sm"
					data-testid={TRANSIT_TESTID.customRouteCancel}
					onClick={onDone}
				>
					Cancel
				</Button>
				<Button
					size="sm"
					data-testid={TRANSIT_TESTID.customRouteSave}
					disabled={disabled}
					onClick={save}
				>
					{saving ? "Saving…" : editing ? "Save changes" : "Save route"}
				</Button>
			</div>
		</div>
	);
}

function zoneShort(tz: string, at: number): string {
	return tzLabel(tz, at);
}

function Field({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="grid grid-cols-[4.5rem_1fr] items-center gap-2">
			<span className="text-xs text-muted-foreground">{label}</span>
			<div className="min-w-0">{children}</div>
		</div>
	);
}

function StationField({
	japan,
	value,
	label,
	testId,
	placeholder,
	disabled,
	load,
	onChange,
	onPick,
}: {
	japan: boolean;
	value: Station;
	label: string;
	testId: string;
	placeholder: string;
	disabled?: boolean;
	load: (q: string) => Promise<
		{
			key: string;
			name: string;
			nameEn?: string;
			no?: string;
			lat: number;
			lng: number;
			distanceM?: number;
			lines: { key: string; short: string; color?: string }[];
		}[]
	>;
	onChange: (s: Station) => void;
	onPick: (s: Station) => void;
}) {
	return (
		<SuggestInput
			value={value.name}
			aria-label={label}
			testId={testId}
			itemTestId={TRANSIT_TESTID.stationSuggestion}
			placeholder={placeholder}
			disabled={disabled}
			onChange={(name) => onChange({ name })}
			load={japan ? load : () => []}
			itemKey={(s) => s.key}
			renderItem={(s) => (
				<span className="grid gap-0.5">
					<span className="flex items-baseline gap-1.5">
						<span className="truncate font-medium">{s.nameEn ?? s.name}</span>
						<span lang="ja" className="truncate text-xs text-muted-foreground">
							{s.name}
						</span>
						{s.no ? (
							<span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
								{s.no}
							</span>
						) : null}
					</span>
					<span className="flex flex-wrap items-center gap-1">
						{s.lines.slice(0, 4).map((l) => (
							<span
								key={l.key}
								className="inline-flex h-4 items-center rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground"
								style={
									l.color
										? { boxShadow: `inset 3px 0 0 ${l.color}` }
										: undefined
								}
							>
								{l.short}
							</span>
						))}
						{s.distanceM !== undefined ? (
							<span className="text-[10px] text-muted-foreground">
								{s.distanceM < 1000
									? `${s.distanceM} m`
									: `${(s.distanceM / 1000).toFixed(1)} km`}
							</span>
						) : null}
					</span>
				</span>
			)}
			onPick={(s) => onPick({ name: stationLabel(s), lat: s.lat, lng: s.lng })}
		/>
	);
}

function ColorSwatch({
	value,
	onChange,
	disabled,
}: {
	value?: string;
	onChange: (c: string | undefined) => void;
	disabled?: boolean;
}) {
	const [hex, setHex] = useState(value ?? "");
	return (
		<Popover>
			<PopoverTrigger asChild disabled={disabled}>
				<button
					type="button"
					aria-label="Line colour"
					className="size-6 shrink-0 rounded-full border ring-offset-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					style={{ backgroundColor: value ?? "transparent" }}
				>
					{value ? null : (
						<span className="block size-full rounded-full bg-hatch" />
					)}
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-52 p-2" align="start">
				<div className="grid grid-cols-6 gap-1.5">
					{SWATCHES.map((c) => (
						<button
							key={c}
							type="button"
							aria-label={c}
							onClick={() => {
								onChange(c);
								setHex(c);
							}}
							className={cn(
								"size-6 rounded-full ring-offset-1",
								value === c && "ring-2 ring-primary",
							)}
							style={{ backgroundColor: c }}
						/>
					))}
				</div>
				<div className="mt-2 flex gap-1.5">
					<Input
						value={hex}
						aria-label="Hex colour"
						placeholder="#RRGGBB"
						className="h-7 font-mono text-xs"
						onChange={(e) => {
							const v = e.target.value.trim();
							setHex(v);
							if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v.toUpperCase());
						}}
					/>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 text-xs"
						onClick={() => {
							onChange(undefined);
							setHex("");
						}}
					>
						None
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
