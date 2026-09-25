import { useEffect, useState, useSyncExternalStore } from "react";
import type { TripRole } from "@/lib/schemas/enums";
import type { SocketSnapshot } from "./collab-client";
import { useCollabClient, useTripChannel } from "./trip-channel";

/**
 * Connection status and the "can I edit right now" rule (SPEC §10.7):
 * - `live`          the socket is open;
 * - `connecting`    never connected yet (≤ 10 s);
 * - `reconnecting`  was live, down for ≤ 10 s;
 * - `offline`       `navigator.onLine === false`, or down for more than 10 s.
 */
export type ConnectionStatus =
	| "connecting"
	| "live"
	| "reconnecting"
	| "offline";

export const OFFLINE_AFTER_MS = 10_000;

export function deriveConnectionStatus(
	socket: SocketSnapshot,
	online: boolean,
	now: number,
): ConnectionStatus {
	if (!online) return "offline";
	if (socket.status === "connected") return "live";
	const downFor = socket.downSince === null ? 0 : now - socket.downSince;
	if (downFor > OFFLINE_AFTER_MS) return "offline";
	return socket.everConnected ? "reconnecting" : "connecting";
}

/** Can a user with `role` edit, given the connection? (role ∈ {owner, editor}, not offline.) */
export function canEdit(
	role: TripRole | null | undefined,
	status: ConnectionStatus,
	online: boolean,
): boolean {
	return (
		(role === "owner" || role === "editor") && status !== "offline" && online
	);
}

const INITIAL: SocketSnapshot = {
	status: "connecting",
	everConnected: false,
	downSince: null,
};
const noopSubscribe = () => () => {};
const initial = () => INITIAL;

function subscribeOnline(cb: () => void) {
	window.addEventListener("online", cb);
	window.addEventListener("offline", cb);
	return () => {
		window.removeEventListener("online", cb);
		window.removeEventListener("offline", cb);
	};
}

/** `navigator.onLine`, live. True during SSR. */
export function useOnline(): boolean {
	return useSyncExternalStore(
		subscribeOnline,
		() => navigator.onLine,
		() => true,
	);
}

export function useConnectionStatus(): ConnectionStatus {
	const client = useCollabClient();
	const socket = useSyncExternalStore(
		client?.subscribeSocket ?? noopSubscribe,
		client?.getSocketSnapshot ?? initial,
		initial,
	);
	const online = useOnline();
	const [, tick] = useState(0);
	// Re-render when "down for 10 s" flips reconnecting → offline.
	useEffect(() => {
		if (socket.downSince === null) return;
		const wait = OFFLINE_AFTER_MS - (Date.now() - socket.downSince);
		if (wait < 0) return;
		const t = setTimeout(() => tick((n) => n + 1), wait + 50);
		return () => clearTimeout(t);
	}, [socket.downSince]);
	return deriveConnectionStatus(socket, online, Date.now());
}

/**
 * Whether edit affordances are enabled. `role` defaults to the role the collab
 * server reported for this trip's channel (TripChannelProvider); pass the
 * workspace's role explicitly outside it.
 */
export function useCanEdit(role?: TripRole | null): boolean {
	const channel = useTripChannel();
	const status = useConnectionStatus();
	const online = useOnline();
	return canEdit(role ?? channel?.state.you?.role ?? null, status, online);
}
