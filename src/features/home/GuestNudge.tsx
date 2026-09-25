/**
 * The quiet line above the workspace (SPEC §12.5 `GuestNudge()`, §11.2 flow
 * 7; ADDENDUM §10 "placeholders ↔ accounts"):
 *
 * - Link guests: "You're viewing as Guest Heron · Rename · Sign in to keep
 *   this trip". A signed-in guest whose name matches a person without an
 *   account ("Audrey") sees "Are you Audrey? Ask the owner to add you": a
 *   link never makes anyone a member by itself (QA A-10, SPEC R25). The
 *   owner's "Add to trip" merges that placeholder into the new membership
 *   (`promoteGuestCore`), or links it to her email (FB-14: no per-person
 *   join links).
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
import { renameGuest } from "@/lib/auth/share.functions";
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
function GuestClaimHint({
	placeholder,
	onDone,
}: {
	placeholder: GraphMember;
	onDone: () => void;
}) {
	return (
		<span
			data-testid={HOME_TESTID.claimPrompt}
			className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1"
		>
			<span>
				Are you{" "}
				<span className="font-medium text-foreground">{placeholder.name}</span>?
				Ask the owner to add you to the trip. What's tagged {placeholder.name}{" "}
				becomes yours.
			</span>
			<Button size="xs" variant="ghost" onClick={onDone}>
				Not me
			</Button>
		</span>
	);
}

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
					{access.role === "rater"
						? "Sign in to rate places"
						: "Sign in to keep this trip"}
				</Link>
			) : candidate && !dismissed ? (
				<GuestClaimHint placeholder={candidate} onDone={dismiss} />
			) : (
				<span>Ask the owner to add you to be taggable.</span>
			)}
		</div>
	);
}
