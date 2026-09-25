/**
 * One person in the group's rating progress: "Remind" next to someone with
 * places left (the Rate and Review steps, the Overview's checklist), and
 * for owners and editors a menu on their name to leave their ratings out
 * or count them again.
 */
import { cn } from "cn";
import { BellRing, ChevronDown, CircleOff, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { GraphMember } from "@/lib/engine/types";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { ratingsCount } from "../lib/rate";
import { RATING_TESTID } from "./rating-testids";
import {
	remindable,
	useCanCountRatings,
	useCanRemind,
	useRateReminders,
	useRemind,
	useSetRatingsCounted,
} from "./use-rating-people";

/** "Maya", or "You" for yourself. */
export function personName(m: GraphMember, me: string | null): string {
	return m.id === me
		? "You"
		: (m.firstName ?? m.name.split(/\s+/)[0] ?? m.name);
}

/** "Remind" (a push and a line in the trip), "Reminded" for 12 hours. */
export function RemindButton({
	member,
	left,
	named = false,
	className,
}: {
	member: GraphMember;
	/** Places they have left to rate. */
	left: number;
	/** "Remind Maya" instead of "Remind" (away from their name). */
	named?: boolean;
	className?: string;
}) {
	const { access } = useWorkspace();
	const allowed = useCanRemind();
	const reminders = useRateReminders();
	const remind = useRemind();
	if (!allowed || !remindable(member, access.memberId, left)) return null;
	const name = personName(member, access.memberId);
	const done =
		remind.isPending ||
		!!reminders?.recent.some((r) => r.memberId === member.id);
	return (
		<button
			type="button"
			data-testid={RATING_TESTID.remind}
			data-member={member.id}
			data-state={done ? "reminded" : "ready"}
			disabled={done}
			aria-label={done ? `${name} was reminded` : `Remind ${name} to rate`}
			title={
				done
					? "Reminded. You can remind them again after 12 hours."
					: `Send ${name} a reminder to rate`
			}
			onClick={() => remind.mutate({ memberId: member.id, name })}
			className={cn(
				"inline-flex cursor-pointer items-center gap-1 rounded text-primary underline-offset-2 hover:underline disabled:cursor-default disabled:text-muted-foreground disabled:no-underline",
				className,
			)}
		>
			<BellRing className="size-3" strokeWidth={1.75} aria-hidden />
			{done ? "Reminded" : "Remind"}
			{named ? ` ${name}` : null}
		</button>
	);
}

/**
 * The person's name; for owners and editors a menu: "Leave out Maya's
 * ratings" / "Count Maya's ratings again". Ratings are never deleted.
 */
export function PersonMenu({
	member,
	children,
	className,
}: {
	member: GraphMember;
	children: ReactNode;
	className?: string;
}) {
	const { access } = useWorkspace();
	const allowed = useCanCountRatings();
	const set = useSetRatingsCounted();
	if (!allowed) return <span className={className}>{children}</span>;
	const counted = ratingsCount(member);
	const mine = member.id === access.memberId;
	const whose = mine ? "your" : `${personName(member, null)}'s`;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				data-testid={RATING_TESTID.personMenu}
				data-member={member.id}
				aria-label={`${mine ? "Your" : `${personName(member, null)}'s`} ratings`}
				className={cn(
					"inline-flex cursor-pointer items-center gap-0.5 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
					className,
				)}
			>
				{children}
				<ChevronDown className="size-3 opacity-60" aria-hidden />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
					{counted
						? "Leaving them out keeps every rating: you can count them again any time."
						: `${mine ? "Your" : `${personName(member, null)}'s`} ratings aren't counted.`}
				</DropdownMenuLabel>
				{counted ? (
					<DropdownMenuItem
						data-testid={RATING_TESTID.leaveOut}
						onSelect={() => set.mutate({ memberId: member.id, counted: false })}
					>
						<CircleOff /> Leave out {whose} ratings
					</DropdownMenuItem>
				) : (
					<DropdownMenuItem
						data-testid={RATING_TESTID.countAgain}
						onSelect={() => set.mutate({ memberId: member.id, counted: true })}
					>
						<RotateCcw /> Count {whose} ratings again
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
