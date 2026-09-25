import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import type { Awareness } from "y-protocols/awareness";
import {
	editingPeer,
	type PresenceSnapshot,
	peersAt,
	presenceStoreFor,
} from "./presence-store";
import {
	type AwarenessEditing,
	type AwarenessView,
	channelDocName,
	type Peer,
} from "./protocol";
import { useCollabClient, useTripChannel } from "./trip-channel";

/**
 * Presence hooks (SPEC §10.7). They read the awareness of the trip's channel
 * document; the server stamps every peer's `user` (name, colour, member id, guest)
 * and validates `view`/`editing` (§10.4), so what they return is safe to render as
 * text. Inside a `<TripChannelProvider>` the trip comes from context; `usePresence`
 * can also be given a trip id directly.
 */

const EMPTY: PresenceSnapshot = { peers: [], clients: [], self: null };
const noopSubscribe = () => () => {};
const empty = () => EMPTY;

/** The channel awareness of `tripId` (or the provider's trip). */
function useChannelAwareness(tripId?: string): {
	awareness: Awareness | null;
	selfUserId: string | null;
} {
	const channel = useTripChannel();
	const useContextChannel =
		channel !== null && (tripId === undefined || tripId === channel.tripId);
	const client = useCollabClient();
	const [own, setOwn] = useState<Awareness | null>(null);
	const ownTripId = useContextChannel ? null : (tripId ?? null);

	useEffect(() => {
		if (!client || !ownTripId) return;
		const lease = client.acquire(channelDocName(ownTripId));
		setOwn(lease.awareness);
		return () => {
			lease.release();
			setOwn(null);
		};
	}, [client, ownTripId]);

	if (useContextChannel) {
		return {
			awareness: channel.controller?.channel?.awareness ?? null,
			selfUserId: channel.state.you?.userId ?? null,
		};
	}
	return { awareness: own, selfUserId: null };
}

export type Presence = {
	/** Other people on the trip (one entry per user; my other tabs excluded). */
	peers: readonly Peer[];
	/** Every other client (users with several tabs appear several times). */
	clients: readonly Peer[];
	/** What this tab publishes. */
	self: PresenceSnapshot["self"];
	/** Publish where I am (null hides it). Throttle it; the Workspace syncs it. */
	setView(view: AwarenessView | null): void;
	/** Publish what I'm editing (null when the field blurs). */
	setEditing(editing: AwarenessEditing): void;
	/** FB-17a: publish who I follow (null when I stop). */
	setFollowing(userId: string | null): void;
	/** FB-17b: start (`{ id }`) or end (null) my spotlight. */
	setSpotlight(spotlight: { id: string } | null): void;
};

export function usePresence(tripId?: string): Presence {
	const { awareness, selfUserId } = useChannelAwareness(tripId);
	const store = awareness ? presenceStoreFor(awareness) : null;
	useEffect(() => {
		store?.setSelfUserId(selfUserId);
	}, [store, selfUserId]);
	const snapshot = useSyncExternalStore(
		store?.subscribe ?? noopSubscribe,
		store?.getSnapshot ?? empty,
		empty,
	);
	const setView = useCallback(
		(view: AwarenessView | null) => store?.setView(view),
		[store],
	);
	const setEditing = useCallback(
		(e: AwarenessEditing) => store?.setEditing(e),
		[store],
	);
	const setFollowing = useCallback(
		(id: string | null) => store?.setFollowing(id),
		[store],
	);
	const setSpotlight = useCallback(
		(s: { id: string } | null) => store?.setSpotlight(s),
		[store],
	);
	return useMemo(
		() => ({
			peers: snapshot.peers,
			clients: snapshot.clients,
			self: snapshot.self,
			setView,
			setEditing,
			setFollowing,
			setSpotlight,
		}),
		[snapshot, setView, setEditing, setFollowing, setSpotlight],
	);
}

/**
 * The trip channel's raw awareness and my user id, for the live-cursor layer
 * (FB-17), which reads and writes `cursor`/`react` outside React.
 */
export function useTripAwareness(): {
	awareness: Awareness | null;
	selfUserId: string | null;
} {
	return useChannelAwareness();
}

/** Other people on the provider's trip, one per user. */
export function usePeers(): readonly Peer[] {
	return usePresence().peers;
}

/** Peers looking at a node / item / selection (map pins, plan rows, outline). */
export function usePeersAt(where: {
	nodeId?: string;
	itemId?: string;
	sel?: string;
}): Peer[] {
	const { clients } = usePresence();
	const { nodeId, itemId, sel } = where;
	return useMemo(
		() => peersAt(clients, { nodeId, itemId, sel }),
		[clients, nodeId, itemId, sel],
	);
}

/** The peer editing `kind/id` (and `field`), for the "Maya is editing" rule (§10.8). */
export function useEditingPeer(
	kind: NonNullable<AwarenessEditing>["kind"],
	id: string,
	field?: string,
): Peer | null {
	const { clients } = usePresence();
	return useMemo(
		() => editingPeer(clients, kind, id, field),
		[clients, kind, id, field],
	);
}

/** Setter for my `editing` presence (call with null on blur). */
export function useSetEditing(): (editing: AwarenessEditing) => void {
	return usePresence().setEditing;
}

/**
 * Publishes `view` as my presence whenever it changes (a small debounce keeps
 * rapid navigation from flooding the socket). Pass null to publish nothing.
 */
export function useMyAwarenessSync(
	view: AwarenessView | null,
	debounceMs = 250,
): void {
	const { setView } = usePresence();
	const serialized = view ? JSON.stringify(view) : null;
	useEffect(() => {
		const t = setTimeout(
			() =>
				setView(serialized ? (JSON.parse(serialized) as AwarenessView) : null),
			debounceMs,
		);
		return () => clearTimeout(t);
	}, [serialized, setView, debounceMs]);
}
