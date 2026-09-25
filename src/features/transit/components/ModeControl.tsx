/**
 * The mode control (DESIGN §8.2): a full-width 32px segmented control —
 * Walk · Transit · Flight · Other, each with its mode glyph. A single-select
 * listbox (arrow keys move, Enter/Space/click choose), so screen readers and
 * the foundation spec (`leg-mode` → option "transit") read it as a choice.
 */
import { cn } from "cn";
import { type KeyboardEvent, useRef } from "react";
import { ModeGlyph } from "@/components/common/glyphs";
import { LEG_MODE_VALUES, type LegMode } from "@/lib/schemas/enums";
import { TESTID } from "@/lib/testids";
import { TRANSIT_TESTID } from "../testids";

const LABEL: Record<LegMode, string> = {
	walk: "Walk",
	transit: "Transit",
	flight: "Flight",
	other: "Other",
};

export function ModeControl({
	value,
	onChange,
	disabled,
	reason,
	allowed = LEG_MODE_VALUES,
}: {
	value: LegMode | null;
	onChange: (mode: LegMode) => void;
	disabled?: boolean;
	/** Why it's disabled ("View only", "Offline — editing paused"). */
	reason?: string | null;
	/** Stay legs can't be flights. */
	allowed?: readonly LegMode[];
}) {
	const refs = useRef<(HTMLButtonElement | null)[]>([]);
	const modes = LEG_MODE_VALUES.filter((m) => allowed.includes(m));
	const onKey = (e: KeyboardEvent, i: number) => {
		const step =
			e.key === "ArrowRight" || e.key === "ArrowDown"
				? 1
				: e.key === "ArrowLeft" || e.key === "ArrowUp"
					? -1
					: 0;
		if (!step) return;
		e.preventDefault();
		const next = (i + step + modes.length) % modes.length;
		refs.current[next]?.focus();
	};
	return (
		<div
			role="listbox"
			aria-label="Travel mode"
			aria-orientation="horizontal"
			aria-disabled={disabled || undefined}
			title={disabled && reason ? reason : undefined}
			data-testid={TESTID.legMode}
			className={cn(
				"grid h-8 w-full rounded-lg bg-muted p-0.5",
				modes.length === 4 ? "grid-cols-4" : "grid-cols-3",
				disabled && "opacity-70",
			)}
		>
			{modes.map((m, i) => {
				const selected = value === m;
				return (
					<button
						key={m}
						ref={(el) => {
							refs.current[i] = el;
						}}
						type="button"
						role="option"
						aria-selected={selected}
						tabIndex={selected || (!value && i === 0) ? 0 : -1}
						disabled={disabled}
						data-testid={TRANSIT_TESTID.modeOption}
						data-mode={m}
						onKeyDown={(e) => onKey(e, i)}
						onClick={() => onChange(m)}
						className={cn(
							"inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-[13px] font-medium outline-none transition-[color,background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
							selected
								? "bg-card text-foreground shadow-sm ring-1 ring-border"
								: "text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground",
						)}
					>
						<ModeGlyph mode={m} colored={selected} />
						<span className="truncate">{LABEL[m]}</span>
					</button>
				);
			})}
		</div>
	);
}
