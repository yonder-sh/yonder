/**
 * Presence around live cursors (FB-17a/b):
 * - `useFollowAwareness`: publishes who I follow (for "Audrey is following you");
 * - `useSpotlight`: "Ask everyone to follow me" — while a peer presents,
 *   everyone else follows them (FollowBar: "Following Dennis · Stop");
 *   anyone can break away (Stop, for that spotlight); when the presenter
 *   ends it, their followers stop too;
 * - `SpotlightMenuItem` / `SpotlightBar`: start it, and the presenter's own
 *   "Everyone is following you · End";
 * - `FollowersBadge`: an eye on my avatar with who follows me;
 * - `ElsewhereChips`: "Audrey · Money tab", "Audrey · in Kyoto" for people
 *   not on my screen (a tap goes there once);
 * - `CrumbPresence`: presence dots on a breadcrumb crumb (their scope).
 */
import { useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import { Eye, Presentation } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { presenceColor } from "@/components/common/person-avatar";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { mustRedact } from "@/lib/auth/roles";
import { randomId } from "@/lib/realtime/cursor-protocol";
import { usePresence, useTripAwareness } from "@/lib/realtime/presence";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { safeFollowPath } from "../follow";
import { SHELL_TESTID } from "../testids";
import { followersOf, spotlightPresenter, whereOf } from "./where";

/** Publishes `following` on my awareness whenever I start or stop following. */
export function useFollowAwareness(): void {
	const following = useUi((s) => s.following);
	const { setFollowing } = usePresence();
	useEffect(() => {
		setFollowing(following);
	}, [following, setFollowing]);
}

/** Spotlights I broke away from (per page; a new spotlight asks again). */
const dismissed = new Set<string>();

export function useSpotlight(): void {
	const { peers, self, setSpotlight } = usePresence();
	const following = useUi((s) => s.following);
	const setFollowing = useUi((s) => s.setFollowing);
	const presenting = !!self?.spotlight;
	const presenter = presenting ? null : spotlightPresenter(peers, dismissed);
	const spotId = presenter?.spotlight?.id ?? null;
	const presenterId = presenter?.user.id ?? null;
	/** The spotlight I joined, and whom it made me follow. */
	const joined = useRef<{ id: string; userId: string; name: string } | null>(
		null,
	);

	// Join: follow the presenter.
	useEffect(() => {
		if (!spotId || !presenterId || !presenter) return;
		if (joined.current?.id === spotId) return;
		joined.current = {
			id: spotId,
			userId: presenterId,
			name: presenter.user.name,
		};
		if (following !== presenterId) setFollowing(presenterId);
		toast(`${presenter.user.name} asked everyone to follow`, {
			id: `spotlight-${spotId}`,
		});
	}, [spotId, presenterId, presenter, following, setFollowing]);

	// Break away: I stopped (or switched) following during their spotlight.
	useEffect(() => {
		const j = joined.current;
		if (j && following !== j.userId) {
			dismissed.add(j.id);
			joined.current = null;
		}
	}, [following]);

	// The presenter ended it (or left): stop following them.
	useEffect(() => {
		const j = joined.current;
		if (!j || spotId === j.id) return;
		joined.current = null;
		if (useUi.getState().following === j.userId) {
			setFollowing(null);
			toast(`${j.name} ended the spotlight`);
		}
	}, [spotId, setFollowing]);

	// Presenting: I follow nobody. Leaving the trip ends it (awareness goes).
	useEffect(() => {
		if (presenting && useUi.getState().following) setFollowing(null);
	}, [presenting, setFollowing]);
	useEffect(() => () => setSpotlight(null), [setSpotlight]);
}

export function SpotlightMenuItem() {
	const { peers, self, setSpotlight } = usePresence();
	const { mode } = useWorkspace();
	if (mode !== "live") return null;
	const on = !!self?.spotlight;
	return (
		<DropdownMenuItem
			data-testid={SHELL_TESTID.spotlightMenuItem}
			disabled={!on && peers.length === 0}
			onSelect={() => setSpotlight(on ? null : { id: randomId(12) })}
		>
			<Presentation />
			{on
				? "Stop presenting"
				: peers.length
					? "Ask everyone to follow me"
					: "Ask everyone to follow me (nobody else here)"}
		</DropdownMenuItem>
	);
}

/** The presenter's bar: who follows, and End. */
export function SpotlightBar({ className }: { className?: string }) {
	const { peers, self, setSpotlight } = usePresence();
	const { selfUserId } = useTripAwareness();
	const { graph } = useWorkspace();
	if (!self?.spotlight) return null;
	const followers = followersOf(peers, selfUserId);
	const color = presenceColor(graph.me.color);
	return (
		<div
			data-testid={SHELL_TESTID.spotlightBar}
			role="status"
			className={cn(
				"relative flex h-8 min-w-0 shrink-0 items-center justify-center gap-2 px-3 text-xs",
				className,
			)}
			style={{
				backgroundColor: `color-mix(in oklab, ${color} 12%, var(--background))`,
			}}
		>
			<Presentation className="size-3.5" style={{ color }} aria-hidden />
			<span>
				{followers.length === 0
					? "Asking everyone to follow you…"
					: followers.length === 1
						? `${followers[0]?.user.name.split(" ")[0]} is following you`
						: `${followers.length} people are following you`}
			</span>
			<span aria-hidden="true" className="text-muted-foreground">
				·
			</span>
			<button
				type="button"
				data-testid={SHELL_TESTID.spotlightEnd}
				className="font-medium text-primary underline-offset-2 hover:underline"
				onClick={() => setSpotlight(null)}
			>
				End
			</button>
		</div>
	);
}

/** An eye on my own avatar: who is following me (FB-17a). */
export function FollowersBadge({ className }: { className?: string }) {
	const { peers } = usePresence();
	const { selfUserId } = useTripAwareness();
	const followers = followersOf(peers, selfUserId);
	if (!followers.length) return null;
	const names = followers.map((p) => p.user.name.split(" ")[0]);
	const text =
		names.length === 1
			? `${names[0]} is following you`
			: `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are following you`;
	const first = followers[0];
	return (
		<span
			data-testid={SHELL_TESTID.followersBadge}
			role="status"
			title={text}
			aria-label={text}
			className={cn(
				"pointer-events-none absolute -bottom-1 -left-1 flex h-4 min-w-4 items-center justify-center gap-px rounded-full px-0.5 text-white ring-2 ring-background",
				className,
			)}
			style={{ backgroundColor: presenceColor(first?.user.color) }}
		>
			<Eye className="size-2.5" strokeWidth={2.25} aria-hidden />
			{followers.length > 1 ? (
				<span className="text-[9px] leading-none font-semibold">
					{followers.length}
				</span>
			) : null}
			<span className="sr-only">{text}</span>
		</span>
	);
}

/**
 * People on the trip but not on my screen (FB-17a): "Audrey · in Kyoto",
 * "Audrey · Money tab". A tap takes me there once (Follow keeps me there).
 */
export function ElsewhereChips({
	className,
	strip = false,
}: {
	className?: string;
	/** A quiet one-line strip (the centre panel's foot) instead of floating pills. */
	strip?: boolean;
}) {
	const { peers } = usePresence();
	const { scope, tab, graph } = useWorkspace();
	const following = useUi((s) => s.following);
	const router = useRouter();
	const canSeeMoney = !mustRedact(graph.me);
	const rows = useMemo(
		() =>
			peers
				.map((p) => ({
					p,
					w: whereOf(
						p.view,
						{ scopeId: scope?.id ?? null, tab },
						graph.trip.name,
						canSeeMoney,
					),
				}))
				.filter((r) => r.w && r.p.user.id !== following),
		[peers, scope?.id, tab, graph.trip.name, canSeeMoney, following],
	);
	if (!rows.length) return null;
	const shown = rows.slice(0, 3);
	return (
		<ul
			data-testid={SHELL_TESTID.elsewhereChips}
			aria-label="Where others are"
			className={cn(
				strip
					? "flex min-w-0 items-center gap-1.5 overflow-hidden"
					: "pointer-events-none flex flex-col items-start gap-1",
				className,
			)}
		>
			{shown.map(({ p, w }) => {
				const go =
					typeof window !== "undefined"
						? safeFollowPath(
								p.view?.path,
								graph.trip.slug,
								window.location.origin,
							)
						: null;
				const first = p.user.name.split(" ")[0] ?? p.user.name;
				return (
					<li key={p.user.id}>
						<button
							type="button"
							data-testid={SHELL_TESTID.elsewhereChip}
							data-user-id={p.user.id}
							disabled={!go}
							onClick={() => go && void router.navigate({ href: go })}
							title={go ? `Go to ${first}` : undefined}
							className={cn(
								"pointer-events-auto inline-flex h-6 max-w-64 items-center gap-1.5 rounded-full pr-2.5 pl-2 text-xs hover:bg-accent disabled:cursor-default",
								strip
									? "bg-muted/60"
									: "border bg-card/95 shadow-float backdrop-blur-sm",
							)}
						>
							<span
								aria-hidden
								className="size-1.5 shrink-0 rounded-full"
								style={{ backgroundColor: presenceColor(p.user.color) }}
							/>
							<span className="font-medium">{first}</span>
							<span className="truncate text-muted-foreground">
								· {w?.text}
							</span>
						</button>
					</li>
				);
			})}
			{rows.length > shown.length ? (
				<li className="shrink-0 pl-1 text-[11px] text-muted-foreground">
					+{rows.length - shown.length} more
				</li>
			) : null}
		</ul>
	);
}

/** Presence dots for the people whose scope is `nodeId` (null = the trip). */
export function CrumbPresence({ nodeId }: { nodeId: string | null }) {
	const { peers } = usePresence();
	const here = peers.filter(
		(p) => p.view && (p.view.scopeId ?? null) === nodeId,
	);
	if (!here.length) return null;
	return (
		<span
			data-testid={SHELL_TESTID.crumbPresence}
			className="ml-0.5 inline-flex shrink-0 items-center gap-0.5"
			role="img"
			aria-label={`${here.map((p) => p.user.name.split(" ")[0]).join(", ")} here`}
		>
			{here.slice(0, 3).map((p) => (
				<span
					key={p.user.id}
					className="size-1.5 rounded-full"
					style={{ backgroundColor: presenceColor(p.user.color) }}
				/>
			))}
		</span>
	);
}
