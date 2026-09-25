/**
 * The date editor (EXTENSIONS §7 "Date editor"; ADDENDUM §10 relative
 * windows): opens with Due preselected and only the calendar; "Add time"
 * reveals time + zone (default: the target place's zone, else the trip's).
 * The secondary row holds the kind (Due · Opens · On), "By day…", "Before an
 * item…" (a rule that follows the item when it or the trip moves: "1 month
 * before at 10:00 JST", "355 days before", "the 10th, 2 months before") and
 * Clear. A live preview shows the resolved date.
 */
import { cn } from "cn";
import { CalendarClock, Link2 } from "lucide-react";
import { type ReactNode, type RefObject, useMemo, useState } from "react";
import { TimeInput } from "@/components/common/time";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useIsMobile } from "@/hooks/use-mobile";
import { dueCtxOf, effectiveDue } from "@/lib/engine/due";
import { tzLabel } from "@/lib/engine/time";
import type { DueKind } from "@/lib/schemas/enums";
import type { DueRule } from "@/lib/schemas/lists";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { dayLabel, itemName } from "./list-model";
import type { ListItemDto } from "./lists.functions";
import type { ListItemPatch } from "./server/proposable.server";
import { LISTS_TESTID } from "./testids";

type Mode = "date" | "day" | "relative";

const KINDS: { kind: DueKind; label: string }[] = [
	{ kind: "due", label: "Due" },
	{ kind: "opens", label: "Opens" },
	{ kind: "on", label: "On" },
];

