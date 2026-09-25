import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
} from "y-protocols/awareness";
import * as Y from "yjs";
import { tripKeys } from "@/lib/query/keys";
import type { CollabClient, DocLease, DocSnapshot } from "./collab-client";

/** A CollabClient double: one lease per name, with a real Awareness and a stateless emitter. */
function fakeClient() {
	const leases = new Map<
		string,
		{
			lease: DocLease;
			emit(payload: string): void;
			set(s: Partial<DocSnapshot>): void;
		}
	>();
	const acquire = (name: string): DocLease => {
		let entry = leases.get(name);
		if (!entry) {
			const doc = new Y.Doc();
			const awareness = new Awareness(doc);
			const stateless = new Set<(p: string) => void>();
			const listeners = new Set<() => void>();
			let snap: DocSnapshot = {
				status: "authenticated",
				synced: true,
				readOnly: true,
				reason: null,
			};
			entry = {
				lease: {
					name,
					doc,
					provider: {} as DocLease["provider"],
					awareness,
					getSnapshot: () => snap,
					subscribe: (l) => {
						listeners.add(l);
						return () => listeners.delete(l);
					},
					onStateless: (cb) => {
						stateless.add(cb);
						return () => stateless.delete(cb);
					},
					release: () => {},
				},
				emit: (p) => {
					for (const cb of stateless) cb(p);
				},
				set: (s) => {
					snap = { ...snap, ...s };
					for (const l of listeners) l();
				},
			};
			leases.set(name, entry);
		}
		return entry.lease;
	};
	// useSyncExternalStore needs a stable snapshot object (like the real client's).
	const socket = { status: "connected", everConnected: true, downSince: null };
	const client = {
		acquire,
		getSocketSnapshot: () => socket,
		subscribeSocket: () => () => {},
	} as unknown as CollabClient;
	return { client, leases };
}

const fake = fakeClient();
vi.mock("./collab-client", () => ({
	getCollabClient: () => fake.client,
	onCollabClientReset: () => () => {},
}));

const { TripChannelProvider } = await import("./trip-channel");
const { usePeers, usePeersAt } = await import("./presence");
const { useCanEdit, useConnectionStatus } = await import("./connection");

const T = "0192f5a0-0000-7000-8000-000000000001";
const N = "0192f5a0-0000-7000-8000-0000000000aa";

function Probe() {
	const peers = usePeers();
	const atNode = usePeersAt({ nodeId: N });
	const canEdit = useCanEdit();
	const status = useConnectionStatus();
	return (
		<div>
			<span data-testid="peers">{peers.map((p) => p.user.name).join(",")}</span>
			<span data-testid="at-node">{atNode.length}</span>
			<span data-testid="can-edit">{String(canEdit)}</span>
			<span data-testid="status">{status}</span>
		</div>
	);
}

function wrap(qc: QueryClient, children: ReactNode) {
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("TripChannelProvider + hooks", () => {
	it("wires hello, invalidations, presence and edit rights", async () => {
		const qc = new QueryClient();
		const spy = vi.spyOn(qc, "invalidateQueries");
		render(
			wrap(
				qc,
				<TripChannelProvider tripId={T} baseVersion={4} coalesceMs={0}>
					<Probe />
				</TripChannelProvider>,
			),
		);
		const channel = fake.leases.get(`trip/${T}`);
		expect(channel).toBeDefined();
		if (!channel) return;

		// hello: same version → no refetch; role editor → can edit
		await act(async () => {
			channel.emit(
				JSON.stringify({
					type: "hello",
					tripId: T,
					version: 4,
					you: {
						userId: "u-me",
						memberId: null,
						role: "editor",
						guest: false,
						color: 1,
						name: "Me",
					},
				}),
			);
		});
		expect(screen.getByTestId("can-edit").textContent).toBe("true");
		expect(screen.getByTestId("status").textContent).toBe("live");
		expect(spy).not.toHaveBeenCalled();

		// a live invalidate from someone else
		await act(async () => {
			channel.emit(
				JSON.stringify({
					type: "invalidate",
					tripId: T,
					version: 5,
					keys: ["media"],
				}),
			);
			await new Promise((r) => setTimeout(r, 5));
		});
		expect(spy).toHaveBeenCalledWith({ queryKey: tripKeys.media(T) });

		// a peer shows up at a node (the server already stamped `user`)
		await act(async () => {
			const other = new Awareness(new Y.Doc());
			other.setLocalState({
				user: {
					id: "u-bob",
					memberId: null,
					name: "Bob",
					color: 2,
					guest: false,
				},
				view: {
					scopeId: N,
					scopeName: "Tokyo",
					lens: "city",
					tab: "plan",
					days: null,
					sel: null,
					path: "/t/x",
				},
			});
			applyAwarenessUpdate(
				channel.lease.awareness as Awareness,
				encodeAwarenessUpdate(other, [other.clientID]),
				"remote",
			);
		});
		expect(screen.getByTestId("peers").textContent).toBe("Bob");
		expect(screen.getByTestId("at-node").textContent).toBe("1");
	});
});
