import { useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	type CollabClient,
	getCollabClient,
	onCollabClientReset,
} from "./collab-client";
import {
	TripLiveController,
	type TripLiveOptions,
	type TripLiveState,
} from "./trip-live";

/**
 * React bindings for the live trip channel (SPEC §10.5, §10.7):
 * - `useCollabClient()`  the page's shared socket (null during SSR);
 * - `useTripLive(tripId, options)`  joins the trip channel and keeps TanStack
 *   Query fresh (see TripLiveController);
 * - `<TripChannelProvider tripId baseVersion …>`  does the same once for the
 *   workspace and gives presence hooks (`usePeers`, …) their trip.
 */

/** The page's collab client; re-renders with a new one after `resetCollabClient()`. */
export function useCollabClient(): CollabClient | null {
	const [client, setClient] = useState<CollabClient | null>(null);
	useEffect(() => {
		setClient(getCollabClient());
		return onCollabClientReset(() => setClient(getCollabClient()));
	}, []);
	return client;
}

export type UseTripLiveOptions = Omit<TripLiveOptions, "queryClient">;

const IDLE: TripLiveState = {
	status: "connecting",
	reason: null,
	version: null,
	you: null,
	lastEventAt: null,
};
const noopSubscribe = () => () => {};
const idle = () => IDLE;

/**
 * Keeps one trip's queries live. Callbacks may change between renders (the latest
 * are used); `baseVersion` should be the loaded graph's `trip.version`.
 */
export function useTripLive(
	tripId: string | null | undefined,
	options: UseTripLiveOptions = {},
): TripLiveState & { controller: TripLiveController | null } {
	const queryClient = useQueryClient();
	const client = useCollabClient();
	const latest = useRef(options);
	latest.current = options;
	const [controller, setController] = useState<TripLiveController | null>(null);

	useEffect(() => {
		if (!client || !tripId) return;
		const o = () => latest.current;
		const c = new TripLiveController(client, tripId, {
			queryClient,
			baseVersion: o().baseVersion,
			tabId: o().tabId,
			hiddenRefetchMs: o().hiddenRefetchMs,
			coalesceMs: o().coalesceMs,
			onFlash: (h, a) => o().onFlash?.(h, a),
			onJob: (e) => o().onJob?.(e),
			onAccessLost: (r) => o().onAccessLost?.(r),
			onMessage: (m) => o().onMessage?.(m),
		});
		c.start();
		setController(c);
		return () => {
			c.stop();
			setController(null);
		};
	}, [client, tripId, queryClient]);

	useEffect(() => {
		controller?.setBaseVersion(options.baseVersion);
	}, [controller, options.baseVersion]);

	const state = useSyncExternalStore(
		controller?.subscribe ?? noopSubscribe,
		controller?.getSnapshot ?? idle,
		idle,
	);
	return { ...state, controller };
}

type TripChannelValue = {
	tripId: string;
	controller: TripLiveController | null;
	state: TripLiveState;
};

const TripChannelContext = createContext<TripChannelValue | null>(null);

/**
 * Mount once per open trip (the workspace). Everything below can use the presence
 * and connection hooks without passing the trip id.
 */
export function TripChannelProvider({
	tripId,
	children,
	...options
}: UseTripLiveOptions & { tripId: string; children?: ReactNode }) {
	const { controller, status, reason, version, you, lastEventAt } = useTripLive(
		tripId,
		options,
	);
	const value = useMemo<TripChannelValue>(
		() => ({
			tripId,
			controller,
			state: { status, reason, version, you, lastEventAt },
		}),
		[tripId, controller, status, reason, version, you, lastEventAt],
	);
	return (
		<TripChannelContext.Provider value={value}>
			{children}
		</TripChannelContext.Provider>
	);
}

/** The surrounding TripChannelProvider's trip, controller and state (or null). */
export function useTripChannel(): TripChannelValue | null {
	return useContext(TripChannelContext);
}
