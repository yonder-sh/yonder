/**
 * DESIGN §4.1 presence avatars (live mode only): up to 3 peers with a
 * presence-colour ring (dotted for guests), then "+N". The hover card (DESIGN
 * §8.7) says where each one is and offers **Follow** (mirrors their view,
 * `useFollow`), or **Stop following**. `view.path` is re-checked on the
 * client before it is ever used (`safeFollowPath`, SPEC §10.4).
 */
import { AvatarStack, MemberAvatar } from "@/components/common/member";
import { Button } from "@/components/ui/button";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import { usePeers } from "@/lib/realtime/presence";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { safeFollowPath } from "./follow";
import { SHELL_TESTID } from "./testids";

const TAB_WORD = {
	overview: "Overview",
	plan: "Plan",
	places: "Places",
	media: "Media",
	lists: "Lists",
	notes: "Notes",
	money: "Money",
} as const;

export function PresenceAvatars({
	max = 3,
	size = 28,
}: {
	max?: number;
	size?: 20 | 28;
}) {
	const peers = usePeers();
	const { graph } = useWorkspace();
	const following = useUi((s) => s.following);
	const setFollowing = useUi((s) => s.setFollowing);
	if (peers.length === 0) return null;
	const people = peers.map((p) => ({
		id: p.user.id,
		name: p.user.name,
		color: p.user.color,
		guest: p.user.guest,
		// FB-16: the member's current picture (else the one presence carries).
		userId: p.user.id,
		memberId: p.user.memberId,
		image: p.user.image,
		view: p.view,
	}));
	return (
		<AvatarStack
			people={people}
			max={max}
			size={size}
			renderAvatar={(p, avatar) => {
				const view = people.find((x) => x.id === p.id)?.view;
				const followable =
					typeof window !== "undefined" &&
					!!safeFollowPath(view?.path, graph.trip.slug, window.location.origin);
				const isFollowed = following === p.id;
				return (
					<HoverCard openDelay={200}>
						<HoverCardTrigger asChild>
							<button
								type="button"
								data-testid={TESTID.presenceAvatar}
								aria-label={`${p.name}${view ? `, looking at ${view.scopeName || "the trip"}` : ""}`}
								onClick={() =>
									followable && setFollowing(isFollowed ? null : p.id)
								}
								className="inline-flex rounded-full"
							>
								{avatar}
							</button>
						</HoverCardTrigger>
						<HoverCardContent className="w-60 text-sm" align="end">
							<div className="flex items-center gap-3">
								<MemberAvatar user={p} size={40} />
								<div className="min-w-0">
									<p className="truncate font-medium">{p.name}</p>
									<p className="text-xs text-muted-foreground">
										{p.guest ? "Guest" : "Viewing now"}
									</p>
								</div>
							</div>
							{view ? (
								<p className="mt-2 text-xs text-muted-foreground">
									Viewing {view.scopeName || "the trip"} ·{" "}
									{TAB_WORD[view.tab] ?? view.tab}
								</p>
							) : null}
							{followable ? (
								<Button
									size="sm"
									variant="outline"
									className="mt-3 w-full"
									data-testid={SHELL_TESTID.followButton}
									onClick={() => setFollowing(isFollowed ? null : p.id)}
								>
									{isFollowed ? "Stop following" : "Follow"}
								</Button>
							) : null}
						</HoverCardContent>
					</HoverCard>
				);
			}}
		/>
	);
}
