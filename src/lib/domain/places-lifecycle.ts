/**
 * The places lifecycle's stored half (docs/PLACES.md §3, §7): one decision
 * kept in three columns. `nodes.status` is what the rest of the app reads
 * ("dropped" hides a place in the Outline, the map and the lists);
 * `idea_status` is the explicit lifecycle decision (idea, shortlist,
 * dropped); `shortlist_pin` is how the shortlist was decided (auto follows
 * the group score, pinned / unpinned are by hand).
 *
 * `lifecycleSet` turns a node patch into the columns to write, so the server
 * core, the client's optimistic update and the proposal overlay agree.
 * Isomorphic and pure.
 */
import type { IdeaStatus, NodeStatus, ShortlistPin } from "@/lib/schemas/enums";

export type LifecycleFields = {
	status?: NodeStatus;
	ideaStatus?: IdeaStatus;
	shortlistPin?: ShortlistPin;
};

/**
 * The lifecycle columns a patch writes, given the node as stored:
 * - dropping (`status` or `ideaStatus` = dropped) sets both to dropped;
 * - bringing a place back (`status: active`, or `ideaStatus` idea / shortlist)
 *   makes it active again, a shortlist pick when it is pinned;
 * - pinning makes `ideaStatus` shortlist, unpinning or `auto` makes it an idea
 *   (a dropped place stays dropped until it is brought back).
 * A patch that touches none of the three writes nothing.
 */
export function lifecycleSet(
	node: { status: NodeStatus; shortlistPin?: ShortlistPin },
	p: LifecycleFields,
): LifecycleFields {
	if (
		p.status === undefined &&
		p.ideaStatus === undefined &&
		p.shortlistPin === undefined
	)
		return {};
	const out: LifecycleFields = {};
	let pin = p.shortlistPin ?? node.shortlistPin ?? "auto";
	if (p.ideaStatus === "shortlist") pin = "pinned";
	if (p.shortlistPin !== undefined || p.ideaStatus === "shortlist")
		out.shortlistPin = pin;
	const restore =
		p.status === "active" ||
		(p.ideaStatus !== undefined && p.ideaStatus !== "dropped");
	const drop =
		!restore &&
		(p.ideaStatus === "dropped" ||
			p.status === "dropped" ||
			node.status === "dropped");
	if (drop) {
		out.status = "dropped";
		out.ideaStatus = "dropped";
		return out;
	}
	if (node.status !== "active") out.status = "active";
	out.ideaStatus = pin === "pinned" ? "shortlist" : "idea";
	return out;
}
