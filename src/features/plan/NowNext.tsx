/**
 * "Now 10:45 Harajuku →" / "Starts in 376 days · Day 1 Haneda" (SPEC §12.5
 * `NowNext()`, DESIGN §6): before the trip, the countdown and the first stop;
 * during it, the current stop (else the next one) with its local time, on a
 * live clock; after it, "Trip finished". A tap selects the stop. "Now" sits on
 * the one glow pill of the sheet.
 */
import { ChevronRight } from "lucide-react";
import { daysUntil, formatTime, todayIn } from "@/lib/format";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { useNow } from "./use-media";
import { itemName } from "./use-plan-actions";

export function NowNext() {
	const { ix, schedule, graph, nav } = useWorkspace();
	const now = useNow(30_000);
	const first = ix.ordered[0];
	if (!first) return null;
	const start = graph.trip.startDate ?? ix.days[0]?.date;
	// One countdown everywhere (QA VIS2-12): the days are counted from the
	// viewer's own date, as on the dashboard. The trip's default zone (JST) is
	// already a day ahead of a New York afternoon, which made "373 days" next
	// to the dashboard's "374".
	const today = now > 0 ? todayIn() : (start ?? "");
	const until = start ? daysUntil(start, today) : 0;
	// Whether it has begun is a matter of instants, not dates: at 21:00 in New
	// York the Tokyo day 1 is already under way.
	const firstStart = schedule.items[first.id]?.start.getTime();
	const begun = now > 0 && firstStart !== undefined && now >= firstStart;

	let pill = "Next";
	let text: string;
	let target: string | null = null;
	if (until > 0 && !begun) {
		// The first stop's own day: a trip that opens with a travel day (Asia
		// 2027's Day 1 is the JFK flight) starts its stops on Day 2.
		const dayNo = ix.days.findIndex((d) => d.id === first.dayId) + 1 || 1;
		text = `Starts in ${until} ${until === 1 ? "day" : "days"} · Day ${dayNo} ${itemName(ix, first)}`;
		target = first.id;
	} else {
		const at = now || Date.now();
		const current = ix.ordered.find((it) => {
			const s = schedule.items[it.id];
			return s && s.start.getTime() <= at && s.end.getTime() > at;
		});
		const next = ix.ordered.find((it) => {
			const s = schedule.items[it.id];
			return s && s.start.getTime() > at;
		});
		const it = current ?? next;
		const s = it ? schedule.items[it.id] : undefined;
		if (it && s) {
			pill = current ? "Now" : "Next";
			text = `${formatTime(current ? at : s.start, s.tz)} ${itemName(ix, it)}`;
			target = it.id;
		} else {
			text = "Trip finished";
		}
	}
	return (
		<button
			type="button"
			data-testid={TESTID.nowNext}
			disabled={!target}
			onClick={() => target && nav.select({ kind: "item", id: target })}
			className="flex h-9 w-full shrink-0 items-center gap-2 px-4 text-left text-sm disabled:cursor-default"
		>
			<span className="shrink-0 rounded-full bg-glow px-2 py-0.5 text-xs font-semibold text-glow-foreground">
				{pill}
			</span>
			<span className="min-w-0 flex-1 truncate">{text}</span>
			{target ? (
				<ChevronRight
					className="size-4 shrink-0 text-muted-foreground"
					strokeWidth={1.5}
					aria-hidden
				/>
			) : null}
		</button>
	);
}
