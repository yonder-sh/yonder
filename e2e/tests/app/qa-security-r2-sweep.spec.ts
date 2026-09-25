/**
 * QA security verifier (I2 round 2): the server functions round 1 didn't
 * call, as a non-member (fresh account), a viewer member (Kai), a guest
 * viewer and a guest suggester, with Asia 2027's real ids. Anything but a
 * refusal is a finding; the ids and payloads come from Dennis's own reads.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { call, EMAIL, guestPage, IDS, MOD, memberPage, T, TOKEN } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";

test("remaining server functions refuse outsiders, viewers and guests", async ({ browser }) => {
	test.setTimeout(600_000);
	const d = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	const g = await call(d.page, MOD.graph, "getTripGraph", { tripId: T });
	const m = await call(d.page, MOD.money, "listMoney", { tripId: T });
	const media = await call(d.page, MOD.media, "listTripMedia", { tripId: T });
	const lists = await call(d.page, MOD.lists, "listTripListItems", { tripId: T });
	const props = await call(d.page, MOD.proposals, "listProposals", { tripId: T });
	expect(g.ok && m.ok && media.ok && lists.ok && props.ok).toBe(true);
	const G = (g as { r: { items: { id: string; dayId: string | null }[]; nodes: { id: string; parentId: string | null; name: string }[]; days: { id: string; date: string }[]; legs: { id: string; fromItemId?: string; toItemId?: string; kind?: string; details?: { kind?: string } }[]; trip: { version: number } } }).r;
	const M = JSON.stringify((m as { r: unknown }).r);
	const expenseId = /"expenses":\[\{"id":"([0-9a-f-]{36})"/.exec(M)?.[1] ?? /"id":"([0-9a-f-]{36})","tripId"/.exec(M)?.[1] ?? "";
	const att = ((media as { r: { id: string; kind: string }[] }).r ?? []).find((a) => a.kind === "photo")?.id ?? "";
	const li = ((lists as { r: { id: string }[] }).r ?? [])[0]?.id ?? "";
	const proposalId = ((props as { r: { id: string }[] }).r ?? [])[0]?.id ?? "";
	const item = G.items.find((i) => i.dayId)!;
	const node = G.nodes.find((n) => n.name === "Golden Gai")!;
	const day = G.days[10]!;
	const leg = G.legs.find((l) => l.details?.kind !== "flight" && l.fromItemId && l.toItemId) ?? G.legs[0]!;
	const pair = { kind: "pair", fromItemId: leg.fromItemId, toItemId: leg.toItemId };
	await d.ctx.close();
	const ids = { expenseId, att, li, proposalId, item: item.id, node: node.id, day: day.id, leg: leg.id };

	const probes: [string, string, string, unknown][] = [
		["resolveTripSlug", MOD.trips, "resolveTripSlug", { slug: "asia-2027" }],
		["previewTripDates", MOD.trips, "previewTripDates", { tripId: T, startDate: "2027-10-02", endDate: "2027-11-06" }],
		["shiftTripDates", MOD.trips, "shiftTripDates", { tripId: T, deltaDays: 1, expectedVersion: G.trip.version }],
		["insertDay", MOD.days, "insertDay", { tripId: T, dayId: day.id, where: "after" }],
		["moveDay", MOD.days, "moveDay", { dayId: day.id, toDate: "2027-10-20" }],
		["updateDay", MOD.days, "updateDay", { dayId: day.id, title: "sweep" }],
		["deleteDay", MOD.days, "deleteDay", { dayId: day.id }],
		["deleteItem", MOD.items, "deleteItem", { itemId: item.id }],
		["updateItem", MOD.items, "updateItem", { itemId: item.id, patch: { title: "sweep" } }],
		["moveItem", MOD.items, "moveItem", { itemId: item.id, dayId: null }],
		["restoreItem", MOD.items, "restoreItem", { itemId: item.id, deletedAt: new Date().toISOString() }],
		["deleteNode", MOD.nodes, "deleteNode", { nodeId: node.id }],
		["restoreNode", MOD.nodes, "restoreNode", { nodeId: node.id, deletedAt: new Date().toISOString() }],
		["moveNode", MOD.nodes, "moveNode", { nodeId: node.id, parentId: null }],
		["createNodePath", MOD.nodes, "createNodePath", { tripId: T, chain: [{ id: node.id }, { type: "place", name: "Sweep place" }] }],
		["setNodePriority(self?)", MOD.nodes, "setNodePriority", { nodeId: node.id, memberId: IDS.MEMBER?.kai ?? "01a0cf13-fec7-770d-83d2-81162526e869", priority: "nah" }],
		["deleteLeg", MOD.legs, "deleteLeg", { legId: leg.id }],
		["setLegAssignees", MOD.legs, "setLegAssignees", { legId: leg.id, memberIds: [] }],
		["resetLegEstimate", MOD.legs, "resetLegEstimate", { legId: leg.id }],
		["deleteListItem", MOD.lists, "deleteListItem", { id: li }],
		["updateListItem", MOD.lists, "updateListItem", { id: li, patch: { text: "sweep" } }],
		["moveListItem", MOD.lists, "moveListItem", { id: li }],
		["restoreListItem", MOD.lists, "restoreListItem", { id: li }],
		["setListItemAssignees", MOD.lists, "setListItemAssignees", { id: li, memberIds: [] }],
		["deleteAttachment", MOD.media, "deleteAttachment", { id: att }],
		["updateAttachment", MOD.media, "updateAttachment", { id: att, caption: "sweep" }],
		["restoreAttachment", MOD.media, "restoreAttachment", { id: att }],
		["createPosterUpload", MOD.media, "createPosterUpload", { id: att, size: 1000 }],
		["completeUpload", MOD.media, "completeUpload", { id: att, hasPoster: false }],
		["refreshLinkMeta", MOD.media, "refreshLinkMeta", { id: att }],
		["updateExpense", MOD.money, "updateExpense", { id: expenseId, patch: { title: "sweep" } }],
		["deleteExpense", MOD.money, "deleteExpense", { id: expenseId }],
		["restoreExpense", MOD.money, "restoreExpense", { id: expenseId }],
		["markExpensePaid", MOD.money, "markExpensePaid", { id: expenseId }],
		["setExpenseRate", MOD.money, "setExpenseRate", { id: expenseId, rate: 1.5 }],
		["setBudgetLine", MOD.money, "setBudgetLine", { tripId: T, nodeId: node.id, amountMinor: 100 }],
		["resolveProposal", MOD.proposals, "resolveProposal", { proposalId, decision: "reject" }],
		["withdrawProposal", MOD.proposals, "withdrawProposal", { proposalId }],
		["removeGuest", MOD.sharing, "removeGuest", { tripId: T, userId: "x" }],
		["resetShareLink", MOD.sharing, "resetShareLink", { tripId: T, role: "viewer" }],
		["promoteGuest", MOD.sharing, "promoteGuest", { tripId: T, userId: "x", role: "editor" }],
		["getTransitOptions", MOD.transit, "getTransitOptions", { target: pair, departAt: "2027-10-05T10:00:00+09:00" }],
		["lockTransitTimes", MOD.transit, "lockTransitTimes", { target: pair, optionId: "x" }],
		["setOpeningHours", MOD.insights, "setOpeningHours", { nodeId: node.id, hours: null }],
		["getPlacePhotos", MOD.places, "getPlacePhotos", { nodeId: node.id }],
		["reverseGeocode", MOD.places, "reverseGeocode", { tripId: T, lat: 35.69, lng: 139.7 }],
		["getPlacePreview", MOD.places, "getPlacePreview", { tripId: T, provider: "photon", ref: "osm:N1", sessionToken: "x" }],
	];
	const out: Record<string, unknown> = { ids };
	for (const [who, open] of [
		["outsider", () => memberPage(browser, `qa-sec-r2-sw-${Date.now().toString(36)}@example.com`, "Oscar", "Outsider")],
		["kai", () => memberPage(browser, EMAIL.kai)],
		["guestViewer", () => guestPage(browser, TOKEN.viewer)],
		["guestSuggester", () => guestPage(browser, TOKEN.suggester)],
	] as const) {
		const { ctx, page } = await open();
		const row: Record<string, string> = {};
		for (const [label, mod, fn, data] of probes) {
			const r = await call(page, mod, fn, data);
			row[label] = r.ok ? `OK ${JSON.stringify(r.r).slice(0, 100)}` : r.err.replace(/\s+/g, " ").slice(0, 90);
		}
		out[who] = row;
		await ctx.close();
	}
	writeFileSync(path.join(DIR, "r2-sweep.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
});
