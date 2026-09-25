/**
 * Small UI pieces WP-Insights shares between its components.
 */
import { cn } from "cn";
import { CalendarDays } from "lucide-react";
import {
	type ReactElement,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Calendar } from "@/components/ui/calendar";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";

/**
 * A popover that opens on hover with a mouse and on tap/click everywhere
 * (DESIGN: tooltips carry the reason; ADDENDUM §10: "tap to see all"). A click
 * pins it open; Esc or a click outside closes it. The trigger's click never
 * reaches the card or row underneath (it would select it).
 */
export function HoverPopover({
	trigger,
	children,
	className,
	side = "bottom",
	align = "start",
	testId,
}: {
	trigger: ReactElement;
	children: ReactNode;
	className?: string;
	side?: "top" | "bottom" | "left" | "right";
	align?: "start" | "center" | "end";
	testId?: string;
}) {
	const [mode, setMode] = useState<"closed" | "hover" | "pinned">("closed");
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const clear = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	}, []);
	useEffect(() => clear, [clear]);
	const enter = (e: React.PointerEvent) => {
		if (e.pointerType !== "mouse") return;
		clear();
		timer.current = setTimeout(
			() => setMode((m) => (m === "closed" ? "hover" : m)),
			150,
		);
	};
	const leave = (e: React.PointerEvent) => {
		if (e.pointerType !== "mouse") return;
		clear();
		timer.current = setTimeout(
			() => setMode((m) => (m === "hover" ? "closed" : m)),
			180,
		);
	};
	return (
		<Popover
			open={mode !== "closed"}
			onOpenChange={(v) => {
				if (!v) setMode("closed");
			}}
		>
			<PopoverTrigger
				asChild
				onPointerEnter={enter}
				onPointerLeave={leave}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					clear();
					setMode((m) => (m === "pinned" ? "closed" : "pinned"));
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") e.stopPropagation();
				}}
			>
				{trigger}
			</PopoverTrigger>
			<PopoverContent
				side={side}
				align={align}
				data-testid={testId}
				onPointerEnter={(e) => {
					if (e.pointerType === "mouse") clear();
				}}
				onPointerLeave={leave}
				onOpenAutoFocus={(e) => {
					if (mode === "hover") e.preventDefault();
				}}
				onClick={(e) => e.stopPropagation()}
				collisionPadding={12}
				className={cn(
					"w-[280px] rounded-xl p-0 text-[13px] shadow-float",
					className,
				)}
			>
				{children}
			</PopoverContent>
		</Popover>
	);
}

/** The 11px overline that labels a section ("CLIMATE", "OPENING HOURS"). */
export function Overline({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<p
			className={cn(
				"text-[11px] leading-[14px] font-semibold tracking-[.06em] text-muted-foreground uppercase",
				className,
			)}
		>
			{children}
		</p>
	);
}

/** A small segmented control (a radio group of pills). */
export function Segmented<T extends string>({
	value,
	onChange,
	options,
	label,
	disabled,
	testId,
	className,
}: {
	value: T;
	onChange: (v: T) => void;
	options: readonly { value: T; label: string }[];
	label: string;
	disabled?: boolean;
	testId?: string;
	className?: string;
}) {
	return (
		<div
			role="radiogroup"
			aria-label={label}
			data-testid={testId}
			className={cn(
				"inline-flex h-8 items-center gap-0.5 rounded-full bg-muted p-0.5",
				className,
			)}
		>
			{options.map((o) => {
				const on = o.value === value;
				return (
					// biome-ignore lint/a11y/useSemanticElements: a pill radio, keyboard-operable as a button
					<button
						key={o.value}
						type="button"
						role="radio"
						aria-checked={on}
						data-value={o.value}
						disabled={disabled}
						onClick={() => onChange(o.value)}
						className={cn(
							"h-7 rounded-full px-3 text-xs font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50",
							on
								? "bg-card text-foreground shadow-xs"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{o.label}
					</button>
				);
			})}
		</div>
	);
}

/**
 * A Dialog that becomes a bottom sheet under 640px (EXTENSIONS §4.5/§5: "a
 * Sheet on mobile"): same content, no second component tree.
 */
export const SHEET_ON_MOBILE =
	"flex max-h-[min(90dvh,820px)] flex-col gap-0 overflow-hidden p-0 max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:w-full max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:rounded-t-2xl max-sm:data-[state=closed]:slide-out-to-bottom max-sm:data-[state=open]:slide-in-from-bottom max-sm:data-[state=closed]:zoom-out-100 max-sm:data-[state=open]:zoom-in-100";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** "Mon 11 Oct 2027" (DESIGN §12: dates read "Thu 15 Apr"). */
export function longDate(iso: string): string {
	const d = new Date(`${iso}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return iso;
	return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A calendar date (`YYYY-MM-DD`) as the local-midnight Date the day picker works in. */
export function pickerDate(iso: string): Date {
	const [y, m, d] = iso.split("-").map(Number);
	return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** The day picker's local date → `YYYY-MM-DD`. */
export function isoOfPicked(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A date field that reads "Mon 11 Oct 2027" and opens a calendar (no locale-shaped 10/11/2027). */
export function DateField({
	value,
	onChange,
	label,
	defaultMonth,
	disabled,
	className,
}: {
	value: string;
	onChange: (iso: string) => void;
	label: string;
	/** `YYYY-MM-DD` to open on when empty (the trip's start). */
	defaultMonth?: string | null;
	disabled?: boolean;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const month = value || defaultMonth || null;
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild disabled={disabled}>
				<button
					type="button"
					aria-label={label}
					data-value={value || undefined}
					className={cn(
						"inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-transparent px-2.5 text-[13px] whitespace-nowrap shadow-xs transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50",
						!value && "text-muted-foreground",
						className,
					)}
				>
					<CalendarDays
						className="size-3.5 text-muted-foreground"
						strokeWidth={1.75}
						aria-hidden
					/>
					<span className="tnum">
						{value ? longDate(value) : "Pick a date"}
					</span>
				</button>
			</PopoverTrigger>
			<PopoverContent
				className="w-auto p-0"
				align="start"
				collisionPadding={12}
			>
				<Calendar
					mode="single"
					weekStartsOn={1}
					{...(month ? { defaultMonth: pickerDate(month) } : {})}
					{...(value ? { selected: pickerDate(value) } : {})}
					onSelect={(d) => {
						if (!d) return;
						onChange(isoOfPicked(d));
						setOpen(false);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}
