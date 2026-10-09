/**
 * The quiet line above the workspace (SPEC §12.5 `GuestNudge()`, §11.2 flow
 * 7; ADDENDUM §10 "placeholders ↔ accounts"):
 *
 * - Signed-out link guests only view (owner, 2026-10-09): "You're viewing
 *   as Guest Heron · Rename · Sign in to edit and rate places" (as the link
 *   allows; "Sign in to keep this trip" on a view link). Signing in joins
 *   them at the link's role (`migrateGuestToUser`).
 * - Signed-in link guests: "You're a guest here as Ana · Join the trip":
 *   one tap makes them a member at the link's role (`joinTripByLink`); a
 *   link never makes anyone a member by itself (QA A-10, SPEC R25).
 * - Members get "Are you Audrey?" → "That's me" once when their name matches
 *   a placeholder (e.g. they signed up without the invite email); it asks
 *   first (FB-15: the merge can't be undone) and then `claimPlaceholder`.
 *   "Not me" hides it on this device.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { Check, Pencil, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TripRole } from "@/lib/auth/roles";
import { joinTripByLink, renameGuest } from "@/lib/auth/share.functions";
import type { GraphMember } from "@/lib/engine/types";
import { sessionKey, tripKeys } from "@/lib/query/keys";
import { sessionQuery } from "@/lib/query/trip-queries";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { ClaimConfirmDialog } from "./ClaimConfirm";
import { matchingPlaceholder } from "./claim-match";
import { HOME_TESTID } from "./testids";

/** A placeholder that looks like this person ("Audrey" for Audrey Nguyen). */
export function likelyPlaceholder(
	members: readonly GraphMember[],
	person: { name: string; firstName?: string },
): GraphMember | null {
	return matchingPlaceholder(members, person);
}

function dismissedKey(tripId: string) {
	return `yonder:claim-dismissed:${tripId}`;
}

function ClaimPrompt({
	tripId,
	placeholder,
	onDone,
}: {
	tripId: string;
	placeholder: GraphMember;
	onDone: () => void;
}) {
	const [asking, setAsking] = useState(false);
	return (
		<span
			data-testid={HOME_TESTID.claimPrompt}
			className="flex items-center gap-2"
		>
			<span>
				Are you{" "}
				<span className="font-medium text-foreground">{placeholder.name}</span>?
			</span>
			<Button
				size="xs"
				data-testid={HOME_TESTID.claimButton}
				onClick={() => setAsking(true)}
			>
				<Check /> That's me
			</Button>
			<Button size="xs" variant="ghost" onClick={onDone}>
				Not me
			</Button>
			<ClaimConfirmDialog
				tripId={tripId}
				placeholder={placeholder}
				open={asking}
				onOpenChange={setAsking}
				onClaimed={onDone}
			/>
		</span>
	);
}

/**
 * A signed-in link guest who looks like a placeholder: only the owner can
 * make them a member (QA A-10: a link never grants money or booking refs).
 */
function RenameInline({
	current,
	onDone,
}: {
	current: string;
	onDone: () => void;
}) {
	const [name, setName] = useState(current);
	const qc = useQueryClient();
	const { graph } = useWorkspace();
	const save = useMutation({
		mutationFn: () => renameGuest({ data: { name: name.trim() } }),
		onSuccess: async () => {
			await Promise.all([
				qc.invalidateQueries({ queryKey: sessionKey }),
				qc.invalidateQueries({ queryKey: tripKeys.graph(graph.trip.id) }),
			]);
			onDone();
		},
	});
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (name.trim()) save.mutate();
	};
	return (
		<form onSubmit={submit} className="flex items-center gap-1.5">
			<Input
				autoFocus
				value={name}
				maxLength={40}
				onChange={(e) => setName(e.target.value)}
				aria-label="Your name as a guest"
				className="h-6 w-40 px-2 text-xs"
			/>
			<Button type="submit" size="xs" disabled={!name.trim() || save.isPending}>
				Save
			</Button>
			<Button type="button" size="xs" variant="ghost" onClick={onDone}>
				<X />
			</Button>
		</form>
	);
}

