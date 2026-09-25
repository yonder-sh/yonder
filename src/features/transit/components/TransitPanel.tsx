/**
 * Transit (DESIGN §8.2; SPEC §14.2; ADDENDUM §5): "Departing 11:30 JST", the
 * options (fetched + custom; fastest first, chosen ringed), the Japan note
 * ("Estimated from the rail network — no timetables. Check times in Google
 * Maps →") with the N02 attribution, the no-provider callout, "Refresh
 * routes", "+ Custom route", and the reserved/booking line of the chosen
 * route (masked for link guests).
 *
 * Fetching options is edit-only (providers cost money); it runs once
 * automatically when an editor opens a transit leg with no options yet.
 * Suggesters pick an option by suggesting it as a full route
 * (`transit.route.save`), never `chooseTransitOption`.
 */
import { useQuery } from "@tanstack/react-query";
import { Info, Plus, RefreshCw, RotateCcw, TrainFront } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { DurationInput, useDisplayPrefs } from "@/components/common/time";
import { undoToast } from "@/components/common/undo-toast";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { tzLabel } from "@/lib/engine/time";
import { formatDuration, formatTime } from "@/lib/format";
import { capabilitiesQuery } from "@/lib/query/trip-queries";
import type { TransitRoute } from "@/lib/schemas/legs";
import { googleMapsDirectionsUrl } from "../lib/endpoints";
import {
	bookingLine,
	clockText,
	doorToDoor,
	fastestId,
	isWalkOnlyRoute,
	listedRoutes,
	sortOptions,
} from "../lib/route-view";
import { TRANSIT_TESTID } from "../testids";
import type { TransitOptionsResult } from "../transit.functions";
import type { LegEditor } from "../use-leg-editor";
import { GoogleMapsLink, Masked, RailAttribution } from "./bits";
import { CustomRouteBuilder } from "./CustomRouteBuilder";
import { RouteOptionCard } from "./RouteOptionCard";

