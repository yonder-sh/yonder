/**
 * QA security verifier (I2 round 2): cross-trip reference injection (IDOR in
 * payload ids). Xavier owns trip X (a fixture clone) and is only a GUEST
 * EDITOR of Asia 2027 (T) through the edit link. Every write that names ids
 * from both trips must be refused; nothing may end up linking the two trips
 * (the SQL check at the end is the verdict). Writes JSON for the report.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { call, MEMBER, MOD, T, TOKEN } from "./qa-security-helpers";
import { openLink } from "./_helpers/link";

test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const PSQL = process.env.QA_SEC_PSQL ?? "/nix/store/8zm2sma9jgvq101yy4x45za4y28yd164-postgresql-17.10/bin/psql";
const DB = process.env.DATABASE_URL ?? "postgres://trip:trip@localhost:5432/trip_a27";
const sqlRows = (q: string) => execFileSync(PSQL, ["-At", "-F", "|", DB, "-c", q], { encoding: "utf8" }).trim();

type G = {
	items: { id: string; dayId: string | null; nodeId: string | null; title?: string | null }[];
	nodes: { id: string; parentId: string | null; name: string; type?: string; level?: string }[];
	days: { id: string; date: string }[];
	legs: { id: string }[];
	members: { id: string; name: string; status?: string }[];
};

test("payload ids from another trip are refused", async ({ browser }) => {
	test.setTimeout(400_000);
	const stamp = Date.now().toString(36);
	const out: Record<string, unknown> = { stamp };
	const ctx = await browser.newContext();
	await loginViaApi(ctx.request, `qa-sec-xavier-${stamp}@example.com`, { first: "Xavier", last: "Attacker" });
	const page = await ctx.newPage();
	const X = await cloneFixtureTrip(page.request);
	await openLink(page, "asia-2027", TOKEN.editor);
	await page.waitForURL(/\/t\/asia-2027/, { timeout: 30_000 });
	const tg = await call(page, MOD.graph, "getTripGraph", { tripId: T });
	const xg = await call(page, MOD.graph, "getTripGraph", { tripId: X.tripId });
	expect(tg.ok && xg.ok, JSON.stringify([tg, xg]).slice(0, 300)).toBe(true);
	const tG = (tg as { r: G }).r;
	const xG = (xg as { r: G }).r;
	out.me = (tg as { r: { me: unknown } }).r.me;
	const tItem = tG.items.find((i) => i.dayId && i.title && !/flight|check in/i.test(i.title ?? ""))!;
	const tItem2 = tG.items.find((i) => i.dayId && i.id !== tItem.id && i.dayId === tItem.dayId)!;
	const tLeaf = tG.nodes.find((n) => n.name === "Golden Gai")!;
	const tDay = tG.days[5]!;
	const xItem = xG.items.find((i) => i.dayId)!;
	const xNode = xG.nodes.find((n) => n.parentId)!;
	const xDay = xG.days[0]!;
	const xLeg = xG.legs[0];
	out.ids = { tItem: tItem.id, tItem2: tItem2?.id, tLeaf: tLeaf.id, tDay: tDay.id, xItem: xItem.id, xNode: xNode.id, xDay: xDay.id, xLeg: xLeg?.id };
	const res: Record<string, string> = {};
	const probe = async (label: string, mod: string, fn: string, data: unknown) => {
		const r = await call(page, mod, fn, data);
		res[label] = r.ok ? `OK ${JSON.stringify(r.r).slice(0, 140)}` : r.err.slice(0, 140);
		return r;
	};
	// Helpers in X.
	const xList = await probe("setup: X todo", MOD.lists, "createListItem", { tripId: X.tripId, target: { kind: "node", nodeId: xNode.id }, list: "todo", text: `x todo ${stamp}` });
	const xListId = xList.ok ? (xList.r as { id: string }).id : null;
	const xLink = await probe("setup: X link", MOD.media, "addLink", { tripId: X.tripId, target: { kind: "node", nodeId: xNode.id }, url: `https://example.com/x-${stamp}` });
	const xLinkId = xLink.ok ? (xLink.r as { id: string }).id : null;

	await probe("moveItem(T item → X day)", MOD.items, "moveItem", { itemId: tItem.id, dayId: xDay.id });
	await probe("moveItem(X item → T day)", MOD.items, "moveItem", { itemId: xItem.id, dayId: tDay.id });
	await probe("createItem(X, node from T)", MOD.items, "createItem", { tripId: X.tripId, dayId: xDay.id, nodeId: tLeaf.id, durationMin: 30 });
	await probe("createItem(T, node from X)", MOD.items, "createItem", { tripId: T, dayId: tDay.id, nodeId: xNode.id, durationMin: 30 });
	await probe("createItem(X, after T item)", MOD.items, "createItem", { tripId: X.tripId, dayId: xDay.id, title: `after ${stamp}`, afterItemId: tItem.id });
	await probe("updateItem(X item → T node)", MOD.items, "updateItem", { itemId: xItem.id, patch: { nodeId: tLeaf.id } });
	await probe("updateItem(T item → X node)", MOD.items, "updateItem", { itemId: tItem.id, patch: { nodeId: xNode.id } });
	await probe("moveNode(T leaf → under X)", MOD.nodes, "moveNode", { nodeId: tLeaf.id, parentId: xNode.id });
	await probe("moveNode(X node → under T)", MOD.nodes, "moveNode", { nodeId: xNode.id, parentId: tLeaf.id });
	await probe("createNode(X, parent in T)", MOD.nodes, "createNode", { tripId: X.tripId, parentId: tLeaf.id, type: "place", name: `x-in-t ${stamp}` });
	await probe("createListItem(X, target T node)", MOD.lists, "createListItem", { tripId: X.tripId, target: { kind: "node", nodeId: tLeaf.id }, list: "todo", text: `leak ${stamp}` });
	await probe("createListItem(T, target X item)", MOD.lists, "createListItem", { tripId: T, target: { kind: "item", itemId: xItem.id }, list: "todo", text: `inj ${stamp}` });
	if (xListId) {
		await probe("setListItemTargets(X todo → T node)", MOD.lists, "setListItemTargets", { id: xListId, nodeIds: [tLeaf.id] });
		await probe("setListItemAssignees(X todo → T Dennis)", MOD.lists, "setListItemAssignees", { id: xListId, memberIds: [MEMBER.dennis] });
	}
	await probe("ensureLeg(T item → X item)", MOD.legs, "ensureLeg", { target: { kind: "pair", fromItemId: tItem.id, toItemId: xItem.id } });
	if (xLeg && tItem2) await probe("relinkLeg(X leg → T items)", MOD.legs, "relinkLeg", { legId: xLeg.id, fromItemId: tItem.id, toItemId: tItem2.id });
	await probe("addLink(X, target T node)", MOD.media, "addLink", { tripId: X.tripId, target: { kind: "node", nodeId: tLeaf.id }, url: `https://example.com/leak-${stamp}` });
	await probe("addLink(T, target X node)", MOD.media, "addLink", { tripId: T, target: { kind: "node", nodeId: xNode.id }, url: `https://example.com/inj-${stamp}` });
	if (xLinkId) await probe("updateAttachment(X link → T node)", MOD.media, "updateAttachment", { id: xLinkId, target: { kind: "node", nodeId: tLeaf.id } });
	await probe("createUpload(X, target T node)", MOD.media, "createUpload", { tripId: X.tripId, target: { kind: "node", nodeId: tLeaf.id }, type: "image/jpeg", size: 1000, name: "x.jpg" });
	await probe("createExpense(X, target T node)", MOD.money, "createExpense", { tripId: X.tripId, target: { kind: "node", nodeId: tLeaf.id }, title: `exp ${stamp}`, amountMinor: 100, currency: "USD" });
	await probe("setItemAssignees(X item → T Dennis)", MOD.items, "setItemAssignees", { itemId: xItem.id, memberIds: [MEMBER.dennis] });
	await probe("setNodePriority(X node, T Dennis)", MOD.nodes, "setNodePriority", { nodeId: xNode.id, memberId: MEMBER.dennis, priority: "must" });
	await probe("setNodePriority(T node, X owner)", MOD.nodes, "setNodePriority", { nodeId: tLeaf.id, memberId: X.members.owner, priority: "must" });
	await probe("linkPlaceholder(X Audrey → T Dennis)", MOD.sharing, "linkPlaceholder", { memberId: X.members.audrey, toMemberId: MEMBER.dennis });
	await probe("setDayStay(X day → T node)", MOD.days, "setDayStay", { fromDayId: xDay.id, nodeId: tLeaf.id });
	await probe("createItem(X, note mentions T Dennis)", MOD.items, "createItem", { tripId: X.tripId, dayId: xDay.id, title: `mention ${stamp}`, note: `hey [@Dennis Tester](mention:${MEMBER.dennis}) ${stamp}` });
	await probe("createListItem(X, note mentions T Dennis)", MOD.lists, "createListItem", { tripId: X.tripId, target: { kind: "node", nodeId: xNode.id }, list: "todo", text: `m ${stamp}`, note: `ping [@Dennis Tester](mention:${MEMBER.dennis})` });
	out.results = res;

	// Verdict from the database: nothing may link X and T.
	const t = T;
	const x = X.tripId;
	out.sql = {
		itemsWithForeignNode: sqlRows(`select i.id from items i join nodes n on n.id=i.node_id where i.trip_id<>n.trip_id and (i.trip_id in ('${t}','${x}'))`),
		itemsWithForeignDay: sqlRows(`select i.id from items i join trip_days d on d.id=i.day_id where i.trip_id<>d.trip_id and (i.trip_id in ('${t}','${x}'))`),
		nodesWithForeignParent: sqlRows(`select c.id from nodes c join nodes p on p.id=c.parent_id where c.trip_id<>p.trip_id and (c.trip_id in ('${t}','${x}'))`),
		legsCrossTrip: sqlRows(`select l.id from legs l join items a on a.id=l.from_item_id join items b on b.id=l.to_item_id where not (l.trip_id=a.trip_id and l.trip_id=b.trip_id) and l.trip_id in ('${t}','${x}')`),
		listItemsForeignTarget: sqlRows(`select li.id from list_items li left join nodes n on n.id=li.node_id left join items it on it.id=li.item_id where (n.trip_id is not null and n.trip_id<>li.trip_id) or (it.trip_id is not null and it.trip_id<>li.trip_id)`),
		listTargetsForeign: sqlRows(`select t.list_item_id from list_item_targets t join list_items li on li.id=t.list_item_id join nodes n on n.id=t.node_id where n.trip_id<>li.trip_id`),
		attachmentsForeignTarget: sqlRows(`select a.id from attachments a left join nodes n on n.id=a.node_id left join items it on it.id=a.item_id where (n.trip_id is not null and n.trip_id<>a.trip_id) or (it.trip_id is not null and it.trip_id<>a.trip_id)`),
		expensesForeignNode: sqlRows(`select e.id from expenses e join nodes n on n.id=e.node_id where n.trip_id<>e.trip_id`).slice(0, 400),
		assigneesForeign: sqlRows(`select a.item_id from item_assignees a join items i on i.id=a.item_id join trip_members m on m.id=a.member_id where m.trip_id<>i.trip_id`),
		listAssigneesForeign: sqlRows(`select a.list_item_id from list_item_assignees a join list_items i on i.id=a.list_item_id join trip_members m on m.id=a.member_id where m.trip_id<>i.trip_id`),
		prioritiesForeign: sqlRows(`select p.node_id from node_priorities p join nodes n on n.id=p.node_id join trip_members m on m.id=p.member_id where m.trip_id<>n.trip_id`),
		mentionsForeign: sqlRows(`select mn.id from mentions mn join trip_members m on m.id=mn.member_id where m.trip_id<>mn.trip_id`),
		tLeafStillInT: sqlRows(`select trip_id from nodes where id='${tLeaf.id}'`) === t,
		tItemDay: sqlRows(`select day_id from items where id='${tItem.id}'`),
	};
	writeFileSync(path.join(DIR, "r2-crosstrip.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await ctx.close();
});