/** What signing in lets a link guest do, as the link allows. */
export function signInText(linkRole: TripRole): string {
	if (linkRole === "editor" || linkRole === "owner")
		return "Sign in to edit and rate places";
	if (linkRole === "suggester")
		return "Sign in to suggest changes and rate places";
	if (linkRole === "rater") return "Sign in to rate places";
	return "Sign in to keep this trip";
}

/** "Join the trip": a signed-in guest becomes a member at the link's role. */
export function JoinTrip({
	tripId,
	linkRole,
	bare = false,
}: {
	tripId: string;
	linkRole: TripRole;
	/** Just the button (on a rating card, which says why). */
	bare?: boolean;
}) {
	const qc = useQueryClient();
	const join = useMutation({
		mutationFn: () => joinTripByLink({ data: { tripId } }),
		onSuccess: () => qc.invalidateQueries({ queryKey: tripKeys.graph(tripId) }),
	});
	return (
		<span className="flex items-center gap-2">
			{bare || linkRole === "viewer" ? null : <span>Join to rate places.</span>}
			<Button
				size="xs"
				data-testid={HOME_TESTID.joinTrip}
				disabled={join.isPending}
				onClick={() => join.mutate()}
			>
				Join the trip
			</Button>
			{join.isError ? (
				<span className="text-destructive" role="alert">
					Couldn't join. The link may be off now.
				</span>
			) : null}
		</span>
	);
}

export function GuestNudge() {
	const { access, graph, mode } = useWorkspace();
	const session = useQuery({ ...sessionQuery(), enabled: mode === "live" });
	const location = useLocation();
	const [renaming, setRenaming] = useState(false);
	const [dismissed, setDismissed] = useState(true);
	const tripId = graph.trip.id;
	useEffect(() => {
		try {
			setDismissed(localStorage.getItem(dismissedKey(tripId)) === "1");
		} catch {
			setDismissed(false);
		}
	}, [tripId]);
	const dismiss = () => {
		setDismissed(true);
		try {
			localStorage.setItem(dismissedKey(tripId), "1");
		} catch {
			// private mode: it comes back next time
		}
	};
	const viewer = session.data;
	const linkRole = graph.me.linkRole ?? access.role;
	const anonymous = viewer?.isAnonymous ?? access.isGuest;
	const candidate =
		viewer && !anonymous
			? likelyPlaceholder(graph.members, {
					name: viewer.name,
					firstName: viewer.firstName,
				})
			: null;

	if (!access.isGuest) {
		if (!candidate || dismissed || mode !== "live") return null;
		return (
			<div
				data-testid={TESTID.guestNudge}
				className="flex min-h-8 shrink-0 items-center justify-center gap-2 border-b bg-muted px-4 py-1 text-xs text-muted-foreground"
			>
				<ClaimPrompt tripId={tripId} placeholder={candidate} onDone={dismiss} />
			</div>
		);
	}
	const next = `${location.pathname}${location.searchStr ?? ""}`;
	return (
		<div
			data-testid={TESTID.guestNudge}
			className="flex min-h-8 shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b bg-muted px-4 py-1 text-xs text-muted-foreground"
		>
			{renaming ? (
				<RenameInline
					current={graph.me.name}
					onDone={() => setRenaming(false)}
				/>
			) : (
				<span className="flex items-center gap-1.5">
					You're {anonymous ? "viewing as" : "a guest here as"}{" "}
					<span className="font-medium text-foreground">{graph.me.name}</span>
					{anonymous ? (
						<button
							type="button"
							data-testid={HOME_TESTID.guestRename}
							onClick={() => setRenaming(true)}
							aria-label="Change your guest name"
							className="inline-flex size-5 items-center justify-center rounded hover:bg-accent hover:text-foreground"
						>
							<Pencil className="size-3" />
						</button>
					) : null}
				</span>
			)}
			{anonymous ? (
				<Link
					to="/login"
					search={{ next } as never}
					className="font-medium text-primary hover:underline"
				>
					{/* PLACES §1c: a "Can rate" link rates once you sign in (you become a member). */}
					{signInText(linkRole)}
				</Link>
			) : (
				<JoinTrip tripId={tripId} linkRole={linkRole} />
			)}
		</div>
	);
}
