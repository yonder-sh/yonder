/**
 * A text field with suggestions (stations, lines, airports, airlines): typing
 * is always allowed (custom routes take free text everywhere), ↑/↓ move
 * through the suggestions, Enter picks, Esc closes. The list renders in a
 * portal so the inspector's scroll area never clips it.
 */
import { cn } from "cn";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@/components/ui/popover";

/** Phone keyboards: capitals, no autocorrect or spellcheck (codes, refs, seats). */
export const CAPS_INPUT = {
	autoCapitalize: "characters",
	autoCorrect: "off",
	spellCheck: false,
} as const;

export function SuggestInput<T>({
	value,
	onChange,
	load,
	itemKey,
	renderItem,
	onPick,
	placeholder,
	disabled,
	className,
	inputClassName,
	testId,
	itemTestId,
	"aria-label": ariaLabel,
	minChars = 1,
	autoFocus,
	id,
	caps,
}: {
	value: string;
	onChange: (text: string) => void;
	/** Suggestions for the typed text (debounced 180 ms). */
	load: (q: string) => Promise<T[]> | T[];
	itemKey: (item: T) => string;
	renderItem: (item: T) => ReactNode;
	onPick: (item: T) => void;
	placeholder?: string;
	disabled?: boolean;
	className?: string;
	inputClassName?: string;
	testId?: string;
	itemTestId?: string;
	"aria-label"?: string;
	minChars?: number;
	autoFocus?: boolean;
	id?: string;
	/** Codes (IATA): phones type capitals, no autocorrect (QA MOB-06). */
	caps?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [items, setItems] = useState<T[]>([]);
	const [active, setActive] = useState(0);
	const [typed, setTyped] = useState(false);
	const listId = useId();
	const seq = useRef(0);
	const loadRef = useRef(load);
	loadRef.current = load;

	useEffect(() => {
		if (!typed) return;
		const q = value.trim();
		if (q.length < minChars) {
			setItems([]);
			return;
		}
		const n = ++seq.current;
		const t = setTimeout(async () => {
			try {
				const next = await loadRef.current(q);
				if (n !== seq.current) return;
				setItems(next);
				setActive(0);
				setOpen(next.length > 0);
			} catch {
				if (n === seq.current) setItems([]);
			}
		}, 180);
		return () => clearTimeout(t);
	}, [value, typed, minChars]);

	const pick = (item: T) => {
		onPick(item);
		setOpen(false);
		setTyped(false);
	};

	return (
		<Popover open={open && items.length > 0} onOpenChange={setOpen}>
			<PopoverAnchor asChild>
				<div className={cn("min-w-0", className)}>
					<Input
						id={id}
						value={value}
						disabled={disabled}
						placeholder={placeholder}
						aria-label={ariaLabel}
						data-testid={testId}
						autoComplete="off"
						{...(caps ? CAPS_INPUT : {})}
						autoFocus={autoFocus}
						role="combobox"
						aria-expanded={open && items.length > 0}
						aria-controls={listId}
						aria-autocomplete="list"
						className={cn("h-8", inputClassName)}
						onChange={(e) => {
							setTyped(true);
							onChange(e.target.value);
						}}
						onBlur={() => setTimeout(() => setOpen(false), 120)}
						onKeyDown={(e) => {
							if (!open || !items.length) return;
							if (e.key === "ArrowDown") {
								e.preventDefault();
								setActive((a) => (a + 1) % items.length);
							} else if (e.key === "ArrowUp") {
								e.preventDefault();
								setActive((a) => (a - 1 + items.length) % items.length);
							} else if (e.key === "Enter") {
								e.preventDefault();
								const it = items[active];
								if (it) pick(it);
							} else if (e.key === "Escape") {
								e.preventDefault();
								e.stopPropagation();
								setOpen(false);
							}
						}}
					/>
				</div>
			</PopoverAnchor>
			<PopoverContent
				align="start"
				sideOffset={4}
				className="w-[var(--radix-popover-trigger-width)] min-w-64 p-1"
				onOpenAutoFocus={(e) => e.preventDefault()}
				onCloseAutoFocus={(e) => e.preventDefault()}
			>
				<div id={listId} role="listbox" className="max-h-64 overflow-y-auto">
					{items.map((item, i) => (
						<div
							key={itemKey(item)}
							role="option"
							tabIndex={-1}
							aria-selected={i === active}
							data-testid={itemTestId}
							onMouseDown={(e) => {
								e.preventDefault();
								pick(item);
							}}
							onMouseEnter={() => setActive(i)}
							onKeyDown={() => undefined}
							className={cn(
								"cursor-pointer rounded-md px-2 py-1.5 text-sm",
								i === active && "bg-accent text-accent-foreground",
							)}
						>
							{renderItem(item)}
						</div>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}
