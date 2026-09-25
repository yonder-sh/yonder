/**
 * FB-15: "This is me" asks first. Claiming a placeholder merges it into the
 * caller's membership (F's `claimPlaceholderRow` → `mergeMember`): what is
 * tagged with that name becomes theirs and the name leaves the people list.
 * There is no undo, and the button sits next to others in a menu, so a
 * misclick must not do it. Used by the Share dialog's member menu and the
 * "Are you Audrey?" line above the workspace (`GuestNudge`).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { meKeys, tripKeys } from "@/lib/query/keys";
import { claimPlaceholder } from "./sharing.functions";
import { HOME_TESTID } from "./testids";

export function ClaimConfirmDialog({
	tripId,
	placeholder,
	open,
	onOpenChange,
	onClaimed,
}: {
	tripId: string;
	/** The person without an account ("Audrey"). */
	placeholder: { id: string; name: string } | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onClaimed?: () => void;
}) {
	const qc = useQueryClient();
	const claim = useMutation({
		mutationFn: (memberId: string) =>
			claimPlaceholder({ data: { tripId, memberId } }),
		onSuccess: async () => {
			await Promise.all([
				qc.invalidateQueries({ queryKey: tripKeys.graph(tripId) }),
				qc.invalidateQueries({ queryKey: tripKeys.sharing(tripId) }),
				qc.invalidateQueries({ queryKey: meKeys.trips }),
			]);
			toast.success(`You're ${placeholder?.name ?? "them"} on this trip now`);
			onOpenChange(false);
			onClaimed?.();
		},
	});
	const name = placeholder?.name ?? "";
	return (
		<AlertDialog
			open={open}
			onOpenChange={(v) => {
				if (!claim.isPending) onOpenChange(v);
			}}
		>
			<AlertDialogContent data-testid={HOME_TESTID.claimConfirm}>
				<AlertDialogHeader>
					<AlertDialogTitle>Are you {name}?</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div className="grid gap-2 text-sm text-muted-foreground">
							<p>
								Everything tagged “{name}” becomes yours: assigned to-dos and
								plans, @mentions, ratings and their comments, expense splits,
								payments and balances, and budget lines. “{name}” then leaves
								the list of people, and you take their place.
							</p>
							<p className="font-medium text-foreground">
								This can't be undone.
							</p>
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={claim.isPending}>
						Cancel
					</AlertDialogCancel>
					<AlertDialogAction
						data-testid={HOME_TESTID.claimConfirmYes}
						disabled={!placeholder || claim.isPending}
						onClick={(e) => {
							// Stay open until the merge is done (errors toast globally).
							e.preventDefault();
							if (placeholder) claim.mutate(placeholder.id);
						}}
					>
						Yes, I'm {name}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
