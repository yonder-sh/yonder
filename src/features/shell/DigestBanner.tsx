/**
 * E6 digest, simplified by ADDENDUM §10: ONE 32px line at the top of the Plan
 * tab (and the mobile sheet) — "12 changes since you last looked" — linking
 * to the activity view; **Got it** (`markTripSeen(snapshot.currentVersion)`)
 * is the only dismissal. Review counts and suggestion results are inbox
 * items now, not banner lines.
 *
 * Snapshot rules (EXTENSIONS §9): `getDigest` is prefetched with the trip
 * bootstrap (the `/t/$trip` loader) and read once (`staleTime: Infinity`, not in
 * the live keys), so it never grows mid-session. If it hasn't resolved by the
 * time the timeline has painted (a short grace), the banner is skipped for
 * this visit instead of pushing the plan down later.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History } from "lucide-react";
import { useEffect, useState } from "react";
import { markTripSeen } from "@/functions/activity.functions";
import { digestCount } from "@/lib/engine/digest";
import { tripKeys } from "@/lib/query/keys";
import { tripDigestQuery } from "@/lib/query/trip-queries";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";

/** How long after the plan paints a late digest may still appear. */
export const DIGEST_GRACE_MS = 1_500;

/** Trips whose banner was skipped or dismissed this visit (per page load). */
const settled = new Set<string>();

export function DigestBanner() {
	const { graph, mode } = useWorkspace();
	const tripId = graph.trip.id;
	const live = mode === "live";
	const qc = useQueryClient();
	const q = useQuery({ ...tripDigestQuery(tripId), enabled: live });
	const setActivityOpen = useShell((s) => s.setActivityOpen);
	const [late, setLate] = useState(false);
	const [hidden, setHidden] = useState(() => settled.has(tripId));

	useEffect(() => {
		if (q.data || hidden) return;
		const t = setTimeout(() => setLate(true), DIGEST_GRACE_MS);
		return () => clearTimeout(t);
	}, [q.data, hidden]);
	// Too late for this visit: remember, so remounts (tab switches) stay quiet.
	useEffect(() => {
		if (late && !q.data) settled.add(tripId);
	}, [late, q.data, tripId]);

	if (!live || hidden || !q.data || (late && settled.has(tripId))) return null;
	const n = digestCount(q.data.rows, { meUserId: graph.me.userId });
	if (n === 0) return null;
	const snapshot = q.data;

	const gotIt = () => {
		settled.add(tripId);
		setHidden(true);
		void markTripSeen({
			data: { tripId, version: snapshot.currentVersion },
		})
			.then(() =>
				qc.setQueryData(tripKeys.digest(tripId), {
					...snapshot,
					seenVersion: snapshot.currentVersion,
					rows: [],
				}),
			)
			.catch(() => {
				// Offline or a blip: it simply shows again next visit.
			});
	};

	return (
		<div
			data-testid={SHELL_TESTID.digestBanner}
			role="status"
			className="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/50 px-4 text-[13px]"
		>
			<History className="size-3.5 shrink-0 text-muted-foreground" />
			<button
				type="button"
				onClick={() => setActivityOpen(true)}
				className="min-w-0 truncate text-left text-foreground underline-offset-2 hover:underline"
			>
				<span className="font-mono tnum">{n > 99 ? "99+" : n}</span>{" "}
				{n === 1 ? "change" : "changes"} since you last looked
			</button>
			<button
				type="button"
				onClick={gotIt}
				data-testid={SHELL_TESTID.digestGotIt}
				className="ml-auto shrink-0 rounded-md px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/10"
			>
				Got it
			</button>
		</div>
	);
}
