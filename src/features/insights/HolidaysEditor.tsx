/**
 * E1: public holidays in Trip settings (WP-Home mounts it): rows of date,
 * name and country. On a listed holiday a place uses its holiday hours
 * (hours day 7) when it has them; a holiday with a country applies only to
 * places in that country. Saved into `settings.holidays` (`updateTrip`,
 * owners and editors).
 *
 * Trip settings mounts this inside its own `<form>` (QA COLLAB-R3-01): every
 * button here is `type="button"` so none of them submits (and closes) the
 * settings, and Enter in a holiday name saves the holidays instead of
 * submitting the settings form. It also holds the unsaved rows (`draft`,
 * NEW-V52-01), so the dialog's own "Save" saves a filled-in holiday too:
 * before, that Save wrote the other settings, closed the dialog and dropped
 * the new holiday without a word.
 */
import { cn } from "cn";
import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useEditGuard } from "@/components/common/edit-guard";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { updateTrip } from "@/functions/trips.functions";
import { shortDate } from "@/lib/engine/hours";
import type { TripGraph } from "@/lib/engine/types";
import { flagEmoji } from "@/lib/format";
import { tripKeys } from "@/lib/query/keys";
import type {
	Holiday,
	TripSettings,
	TripSettingsPatch,
} from "@/lib/schemas/trips";
import { TESTID } from "@/lib/testids";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import { INSIGHTS_TESTID } from "./testids";
import { DateField, Overline } from "./ui";

/** One holiday row as edited (an unsaved row may be half filled in). */
export type HolidayRow = { date: string; name: string; countryCode: string };
type Row = HolidayRow;
const ANY = "any";

/** Why a draft can't be saved yet, or null. Empty rows are ignored. */
export function holidaysDraftError(rows: readonly HolidayRow[]): string | null {
	const seen = new Set<string>();
	for (const r of rows) {
		if (!r.date && !r.name.trim()) continue;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date))
			return "Each holiday needs a date.";
		if (!r.name.trim()) return "Each holiday needs a name.";
		const k = `${r.date}|${r.countryCode}`;
		if (seen.has(k)) return `${shortDate(r.date)} is listed twice.`;
		seen.add(k);
	}
	return null;
}

/** A draft as `settings.holidays` (empty rows dropped, sorted by date). */
export function holidaysOfDraft(rows: readonly HolidayRow[]): Holiday[] {
	return rows
		.filter((r) => r.date && r.name.trim())
		.map((r) => ({
			date: r.date,
			name: r.name.trim().slice(0, 60),
			...(r.countryCode ? { countryCode: r.countryCode } : {}),
		}))
		.sort((a, b) => a.date.localeCompare(b.date))
		.slice(0, 100);
}

