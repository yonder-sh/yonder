/**
 * The Plan's toolbar (One Yonder D03): with a day (or days) in view, a day
 * stepper (‹ › Mon 4 · Tue 5 · Wed 6) and "All days"; always, whose plan
 * ("Everyone ▾").
 */
import { Check, ChevronLeft, ChevronRight, List, Users } from "lucide-react";
import {
	assignableMembers,
	MemberAvatar,
	MemberName,
} from "@/components/common/member";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDateRange, formatDayShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { PLAN_TESTID } from "./testids";

/**
 * ‹ › and the days around the one in view; shift-click adds the day to the
 * range (DESIGN §7.1). "All days" leaves the day.
 */
export function DayStepper() {
	const { ix, days, nav } = useWorkspace();
	if (!days) return null;
	const all = ix.days;
	const from = all.findIndex((d) => d.date === days.from);
	const to = all.findIndex((d) => d.date === days.to);
	const prev = from > 0 ? all[from - 1] : undefined;
	const next = to >= 0 && to < all.length - 1 ? all[to + 1] : undefined;
	const one = days.from === days.to;
	const go = (date: string, e: { shiftKey: boolean }) =>
		e.shiftKey ? nav.extendDays(date) : nav.setDays({ from: date, to: date });
	return (
		<div
			data-testid={PLAN_TESTID.rangeBar}
			className="flex min-w-0 flex-1 items-center gap-1"
		>
			<Button
				variant="outline"
				size="icon-sm"
				aria-label="Previous day"
				title="Previous day · shift-click to add it"
				disabled={!prev}
				onClick={(e) => prev && go(prev.date, e)}
			>
				<ChevronLeft />
			</Button>
			<Button
				variant="outline"
				size="icon-sm"
				aria-label="Next day"
				title="Next day · shift-click to add it"
				disabled={!next}
				onClick={(e) => next && go(next.date, e)}
			>
				<ChevronRight />
			</Button>
			<span className="ml-1 flex min-w-0 items-center gap-1.5 truncate text-sm">
				{one ? (
					<>
						{prev ? (
							<Neighbour
								date={prev.date}
								onGo={go}
								before
								className="max-sm:hidden"
							/>
						) : null}
						<span className="font-medium whitespace-nowrap">
							{formatDayShort(days.from)}
						</span>
						{next ? (
							<Neighbour date={next.date} onGo={go} className="max-sm:hidden" />
						) : null}
					</>
				) : (
					<span className="font-medium whitespace-nowrap tnum">
						{formatDateRange(days.from, days.to)}
					</span>
				)}
			</span>
			<Button
				variant="ghost"
				size="sm"
				className="ml-auto shrink-0"
				onClick={() => nav.setDays(null)}
			>
				<List />
				All days
			</Button>
		</div>
	);
}

/** The day before or after, and the dot between it and the day in view. */
function Neighbour({
	date,
	onGo,
	before = false,
	className,
}: {
	date: string;
	onGo: (date: string, e: { shiftKey: boolean }) => void;
	before?: boolean;
	className?: string;
}) {
	const dot = (
		<span aria-hidden className="text-muted-foreground">
			·
		</span>
	);
	return (
		<span className={cn("flex items-center gap-1.5", className)}>
			{before ? null : dot}
			<button
				type="button"
				onClick={(e) => onGo(date, e)}
				className="whitespace-nowrap text-muted-foreground hover:text-foreground"
			>
				{formatDayShort(date)}
			</button>
			{before ? dot : null}
		</span>
	);
}

/** "Everyone ▾": everyone's plan, mine, or one member's. */
export function WhoMenu() {
	const { graph, who, nav } = useWorkspace();
	const me = graph.me.memberId;
	const others = assignableMembers(graph.members).filter((m) => m.id !== me);
	if (others.length === 0 && !me) return null;
	const pick = (id: string | null) => (
		<Check className={cn("ml-auto", who !== id && "invisible")} />
	);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					data-testid={PLAN_TESTID.whoFilter}
					aria-label="Whose plan"
					className="shrink-0"
				>
					{who ? (
						<MemberAvatar memberId={who} size={16} ring={false} />
					) : (
						<Users />
					)}
					{who === null ? (
						"Everyone"
					) : who === me ? (
						"Me"
					) : (
						<MemberName memberId={who} className="max-w-24 truncate" />
					)}
					<span aria-hidden className="text-muted-foreground">
						▾
					</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-44">
				<DropdownMenuItem onSelect={() => nav.setWho(null)}>
					<Users />
					Everyone
					{pick(null)}
				</DropdownMenuItem>
				{me ? (
					<DropdownMenuItem onSelect={() => nav.setWho(me)}>
						<MemberAvatar memberId={me} size={16} ring={false} />
						Me
						{pick(me)}
					</DropdownMenuItem>
				) : null}
				{others.map((m) => (
					<DropdownMenuItem key={m.id} onSelect={() => nav.setWho(m.id)}>
						<MemberAvatar memberId={m.id} size={16} ring={false} />
						<MemberName memberId={m.id} />
						{pick(m.id)}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
