/**
 * Times and durations (SPEC §12.6, DESIGN §2.6): mono, tabular numbers,
 * 24-hour (or 12-hour when the viewer chose it, ADDENDUM §7.2), always
 * formatted in an explicit zone. Inputs are always 24-hour `HH:mm`.
 */
import { cn } from "cn";
import {
	type KeyboardEvent,
	useEffect,
	useId,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	type DisplayPrefs,
	formatDuration,
	formatTime,
	getDisplayPrefs,
	parseDuration,
	subscribeDisplayPrefs,
} from "@/lib/format";

/** The page-wide 12/24 h and km/mi setting (`setDisplayPrefs`); re-renders on change. */
export function useDisplayPrefs(): DisplayPrefs {
	return useSyncExternalStore(
		subscribeDisplayPrefs,
		getDisplayPrefs,
		getDisplayPrefs,
	);
}

/** "11:42" in `tz` (with the ⁺¹ mark when `nextDay`). */
export function TimeText({
	date,
	tz,
	nextDay,
	className,
}: {
	date: Date | number;
	tz: string;
	nextDay?: boolean;
	className?: string;
}) {
	useDisplayPrefs(); // re-render when the viewer switches 12/24 h
	return (
		<time
			dateTime={new Date(date).toISOString()}
			className={cn("font-mono text-[13px] tnum", className)}
		>
			{formatTime(date, tz)}
			{nextDay ? (
				<sup className="ml-px font-mono text-[9px] text-muted-foreground">
					+1
				</sup>
			) : null}
		</time>
	);
}

/** "1h 30m" (compact "1h30"), mono. */
export function Duration({
	minutes,
	compact,
	className,
}: {
	minutes: number | null | undefined;
	compact?: boolean;
	className?: string;
}) {
	return (
		<span className={cn("font-mono text-[13px] tnum", className)}>
			{formatDuration(minutes, { compact })}
		</span>
	);
}

const DEFAULT_PRESETS = [15, 30, 45, 60, 90, 120, 180, 240];

/**
 * A duration chip that opens presets plus a typed field ("1h30", "90", "1.5h").
 * Invalid input shows an inline error and is never saved (QA A-23).
 */
export function DurationInput({
	value,
	onChange,
	presets = DEFAULT_PRESETS,
	disabled,
	className,
}: {
	value: number;
	onChange: (minutes: number) => void;
	presets?: number[];
	disabled?: boolean;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [error, setError] = useState(false);
	const id = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (open) {
			setText(formatDuration(value, { compact: true }));
			setError(false);
		}
	}, [open, value]);
	// QA TL-02/TL-04: the text is filled in the same render that opens the
	// popover, so the field can take the focus with its value selected: typing
	// "3h" + Enter sets 3h (Radix would focus the first preset, and Enter then
	// applied it).
	const onOpenChange = (o: boolean) => {
		if (o) {
			setText(formatDuration(value, { compact: true }));
			setError(false);
		}
		setOpen(o);
	};
	const commit = () => {
		const m = parseDuration(text);
		if (m === null) return setError(true);
		onChange(m);
		setOpen(false);
	};
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild disabled={disabled}>
				<Button
					variant="outline"
					size="sm"
					className={cn(
						"h-[22px] rounded-full px-2 font-mono text-xs",
						className,
					)}
				>
					{formatDuration(value, { compact: true })}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="w-56 p-3"
				align="start"
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					inputRef.current?.focus();
					inputRef.current?.select();
				}}
			>
				<div className="mb-2 grid grid-cols-4 gap-1">
					{presets.map((p) => (
						<Button
							key={p}
							size="sm"
							variant={p === value ? "default" : "ghost"}
							className="h-7 px-1 font-mono text-xs"
							onClick={() => {
								onChange(p);
								setOpen(false);
							}}
						>
							{formatDuration(p, { compact: true })}
						</Button>
					))}
				</div>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						commit();
					}}
				>
					<label htmlFor={id} className="sr-only">
						Duration
					</label>
					<Input
						ref={inputRef}
						id={id}
						value={text}
						onChange={(e) => {
							setText(e.target.value);
							setError(false);
						}}
						aria-invalid={error || undefined}
						className="h-8 font-mono"
						placeholder="1h30"
					/>
					{error ? (
						<p className="mt-1 text-[12px] text-destructive">
							Try 45m, 1h30 or 1.5h.
						</p>
					) : null}
				</form>
			</PopoverContent>
		</Popover>
	);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * A typed time → `HH:mm`, or null. While typing only complete forms count
 * ("9:30", "09:30", "0930"), so a half-typed "10" never saves 10:00; on blur
 * the loose forms count too ("9" → 09:00, "930" → 09:30, "5pm", "5:30 pm").
 */
