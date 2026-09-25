/**
 * Follow (DESIGN §4.1, SPEC §10.4 / §18.3): mirror a peer's `view.path`.
 *
 * A peer's awareness is written by their client; the collab server validates
 * it, and we re-check it here before navigating (SPEC §10.4): the path must
 * match `VIEW_PATH_RE`, stay on this origin, and stay inside THIS trip
 * (`/t/<slug>`, `/t/<slug>/…` or `/t/<slug>?…` — never `/t/<slug>-other`).
 * Anything else is ignored, so a forged path can never navigate us away.
 */
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { usePeers } from "@/lib/realtime/presence";
import { VIEW_PATH_RE } from "@/lib/realtime/protocol";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";

/** The path to navigate to when following, or null when it must be refused. */
export function safeFollowPath(
	path: unknown,
	slug: string,
	origin: string,
): string | null {
	if (typeof path !== "string" || path.length > 600) return null;
	if (!VIEW_PATH_RE.test(path)) return null;
	let url: URL;
	try {
		url = new URL(path, origin);
	} catch {
		return null;
	}
	if (url.origin !== origin) return null;
	const base = `/t/${slug}`;
	if (url.pathname !== base && !url.pathname.startsWith(`${base}/`))
		return null;
	// `/t/<slug>/rate` is another route (the rate screen): not a workspace view.
	if (url.pathname === `${base}/rate`) return null;
	return `${url.pathname}${url.search}`;
}

/**
 * While `useUi().following` is set, navigate to the followed peer's view each
 * time it changes (replace, so Back isn't flooded). Stops, with a toast, when
 * the peer leaves the trip. Mounted once by the workspace (live mode).
 */
export function useFollow(): void {
	const following = useUi((s) => s.following);
	const setFollowing = useUi((s) => s.setFollowing);
	const peers = usePeers();
	const { graph } = useWorkspace();
	const router = useRouter();
	const peer = following
		? peers.find((p) => p.user.id === following)
		: undefined;
	const path = peer?.view?.path;
	const name = peer?.user.name;
	const nameRef = useRef<string | null>(null);
	if (name) nameRef.current = name;

	useEffect(() => {
		if (!following || !path) return;
		const target = safeFollowPath(
			path,
			graph.trip.slug,
			window.location.origin,
		);
		if (!target) return;
		const here = `${window.location.pathname}${window.location.search}`;
		if (target === here) return;
		void router.navigate({ href: target, replace: true });
	}, [following, path, graph.trip.slug, router]);

	// The followed person left (or never was here): stop quietly after a grace period.
	const present = !!peer;
	useEffect(() => {
		if (!following || present) return;
		const t = setTimeout(() => {
			setFollowing(null);
			toast(`${nameRef.current ?? "They"} left the trip · stopped following`);
		}, 4_000);
		return () => clearTimeout(t);
	}, [following, present, setFollowing]);
}
