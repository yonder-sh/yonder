/**
 * Mobile day chips in the sheet peek (SPEC §12.5 `DayChips()`, DESIGN §6):
 * 32px "D4" pills, scrollable. A tap shows that day (tap again to show all);
 * a long press starts a range and the next tap ends it ("D3–D5"). The active
 * chip scrolls into view.
 */
import { cn } from "cn";
import { useEffect, useRef, useState } from "react";
import { formatDayDate } from "@/lib/format";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";

const LONG_PRESS_MS = 450;

export function DayChips() {
	const { ix, days, nav } = useWorkspace();
	const [anchor, setAnchor] = useState<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const longPressed = useRef(false);
	const strip = useRef<HTMLDivElement>(null);
	const activeDate = days?.from ?? null;

	useEffect(() => {
		if (!activeDate) return;
		const el = strip.current?.querySelector<HTMLElement>(
			`[data-date="${activeDate}"]`,
		);
		el?.scrollIntoView?.({
			block: "nearest",
			inline: "center",
			behavior: "smooth",
		});
	}, [activeDate]);

	if (ix.days.length === 0) return null;
	const clear = () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	};
	return (
		<div
			ref={strip}
			data-testid={TESTID.dayChips}
			role="toolbar"
			aria-label="Days"
			// The chips' 44px hit areas overlap the handle's margin, so the peek keeps its layout.
			className="-mt-1 flex shrink-0 items-center gap-0.5 overflow-x-auto px-2.5 [scrollbar-width:none]"
		>
			{anchor ? (
				<span className="flex h-8 shrink-0 items-center rounded-full bg-primary/10 px-2.5 text-xs text-primary">
					Tap the last day
				</span>
			) : null}
			{ix.days.map((d, i) => {
				const active =
					days !== null && d.date >= days.from && d.date <= days.to;
				const edge =
					days &&
					days.from !== days.to &&
					(d.date === days.from || d.date === days.to);
				const isAnchor = anchor === d.date;
				return (
					<button
						key={d.id}
						type="button"
						data-date={d.date}
						aria-pressed={active}
						aria-label={`Day ${i + 1}, ${formatDayDate(d.date)}`}
						onPointerDown={() => {
							longPressed.current = false;
							clear();
							timer.current = setTimeout(() => {
								longPressed.current = true;
								setAnchor(d.date);
								nav.setDays({ from: d.date, to: d.date });
								navigator.vibrate?.(10);
							}, LONG_PRESS_MS);
						}}
						onPointerUp={clear}
						onPointerLeave={clear}
						onPointerCancel={clear}
						onContextMenu={(e) => e.preventDefault()}
						onClick={() => {
							if (longPressed.current) {
								longPressed.current = false;
								return;
							}
							if (anchor) {
								const [from, to] =
									anchor <= d.date ? [anchor, d.date] : [d.date, anchor];
								nav.setDays({ from, to });
								setAnchor(null);
								return;
							}
							const only = days?.from === d.date && days.to === d.date;
							nav.setDays(only ? null : { from: d.date, to: d.date });
						}}
						// MOB-07 / DESIGN §6: a 44px touch target around the 32px pill.
						className="group flex h-11 min-w-11 shrink-0 items-center justify-center px-0.5 outline-none select-none [touch-action:manipulation]"
					>
						<span
							className={cn(
								"flex h-8 items-center rounded-full px-3 font-mono text-[13px] tnum transition-colors group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-ring",
								active
									? "bg-foreground text-background"
									: "bg-muted text-foreground",
								edge &&
									"ring-2 ring-primary ring-offset-1 ring-offset-background",
								isAnchor && "ring-2 ring-primary",
							)}
						>
							D{i + 1}
						</span>
					</button>
				);
			})}
			{days && days.from !== days.to ? (
				<span className="flex h-8 shrink-0 items-center px-1 font-mono text-xs text-muted-foreground tnum">
					D{(ix.dayIndex.get(days.from) ?? 0) + 1}–D
					{(ix.dayIndex.get(days.to) ?? 0) + 1}
				</span>
			) : null}
		</div>
	);
}
