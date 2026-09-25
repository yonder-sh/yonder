/**
 * E3: sunrise–sunset on the day header (WP-Plan): a 12px `Sunrise` glyph and
 * "05:47–17:07" in muted mono; `compact` (below 640px) shows only a `Sunset`
 * glyph and "17:07". The tooltip adds the golden hour and the place:
 * "Sunrise 05:47 · Golden hour 16:32 · Sunset 17:07 · Tokyo". Times are the
 * place's local time, computed offline (suncalc).
 */
import { cn } from "cn";
import { Sunrise, Sunset } from "lucide-react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { INSIGHTS_TESTID } from "./testids";
import { daySunOf } from "./use-hours-issues";

export function DaySun({
	dayId,
	compact = false,
	full = false,
}: {
	dayId: string;
	compact?: boolean;
	/** The day Overview's full line ("Sunrise 05:47 · Golden hour 16:32 · Sunset 17:07 · Tokyo"). */
	full?: boolean;
}) {
	const { ix, schedule } = useWorkspace();
	const ds = daySunOf(ix, schedule, dayId);
	if (!ds) return null;
	const { sun, place } = ds;
	const polar =
		sun.polar === "day"
			? "Midnight sun"
			: sun.polar === "night"
				? "Polar night"
				: null;
	const detail = polar
		? `${polar} · ${place.name}`
		: `Sunrise ${sun.sunrise} · Golden hour ${sun.goldenStart} · Sunset ${sun.sunset} · ${place.name}`;
	const Glyph = compact ? Sunset : Sunrise;
	if (full)
		return (
			<p
				data-testid={TESTID.daySun}
				data-full
				className="flex items-center gap-1.5 text-[12px] leading-4 text-muted-foreground"
			>
				<Sunrise className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
				<span className="tnum">{detail}</span>
			</p>
		);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					data-testid={TESTID.daySun}
					data-compact={compact || undefined}
					className={cn(
						"inline-flex shrink-0 cursor-default items-center gap-1 rounded-sm font-mono text-[12px] leading-4 text-muted-foreground tnum focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
					)}
				>
					<Glyph className="size-3 shrink-0" strokeWidth={1.75} aria-hidden />
					<span className="sr-only">{detail}</span>
					{polar ? (
						<span aria-hidden className="font-sans">
							{polar}
						</span>
					) : compact ? (
						<span aria-hidden>
							<span className="sr-only">Sunset </span>
							{sun.sunset}
						</span>
					) : (
						<span aria-hidden>
							{sun.sunrise}–{sun.sunset}
						</span>
					)}
				</span>
			</TooltipTrigger>
			<TooltipContent
				data-testid={INSIGHTS_TESTID.daySunDetail}
				className="max-w-[280px]"
			>
				{detail}
			</TooltipContent>
		</Tooltip>
	);
}