export function parseTimeInput(
	text: string,
	opts: { loose?: boolean } = {},
): string | null {
	const t = text.trim().toLowerCase();
	const ok = (h: number, m: number) =>
		h >= 0 && h < 24 && m >= 0 && m < 60 ? `${pad2(h)}:${pad2(m)}` : null;
	let m = /^(\d{1,2})[:.h](\d{2})$/.exec(t) ?? /^(\d{2})(\d{2})$/.exec(t);
	if (m) return ok(Number(m[1]), Number(m[2]));
	if (!opts.loose) return null;
	m = /^(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?m?\.?$/.exec(t);
	if (m) {
		const h = Number(m[1]);
		if (h < 1 || h > 12) return null;
		return ok((h % 12) + (m[3] === "p" ? 12 : 0), Number(m[2] ?? 0));
	}
	m = /^(\d)(\d{2})$/.exec(t);
	if (m) return ok(Number(m[1]), Number(m[2]));
	m = /^(\d{1,2})$/.exec(t);
	if (m) return ok(Number(m[1]), 0);
	return null;
}

/** `HH:mm` ± minutes, wrapping around midnight. */
function stepTime(value: string, delta: number): string {
	const [h = 0, m = 0] = value.split(":").map(Number);
	const total = (((h * 60 + m + delta) % 1440) + 1440) % 1440;
	return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/**
 * `HH:mm`, always 24-hour (DESIGN §2.6; a native time input shows "05:30 PM"
 * in en-US browsers). Typed, with ↑/↓ stepping by `step` minutes. `onChange`
 * fires with a complete valid time, or `""` when cleared; an invalid entry is
 * marked and reverts on blur. Empty string = no time.
 */
export function TimeInput({
	value,
	onChange,
	step = 15,
	disabled,
	className,
	"aria-label": ariaLabel = "Time",
}: {
	value: string;
	onChange: (hhmm: string) => void;
	step?: number;
	disabled?: boolean;
	className?: string;
	"aria-label"?: string;
}) {
	const [text, setText] = useState(value);
	const [focused, setFocused] = useState(false);
	useEffect(() => {
		if (!focused) setText(value);
	}, [value, focused]);
	const emit = (next: string) => {
		if (next !== value) onChange(next);
	};
	const invalid =
		text.trim() !== "" && parseTimeInput(text, { loose: true }) === null;
	return (
		<Input
			type="text"
			inputMode="numeric"
			autoComplete="off"
			spellCheck={false}
			placeholder="HH:mm"
			maxLength={8}
			value={text}
			disabled={disabled}
			aria-label={ariaLabel}
			aria-invalid={invalid || undefined}
			onFocus={() => setFocused(true)}
			onChange={(e) => {
				const t = e.target.value;
				setText(t);
				if (t.trim() === "") return emit("");
				const parsed = parseTimeInput(t);
				if (parsed) emit(parsed);
			}}
			onBlur={() => {
				setFocused(false);
				if (text.trim() === "") return setText("");
				const parsed = parseTimeInput(text, { loose: true });
				if (parsed) {
					emit(parsed);
					setText(parsed);
				} else setText(value);
			}}
			onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
				if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
				e.preventDefault();
				const base =
					parseTimeInput(text, { loose: true }) ?? (value || "09:00");
				const next = stepTime(base, e.key === "ArrowUp" ? step : -step);
				setText(next);
				emit(next);
			}}
			className={cn("h-8 w-[5.5rem] font-mono tnum", className)}
		/>
	);
}
