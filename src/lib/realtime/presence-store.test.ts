import { describe, expect, it } from "vitest";
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
} from "y-protocols/awareness";
import * as Y from "yjs";
import { editingPeer, PresenceStore, peersAt } from "./presence-store";

/** A remote client's awareness, merged into `into` the way the provider does. */
function remote(into: Awareness, state: Record<string, unknown>) {
	const a = new Awareness(new Y.Doc());
	a.setLocalState(state);
	applyAwarenessUpdate(into, encodeAwarenessUpdate(a, [a.clientID]), "remote");
	return a;
}

const user = (id: string, name: string) => ({
	id,
	memberId: null,
	name,
	color: 1,
	guest: false,
});

describe("PresenceStore", () => {
	it("lists one entry per other user, hides my other tabs once my id is known", () => {
		const mine = new Awareness(new Y.Doc());
		const store = new PresenceStore(mine);
		remote(mine, { user: user("u-bob", "Bob") });
		remote(mine, {
			user: user("u-bob", "Bob"),
			editing: { kind: "item", id: "i1" },
		});
		remote(mine, { user: user("u-me", "Me (other tab)") });
		remote(mine, { view: { path: "/t/x" } }); // no user yet: ignored

		let peers = store.getSnapshot().peers;
		expect(peers.map((p) => p.user.id).sort()).toEqual(["u-bob", "u-me"]);
		store.setSelfUserId("u-me");
		peers = store.getSnapshot().peers;
		expect(peers.map((p) => p.user.name)).toEqual(["Bob"]);
		expect(
			editingPeer(store.getSnapshot().clients, "item", "i1")?.user.name,
		).toBe("Bob");
	});

	it("keeps the snapshot identity while nothing relevant changes", () => {
		const mine = new Awareness(new Y.Doc());
		const store = new PresenceStore(mine);
		remote(mine, { user: user("u-bob", "Bob") });
		const a = store.getSnapshot();
		store.setSelfUserId(null);
		expect(store.getSnapshot()).toBe(a);
	});

	it("peersAt matches scope, node selection and item selection", () => {
		const base = { clientId: 1, user: user("u", "U") };
		const v = (scopeId: string | null, sel: string | null) => ({
			scopeId,
			scopeName: "",
			lens: "city" as const,
			tab: "plan" as const,
			days: null,
			sel,
			path: "/t/x",
		});
		const peers = [
			{ ...base, view: v("n1", null) },
			{ ...base, clientId: 2, view: v(null, "i.i1") },
			{ ...base, clientId: 3 },
		];
		expect(peersAt(peers, { nodeId: "n1" }).map((p) => p.clientId)).toEqual([
			1,
		]);
		// one entry per user even when two of their tabs match
		expect(
			peersAt([...peers, { ...base, clientId: 4, view: v("n1", null) }], {
				nodeId: "n1",
			}),
		).toHaveLength(1);
		expect(peersAt(peers, { itemId: "i1" }).map((p) => p.clientId)).toEqual([
			2,
		]);
		expect(peersAt(peers, { sel: "i.i1" }).map((p) => p.clientId)).toEqual([2]);
	});
});