export function TransitPanel({ ed }: { ed: LegEditor }) {
	const { leg, details, ends, sched, japan, ws, redacted } = ed;
	const { access } = ws;
	const caps = useQuery({ ...capabilitiesQuery(), enabled: ed.live });
	useDisplayPrefs(); // re-render on a 12/24 h switch
	const editOnly = useEditGuard("edit-only", "Suggesters can't fetch routes");
	const [result, setResult] = useState<TransitOptionsResult | null>(null);
	const [builder, setBuilder] = useState<{ route: TransitRoute | null } | null>(
		null,
	);
	const transit = details?.kind === "transit" ? details : null;
	const stored = ed.alternatives;
	// The chosen manual route is listed even when only `details.route` holds
	// it (imported legs), next to fetched options (QA MT-01).
	const options = sortOptions(listedRoutes(stored, transit?.route));
	const chosenId =
		leg?.mode === "transit" ? (transit?.chosenId ?? transit?.route?.id) : null;
	const fastest = fastestId(options);
	const chosenShown = !!chosenId && options.some((o) => o.id === chosenId);
	const fromTz = ends.from?.tz ?? ws.ix.defaultTz;
	const toTz = ends.to?.tz ?? fromTz;
	const mapsUrl =
		ends.from && ends.to ? googleMapsDirectionsUrl(ends.from, ends.to) : null;
	const walkingUrl =
		ends.from && ends.to
			? googleMapsDirectionsUrl(ends.from, ends.to, "walking")
			: null;
	const providerAvailable =
		!!caps.data &&
		((japan && caps.data.jpRail) || (!japan && caps.data.google));
	const canFetch = ed.live && !editOnly.disabled && providerAvailable;

	// Fetch once when an editor opens a transit leg with no options yet.
	const tried = useRef(false);
	const departAt = (sched?.start ?? new Date()).toISOString();
	const fetch = (refresh = false) =>
		ed.fetchOptions.mutate(
			{ departAt, refresh },
			{ onSuccess: (r) => setResult(r as TransitOptionsResult) },
		);
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per open leg (`tried`).
	useEffect(() => {
		if (tried.current || !canFetch || ed.rowLoading) return;
		if (stored.length || leg?.mode !== "transit") return;
		tried.current = true;
		fetch();
	}, [canFetch, ed.rowLoading, stored.length, leg?.mode]);

	const warnings = [
		...new Set([
			...(result?.notes ?? []),
			...options.flatMap((o) =>
				o.source === "estimate" ? (o.warnings ?? []) : [],
			),
		]),
	];
	const anyEstimate = options.some((o) => o.source === "estimate");
	const scheduleEstimate = options.some((o) => o.scheduleEstimate);
	const stale =
		!!leg?.queriedFor &&
		!!sched &&
		options.some((o) => o.source === "google") &&
		Math.abs(Date.parse(leg.queriedFor) - sched.start.getTime()) > 15 * 60_000;
	const noProvider =
		!japan &&
		!options.length &&
		(result?.unsupportedReason === "no-key" ||
			(caps.data && !caps.data.google));

	const choose = (r: TransitRoute) => {
		// "Walk the whole way" is a walk, not a transit leg (QA MT-06c): the
		// server saves it with the real walk; a suggester suggests the walk.
		if (access.mode === "suggest" && isWalkOnlyRoute(r))
			ed.patch.mutate({
				patch: {
					mode: "walk",
					durationMin: r.durationMin,
					estimateMin: r.durationMin,
					source: "estimate",
					isEdited: false,
				},
			});
		else if (access.mode === "suggest")
			ed.saveRoute.mutate({ ...r, id: `m:${crypto.randomUUID()}` });
		else ed.choose.mutate(r.id);
	};
	const remove = (r: TransitRoute) =>
		ed.deleteRoute.mutate(r.id, {
			onSuccess: () =>
				undoToast("Custom route deleted", async () => {
					await ed.saveRoute.mutateAsync({ ...r, id: r.id });
				}),
		});

	const booking = transit?.booking;
	const fixed = transit?.fixed;
	// QA TR-07: "2h 36m door to door, incl. 20m wait" for a reserved route:
	// from the end of the stop before it, the idle time until the leg starts
	// (departure − platform minutes) is the wait.
	const prevEnd =
		ed.target.kind === "pair"
			? (ws.schedule.items[ed.target.fromItemId]?.end ?? null)
			: null;
	const d2d =
		fixed && sched ? doorToDoor(sched.start, sched.end, prevEnd, fromTz) : null;
	const doorToDoorText = d2d
		? `${formatDuration(d2d.minutes)} door to door${d2d.waitMin > 0 ? `, incl. ${formatDuration(d2d.waitMin)} wait` : ""}`
		: null;
	const bookingText = redacted
		? bookingLine(booking ? { ...booking, seats: [], ref: undefined } : null)
		: bookingLine(booking);

	return (
		<div data-testid={TRANSIT_TESTID.transitPanel} className="grid gap-3">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				{sched ? (
					<p
						data-testid={TRANSIT_TESTID.transitDeparting}
						className="text-sm text-muted-foreground"
					>
						Departing{" "}
						<span className="font-mono text-foreground tnum">
							{formatTime(sched.start, fromTz)}
						</span>{" "}
						{tzLabel(fromTz, sched.start)}
					</p>
				) : null}
				{scheduleEstimate ? (
					<span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-[11px] text-muted-foreground">
						typical schedule
					</span>
				) : null}
			</div>

			{fixed ? (
				<div
					data-testid={TRANSIT_TESTID.chosenBooking}
					className="grid gap-0.5 rounded-lg border bg-card px-3 py-2"
				>
					<p className="flex items-center gap-1.5 text-sm">
						<span aria-hidden className="text-[8px] text-primary">
							◆
						</span>
						<span className="font-medium">Reserved</span>
						<span className="font-mono text-xs text-muted-foreground tnum">
							dep {clockText(fixed.departLocal.slice(11))} →{" "}
							{clockText(fixed.arriveLocal.slice(11))}
							{fixed.arriveLocal.slice(0, 10) !== fixed.departLocal.slice(0, 10)
								? "⁺¹"
								: ""}
						</span>
					</p>
					{doorToDoorText ? (
						<p
							data-testid={TRANSIT_TESTID.transitDoorToDoor}
							className="font-mono text-xs text-muted-foreground tnum"
						>
							{doorToDoorText}
						</p>
					) : null}
					{bookingText || redacted ? (
						<p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
							{bookingText}
							{redacted && (booking?.seats.length || booking) ? (
								<>
									<span>· ref</span>
									<Masked />
								</>
							) : null}
						</p>
					) : null}
				</div>
			) : bookingText ? (
				<p
					data-testid={TRANSIT_TESTID.chosenBooking}
					className="text-xs text-muted-foreground"
				>
					{bookingText}
				</p>
			) : null}

			{leg?.mode === "transit" && !fixed && !chosenShown ? (
				<TimeRow
					ed={ed}
					fastest={options.find((o) => o.id === fastest) ?? null}
					onUseFastest={choose}
				/>
			) : null}

			{japan ? (
				<div
					data-testid={TRANSIT_TESTID.japanNote}
					className="flex gap-2.5 rounded-lg bg-muted px-3 py-2.5"
				>
					<TrainFront
						className="mt-0.5 size-4 shrink-0 text-mode-transit"
						strokeWidth={1.5}
						aria-hidden
					/>
					<div className="grid gap-1">
						<p className="text-[13px] leading-5">
							Estimated from the rail network — no timetables.
						</p>
						<GoogleMapsLink ends={ends} label="Check times in Google Maps →" />
					</div>
				</div>
			) : null}

			{result?.error ? (
				<p
					data-testid={TRANSIT_TESTID.transitError}
					className="text-xs text-muted-foreground"
				>
					{result.error === "rate-limited"
						? "Routing is busy right now — try again in a minute, or enter it manually."
						: "Routing unavailable right now — enter it manually, or look it up."}
				</p>
			) : null}

			{ed.fetchOptions.isPending && !options.length ? (
				<p className="flex items-center gap-2 text-xs text-muted-foreground">
					<Spinner className="size-3" /> Finding routes…
				</p>
			) : null}

			{options.length ? (
				<div className="grid gap-2">
					{options.map((r) => (
						<RouteOptionCard
							key={r.id}
							route={r}
							chosen={r.id === chosenId}
							fastest={options.length > 1 && r.id === fastest}
							fromTz={fromTz}
							toTz={toTz}
							mapsUrl={
								japan ? (isWalkOnlyRoute(r) ? walkingUrl : mapsUrl) : null
							}
							mapsMode={isWalkOnlyRoute(r) ? "walking" : "transit"}
							disabled={!access.canEdit}
							onChoose={() => choose(r)}
							onEdit={
								r.source === "manual"
									? () => setBuilder({ route: r })
									: undefined
							}
							onDelete={r.source === "manual" ? () => remove(r) : undefined}
							onLock={
								r.source === "google" ? () => ed.lock.mutate(r.id) : undefined
							}
						/>
					))}
				</div>
			) : !ed.fetchOptions.isPending &&
				result &&
				!result.error &&
				!noProvider ? (
				<p className="text-xs text-muted-foreground">
					No route found — enter it manually
					{mapsUrl ? ", or look it up in Google Maps" : ""}.
				</p>
			) : null}

			{noProvider ? (
				<div
					data-testid={TRANSIT_TESTID.noProvider}
					className="grid gap-1 rounded-lg bg-muted px-3 py-2.5 text-[13px]"
				>
					<p>No transit provider configured.</p>
					{mapsUrl ? <GoogleMapsLink href={mapsUrl} /> : null}
				</div>
			) : null}

			{warnings.length ? (
				<p
					data-testid={TRANSIT_TESTID.transitWarning}
					className="flex items-start gap-1.5 text-xs text-muted-foreground"
				>
					<Info className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
					{warnings[0]}
				</p>
			) : null}

			{stale ? (
				<button
					type="button"
					className="w-fit text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
					onClick={() => fetch(true)}
					disabled={!canFetch}
				>
					Times changed · Refresh routes
				</button>
			) : null}

			{builder ? (
				<CustomRouteBuilder
					ed={ed}
					editing={builder.route}
					onDone={() => setBuilder(null)}
				/>
			) : (
				<div className="flex flex-wrap items-center gap-1">
					<EditGuard>
						<Button
							variant="ghost"
							size="sm"
							className="h-8 gap-1.5 px-2"
							data-testid={TRANSIT_TESTID.customRouteAdd}
							onClick={() => setBuilder({ route: null })}
						>
							<Plus className="size-4" /> Custom route
						</Button>
					</EditGuard>
					{providerAvailable && ed.live ? (
						<EditGuard kind="edit-only" reason="Suggesters can't fetch routes">
							<Button
								variant="ghost"
								size="sm"
								className="h-8 gap-1.5 px-2"
								data-testid={TRANSIT_TESTID.transitRefresh}
								disabled={ed.fetchOptions.isPending}
								onClick={() => fetch(true)}
							>
								<RefreshCw className="size-3.5" />
								{options.length ? "Refresh routes" : "Find routes"}
							</Button>
						</EditGuard>
					) : null}
					{!japan && mapsUrl && !noProvider ? (
						<GoogleMapsLink href={mapsUrl} className="ml-auto" />
					) : null}
				</div>
			)}

			{japan || anyEstimate ? <RailAttribution className="pt-1" /> : null}
		</div>
	);
}

