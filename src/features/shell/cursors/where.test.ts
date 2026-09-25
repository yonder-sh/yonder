import { describe, expect, it } from "vitest";
import type { AwarenessView, Peer } from "@/lib/realtime/protocol";
import { selectionAnchors } from "./overlay";
import { followersOf, spotlightPresenter, whereOf } from "./where";

const KYOTO = "0192f5a0-0000-7000-8000-00000000c010";
const TOKYO = "0192f5a0-0000-7000-8000-00000000c011";

const view = (
	scopeId: string | null,
	tab: AwarenessView["tab"],
	name = "Kyoto",
) =>
	({
		scopeId,
		scopeName: name,
		lens: "city",
		tab,
		days: null,
		sel: null,
		path: "/t/x",
	}) satisfies AwarenessView;

const peer = (id: string, extra: Partial<Peer> = {}): Peer => ({
	clientId: id.length,
	user: { id, memberId: null, name: `${id} Person`, color: 1, guest: false },
	...extra,
});

describe("where are they (FB-17a)", () => {
	const me = { scopeId: TOKYO, tab: "plan" as const };

	it("nothing when they are on my screen", () => {
		expect(whereOf(view(TOKYO, "plan", "Tokyo"), me, "Asia", true)).toBeNull();
		expect(whereOf(undefined, me, "Asia", true)).toBeNull();
	});

	it("another tab here, another place, the trip itself", () => {
		expect(whereOf(view(TOKYO, "money", "Tokyo"), me, "Asia", true)).toEqual({
			text: "Money tab",
			elsewhere: false,
		});
		expect(whereOf(view(KYOTO, "plan"), me, "Asia", true)).toEqual({
			text: "in Kyoto",
			elsewhere: true,
		});
		expect(whereOf(view(KYOTO, "lists"), me, "Asia", true)?.text).toBe(
			"Lists tab · in Kyoto",
		);
		expect(whereOf(view(null, "plan", ""), me, "Asia 2027", true)?.text).toBe(
			"on Asia 2027",
		);
	});

	it("a guest never reads 'Money tab'", () => {
		expect(
			whereOf(view(TOKYO, "money", "Tokyo"), me, "Asia", false),
		).toBeNull();
		expect(whereOf(view(KYOTO, "money"), me, "Asia", false)?.text).toBe(
			"in Kyoto",
		);
	});
});

describe("followers and spotlight", () => {
	it("who follows me", () => {
		const peers = [
			peer("a", { following: "me" }),
			peer("b", { following: "a" }),
			peer("c"),
		];
		expect(followersOf(peers, "me").map((p) => p.user.id)).toEqual(["a"]);
		expect(followersOf(peers, null)).toEqual([]);
	});

	it("the presenter, unless I broke away from that spotlight", () => {
		const peers = [peer("a"), peer("b", { spotlight: { id: "s1abcd" } })];
		expect(spotlightPresenter(peers, new Set())?.user.id).toBe("b");
		expect(spotlightPresenter(peers, new Set(["s1abcd"]))).toBeNull();
		expect(spotlightPresenter([peer("a")], new Set())).toBeNull();
	});

	it("a peer's selection rings its card or day, not nodes", () => {
		expect(selectionAnchors(`i.${KYOTO}`)).toEqual([`item:${KYOTO}`]);
		expect(selectionAnchors(`d.${KYOTO}`)).toEqual([`dayh:${KYOTO}`]);
		expect(selectionAnchors(`n.${KYOTO}`)).toEqual([]);
		expect(selectionAnchors(null)).toEqual([]);
	});
});
