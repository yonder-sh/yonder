/**
 * Invite (owner, 2026-10-09): the way to ask people onto the trip, in the
 * top bar and the phone's header (not under ⋯), opening the share dialog.
 * Filled while nobody else has joined (the group rates before the nights);
 * quiet once someone has.
 */
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TESTID } from "@/lib/testids";
import { cn } from "@/lib/utils";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";

/** Nobody else with an account on the trip yet. */
export function useAlone(): boolean {
	const { graph } = useWorkspace();
	return !graph.members.some(
		(m) => m.id !== graph.me.memberId && m.userId && m.status === "active",
	);
}

export function InviteButton({
	compact = false,
	phone = false,
}: {
	/** Icon only (tablet widths). */
	compact?: boolean;
	phone?: boolean;
}) {
	const setShareOpen = useUi((s) => s.setShareOpen);
	const alone = useAlone();
	return (
		<Button
			variant={alone ? "default" : phone ? "ghost" : "outline"}
			size={phone ? "icon" : "sm"}
			onClick={() => setShareOpen(true)}
			data-testid={TESTID.shareButton}
			data-alone={alone || undefined}
			aria-label="Invite"
			className={cn(phone && "size-11 shrink-0 rounded-full")}
		>
			<UserPlus className={cn(phone && "size-5")} />
			{phone ? null : (
				<span className={compact ? "sr-only" : undefined}>Invite</span>
			)}
		</Button>
	);
}

export function InviteMenuItem() {
	const setShareOpen = useUi((s) => s.setShareOpen);
	return (
		<DropdownMenuItem onSelect={() => setShareOpen(true)}>
			<UserPlus /> Invite
		</DropdownMenuItem>
	);
}
