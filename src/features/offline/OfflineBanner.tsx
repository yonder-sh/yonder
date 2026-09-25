/**
 * "Saved copy from 14:02 · editing paused" (SPEC §12.5 `OfflineBanner()`,
 * §16.4, DESIGN §6; ADDENDUM §10 "offline is read-only, notes included"),
 * shown while the connection is offline. The time is when the trip's data
 * was last fetched (the persisted graph), in the browser's zone; older than
 * today, the day is named too. Edit controls say why they're disabled
 * (`useEditGuard`), and come back on their own when the connection does.
 */
import { CloudOff } from "lucide-react";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { useOfflineAvailability } from "./use-offline-availability";

export function savedAtLabel(savedAt: number, now = Date.now()): string {
	const d = new Date(savedAt);
	const time = d.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	const sameDay = new Date(now).toDateString() === d.toDateString();
	if (sameDay) return time;
	const day = d.toLocaleDateString([], {
		weekday: "short",
		day: "numeric",
		month: "short",
	});
	return `${day}, ${time}`;
}

export function OfflineBanner() {
	const { connection, graph } = useWorkspace();
	const { savedAt } = useOfflineAvailability(graph.trip.id);
	if (connection !== "offline") return null;
	return (
		<div
			data-testid={TESTID.offlineBanner}
			role="status"
			aria-live="polite"
			className="flex h-7 shrink-0 items-center justify-center gap-1.5 border-b bg-muted px-4 text-xs text-muted-foreground"
		>
			<CloudOff className="size-3.5" aria-hidden="true" />
			<span className="truncate">
				{savedAt ? (
					<>
						Saved copy from{" "}
						<span className="font-mono tnum">{savedAtLabel(savedAt)}</span> ·
						editing paused
					</>
				) : (
					"Offline · editing paused"
				)}
			</span>
		</div>
	);
}
