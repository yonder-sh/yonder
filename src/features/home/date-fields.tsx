/**
 * Calendar date fields for the home dialogs (DESIGN §10.4 "Calendar
 * mode=range, two months at ≥ 768"): a trigger button showing the dates and
 * a Popover with the shadcn Calendar. Values are `YYYY-MM-DD` strings (trip
 * calendar dates, never instants): the Date objects react-day-picker needs
 * are built from local calendar parts, so no zone can shift a day.
 */
import { cn } from "cn";
import { CalendarDays } from "lucide-react";
import { useEffect, useState } from "react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { formatDateRange, formatDayDate } from "@/lib/format";

export function toDate(iso: string | null | undefined): Date | undefined {
	if (!iso) return undefined;
	const [y, m, d] = iso.split("-").map(Number);
	if (!y || !m || !d) return undefined;
	return new Date(y, m - 1, d);
}

export function toIso(date: Date | undefined): string | null {
	if (!date) return null;
	const p = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Inclusive day count of a range, or null. */
export function dayCount(
	from: string | null | undefined,
	to: string | null | undefined,
): number | null {
	if (!from || !to) return null;
	return (
		Math.round(
			(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
				86_400_000,
		) + 1
	);
}

function useWide(): boolean {
	const [wide, setWide] = useState(false);
	useEffect(() => {
		const mq = window.matchMedia("(min-width: 768px)");
		const on = () => setWide(mq.matches);
		on();
		mq.addEventListener("change", on);
		return () => mq.removeEventListener("change", on);
	}, []);
	return wide;
}

export function DateRangeField({
	id,
	from,
	to,
	onChange,
	disabled,
	placeholder = "Pick dates",
	className,
	testId,
}: {
	id?: string;
	from: string | null;
	to: string | null;
	onChange: (from: string | null, to: string | null) => void;
	disabled?: boolean;
	placeholder?: string;
	className?: string;
	testId?: string;
}) {
	const wide = useWide();
	const [open, setOpen] = useState(false);
	const selected: DateRange | undefined = from
		? { from: toDate(from), to: toDate(to) }
		: undefined;
	const days = dayCount(from, to);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					id={id}
					type="button"
					variant="outline"
					disabled={disabled}
					data-testid={testId}
					className={cn(
						"h-9 w-full justify-start gap-2 px-3 font-normal",
						!from && "text-muted-foreground",
						className,
					)}
				>
					<CalendarDays className="size-4 opacity-60" />
					{from ? (
						<span className="flex min-w-0 flex-1 items-center justify-between gap-2">
							<span className="truncate">
								{to && to !== from
									? formatDateRange(from, to, { year: true })
									: formatDayDate(from, { year: true })}
							</span>
							{days ? (
								<span className="font-mono text-xs text-muted-foreground tnum">
									{days} {days === 1 ? "day" : "days"}
								</span>
							) : null}
						</span>
					) : (
						placeholder
					)}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-auto p-0" align="start">
				<Calendar
					mode="range"
					numberOfMonths={wide ? 2 : 1}
					defaultMonth={toDate(from) ?? new Date()}
					selected={selected}
					onSelect={(r) => {
						onChange(toIso(r?.from), toIso(r?.to));
						if (r?.from && r?.to && r.from.getTime() !== r.to.getTime())
							setOpen(false);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}

export function DateField({
	id,
	value,
	onChange,
	disabled,
	placeholder = "Pick a date",
	testId,
}: {
	id?: string;
	value: string | null;
	onChange: (v: string | null) => void;
	disabled?: boolean;
	placeholder?: string;
	testId?: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					id={id}
					type="button"
					variant="outline"
					disabled={disabled}
					data-testid={testId}
					className={cn(
						"h-9 w-full justify-start gap-2 px-3 font-normal",
						!value && "text-muted-foreground",
					)}
				>
					<CalendarDays className="size-4 opacity-60" />
					{value ? formatDayDate(value, { year: true }) : placeholder}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-auto p-0" align="start">
				<Calendar
					mode="single"
					defaultMonth={toDate(value) ?? new Date()}
					selected={toDate(value)}
					onSelect={(d) => {
						onChange(toIso(d));
						setOpen(false);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}
