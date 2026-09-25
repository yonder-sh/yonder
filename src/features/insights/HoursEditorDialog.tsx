/**
 * E1 hours editor (EXTENSIONS §4.5), opened with `useUi().openHoursEditor({
 * nodeId })`: a 480px Dialog (a bottom sheet on phones) where every
 * `OpeningHours` field round-trips (`hours-draft.ts`): per weekday Closed /
 * 24h / ranges with a last entry, "Copy Mon to weekdays", Open 24h, "Also
 * closed: 2nd Tue", "Last entry 60 min before close", closed days alone
 * ("Hours unknown, closed on…"), holidays, special dates and a note. Sheet or
 * Google hours prefill it ("Parsed from the sheet — confirm or fix"); Save
 * stores them as manual through `setOpeningHours` (proposable `node.hours`).
 */
import { cn } from "cn";
import { Copy, Plus, Trash2, X } from "lucide-react";
import { createContext, useContext, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { useEditGuard } from "@/components/common/edit-guard";
import { undoToast } from "@/components/common/undo-toast";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { effectiveHours, WEEKDAY_SHORT } from "@/lib/engine/hours";
import { tripKeys } from "@/lib/query/keys";
import { useFormPresence } from "@/lib/realtime/form-presence";
import type { OpeningHours } from "@/lib/schemas/hours";
import { TESTID } from "@/lib/testids";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import { useUi } from "@/lib/workspace/ui-store";
import {
	type DayState,
	emptyRange,
	fromDraft,
	type HoursDraft,
	MAX_RANGES,
	normalizeClock,
	type RangeDraft,
	toDraft,
} from "./hours-draft";
import { shortIsoDay, WEEK_ORDER } from "./hours-format";
import { setOpeningHours } from "./insights.functions";
import { useLatestMount } from "./latest-mount";
import { INSIGHTS_TESTID } from "./testids";
import { DateField, Overline, Segmented, SHEET_ON_MOBILE } from "./ui";

/** Whether ranges show their own last-entry field. */
const ShowLastEntry = createContext(false);

const NTH_OPTIONS = [
	{ value: "1", label: "1st" },
	{ value: "2", label: "2nd" },
	{ value: "3", label: "3rd" },
	{ value: "4", label: "4th" },
	{ value: "5", label: "5th" },
	{ value: "-1", label: "last" },
];

export function HoursEditorDialog() {
	const req = useUi((s) => s.hoursEditor);
	// FB-24: "Dennis is editing opening hours" on the place.
	useFormPresence(
		req ? { k: "hours", m: "edit", t: `tree:${req.nodeId}` } : null,
	);
	const open = useUi((s) => s.openHoursEditor);
	const ws = useWorkspaceOptional();
	const live = useLatestMount("hours-editor-dialog");
	const node = req && ws ? ws.ix.node(req.nodeId) : undefined;
	if (!live) return null;
	return (
		<Dialog open={req !== null} onOpenChange={(v) => !v && open(null)}>
			<DialogContent
				className={cn(SHEET_ON_MOBILE, "sm:max-w-[480px]")}
				data-testid={TESTID.hoursEditorDialog}
			>
				{node && ws ? (
					<EditorBody
						key={node.id}
						nodeId={node.id}
						onClose={() => open(null)}
					/>
				) : (
					<DialogHeader className="p-5">
						<DialogTitle>Opening hours</DialogTitle>
						<DialogDescription>That place no longer exists.</DialogDescription>
					</DialogHeader>
				)}
			</DialogContent>
		</Dialog>
	);
}

function EditorBody({
	nodeId,
	onClose,
}: {
	nodeId: string;
	onClose: () => void;
}) {
	const ws = useWorkspaceOptional();
	const guard = useEditGuard();
	const node = ws?.ix.node(nodeId);
	const tripId = ws?.graph.trip.id ?? "";
	const eh = node && ws ? effectiveHours(node, ws.graph.trip.settings) : null;
	const stored = node?.details?.openingHours ?? null;
	const [draft, setDraft] = useState<HoursDraft>(() =>
		toDraft(eh?.hours ?? null),
	);
	const [error, setError] = useState<string | null>(null);
	// Per-range last entries stay out of the way unless the hours have some.
	const [showLast, setShowLast] = useState(() =>
		[...draft.days.flatMap((d) => d.ranges), ...draft.holiday.ranges].some(
			(r) => r.lastEntry,
		),
	);
	// The version the person started from (a stale save → CONFLICT).
	const [baseUpdatedAt] = useState(node?.updatedAt);
	const save = useTripMutation(
		(v: {
			nodeId: string;
			hours: OpeningHours | null;
			expectedUpdatedAt?: string;
		}) => setOpeningHours({ data: v }),
		{ keys: [tripKeys.graph(tripId)], tripId },
	);
	if (!node || !ws) return null;

	const update = (f: (d: HoursDraft) => void) => {
		setError(null);
		setDraft((d) => {
			const next = structuredClone(d);
			f(next);
			return next;
		});
	};

	const submit = () => {
		const r = fromDraft(draft, new Date().toISOString());
		if (!r.ok) {
			setError(r.error);
			return;
		}
		save.mutate(
			{
				nodeId,
				hours: r.hours,
				...(baseUpdatedAt ? { expectedUpdatedAt: baseUpdatedAt } : {}),
			},
			{
				onSuccess: (res) => {
					onClose();
					if (res && typeof res === "object" && "proposed" in res) return;
					toast(`Hours saved for ${node.name}`);
				},
			},
		);
	};
	const remove = () => {
		const previous = stored;
		save.mutate(
			{ nodeId, hours: null },
			{
				onSuccess: (res) => {
					onClose();
					if (res && typeof res === "object" && "proposed" in res) return;
					if (previous)
						undoToast(`Hours removed from ${node.name}`, () =>
							save.mutate({ nodeId, hours: previous }),
						);
				},
			},
		);
	};

	const banner =
		eh?.source === "sheet"
			? {
					title: "Parsed from the sheet — confirm or fix",
					raw: eh.raw ?? null,
					rest: eh.unparsed || null,
				}
			: eh?.source === "google"
				? {
						title: `From Google${shortIsoDay(eh.hours.updatedAt) ? ` · ${shortIsoDay(eh.hours.updatedAt)}` : ""}. Saving makes them yours.`,
						raw: null,
						rest: null,
					}
				: !eh && node.details?.openHoursText
					? {
							title: "The sheet says",
							raw: node.details.openHoursText,
							rest: null,
						}
					: null;

	return (
		<ShowLastEntry.Provider value={showLast}>
			<DialogHeader className="gap-1 border-b px-5 pt-5 pb-4 text-left">
				<DialogTitle className="text-[17px] leading-6 font-semibold">
					Opening hours
				</DialogTitle>
				<DialogDescription className="truncate text-[13px]">
					{node.name}
				</DialogDescription>
			</DialogHeader>
			<div className="grid min-h-0 flex-1 gap-5 overflow-y-auto px-5 py-4">
				{banner ? (
					<div
						data-testid={INSIGHTS_TESTID.hoursEditorBanner}
						className="grid gap-1 rounded-lg bg-muted/70 px-3 py-2.5 text-[12px] leading-4"
					>
						<p className="font-medium text-foreground">{banner.title}</p>
						{banner.raw ? (
							<p className="text-muted-foreground italic">“{banner.raw}”</p>
						) : null}
						{banner.rest ? (
							<p className="text-muted-foreground">Not read: {banner.rest}</p>
						) : null}
					</div>
				) : null}

				<div className="grid gap-3">
					<Segmented
						label="Kind of hours"
						testId={INSIGHTS_TESTID.hoursEditorMode}
						value={draft.mode}
						onChange={(mode) =>
							update((d) => {
								d.mode = mode;
							})
						}
						options={[
							{ value: "weekly", label: "Weekly hours" },
							{ value: "always", label: "Open 24h" },
							{ value: "closedOnly", label: "Only closed days" },
						]}
						className="max-w-full overflow-x-auto"
					/>

					{draft.mode === "weekly" ? (
						<WeeklyEditor draft={draft} update={update} />
					) : draft.mode === "closedOnly" ? (
						<div className="grid gap-2">
							<p className="text-[13px] text-muted-foreground">
								Hours unknown, closed on:
							</p>
							<div className="flex flex-wrap gap-1.5">
								{WEEK_ORDER.map((day) => {
									const on = draft.closedDays.includes(day);
									return (
										<button
											key={day}
											type="button"
											aria-pressed={on}
											data-testid={INSIGHTS_TESTID.hoursEditorClosedDay}
											data-day={day}
											onClick={() =>
												update((d) => {
													d.closedDays = on
														? d.closedDays.filter((x) => x !== day)
														: [...d.closedDays, day];
												})
											}
											className={cn(
												"h-8 min-w-11 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
												on
													? "border-foreground bg-foreground text-background"
													: "border-input text-muted-foreground hover:text-foreground",
											)}
										>
											{WEEKDAY_SHORT[day]}
										</button>
									);
								})}
							</div>
						</div>
					) : (
						<p className="text-[13px] text-muted-foreground">
							Open day and night. Special dates below still apply.
						</p>
					)}
				</div>

				<div className="grid gap-3 border-t pt-4">
					<Overline>Rules</Overline>
					<div className="grid gap-2">
						{draft.closedNth.length ? (
							<p className="text-[13px] text-muted-foreground">
								Also closed on the
							</p>
						) : null}
						{draft.closedNth.map((n, i) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
								key={i}
								data-testid={INSIGHTS_TESTID.hoursEditorNth}
								className="flex flex-wrap items-center gap-2 text-[13px]"
							>
								<Select
									value={String(n.nth)}
									onValueChange={(v) =>
										update((d) => {
											d.closedNth[i] = { ...n, nth: Number(v) };
										})
									}
								>
									<SelectTrigger
										size="sm"
										aria-label="Which week"
										className="h-8 w-[4.75rem]"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{NTH_OPTIONS.map((o) => (
											<SelectItem key={o.value} value={o.value}>
												{o.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Select
									value={String(n.day)}
									onValueChange={(v) =>
										update((d) => {
											d.closedNth[i] = { ...n, day: Number(v) };
										})
									}
								>
									<SelectTrigger
										size="sm"
										aria-label="Weekday"
										className="h-8 w-[4.75rem]"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{WEEK_ORDER.map((day) => (
											<SelectItem key={day} value={String(day)}>
												{WEEKDAY_SHORT[day]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<span className="text-muted-foreground">of each month</span>
								<IconButton
									label="Remove this rule"
									onClick={() => update((d) => void d.closedNth.splice(i, 1))}
								>
									<X className="size-3.5" />
								</IconButton>
							</div>
						))}
						{draft.closedNth.length < 4 ? (
							<Button
								variant="ghost"
								size="sm"
								data-testid={INSIGHTS_TESTID.hoursEditorAddNth}
								onClick={() =>
									update((d) => void d.closedNth.push({ day: 2, nth: 2 }))
								}
								className="h-7 w-fit gap-1 px-2 text-xs text-muted-foreground"
							>
								<Plus className="size-3.5" /> Also closed on a certain week (2nd
								Tue…)
							</Button>
						) : null}
					</div>
					<div className="flex flex-wrap items-center gap-2 text-[13px]">
						<span className="text-muted-foreground">Last entry</span>
						<Input
							inputMode="numeric"
							aria-label="Last entry, minutes before close"
							data-testid={INSIGHTS_TESTID.hoursEditorLastEntry}
							value={draft.lastEntryMin}
							onChange={(e) => {
								const v = e.target.value.replace(/[^\d]/g, "").slice(0, 3);
								update((d) => {
									d.lastEntryMin = v;
								});
							}}
							placeholder="–"
							className="h-8 w-16 text-center font-mono tnum"
						/>
						<span className="text-muted-foreground">min before close</span>
						{draft.mode === "weekly" ? (
							<Button
								variant="ghost"
								size="sm"
								aria-pressed={showLast}
								onClick={() => setShowLast((v) => !v)}
								className="ml-auto h-7 px-2 text-xs text-muted-foreground"
							>
								{showLast ? "Hide per-day times" : "Or a time per day"}
							</Button>
						) : null}
					</div>
				</div>

				<ExceptionsEditor
					draft={draft}
					update={update}
					tripStart={ws.graph.trip.startDate}
				/>

				<div className="grid gap-1.5 border-t pt-4">
					<Overline>Note</Overline>
					<Input
						aria-label="Note"
						data-testid={INSIGHTS_TESTID.hoursEditorNote}
						value={draft.note}
						maxLength={200}
						onChange={(e) =>
							update((d) => {
								d.note = e.target.value;
							})
						}
						placeholder="Cash only · kitchen closes 30 min earlier"
						className="h-9"
					/>
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-2 border-t bg-background px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
				{stored ? (
					<Button
						variant="ghost"
						size="sm"
						data-testid={INSIGHTS_TESTID.hoursEditorRemove}
						disabled={guard.disabled || save.isPending}
						onClick={remove}
						className="h-8 gap-1 px-2 text-muted-foreground hover:text-destructive"
					>
						<Trash2 className="size-3.5" /> Remove
					</Button>
				) : null}
				{error ? (
					<p
						role="alert"
						data-testid={INSIGHTS_TESTID.hoursEditorError}
						className="min-w-0 flex-1 text-[12px] leading-4 text-destructive"
					>
						{error}
					</p>
				) : (
					<span className="flex-1" />
				)}
				<Button variant="ghost" size="sm" className="h-8" onClick={onClose}>
					Cancel
				</Button>
				<Button
					size="sm"
					data-testid={INSIGHTS_TESTID.hoursEditorSave}
					disabled={guard.disabled || save.isPending}
					title={guard.reason ?? undefined}
					onClick={submit}
					className="h-8 px-4"
				>
					{save.isPending
						? "Saving…"
						: ws.access.mode === "suggest"
							? "Suggest hours"
							: "Save hours"}
				</Button>
			</div>
		</ShowLastEntry.Provider>
	);
}

type Update = (f: (d: HoursDraft) => void) => void;

function WeeklyEditor({
	draft,
	update,
}: {
	draft: HoursDraft;
	update: Update;
}) {
	return (
		<div className="grid gap-1">
			{WEEK_ORDER.map((day) => (
				<DayRow key={day} day={day} draft={draft} update={update} />
			))}
			<div className="flex items-center justify-between gap-2 pt-1">
				<Button
					variant="ghost"
					size="sm"
					data-testid={INSIGHTS_TESTID.hoursEditorCopyMon}
					onClick={() =>
						update((d) => {
							const mon = d.days[1];
							if (!mon) return;
							for (const day of [2, 3, 4, 5])
								d.days[day] = structuredClone(mon);
						})
					}
					className="h-7 gap-1 px-2 text-xs text-muted-foreground"
				>
					<Copy className="size-3.5" /> Copy Mon to weekdays
				</Button>
			</div>
			<div
				data-testid={INSIGHTS_TESTID.hoursEditorHoliday}
				className="mt-1 grid gap-2 border-t pt-3 sm:grid-cols-[3.75rem_1fr] sm:gap-x-2"
			>
				<span className="pt-1.5 text-[13px] font-medium">Holidays</span>
				<div className="grid gap-1.5">
					<Segmented
						label="Holiday hours"
						value={draft.holiday.on ? "own" : "same"}
						onChange={(v) =>
							update((d) => {
								d.holiday.on = v === "own";
							})
						}
						options={[
							{ value: "same", label: "Like that weekday" },
							{ value: "own", label: "Own hours" },
						]}
						className="w-fit"
					/>
					{draft.holiday.on ? (
						<Ranges
							ranges={draft.holiday.ranges}
							where="Holidays"
							onChange={(ranges) =>
								update((d) => {
									d.holiday.ranges = ranges;
								})
							}
						/>
					) : null}
				</div>
			</div>
		</div>
	);
}

function DayRow({
	day,
	draft,
	update,
}: {
	day: number;
	draft: HoursDraft;
	update: Update;
}) {
	const dd = draft.days[day];
	if (!dd) return null;
	return (
		<div
			data-testid={INSIGHTS_TESTID.hoursEditorDay}
			data-day={day}
			data-state={dd.state}
			className="grid grid-cols-[2.75rem_1fr] items-start gap-x-2 py-0.5"
		>
			<span className="pt-1.5 text-[13px] font-medium">
				{WEEKDAY_SHORT[day]}
			</span>
			<div className="flex flex-wrap items-start gap-x-2 gap-y-1.5">
				<Select
					value={dd.state}
					onValueChange={(v) =>
						update((d) => {
							const t = d.days[day];
							if (t) t.state = v as DayState;
						})
					}
				>
					<SelectTrigger
						size="sm"
						data-testid={INSIGHTS_TESTID.hoursEditorDayState}
						aria-label={`${WEEKDAY_SHORT[day]}: open or closed`}
						className="h-8 w-[5.25rem] text-xs"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="hours">Hours</SelectItem>
						<SelectItem value="24h">24h</SelectItem>
						<SelectItem value="closed">Closed</SelectItem>
					</SelectContent>
				</Select>
				{dd.state === "hours" ? (
					<Ranges
						ranges={dd.ranges}
						where={WEEKDAY_SHORT[day] ?? ""}
						onChange={(ranges) =>
							update((d) => {
								const t = d.days[day];
								if (t) t.ranges = ranges;
							})
						}
					/>
				) : (
					<span className="pt-1.5 text-[13px] text-muted-foreground">
						{dd.state === "24h" ? "Open all day" : "Closed"}
					</span>
				)}
			</div>
		</div>
	);
}

function Ranges({
	ranges,
	where,
	onChange,
}: {
	ranges: RangeDraft[];
	where: string;
	onChange: (r: RangeDraft[]) => void;
}) {
	const showLast = useContext(ShowLastEntry);
	const set = (i: number, patch: Partial<RangeDraft>) =>
		onChange(ranges.map((r, j) => (j === i ? { ...r, ...patch } : r)));
	return (
		<div className="grid gap-1.5">
			{ranges.map((r, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: ranges have no identity
					key={i}
					className="flex flex-wrap items-center gap-1.5"
				>
					<ClockField
						value={r.open}
						label={`${where} opens`}
						testId={INSIGHTS_TESTID.hoursEditorOpen}
						onChange={(open) => set(i, { open })}
					/>
					<span className="text-muted-foreground">–</span>
					<ClockField
						value={r.close}
						label={`${where} closes`}
						allow24
						testId={INSIGHTS_TESTID.hoursEditorClose}
						onChange={(close) => set(i, { close })}
					/>
					{showLast || r.lastEntry ? (
						<ClockField
							value={r.lastEntry}
							label={`${where} last entry`}
							placeholder="last"
							muted
							onChange={(lastEntry) => set(i, { lastEntry })}
						/>
					) : null}
					{i > 0 ? (
						<IconButton
							label="Remove these hours"
							onClick={() => onChange(ranges.filter((_, j) => j !== i))}
						>
							<X className="size-3.5" />
						</IconButton>
					) : ranges.length < MAX_RANGES ? (
						<IconButton
							label={`Add a second range on ${where}`}
							testId={INSIGHTS_TESTID.hoursEditorAddRange}
							onClick={() => onChange([...ranges, emptyRange()])}
						>
							<Plus className="size-3.5" />
						</IconButton>
					) : null}
				</div>
			))}
		</div>
	);
}

/** A 24-hour "HH:mm" field in mono; typing "930" or "9pm" is fine (normalised on blur). */
function ClockField({
	value,
	onChange,
	label,
	allow24,
	placeholder = "00:00",
	muted,
	testId,
}: {
	value: string;
	onChange: (v: string) => void;
	label: string;
	allow24?: boolean;
	placeholder?: string;
	muted?: boolean;
	testId?: string;
}) {
	const bad = value.trim() !== "" && normalizeClock(value, allow24) === null;
	return (
		<Input
			value={value}
			aria-label={label}
			aria-invalid={bad || undefined}
			data-testid={testId}
			inputMode="numeric"
			autoComplete="off"
			placeholder={placeholder}
			maxLength={7}
			onChange={(e) => onChange(e.target.value)}
			onBlur={() => {
				const n = normalizeClock(value, allow24);
				if (n && n !== value) onChange(n);
			}}
			className={cn(
				"h-8 w-[4.25rem] px-2 text-center font-mono text-[13px] tnum",
				muted &&
					"text-muted-foreground placeholder:font-sans placeholder:text-[12px]",
			)}
		/>
	);
}

function IconButton({
	label,
	onClick,
	children,
	testId,
}: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
	testId?: string;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			data-testid={testId}
			onClick={onClick}
			className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		>
			{children}
		</button>
	);
}

function ExceptionsEditor({
	tripStart,
	draft,
	update,
}: {
	draft: HoursDraft;
	update: Update;
	tripStart: string | null;
}) {
	const id = useId();
	const sorted = useMemo(() => draft.exceptions, [draft.exceptions]);
	return (
		<div className="grid gap-2 border-t pt-4">
			<Overline>Special dates</Overline>
			{sorted.length ? (
				<div className="grid gap-2.5">
					{sorted.map((e, i) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
							key={i}
							data-testid={INSIGHTS_TESTID.hoursEditorException}
							className="grid gap-1.5 rounded-lg border px-2.5 py-2"
						>
							<div className="flex flex-wrap items-center gap-2">
								<DateField
									label="Special date"
									value={e.date}
									defaultMonth={tripStart}
									onChange={(date) =>
										update((d) => {
											d.exceptions[i] = { ...e, date };
										})
									}
									className="w-[10.5rem]"
								/>
								<Segmented
									label="Open or closed that day"
									value={e.closed ? "closed" : "hours"}
									onChange={(v) =>
										update((d) => {
											d.exceptions[i] = {
												...e,
												closed: v === "closed",
											};
										})
									}
									options={[
										{ value: "closed", label: "Closed" },
										{ value: "hours", label: "Hours" },
									]}
								/>
								<span className="flex-1" />
								<IconButton
									label="Remove this date"
									onClick={() => update((d) => void d.exceptions.splice(i, 1))}
								>
									<X className="size-3.5" />
								</IconButton>
							</div>
							{!e.closed ? (
								<Ranges
									ranges={e.ranges}
									where={e.date || "That day"}
									onChange={(ranges) =>
										update((d) => {
											d.exceptions[i] = { ...e, ranges };
										})
									}
								/>
							) : null}
							<Input
								id={`${id}-l${i}`}
								aria-label="What's special"
								value={e.label}
								maxLength={60}
								onChange={(ev) =>
									update((d) => {
										d.exceptions[i] = { ...e, label: ev.target.value };
									})
								}
								placeholder="Why (Sports Day, renovation…)"
								className="h-8 text-[13px]"
							/>
						</div>
					))}
				</div>
			) : (
				<p className="text-[13px] text-muted-foreground">
					None. Add a holiday closure or a short day.
				</p>
			)}
			{draft.exceptions.length < 60 ? (
				<Button
					variant="ghost"
					size="sm"
					data-testid={INSIGHTS_TESTID.hoursEditorAddException}
					onClick={() =>
						update(
							(d) =>
								void d.exceptions.push({
									date: "",
									closed: true,
									ranges: [emptyRange()],
									label: "",
								}),
						)
					}
					className="h-7 w-fit gap-1 px-2 text-xs text-muted-foreground"
				>
					<Plus className="size-3.5" /> Add a date
				</Button>
			) : null}
		</div>
	);
}
