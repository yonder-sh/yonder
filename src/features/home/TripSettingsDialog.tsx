/**
 * Trip settings (SPEC §12.5 `TripSettingsDialog()`, DESIGN §8.5; EXTENSIONS
 * §1.4), opened with `useUi().setSettingsOpen(true)`.
 *
 * - Name, URL slug (owner), and the plan settings: default day start,
 *   capacity per day, **Home currency** (the unit of all money math; the
 *   warning says expenses get re-converted), walking speed, autofill.
 *   Saved together through `updateTrip` (direct, `tripSettings`).
 * - Dates: a Calendar range, previewed with `previewTripDates` ("3 items on
 *   Fri 5 Nov move to Unscheduled. Nothing is deleted.") and applied with
 *   `setTripDates` (proposable: a suggester's change becomes a suggestion)
 *   with `expectedVersion` = the preview's version (what the user reviewed).
 *   "Try other dates…" opens WP-Insights' `ShiftTripDialog` (the what-if).
 * - Public holidays (`HolidaysEditor`, WP-Insights): its unsaved rows live
 *   here, so Save writes them with the rest (NEW-V52-01: it used to close the
 *   dialog and drop a holiday that wasn't saved with "Save holidays").
 * - "Duplicate…" (ADDENDUM §9), "Leave trip" for members who aren't the
 *   owner, and the owner's Danger zone: delete with the name typed.
 *
 * Every edit affordance goes through `useEditGuard` (offline, view-only;
 * settings are `edit-only`: suggesters see why they can't).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClock, Copy, LogOut, Trash2 } from "lucide-react";
import {
	type FormEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { DurationInput, TimeInput } from "@/components/common/time";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	type HolidayRow,
	HolidaysEditor,
	holidaysDraftError,
	holidaysOfDraft,
} from "@/features/insights/HolidaysEditor";
import { tripMoneyQuery } from "@/features/money/queries";
import { removeTripOffline } from "@/features/offline/saved-trips";
import {
	deleteTrip,
	previewTripDates,
	setTripDates,
	updateTrip,
} from "@/functions/trips.functions";
import { can } from "@/lib/auth/roles";
import { errorCode } from "@/lib/errors";
import { formatDayDate } from "@/lib/format";
import { meKeys, tripKeys } from "@/lib/query/keys";
import { useFormPresence } from "@/lib/realtime/form-presence";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { currencyName, HOME_CURRENCIES } from "./currencies";
import { DuplicateTripDialog } from "./DuplicateTripDialog";
import { DateRangeField } from "./date-fields";
import { useDialogFocus } from "./dialog-focus";
import { leaveTrip } from "./sharing.functions";
import { HOME_TESTID } from "./testids";

/** Two settings forms hold the same values (shallow: every field is a primitive). */
function sameForm<T extends Record<string, unknown>>(a: T, b: T): boolean {
	return Object.keys(a).every((k) => Object.is(a[k], b[k]));
}

const WALK_SPEEDS = [
	{ v: 3.5, label: "Relaxed · 3.5 km/h" },
	{ v: 4.5, label: "Normal · 4.5 km/h" },
	{ v: 5.5, label: "Brisk · 5.5 km/h" },
];