export function HolidaysEditor({
	tripId: tripIdProp,
	settings: settingsProp,
	countries: countriesProp,
	draft,
	onDraftChange,
}: {
	/** Outside a workspace (the dashboard's settings), pass the trip. */
	tripId?: string;
	settings?: TripSettings;
	countries?: { code: string; name: string }[];
	/**
	 * Controlled draft (NEW-V52-01): Trip settings holds the unsaved rows, so
	 * its own "Save" writes them too instead of dropping them, and a remote
	 * change to the trip never resets them. Null = nothing unsaved.
	 */
	draft?: HolidayRow[] | null;
	onDraftChange?: (rows: HolidayRow[] | null) => void;
} = {}) {
	const ws = useWorkspaceOptional();
	const tripId = tripIdProp ?? ws?.graph.trip.id ?? "";
	const settings = settingsProp ?? ws?.graph.trip.settings ?? {};
	const tripStart = ws?.graph.trip.startDate ?? null;
	const guard = useEditGuard(
		"edit-only",
		"Only editors can change trip settings",
	);
	const countries = useMemo(
		() =>
			countriesProp ??
			(ws?.graph.nodes ?? [])
				.filter((n) => n.type === "country" && n.countryCode)
				.map((n) => ({ code: n.countryCode as string, name: n.name })),
		[countriesProp, ws?.graph.nodes],
	);
	const saved = settings.holidays ?? [];
	const [ownRows, setOwnRows] = useState<Row[] | null>(null);
	const rows = onDraftChange ? (draft ?? null) : ownRows;
	const setRows = onDraftChange ?? setOwnRows;
	const current: Row[] =
		rows ??
		saved.map((h) => ({
			date: h.date,
			name: h.name,
			countryCode: h.countryCode ?? "",
		}));
	const save = useTripMutation(
		(v: { tripId: string; settings: TripSettingsPatch }) =>
			updateTrip({ data: v }),
		{
			keys: [tripKeys.graph(tripId)],
			// Closure chips pick up the new holidays before the server answers.
			optimistic: (qc, v) =>
				qc.setQueryData<TripGraph>(tripKeys.graph(tripId), (g) =>
					g
						? {
								...g,
								trip: {
									...g.trip,
									settings: { ...g.trip.settings, ...v.settings },
								},
							}
						: g,
				),
		},
	);
	const dirty = rows !== null;
	const error = holidaysDraftError(current);
	const set = (i: number, patch: Partial<Row>) =>
		setRows(current.map((r, j) => (j === i ? { ...r, ...patch } : r)));

	const canSave = dirty && !error && !guard.disabled && !save.isPending;
	const submit = () => {
		if (error) return;
		const holidays = holidaysOfDraft(current);
		// Only `holidays` is sent: `updateTrip` writes just the keys it gets.
		save.mutate(
			{ tripId, settings: { holidays } },
			{
				onSuccess: () => {
					setRows(null);
					toast(
						holidays.length
							? `${holidays.length} holiday${holidays.length === 1 ? "" : "s"} saved`
							: "Holidays cleared",
					);
				},
			},
		);
	};

	return (
		<section data-testid={TESTID.holidaysEditor} className="grid gap-2.5">
			<div className="grid gap-1">
				<Overline>Public holidays</Overline>
				<p className="text-[12px] leading-4 text-muted-foreground">
					Places use their holiday hours on these days.
				</p>
			</div>
			{current.length ? (
				<ul className="grid gap-1.5">
					{current.map((r, i) => (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved
							key={i}
							data-testid={INSIGHTS_TESTID.holidayRow}
							className="flex flex-wrap items-center gap-1.5"
						>
							<DateField
								label="Holiday date"
								value={r.date}
								defaultMonth={tripStart}
								disabled={guard.disabled}
								onChange={(date) => set(i, { date })}
								className="w-[10.5rem]"
							/>
							<Input
								aria-label="Holiday name"
								value={r.name}
								maxLength={60}
								disabled={guard.disabled}
								placeholder="Sports Day"
								onChange={(e) => set(i, { name: e.target.value })}
								onKeyDown={(e) => {
									// Enter would submit the enclosing settings form.
									if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
									e.preventDefault();
									if (canSave) submit();
								}}
								className="h-8 min-w-[8rem] flex-1 text-[13px]"
							/>
							<Select
								value={r.countryCode || ANY}
								disabled={guard.disabled}
								onValueChange={(v) =>
									set(i, { countryCode: v === ANY ? "" : v })
								}
							>
								<SelectTrigger
									size="sm"
									aria-label="Country"
									className="h-8 w-[7.5rem] text-[13px]"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ANY}>Everywhere</SelectItem>
									{countries.map((c) => (
										<SelectItem key={c.code} value={c.code}>
											{flagEmoji(c.code)} {c.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<button
								type="button"
								aria-label="Remove this holiday"
								disabled={guard.disabled}
								onClick={() => setRows(current.filter((_, j) => j !== i))}
								className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
							>
								<X className="size-3.5" />
							</button>
						</li>
					))}
				</ul>
			) : (
				<p className="text-[13px] text-muted-foreground">No holidays yet.</p>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					data-testid={INSIGHTS_TESTID.holidayAdd}
					disabled={guard.disabled || current.length >= 100}
					title={guard.reason ?? undefined}
					onClick={() =>
						setRows([
							...current,
							{
								date: "",
								name: "",
								countryCode:
									countries.length === 1 ? (countries[0]?.code ?? "") : "",
							},
						])
					}
					className="h-7 gap-1 px-2 text-xs text-muted-foreground"
				>
					<Plus className="size-3.5" /> Add holiday
				</Button>
				<span className="flex-1" />
				{error && dirty ? (
					<span className="text-[12px] text-destructive">{error}</span>
				) : null}
				{dirty ? (
					<>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-xs"
							onClick={() => setRows(null)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							size="sm"
							data-testid={INSIGHTS_TESTID.holidaySave}
							disabled={!canSave}
							onClick={submit}
							className={cn("h-7 px-3 text-xs")}
						>
							{save.isPending ? "Saving…" : "Save holidays"}
						</Button>
					</>
				) : null}
			</div>
		</section>
	);
}
