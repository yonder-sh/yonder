import type { Awareness } from "y-protocols/awareness";
import type {
	AwarenessEditing,
	AwarenessState,
	AwarenessView,
	Peer,
} from "./protocol";

/**
 * Derived presence for one channel document's awareness (SPEC §10.7): one entry per
 * user (a user's several tabs collapse to the most recently active one), excluding
 * this client and — once known — this user's other tabs. Snapshots are recomputed
 * on awareness changes only, so many `usePeersAt` subscribers share one array.
 */
export type PresenceSnapshot = {
	/** Other users, most recently active state per user, sorted by name. */
	peers: readonly Peer[];
	/**
	 * Every other client (a user with two tabs appears twice). Use it for "where"
	 * and "editing" questions: any of a user's tabs counts.
	 */
	clients: readonly Peer[];
	/** This client's own local state (view/editing it publishes). */
	self: Partial<AwarenessState> | null;
};

const EMPTY: PresenceSnapshot = { peers: [], clients: [], self: null };

export class PresenceStore {
	private snapshot: PresenceSnapshot = EMPTY;
	private listeners = new Set<() => void>();
	private selfUserId: string | null = null;
	private readonly onChange = () => this.recompute();

	constructor(private readonly awareness: Awareness) {
		awareness.on("change", this.onChange);
		this.recompute();
	}

	getSnapshot = (): PresenceSnapshot => this.snapshot;

	subscribe = (l: () => void): (() => void) => {
		this.listeners.add(l);
		return () => {
			this.listeners.delete(l);
		};
	};

	/** The signed-in user's id (from the channel's `hello`), to hide my other tabs. */
	setSelfUserId(id: string | null): void {
		if (this.selfUserId === id) return;
		this.selfUserId = id;
		this.recompute();
	}

	setView(view: AwarenessView | null): void {
		this.awareness.setLocalStateField("view", view);
	}

	setEditing(editing: AwarenessEditing): void {
		this.awareness.setLocalStateField("editing", editing);
	}

	/** FB-17a: who I follow (null when I stop). */
	setFollowing(userId: string | null): void {
		const cur = (
			this.awareness.getLocalState() as Partial<AwarenessState> | null
		)?.following;
		if ((cur ?? null) === userId) return;
		this.awareness.setLocalStateField("following", userId);
	}

	/** FB-17b: start (`{ id }`) or end (null) my spotlight. */
	setSpotlight(spotlight: { id: string } | null): void {
		this.awareness.setLocalStateField("spotlight", spotlight);
	}

	/** The awareness this store reads (the cursor layer writes `cursor`/`react` on it directly). */
	get raw(): Awareness {
		return this.awareness;
	}

	destroy(): void {
		this.awareness.off("change", this.onChange);
		this.listeners.clear();
	}

	private recompute() {
		const own = this.awareness.clientID;
		const byUser = new Map<string, { peer: Peer; at: number }>();
		const clients: Peer[] = [];
		for (const [clientId, raw] of this.awareness.getStates()) {
			if (clientId === own) continue;
			const state = raw as Partial<AwarenessState>;
			const user = state.user;
			if (!user || typeof user.id !== "string") continue;
			if (this.selfUserId && user.id === this.selfUserId) continue;
			const at = this.awareness.meta.get(clientId)?.lastUpdated ?? 0;
			const peer: Peer = { ...state, user, clientId };
			clients.push(peer);
			const prev = byUser.get(user.id);
			if (!prev || at >= prev.at) byUser.set(user.id, { peer, at });
		}
		const peers = [...byUser.values()]
			.map((v) => v.peer)
			.sort(
				(a, b) =>
					a.user.name.localeCompare(b.user.name) ||
					a.user.id.localeCompare(b.user.id),
			);
		const local =
			(this.awareness.getLocalState() as Partial<AwarenessState> | null) ??
			null;
		const prev = this.snapshot;
		const samePeers = samePeerList(prev.peers, peers);
		const sameClients = samePeerList(prev.clients, clients);
		// My own cursor moves ~20 times a second (FB-17): only the fields the
		// presence UI shows make a new snapshot, never the cursor or a reaction.
		const sameSelf =
			prev.self === local ||
			(prev.self !== null &&
				local !== null &&
				selfKey(prev.self) === selfKey(local));
		if (samePeers && sameClients && sameSelf) return;
		this.snapshot = {
			peers: samePeers ? prev.peers : peers,
			clients: sameClients ? prev.clients : clients,
			self: sameSelf ? prev.self : local,
		};
		for (const l of [...this.listeners]) l();
	}
}

/**
 * The parts of a state the presence UI renders: not `cursor`/`react` (20 Hz),
 * `cam`, `drag` or `menu` (the overlay and the map read those straight from
 * the awareness); `media` and `form` change only on open / close / play.
 */
function selfKey(s: Partial<AwarenessState>): string {
	return JSON.stringify([
		s.view ?? null,
		s.editing ?? null,
		s.following ?? null,
		s.spotlight ?? null,
		s.media ?? null,
		s.form ?? null,
	]);
}

function samePeerList(a: readonly Peer[], b: readonly Peer[]): boolean {
	return (
		a.length === b.length &&
		a.every((p, i) => {
			const q = b[i];
			return (
				q !== undefined &&
				p.clientId === q.clientId &&
				p.user.id === q.user.id &&
				p.user.name === q.user.name &&
				p.user.color === q.user.color &&
				p.user.image === q.user.image &&
				selfKey(p) === selfKey(q)
			);
		})
	);
}

/** One entry per user (the first match wins). */
function uniqueByUser(peers: Peer[]): Peer[] {
	const seen = new Set<string>();
	return peers.filter((p) => !seen.has(p.user.id) && seen.add(p.user.id));
}

const stores = new WeakMap<Awareness, PresenceStore>();

/** The shared store of an awareness instance (created on first use). */
export function presenceStoreFor(awareness: Awareness): PresenceStore {
	let s = stores.get(awareness);
	if (!s) {
		s = new PresenceStore(awareness);
		stores.set(awareness, s);
	}
	return s;
}

/** Users (one entry each) whose view is on a node/item/selection. Pass `clients`. */
export function peersAt(
	peers: readonly Peer[],
	where: { nodeId?: string; itemId?: string; sel?: string },
): Peer[] {
	const at = (p: Peer): boolean => {
		const v = p.view;
		if (!v) return false;
		if (where.sel !== undefined && v.sel === where.sel) return true;
		if (
			where.nodeId !== undefined &&
			(v.scopeId === where.nodeId || v.sel === `n.${where.nodeId}`)
		)
			return true;
		return where.itemId !== undefined && v.sel === `i.${where.itemId}`;
	};
	return uniqueByUser(peers.filter(at));
}

/** The first peer editing `kind/id` (and `field`, when given). Pass `clients`. */
export function editingPeer(
	peers: readonly Peer[],
	kind: NonNullable<AwarenessEditing>["kind"],
	id: string,
	field?: string,
): Peer | null {
	return (
		peers.find(
			(p) =>
				p.editing?.kind === kind &&
				p.editing.id === id &&
				(field === undefined || p.editing.field === field),
		) ?? null
	);
}