/**
 * The leg's own minutes when no listed route is chosen (QA TR-04 "add time",
 * TR-08): "Time [1h56m] · Set by hand", with "Use the fastest route (21m)" when
 * options exist, or "Reset to 21m" back to the stored estimate.
 */
function TimeRow({
	ed,
	fastest,
	onUseFastest,
}: {
	ed: LegEditor;
	fastest: TransitRoute | null;
	onUseFastest: (r: TransitRoute) => void;
}) {
	const { leg, sched } = ed;
	const minutes = leg?.durationMin ?? sched?.minutes ?? 0;
	const edited = !!leg?.isEdited;
	const estimate = leg?.estimateMin ?? null;
	return (
		<div
			data-testid={TRANSIT_TESTID.transitTime}
			className="flex flex-wrap items-center gap-x-2 gap-y-1"
		>
			<span className="text-xs text-muted-foreground">Time</span>
			<EditGuard>
				<DurationInput
					value={minutes}
					onChange={(m) =>
						ed.patch.mutate({
							patch: {
								mode: "transit",
								durationMin: m,
								isEdited: true,
								distanceM: null,
								...(estimate === null && !edited
									? { estimateMin: minutes || null }
									: {}),
							},
						})
					}
				/>
			</EditGuard>
			<span className="text-xs text-muted-foreground">
				{edited ? "Set by hand" : leg?.durationMin ? "est." : "add time"}
			</span>
			{edited && fastest ? (
				<EditGuard>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 gap-1 px-2 text-xs"
						data-testid={TRANSIT_TESTID.transitUseFastest}
						onClick={() => onUseFastest(fastest)}
					>
						<RotateCcw className="size-3.5" />
						Use the fastest route (
						{formatDuration(fastest.durationMin, { compact: true })})
					</Button>
				</EditGuard>
			) : edited && estimate !== null && estimate !== minutes ? (
				<EditGuard>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 gap-1 px-2 text-xs"
						data-testid={TRANSIT_TESTID.transitReset}
						onClick={() => ed.reset.mutate()}
					>
						<RotateCcw className="size-3.5" />
						Reset to {formatDuration(estimate, { compact: true })}
					</Button>
				</EditGuard>
			) : null}
		</div>
	);
}
