/**
 * What each tab is for, in one plain line (owner, 2026-09-25): the lead of
 * a tab's empty state, and the tab's tooltip otherwise.
 */
import { cn } from "cn";
import type { Tab } from "@/lib/workspace/search";

export const TAB_PURPOSE: Record<Tab, string> = {
	overview: "The whole trip at a glance.",
	plan: "When and where you'll be, day by day.",
	places:
		"What you want to do. Add places, rate them together, keep the favourites.",
	media: "Photos, videos, PDFs and links from the trip.",
	lists: "To-dos and shopping lists, shared or just for you.",
	notes: "Tips, plans and anything else worth writing down.",
	money: "What things cost, who paid, and who owes whom.",
};

export function TabPurpose({
	tab,
	className,
}: {
	tab: Tab;
	className?: string;
}) {
	return (
		<p
			data-testid="tab-purpose"
			data-tab={tab}
			className={cn("text-sm text-balance text-muted-foreground", className)}
		>
			{TAB_PURPOSE[tab]}
		</p>
	);
}
