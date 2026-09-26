/**
 * DESIGN §4.1 following bar (32px under the top bar): "Following Maya ·
 * Stop" on the followed person's presence colour at 10%. The mirroring
 * itself is `useFollow()` (follow.ts), mounted by the workspace; this is its
 * visible trace and the way out.
 */
import { presenceColor } from "@/components/common/member";
import { usePeers } from "@/lib/realtime/presence";
import { useUi } from "@/lib/workspace/ui-store";
import { useFollowPause } from "./follow-pause";
import { FollowFormBanner } from "./form-presence-ui";
import { SHELL_TESTID } from "./testids";

export function FollowBar() {
	const following = useUi((s) => s.following);
	const setFollowing = useUi((s) => s.setFollowing);
	const peers = usePeers();
	// My own scroll or sheet drag paused part of it: the way back.
	const paused = useFollowPause((s) => s.scroll || s.sheet);
	const resume = useFollowPause((s) => s.resume);
	if (!following) return null;
	const peer = peers.find((p) => p.user.id === following);
	const color = presenceColor(peer?.user.color);
	return (
		<>
			<div
				data-testid={SHELL_TESTID.followBar}
				role="status"
				className="relative flex h-8 min-w-0 shrink-0 items-center justify-center gap-2 px-3 text-xs"
				style={{
					backgroundColor: `color-mix(in oklab, ${color} 10%, var(--background))`,
				}}
			>
				<span
					aria-hidden="true"
					className="size-2 rounded-full"
					style={{ backgroundColor: color }}
				/>
				<span className="min-w-0 truncate">
					Following{" "}
					<span className="font-medium">{peer?.user.name ?? "…"}</span>
					{peer?.view?.scopeName ? (
						<span className="text-muted-foreground">
							{" "}
							· {peer.view.scopeName}
						</span>
					) : null}
				</span>
				{paused ? (
					<>
						<span aria-hidden="true" className="text-muted-foreground">
							·
						</span>
						<button
							type="button"
							data-testid={SHELL_TESTID.followResume}
							className="shrink-0 font-medium text-primary underline-offset-2 hover:underline"
							onClick={resume}
						>
							Resume
						</button>
					</>
				) : null}
				<span aria-hidden="true" className="text-muted-foreground">
					·
				</span>
				<button
					type="button"
					className="shrink-0 font-medium text-primary underline-offset-2 hover:underline"
					onClick={() => setFollowing(null)}
				>
					Stop
				</button>
			</div>
			{/* FB-24: the dialog they have open (non-interactive). */}
			<FollowFormBanner peer={peer} />
		</>
	);
}