function Row({
	label,
	htmlFor,
	hint,
	children,
}: {
	label: string;
	htmlFor?: string;
	hint?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="grid gap-1.5 sm:grid-cols-[160px_1fr] sm:items-start sm:gap-4">
			<Label
				htmlFor={htmlFor}
				className="text-[13px] text-muted-foreground sm:h-9"
			>
				{label}
			</Label>
			<div className="grid min-w-0 gap-1">
				{children}
				{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
			</div>
		</div>
	);
}

function Heading({ children }: { children: ReactNode }) {
	return (
		<h3 className="pt-2 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
			{children}
		</h3>
	);
}

/** Dates: pick → preview what moves → apply (or suggest). */
function DatesRow() {
	const { graph, mode } = useWorkspace();
	const trip = graph.trip;
	const [from, setFrom] = useState<string | null>(trip.startDate);
	const [to, setTo] = useState<string | null>(trip.endDate);
	const openShift = useUi((s) => s.openShiftTrip);
	const { disabled, reason } = useEditGuard();
	useEffect(() => {
		setFrom(trip.startDate);
		setTo(trip.endDate);
	}, [trip.startDate, trip.endDate]);
	const changed =
		!!from && !!to && (from !== trip.startDate || to !== trip.endDate);
	const preview = useQuery({
		// With the graph's version: a change that refreshes the graph refreshes
		// the preview too, so it never shows (or sends) an older review.
		queryKey: ["trip-dates-preview", trip.id, from, to, trip.version],
		queryFn: () =>
			previewTripDates({
				data: { tripId: trip.id, startDate: from ?? "", endDate: to ?? "" },
			}),
		enabled: changed && mode === "live",
		staleTime: 10_000,
	});
	// QA NOTE-VERSION-CONFLICT: `expectedVersion` is the version the shown
	// preview was computed at (what the user reviewed). The graph's version
	// lags behind changes that don't refetch the graph (a to-do, an expense),
	// which refused a date change nothing had touched.
	const apply = useTripMutation(
		(v: { startDate: string; endDate: string; expectedVersion: number }) =>
			setTripDates({ data: { tripId: trip.id, ...v } }),
		{
			tripId: trip.id,
			keys: [
				tripKeys.graph(trip.id),
				tripKeys.lists(trip.id),
				tripKeys.counts(trip.id),
				meKeys.trips,
			],
			onSuccess: () => toast.success("Dates changed"),
		},
	);
	const p = preview.data;
	const items = p?.affectedItems ?? [];
	return (
		<div className="grid gap-2">
			<Row label="Dates" htmlFor="trip-settings-dates">
				<div className="grid justify-items-start gap-1">
					<DateRangeField
						id="trip-settings-dates"
						from={from}
						to={to}
						disabled={disabled}
						testId={HOME_TESTID.settingsDates}
						onChange={(a, b) => {
							setFrom(a);
							setTo(b);
						}}
					/>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="-ml-2 h-7 text-primary hover:text-primary"
						disabled={disabled || !trip.startDate}
						title={reason ?? undefined}
						data-testid={HOME_TESTID.settingsTryDates}
						onClick={() => openShift(true)}
					>
						<CalendarClock /> Try other dates…
					</Button>
				</div>
			</Row>
			{changed ? (
				<div className="grid gap-2 rounded-lg bg-muted/60 p-3 text-[13px] sm:ml-[176px]">
					{p?.blockedBy ? (
						<p className="text-warning">{p.blockedBy}</p>
					) : items.length ? (
						<p>
							{items.length} {items.length === 1 ? "item" : "items"} on{" "}
							{p?.removedDays
								.slice(0, 3)
								.map((d) => formatDayDate(d))
								.join(", ")}
							{(p?.removedDays.length ?? 0) > 3 ? "…" : ""} move to Unscheduled.
							Nothing is deleted.
							<span className="mt-1 block truncate text-muted-foreground">
								{items
									.slice(0, 4)
									.map((i) => i.title)
									.join(" · ")}
								{items.length > 4 ? ` +${items.length - 4}` : ""}
							</span>
						</p>
					) : (
						<p className="text-muted-foreground">
							{preview.isPending
								? "Checking what moves…"
								: "Nothing moves to Unscheduled."}
						</p>
					)}
					<div className="flex gap-2">
						<Button
							type="button"
							size="sm"
							data-testid={HOME_TESTID.datesConfirm}
							disabled={
								disabled ||
								apply.isPending ||
								preview.isPending ||
								// A refetch (after a CONFLICT) is a new review: wait for it.
								preview.isFetching ||
								!!p?.blockedBy
							}
							onClick={() => {
								if (!from || !to) return;
								apply.mutate(
									{
										startDate: from,
										endDate: to,
										expectedVersion: p?.version ?? trip.version,
									},
									{
										// "Review again": the next click sends the fresh preview's version.
										onError: (e) => {
											if (errorCode(e) === "CONFLICT") void preview.refetch();
										},
									},
								);
							}}
						>
							{mode === "live" && useUi.getState().suggesting
								? "Suggest these dates"
								: "Change dates"}
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => {
								setFrom(trip.startDate);
								setTo(trip.endDate);
							}}
						>
							Cancel
						</Button>
					</div>
				</div>
			) : null}
		</div>
	);
}

