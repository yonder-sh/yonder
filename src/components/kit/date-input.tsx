/**
 * The one date field (One Yonder kit): reads "Mon 11 Oct 2027", never a
 * locale-shaped 10/11/2027, and opens a calendar. Values are `YYYY-MM-DD`
 * calendar dates; the picker's Date objects are built from local parts, so
 * no zone can shift a day. Picking the chosen day again keeps it.
 */
import { CalendarDays } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { formatDayDate } from "@/lib/format";
import { cn } from "@/lib/utils";

function toDate(iso: string | null | undefined): Date | undefined {
	const [y, m, d] = (iso ?? "").split("-").map(Number);
	return y && m && d ? new Date(y, m - 1, d) : undefined;
}

function toIso(date: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function DateInput({
	value,
	onChange,
	label,
	id,
	placeholder = "Pick a date",
	defaultMonth,
	full = false,
	disabled,
	testId,
	className,
}: {
	/** `YYYY-MM-DD`; empty or null for none. */
	value: string | null;
	onChange: (iso: string) => void;
	/** The accessible name, when no `<Label htmlFor={id}>` gives one. */
	label?: string;
	id?: string;
	placeholder?: string;
	/** `YYYY-MM-DD` to open on when empty (the trip's start). */
	defaultMonth?: string | null;
	/** Stretch across its container (a form). */
	full?: boolean;
	disabled?: boolean;
	testId?: string;
	className?: string;
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
					aria-label={label}
					data-testid={testId}
					data-value={value || undefined}
					className={cn(
						"justify-start gap-2 px-3 font-normal tnum",
						full && "w-full",
						!value && "text-muted-foreground",
						className,
					)}
				>
					<CalendarDays className="size-4 opacity-60" aria-hidden />
					{value ? formatDayDate(value, { year: true }) : placeholder}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="w-auto p-0"
				align="start"
				collisionPadding={12}
			>
				<Calendar
					mode="single"
					defaultMonth={toDate(value || defaultMonth) ?? new Date()}
					selected={toDate(value)}
					onSelect={(d) => {
						if (d) onChange(toIso(d));
						setOpen(false);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}