const pad = (n: number) => String(n).padStart(2, "0");
/** A calendar Date (local components) ↔ `YYYY-MM-DD`. */
const toIso = (d: Date) =>
	`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s: string) => {
	const [y, m, d] = s.split("-").map(Number);
	return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
};

export function DueEditor({
	row,
	open,
	onOpenChange,
	onSave,
	children,
	rowRef,
}: {
	row: ListItemDto;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSave: (patch: ListItemPatch) => void;
	/** The anchor the popover hangs from. */
	children: ReactNode;
	/**
	 * The whole row. On phones the editor hangs from the ROW, not the date
	 * chip under its title: above or below it, it never covers the row's own
	 * title (polish, FB round 2).
	 */
	rowRef?: RefObject<HTMLElement | null>;
}) {
	const phone = useIsMobile();
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			{phone && rowRef ? (
				<>
					<PopoverAnchor virtualRef={rowRef} />
					{children}
				</>
			) : (
				<PopoverAnchor asChild>{children}</PopoverAnchor>
			)}
			{/*
			 * The editor is ~480 px tall with "Before an item…" open. Radix flips
			 * it to whichever side of the row has more room and keeps it on
			 * screen; when neither side has room for all of it (a row mid-screen
			 * on a phone), it is capped to the space it got and scrolls inside
			 * instead of running off the screen.
			 */}
			<PopoverContent
				align="end"
				collisionPadding={8}
				className="max-h-(--radix-popover-content-available-height) w-[312px] max-w-(--radix-popover-content-available-width) overflow-y-auto overscroll-contain p-0"
				data-testid={LISTS_TESTID.dueEditor}
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				{open ? (
					<DueForm
						row={row}
						onSave={(p) => {
							onSave(p);
							onOpenChange(false);
						}}
					/>
				) : null}
			</PopoverContent>
		</Popover>
	);
}

function DueForm({
	row,
	onSave,
}: {
	row: ListItemDto;
	onSave: (patch: ListItemPatch) => void;
}) {
	const { ix, graph, schedule } = useWorkspace();
	const ctx = useMemo(() => dueCtxOf(ix, schedule), [ix, schedule]);
	const targetNodeId =
		row.target.kind === "node"
			? row.target.nodeId
			: row.target.kind === "item"
				? (ix.item(row.target.itemId)?.nodeId ?? null)
				: null;
	const defaultTz = targetNodeId ? ix.tzOf(targetNodeId) : ix.defaultTz;

	const [mode, setMode] = useState<Mode>(
		row.dueRule ? "relative" : row.dueDayId && !row.dueDate ? "day" : "date",
	);
	const [kind, setKind] = useState<DueKind>(row.dueKind);
	const [date, setDate] = useState<string | null>(row.dueDate);
	const [showTime, setShowTime] = useState(!!row.dueTime);
	const [time, setTime] = useState(row.dueTime ?? "09:00");
	const [tz, setTz] = useState(row.dueTz ?? defaultTz);
	const [dayId, setDayId] = useState<string | null>(
		row.dueDayId ?? ix.days[0]?.id ?? null,
	);

	// Relative rule state.
	const scheduled = ix.ordered.filter((i) => i.dayId);
	const firstAt = (nodeId: string | null) =>
		nodeId ? scheduled.find((i) => i.nodeId === nodeId)?.id : undefined;
	const initialItem =
		row.dueRule?.itemId ??
		(row.target.kind === "item" ? row.target.itemId : undefined) ??
		firstAt(targetNodeId) ??
		scheduled[0]?.id ??
		null;
	const [itemId, setItemId] = useState<string | null>(initialItem);
	const [unit, setUnit] = useState<"days" | "months">(
		row.dueRule?.kind ?? "months",
	);
	const [amount, setAmount] = useState(
		String(
			row.dueRule
				? row.dueRule.kind === "days"
					? row.dueRule.days
					: row.dueRule.months
				: 1,
		),
	);
	const [dayOfMonth, setDayOfMonth] = useState(
		row.dueRule?.kind === "months" && row.dueRule.dayOfMonth
			? String(row.dueRule.dayOfMonth)
			: "",
	);
	const itemTz = (id: string | null) =>
		id ? ix.tzOf(ix.item(id)?.nodeId) : defaultTz;
	const [ruleTime, setRuleTime] = useState(row.dueRule?.time ?? "10:00");
	const [ruleTz, setRuleTz] = useState(row.dueRule?.tz ?? itemTz(initialItem));

	const zones = useMemo(() => {
		const set = new Set<string>([ix.defaultTz, defaultTz, tz, ruleTz]);
		for (const n of graph.nodes) if (n.tz) set.add(n.tz);
		try {
			set.add(Intl.DateTimeFormat().resolvedOptions().timeZone);
		} catch {
			// no Intl zone: the trip's zones are enough
		}
		set.add("UTC");
		return [...set].filter(Boolean).sort();
	}, [graph.nodes, ix.defaultTz, defaultTz, tz, ruleTz]);

	const n = Number.parseInt(amount, 10);
	const dom = Number.parseInt(dayOfMonth, 10);
	const rule: DueRule | null =
		itemId && Number.isFinite(n) && n >= 0
			? unit === "days"
				? {
						kind: "days",
						itemId,
						days: Math.min(n, 400),
						time: ruleTime || "00:00",
						tz: ruleTz,
					}
				: {
						kind: "months",
						itemId,
						months: Math.min(n, 24),
						...(Number.isFinite(dom) && dom >= 1 && dom <= 31
							? { dayOfMonth: dom }
							: {}),
						time: ruleTime || "00:00",
						tz: ruleTz,
					}
			: null;

	const patch: ListItemPatch | null =
		mode === "relative"
			? rule
				? { dueKind: kind, dueRule: rule }
				: null
			: mode === "day"
				? dayId
					? {
							dueKind: kind,
							dueDayId: dayId,
							dueDate: null,
							dueTime: null,
							dueTz: null,
						}
					: null
				: date
					? {
							dueKind: kind,
							dueDate: date,
							dueTime: showTime && time ? time : null,
							dueTz: showTime && time ? tz : null,
							dueDayId: null,
						}
					: null;

	const preview = patch
		? effectiveDue(
				{
					dueKind: kind,
					dueRule: mode === "relative" ? rule : null,
					dueDate: mode === "date" ? date : null,
					dueTime: mode === "date" && showTime ? time : null,
					dueTz: mode === "date" && showTime ? tz : null,
					dueDayId: mode === "day" ? dayId : null,
				},
				ctx,
			)
		: null;

	// FB-20: each zone's label at the due moment being edited (EST for a
	// December deadline even while New York is on EDT), else the trip's start.
	const labelDate = date || graph.trip.startDate;
	const labelAt =
		preview?.at ??
		(labelDate ? Date.parse(`${labelDate}T12:00:00Z`) : Date.now());

	const zoneSelect = (value: string, onChange: (v: string) => void) => (
		<Select value={value} onValueChange={onChange}>
			<SelectTrigger
				size="sm"
				className="h-8 min-w-0 flex-1"
				aria-label="Time zone"
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{zones.map((z) => (
					<SelectItem key={z} value={z}>
						{z.replace(/_/g, " ")} · {tzLabel(z, labelAt)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);

	return (
		<div className="flex flex-col">
			{mode === "date" ? (
				<div className="flex flex-col items-center">
					<Calendar
						mode="single"
						selected={date ? fromIso(date) : undefined}
						defaultMonth={fromIso(
							date ?? graph.trip.startDate ?? toIso(new Date()),
						)}
						onSelect={(d) => setDate(d ? toIso(d) : null)}
						className="p-2"
					/>
					<div className="flex w-full items-center gap-2 px-3 pb-2">
						{showTime ? (
							<>
								<TimeInput value={time} onChange={setTime} aria-label="Time" />
								{zoneSelect(tz, setTz)}
							</>
						) : (
							<Button
								variant="ghost"
								size="sm"
								className="h-7 px-2 text-muted-foreground"
								onClick={() => setShowTime(true)}
							>
								<CalendarClock /> Add time
							</Button>
						)}
					</div>
				</div>
			) : null}

			{mode === "day" ? (
				<div className="flex flex-col gap-2 p-3">
					<p className="text-xs text-muted-foreground">
						{kind === "due" ? "Done before this day starts:" : "On this day:"}
					</p>
					<Select value={dayId ?? undefined} onValueChange={setDayId}>
						<SelectTrigger size="sm" className="h-8 w-full" aria-label="Day">
							<SelectValue placeholder="Choose a day" />
						</SelectTrigger>
						<SelectContent>
							{ix.days.map((d) => (
								<SelectItem key={d.id} value={d.id}>
									{dayLabel(ix, d.id)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			) : null}

			{mode === "relative" ? (
				<div
					className="flex flex-col gap-2 p-3"
					data-testid={LISTS_TESTID.dueRelative}
				>
					<p className="text-xs text-muted-foreground">
						Moves with its item when the plan or the trip dates change.
					</p>
					<div className="flex items-center gap-2">
						<Input
							inputMode="numeric"
							value={amount}
							onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
							className="h-8 w-16 font-mono tnum"
							aria-label="How many"
						/>
						<Select
							value={unit}
							onValueChange={(v) => setUnit(v as "days" | "months")}
						>
							<SelectTrigger size="sm" className="h-8 flex-1" aria-label="Unit">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="days">days before</SelectItem>
								<SelectItem value="months">months before</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<Select
						value={itemId ?? undefined}
						onValueChange={(v) => {
							setItemId(v);
							setRuleTz(itemTz(v));
						}}
					>
						<SelectTrigger size="sm" className="h-8 w-full" aria-label="Item">
							<SelectValue placeholder="Choose what it's for" />
						</SelectTrigger>
						<SelectContent className="max-h-72">
							{ix.days.map((d) => {
								const its = scheduled.filter((i) => i.dayId === d.id);
								if (!its.length) return null;
								return (
									<SelectGroup key={d.id}>
										<SelectLabel>{dayLabel(ix, d.id)}</SelectLabel>
										{its.map((i) => (
											<SelectItem key={i.id} value={i.id}>
												{itemName(ix, i.id)}
											</SelectItem>
										))}
									</SelectGroup>
								);
							})}
						</SelectContent>
					</Select>
					{unit === "months" ? (
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							On day
							<Input
								inputMode="numeric"
								placeholder="same"
								value={dayOfMonth}
								onChange={(e) =>
									setDayOfMonth(e.target.value.replace(/\D/g, "").slice(0, 2))
								}
								className="h-7 w-16 font-mono tnum"
								aria-label="Day of the month"
							/>
							of that month
						</div>
					) : null}
					<div className="flex items-center gap-2">
						<TimeInput
							value={ruleTime}
							onChange={setRuleTime}
							aria-label="Time"
						/>
						{zoneSelect(ruleTz, setRuleTz)}
					</div>
				</div>
			) : null}

			<div className="flex items-center justify-between gap-2 border-t px-3 py-2">
				<fieldset
					aria-label="Kind"
					className="m-0 min-w-0 inline-flex h-7 items-center rounded-full border p-0.5 text-xs"
				>
					{KINDS.map((k) => (
						<button
							key={k.kind}
							type="button"
							aria-pressed={kind === k.kind}
							onClick={() => setKind(k.kind)}
							className={cn(
								"h-6 rounded-full px-2.5 transition-colors",
								kind === k.kind
									? "bg-foreground text-background"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{k.label}
						</button>
					))}
				</fieldset>
				<div className="flex items-center gap-1">
					<Button
						variant={mode === "day" ? "secondary" : "ghost"}
						size="xs"
						onClick={() => setMode(mode === "day" ? "date" : "day")}
					>
						By day…
					</Button>
					<Button
						variant={mode === "relative" ? "secondary" : "ghost"}
						size="xs"
						onClick={() => setMode(mode === "relative" ? "date" : "relative")}
						title="Relative to an item's day"
					>
						<Link2 /> Before…
					</Button>
				</div>
			</div>
			{/* Stays in view while a capped editor scrolls: Save is always there. */}
			<div className="sticky bottom-0 flex flex-col gap-2 border-t bg-popover px-3 py-2">
				<span
					className="min-h-4 font-mono text-xs text-muted-foreground tnum"
					aria-live="polite"
				>
					{preview
						? `${preview.label}${preview.date.slice(0, 4) !== (graph.trip.startDate ?? "").slice(0, 4) ? ` · ${preview.date.slice(0, 4)}` : ""}`
						: mode === "relative" && itemId
							? "Date TBD (its item isn't on a day)"
							: ""}
				</span>
				<div className="flex items-center justify-end gap-1">
					<Button
						variant="ghost"
						size="sm"
						data-testid={LISTS_TESTID.dueClear}
						onClick={() =>
							onSave({
								dueDate: null,
								dueTime: null,
								dueTz: null,
								dueDayId: null,
								dueRule: null,
								dueKind: "due",
							})
						}
					>
						Clear
					</Button>
					<Button
						size="sm"
						data-testid={LISTS_TESTID.dueSave}
						disabled={!patch}
						onClick={() => patch && onSave(patch)}
					>
						Save
					</Button>
				</div>
			</div>
		</div>
	);
}
