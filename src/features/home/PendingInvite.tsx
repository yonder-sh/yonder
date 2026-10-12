/**
 * A pending invite's tools in the Share dialog (A082): "Change email…" and
 * "Cancel invite". Cancelling an invite that was a placeholder ("Audrey",
 * linked to an email) makes her a placeholder again, with Undo; a plain
 * email invite that splits, payments, ratings or tags already point at asks
 * first (they stay with a former member).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { undoToast } from "@/components/common/undo-toast";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { humanError } from "@/lib/errors";
import { meKeys, tripKeys } from "@/lib/query/keys";
import {
	cancelInvite,
	changeInviteEmail,
	linkPlaceholder,
} from "./sharing.functions";
import { HOME_TESTID } from "./testids";

type MemberRefs = Extract<
	Awaited<ReturnType<typeof cancelInvite>>,
	{ kind: "confirm" }
>["refs"];

/** The invite form's check (`InviteRow`). */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "Sam has 3 splits and 1 rating": what stays with a former member. */
export function refsSummary(name: string, refs: MemberRefs): string {
	const parts = [
		refs.splits && plural(refs.splits, "split"),
		refs.payments && plural(refs.payments, "payment"),
		refs.ratings && plural(refs.ratings, "rating"),
		refs.tags && plural(refs.tags, "tag"),
	].filter((p): p is string => !!p);
	const list =
		parts.length > 1
			? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
			: (parts[0] ?? "nothing");
	return `${name} has ${list}`;
}

function useRefresh(tripId: string) {
	const qc = useQueryClient();
	return () =>
		Promise.all([
			qc.invalidateQueries({ queryKey: tripKeys.sharing(tripId) }),
			qc.invalidateQueries({ queryKey: tripKeys.graph(tripId) }),
			qc.invalidateQueries({ queryKey: meKeys.trips }),
		]);
}

/** `start()` cancels (or asks first); `dialog` is the confirmation to render. */
export function useCancelInvite(
	tripId: string,
	member: { id: string; name: string },
) {
	const refresh = useRefresh(tripId);
	const [refs, setRefs] = useState<MemberRefs | null>(null);
	const cancel = useMutation({
		mutationFn: (confirmed: boolean) =>
			cancelInvite({ data: { memberId: member.id, confirmed } }),
		onSuccess: (r) => {
			if (r.kind === "confirm") {
				setRefs(r.refs);
				return;
			}
			setRefs(null);
			if (r.kind === "cancelled") toast.success("Invite cancelled");
			else
				undoToast(
					`Invite cancelled. ${r.name} stays on the trip without an account.`,
					async () => {
						await linkPlaceholder({
							data: {
								memberId: member.id,
								email: r.email,
								notify: false,
								note: r.note,
							},
						});
						await refresh();
					},
				);
		},
		onSettled: refresh,
	});
	const dialog = (
		<AlertDialog
			open={refs !== null}
			onOpenChange={(v) => {
				if (!v && !cancel.isPending) setRefs(null);
			}}
		>
			<AlertDialogContent data-testid={HOME_TESTID.cancelInviteConfirm}>
				<AlertDialogHeader>
					<AlertDialogTitle>Cancel {member.name}'s invite?</AlertDialogTitle>
					<AlertDialogDescription>
						{refs ? refsSummary(member.name, refs) : ""}; they'll stay with a
						former member.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={cancel.isPending}>
						Keep invite
					</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						data-testid={HOME_TESTID.cancelInviteYes}
						disabled={cancel.isPending}
						onClick={(e) => {
							e.preventDefault();
							cancel.mutate(true);
						}}
					>
						Cancel invite
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
	return { start: () => cancel.mutate(false), dialog };
}

/** "Change email…": the new address gets the invite email. */
export function ChangeInviteEmail({
	tripId,
	member,
	onClose,
}: {
	tripId: string;
	member: { id: string; name: string; email?: string };
	onClose: () => void;
}) {
	const refresh = useRefresh(tripId);
	const [email, setEmail] = useState(member.email ?? "");
	const [error, setError] = useState<string | null>(null);
	const change = useMutation({
		mutationFn: (to: string) =>
			changeInviteEmail({ data: { memberId: member.id, email: to } }),
		meta: { silent: true },
		onSuccess: (r, to) => {
			toast.success(
				r.status === "active"
					? `Added ${to}`
					: `Invite sent to ${to}. They'll get an email.`,
			);
			onClose();
		},
		onError: (e) => setError(humanError(e)),
		onSettled: refresh,
	});
	const submit = (e: FormEvent) => {
		e.preventDefault();
		const to = email.trim();
		if (!EMAIL_RE.test(to)) {
			setError("Enter an email address like name@example.com.");
			return;
		}
		change.mutate(to);
	};
	return (
		<form
			className="grid gap-1.5 rounded-lg bg-muted/60 p-3"
			onSubmit={submit}
			data-testid={HOME_TESTID.inviteChangeEmail}
		>
			<p className="text-xs text-muted-foreground">
				The invite goes to the new address; the old one no longer works.
			</p>
			<div className="flex gap-2">
				<Input
					type="email"
					inputMode="email"
					autoComplete="off"
					autoFocus
					value={email}
					onChange={(e) => {
						setEmail(e.target.value);
						setError(null);
					}}
					aria-label={`New email for ${member.name}`}
					aria-invalid={!!error}
					className="flex-1 bg-background"
				/>
				<Button
					type="submit"
					size="sm"
					disabled={
						!email.trim() ||
						email.trim().toLowerCase() === member.email ||
						change.isPending
					}
				>
					Send
				</Button>
				<Button type="button" size="sm" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
			</div>
			{error ? (
				<p className="text-meta text-destructive" role="alert">
					{error}
				</p>
			) : null}
		</form>
	);
}