function DeleteTrip() {
	const { graph } = useWorkspace();
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const navigate = useNavigate();
	const qc = useQueryClient();
	const setSettingsOpen = useUi((s) => s.setSettingsOpen);
	const del = useMutation({
		mutationFn: () => deleteTrip({ data: { tripId: graph.trip.id } }),
		onSuccess: async () => {
			await removeTripOffline(graph.trip.id);
			await qc.invalidateQueries({ queryKey: meKeys.trips });
			setOpen(false);
			setSettingsOpen(false);
			toast.success(`Deleted “${graph.trip.name}”`);
			await navigate({ to: "/" });
		},
	});
	return (
		<>
			<EditGuard kind="edit-only" reason="Only the owner can delete a trip">
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
					data-testid={HOME_TESTID.settingsDelete}
					onClick={() => setOpen(true)}
				>
					<Trash2 /> Delete trip
				</Button>
			</EditGuard>
			<AlertDialog open={open} onOpenChange={setOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete “{graph.trip.name}”?</AlertDialogTitle>
						<AlertDialogDescription>
							Everyone loses the trip, its plan, notes, lists and photos. Type
							the trip's name to confirm.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<Input
						autoFocus
						value={typed}
						onChange={(e) => setTyped(e.target.value)}
						aria-label="Trip name"
						placeholder={graph.trip.name}
					/>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={
								typed.trim() !== graph.trip.name.trim() || del.isPending
							}
							onClick={(e) => {
								e.preventDefault();
								del.mutate();
							}}
							className="bg-destructive text-white hover:bg-destructive/90"
						>
							Delete trip
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

function LeaveTrip() {
	const { graph } = useWorkspace();
	const navigate = useNavigate();
	const qc = useQueryClient();
	const setSettingsOpen = useUi((s) => s.setSettingsOpen);
	const [confirm, setConfirm] = useState(false);
	const leave = useMutation({
		mutationFn: () => leaveTrip({ data: { tripId: graph.trip.id } }),
		onSuccess: async () => {
			await removeTripOffline(graph.trip.id);
			await qc.invalidateQueries({ queryKey: meKeys.trips });
			setSettingsOpen(false);
			toast.success(`You left “${graph.trip.name}”`);
			await navigate({ to: "/" });
		},
	});
	const { disabled, reason } = useEditGuard();
	const offlineOnly = disabled && reason !== "View only";
	return confirm ? (
		<div className="flex flex-wrap items-center gap-2 text-[13px]">
			<span>Leave this trip? Someone on it can add you again.</span>
			<Button
				type="button"
				size="sm"
				variant="destructive"
				disabled={leave.isPending}
				onClick={() => leave.mutate()}
			>
				Leave
			</Button>
			<Button
				type="button"
				size="sm"
				variant="ghost"
				onClick={() => setConfirm(false)}
			>
				Cancel
			</Button>
		</div>
	) : (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			disabled={offlineOnly}
			title={offlineOnly ? (reason ?? undefined) : undefined}
			data-testid={HOME_TESTID.settingsLeave}
			onClick={() => setConfirm(true)}
			className="justify-self-start text-muted-foreground"
		>
			<LogOut /> Leave trip
		</Button>
	);
}

export function TripSettingsDialog() {
	const open = useUi((s) => s.settingsOpen);
	// FB-24: followers see "Dennis opened 'Trip settings'".
	useFormPresence(open ? { k: "settings", m: "edit" } : null);
	const setOpen = useUi((s) => s.setSettingsOpen);
	const focus = useDialogFocus();
	const { graph, mode } = useWorkspace();
	const trip = graph.trip;
	const s = trip.settings ?? {};
	const ids = {
		name: useId(),
		slug: useId(),
		start: useId(),
		cap: useId(),
		cur: useId(),
		walk: useId(),
		auto: useId(),
	};
	const who = { role: graph.me.role, isGuest: graph.me.isGuest };
	const owner = can(who, "changeSlug");
	const member = !graph.me.isGuest && !!graph.me.memberId;
	const [dup, setDup] = useState(false);
	const [form, setForm] = useState(() => initial());
	// Unsaved public-holiday rows (NEW-V52-01): held here so this dialog's own
	// Save writes them too, and so nothing but closing the dialog drops them.
	const [holidayDraft, setHolidayDraft] = useState<HolidayRow[] | null>(null);
	function initial() {
		return {
			name: trip.name,
			slug: trip.slug,
			dayStart: s.defaultDayStart ?? "09:00",
			capacity: s.dayCapacityMin ?? 750,
			currency: s.currency ?? "USD",
			walk: s.walkSpeedKmh ?? 4.5,
			autofill: s.autofillLegs ?? true,
		};
	}
	// The form as last reset: a change to the trip (a remote edit, or "Save
	// holidays" here) refreshes the fields only while they're untouched, so it
	// never wipes what someone is typing.
	const baseline = useRef(form);
	const wasOpen = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset when the dialog opens or the trip changes remotely
	useEffect(() => {
		const opening = open && !wasOpen.current;
		wasOpen.current = open;
		if (!open) {
			setHolidayDraft(null);
			return;
		}
		const next = initial();
		setForm((f) => (opening || sameForm(f, baseline.current) ? next : f));
		baseline.current = next;
	}, [open, trip.updatedAt]);
	const money = useQuery({
		...tripMoneyQuery(trip.id),
		enabled: open && mode === "live" && !graph.me.isGuest,
	});
	const expenses = money.data?.expenses.length ?? 0;
	const qc = useQueryClient();
	const save = useMutation({
		mutationFn: () =>
			updateTrip({
				data: {
					tripId: trip.id,
					...(form.name.trim() !== trip.name ? { name: form.name.trim() } : {}),
					...(owner && form.slug !== trip.slug ? { slug: form.slug } : {}),
					settings: {
						defaultDayStart: form.dayStart,
						dayCapacityMin: form.capacity,
						currency: form.currency,
						walkSpeedKmh: form.walk,
						autofillLegs: form.autofill,
						// A holiday filled in but not saved with its own button.
						...(holidayDraft
							? { holidays: holidaysOfDraft(holidayDraft) }
							: {}),
					},
				},
			}),
		onSuccess: async ({ slug }) => {
			setHolidayDraft(null);
			await Promise.all([
				qc.invalidateQueries({ queryKey: tripKeys.graph(trip.id) }),
				qc.invalidateQueries({ queryKey: meKeys.trips }),
				qc.invalidateQueries({ queryKey: tripKeys.money(trip.id) }),
			]);
			setOpen(false);
			toast.success("Settings saved");
			if (slug !== trip.slug)
				window.history.replaceState(
					window.history.state,
					"",
					window.location.pathname.replace(`/t/${trip.slug}`, `/t/${slug}`) +
						window.location.search,
				);
		},
	});
	const { disabled } = useEditGuard(
		"edit-only",
		"Suggesters can't change trip settings",
	);
	const slugOk = /^[a-z0-9-]{1,100}$/.test(form.slug);
	const holidayError = holidayDraft ? holidaysDraftError(holidayDraft) : null;
	const submit = (e: FormEvent) => {
		e.preventDefault();
		// A half-filled holiday: say so (the editor shows which) and keep the
		// dialog open rather than save the rest and drop it.
		if (holidayError) {
			toast.error(`Public holidays: ${holidayError}`);
			return;
		}
		if (form.name.trim() && slugOk) save.mutate();
	};
	const currencyChanged = form.currency !== (s.currency ?? "USD");
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				className="flex max-h-[calc(100svh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]"
				// The dialog itself takes focus (no phone keyboard), Tab stays
				// inside, and closing goes back to the opener (QA A11Y-02).
				{...focus}
				data-testid={TESTID.tripSettingsDialog}
			>
				<form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
					<div className="grid min-h-0 gap-4 overflow-y-auto p-6">
						<DialogHeader>
							<DialogTitle>Trip settings</DialogTitle>
							<DialogDescription>
								Changes are saved for everyone on the trip.
							</DialogDescription>
						</DialogHeader>
						<Row label="Name" htmlFor={ids.name}>
							<Input
								id={ids.name}
								value={form.name}
								maxLength={120}
								disabled={disabled}
								data-testid={HOME_TESTID.settingsName}
								onChange={(e) => setForm({ ...form, name: e.target.value })}
							/>
						</Row>
						{owner ? (
							<Row
								label="Address"
								htmlFor={ids.slug}
								hint={
									slugOk
										? "Old links to the trip stop working when this changes."
										: "Lowercase letters, numbers and dashes only."
								}
							>
								<div className="flex items-center rounded-md border border-input focus-within:ring-2 focus-within:ring-ring/50">
									<span className="pl-3 font-mono text-xs text-muted-foreground">
										/t/
									</span>
									<Input
										id={ids.slug}
										value={form.slug}
										maxLength={100}
										disabled={disabled}
										aria-invalid={!slugOk}
										data-testid={HOME_TESTID.settingsSlug}
										onChange={(e) =>
											setForm({
												...form,
												slug: e.target.value.toLowerCase().replace(/\s+/g, "-"),
											})
										}
										className="border-0 pl-0.5 font-mono text-xs shadow-none focus-visible:ring-0"
									/>
								</div>
							</Row>
						) : null}
						<DatesRow />
						<Heading>Plan</Heading>
						<Row label="Days start at" htmlFor={ids.start}>
							<TimeInput
								value={form.dayStart}
								disabled={disabled}
								aria-label="Default day start"
								className="w-36"
								onChange={(v) => v && setForm({ ...form, dayStart: v })}
							/>
						</Row>
						<Row
							label="Planned per day"
							hint="Days that run longer show a gentle warning."
						>
							<span className="flex items-center sm:h-9">
								<DurationInput
									value={form.capacity}
									disabled={disabled}
									presets={[480, 600, 720, 750, 840]}
									onChange={(v) =>
										setForm({
											...form,
											capacity: Math.min(1440, Math.max(60, v)),
										})
									}
								/>
							</span>
						</Row>
						<Row label="Walking speed" htmlFor={ids.walk}>
							<Select
								value={String(form.walk)}
								disabled={disabled}
								onValueChange={(v) => setForm({ ...form, walk: Number(v) })}
							>
								<SelectTrigger id={ids.walk} className="w-full sm:w-64">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{WALK_SPEEDS.map((w) => (
										<SelectItem key={w.v} value={String(w.v)}>
											{w.label}
										</SelectItem>
									))}
									{WALK_SPEEDS.some((w) => w.v === form.walk) ? null : (
										<SelectItem value={String(form.walk)}>
											{form.walk} km/h
										</SelectItem>
									)}
								</SelectContent>
							</Select>
						</Row>
						<Row label="Travel times" htmlFor={ids.auto}>
							<label
								htmlFor={ids.auto}
								className="flex items-center gap-2 text-sm sm:h-9"
							>
								<Switch
									id={ids.auto}
									checked={form.autofill}
									disabled={disabled}
									onCheckedChange={(v) => setForm({ ...form, autofill: v })}
								/>
								Fill in travel times automatically
							</label>
						</Row>
						{!graph.me.isGuest ? (
							<>
								<Heading>Money</Heading>
								<Row
									label="Home currency"
									htmlFor={ids.cur}
									hint={
										currencyChanged ? (
											<span className="text-foreground">
												{expenses
													? `${expenses} ${expenses === 1 ? "expense" : "expenses"} will be re-converted to ${form.currency}. `
													: ""}
												Balances, budgets and totals will be in{" "}
												{currencyName(form.currency)}. Each expense keeps its
												own currency.
											</span>
										) : (
											"Balances, budgets and group totals use it. Each expense keeps its own currency."
										)
									}
								>
									<Select
										value={form.currency}
										disabled={disabled}
										onValueChange={(v) => setForm({ ...form, currency: v })}
									>
										<SelectTrigger
											id={ids.cur}
											className="w-full sm:w-64"
											data-testid={HOME_TESTID.settingsCurrency}
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{[...new Set([form.currency, ...HOME_CURRENCIES])].map(
												(c) => (
													<SelectItem key={c} value={c}>
														<span className="font-mono text-xs">{c}</span>{" "}
														{currencyName(c)}
													</SelectItem>
												),
											)}
										</SelectContent>
									</Select>
								</Row>
							</>
						) : null}
						{/* HolidaysEditor carries its own "Public holidays" overline (QA VIS-15). */}
						<div className="pt-2">
							<HolidaysEditor
								draft={holidayDraft}
								onDraftChange={setHolidayDraft}
							/>
						</div>
						{member ? (
							<div className="grid gap-3 border-t pt-4">
								<div className="flex flex-wrap items-center gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										data-testid={HOME_TESTID.settingsDuplicate}
										onClick={() => setDup(true)}
									>
										<Copy /> Duplicate…
									</Button>
									{graph.me.role !== "owner" ? <LeaveTrip /> : null}
								</div>
								{owner ? (
									<div className="grid gap-2 rounded-lg border border-destructive/25 p-3">
										<p className="text-[13px] font-medium">Danger zone</p>
										<p className="text-xs text-muted-foreground">
											Deleting removes the trip for everyone. It can't be
											undone.
										</p>
										<div>
											<DeleteTrip />
										</div>
									</div>
								) : null}
							</div>
						) : null}
					</div>
					<DialogFooter className="flex-row justify-end border-t bg-background px-6 py-3">
						<Button
							type="button"
							variant="ghost"
							onClick={() => setOpen(false)}
						>
							Close
						</Button>
						<EditGuard
							kind="edit-only"
							reason="Suggesters can't change trip settings"
						>
							<Button
								type="submit"
								data-testid={HOME_TESTID.settingsSave}
								disabled={save.isPending || !form.name.trim() || !slugOk}
							>
								Save
							</Button>
						</EditGuard>
					</DialogFooter>
				</form>
				{dup ? (
					<DuplicateTripDialog trip={trip} open={dup} onOpenChange={setDup} />
				) : null}
			</DialogContent>
		</Dialog>
	);
}
