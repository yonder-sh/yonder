/**
 * DESIGN §4.1 connection pill: Live (walk-green dot) · Reconnecting… (a
 * pulsing neutral dot: ADDENDUM §10 keeps amber for real conflicts) ·
 * Offline · read-only (no dot, muted fill). Status changes are announced
 * politely.
 */
import { cn } from "cn";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";

const LABEL = {
	live: "Live",
	connecting: "Connecting…",
	reconnecting: "Reconnecting…",
	offline: "Offline · read-only",
} as const;

export function ConnectionPill({ compact = false }: { compact?: boolean }) {
	const { connection, mode } = useWorkspace();
	if (mode === "fixture") return null;
	if (compact && connection === "live") return null;
	return (
		<span
			data-testid={TESTID.connectionPill}
			data-status={connection}
			role="status"
			aria-live="polite"
			className={cn(
				"inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs text-muted-foreground",
				connection === "offline" && "bg-muted",
			)}
		>
			{connection !== "offline" ? (
				<span
					aria-hidden="true"
					className={cn(
						"size-1.5 rounded-full",
						connection === "live"
							? "bg-mode-walk"
							: "animate-pulse bg-muted-foreground/70",
					)}
				/>
			) : null}
			<span className={cn(compact && "sr-only")}>{LABEL[connection]}</span>
		</span>
	);
}
