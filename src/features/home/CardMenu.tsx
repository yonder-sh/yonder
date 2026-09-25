/**
 * ⋯ on a dashboard trip card (hero, "Your trips", "Shared with you", Past):
 * - "Rate places" (FB-05: one of the Rate screen's entry points) opens
 *   `/t/<trip>/rate` on the whole trip, like the workspace's top-bar "Rate";
 * - "Duplicate…" (members);
 * - "Leave trip" (non-owner members).
 *
 * Link guests (`viaLink`) get no menu: they can't rate (no member row),
 * duplicate or leave.
 */
import { Link } from "@tanstack/react-router";
import { Copy, LogOut, MoreHorizontal, Star } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOnline } from "@/lib/realtime/connection";
import { HOME_TESTID } from "./testids";
import type { MyTrip } from "./types";

export function CardMenu({
	trip,
	onDuplicate,
	onLeave,
}: {
	trip: Pick<MyTrip, "slug" | "name" | "role" | "viaLink">;
	onDuplicate: () => void;
	onLeave: () => void;
}) {
	const member = !trip.viaLink;
	const online = useOnline();
	if (!member) return null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				data-testid={HOME_TESTID.tripCardMenu}
				aria-label={`More for ${trip.name}`}
				onClick={(e) => e.stopPropagation()}
				className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			>
				<MoreHorizontal className="size-4" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-44">
				<DropdownMenuItem asChild data-testid={HOME_TESTID.tripCardRate}>
					<Link to="/t/$trip/rate" params={{ trip: trip.slug }}>
						<Star /> Rate places
					</Link>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={onDuplicate} disabled={!online}>
					<Copy /> Duplicate…
				</DropdownMenuItem>
				{trip.role !== "owner" ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							variant="destructive"
							onSelect={onLeave}
							disabled={!online}
						>
							<LogOut /> Leave trip
						</DropdownMenuItem>
					</>
				) : null}
				{!online ? (
					<p className="px-2 py-1.5 text-xs text-muted-foreground">
						Reconnect to change trips.
					</p>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
