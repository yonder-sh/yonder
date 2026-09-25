/**
 * QA security verifier (I2 round 1): SEC-01/02, LINK-03/07, SHARE-06/08 as an
 * adversary. Every actor calls the real server functions from its own page
 * (real cookies, real client stubs) and the results are compared with the
 * EXTENSIONS §3.1 matrix. Writes a JSON dump next to the Playwright output
 * for the report.
 */
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
	call,
	code,
	DAY1,
	DEMO,
	EMAIL,
	EXPENSE,
	GG,
	GG_ITEM,
	guestPage,
	LIST_ITEM,
	MEMBER,
	MOD,
	memberPage,
	PHOTO,
	PQ,
	PQ_NODE,
	T,
	TOKEN,
} from "./qa-security-helpers";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const OUT = process.env.QA_SEC_OUT ?? "/tmp/qa-security-authz.json";

type Probe = { name: string; mod: string; fn: string; data: unknown };

/** Reads every trip-scoped function offers, for trip `trip`. */
const reads = (trip: string): Probe[] => [
	{ name: "getTripGraph", mod: MOD.graph, fn: "getTripGraph", data: { tripId: trip } },
	{ name: "getTripCounts", mod: MOD.graph, fn: "getTripCounts", data: { tripId: trip } },
	{ name: "listActivity", mod: MOD.graph, fn: "listActivity", data: { tripId: trip } },
	{ name: "getDigest", mod: MOD.activity, fn: "getDigest", data: { tripId: trip } },
	{ name: "listProposals", mod: MOD.proposals, fn: "listProposals", data: { tripId: trip } },
	{ name: "listTripMedia", mod: MOD.media, fn: "listTripMedia", data: { tripId: trip } },
	{ name: "listTripListItems", mod: MOD.lists, fn: "listTripListItems", data: { tripId: trip } },
	{ name: "listTripNotes", mod: MOD.notes, fn: "listTripNotes", data: { tripId: trip } },
	{ name: "listMoney", mod: MOD.money, fn: "listMoney", data: { tripId: trip } },
	{ name: "exportMoneyCsv", mod: MOD.money, fn: "exportMoneyCsv", data: { tripId: trip } },
	{ name: "getSharing", mod: MOD.sharing, fn: "getSharing", data: { tripId: trip } },
];

/** Writes on Asia 2027 (all harmless when they succeed for the right roles). */
const writes: Probe[] = [
	{ name: "createItem", mod: MOD.items, fn: "createItem", data: { tripId: T, dayId: DAY1, title: "SEC-probe item" } },
	{ name: "updateNode", mod: MOD.nodes, fn: "updateNode", data: { nodeId: GG, patch: { description: "SEC-probe" } } },
	{ name: "createListItem", mod: MOD.lists, fn: "createListItem", data: { tripId: T, target: { kind: "node", nodeId: GG }, list: "todo", text: "SEC-probe todo" } },
	{ name: "setListItemStatus", mod: MOD.lists, fn: "setListItemStatus", data: { id: LIST_ITEM, status: "open" } },
	{ name: "addLink", mod: MOD.media, fn: "addLink", data: { tripId: T, target: { kind: "node", nodeId: GG }, url: "https://example.com/sec-probe" } },
	{ name: "createUpload", mod: MOD.media, fn: "createUpload", data: { tripId: T, target: { kind: "node", nodeId: GG }, type: "image/jpeg", size: 1000, name: "sec.jpg" } },
	{ name: "createUpload(receipt)", mod: MOD.media, fn: "createUpload", data: { tripId: T, target: { kind: "expense", expenseId: EXPENSE }, type: "image/jpeg", size: 1000, name: "receipt.jpg" } },
	{ name: "setAttachmentVisibility", mod: MOD.media, fn: "setAttachmentVisibility", data: { id: PHOTO, visibility: "everyone" } },
	{ name: "createExpense", mod: MOD.money, fn: "createExpense", data: { tripId: T, target: { kind: "trip" }, title: "SEC-probe expense", amountMinor: 100, currency: "USD" } },
	{ name: "updateTrip(name)", mod: MOD.trips, fn: "updateTrip", data: { tripId: T, name: "Asia 2027" } },
	{ name: "updateTrip(slug)", mod: MOD.trips, fn: "updateTrip", data: { tripId: T, slug: "asia-2027" } },
	{ name: "inviteMember", mod: MOD.sharing, fn: "inviteMember", data: { tripId: T, email: "sec-probe@example.com", role: "viewer" } },
	{ name: "setShareLink", mod: MOD.sharing, fn: "setShareLink", data: { tripId: T, role: "viewer", enabled: true } },
	{ name: "addPlaceholder", mod: MOD.sharing, fn: "addPlaceholder", data: { tripId: T, displayName: "SEC Probe" } },
	{ name: "updateMemberRole(kai)", mod: MOD.sharing, fn: "updateMemberRole", data: { memberId: MEMBER.kai, role: "viewer" } },
	{ name: "removeMember(owner)", mod: MOD.sharing, fn: "removeMember", data: { memberId: MEMBER.dennis } },
	{ name: "markTripSeen", mod: MOD.activity, fn: "markTripSeen", data: { tripId: T } },
	{ name: "proposeNoteAppend", mod: MOD.suggest, fn: "proposeNoteAppend", data: { tripId: T, target: { kind: "node", nodeId: GG }, markdown: "SEC-probe note" } },
	{ name: "duplicateTrip", mod: MOD.dashboard, fn: "duplicateTrip", data: { tripId: T, name: "SEC dup", startDate: "2027-10-02", include: { notes: true, lists: true, media: true, budgets: true, placeholders: true } } },
];

const ACTORS = [
	"eve",
	"kai",
	"maya",
	"audrey",
	"guestViewer",
	"guestSuggester",
	"guestEditor",
	"eveViaViewerLink",
] as const;

test("authz matrix: reads and writes per actor", async ({ browser }) => {
	test.setTimeout(600_000);
	const dump: Record<string, Record<string, string>> = {};
	for (const actor of ACTORS) {
		const { ctx, page } =
			actor === "eve"
				? await memberPage(browser, EMAIL.eve)
				: actor === "kai"
					? await memberPage(browser, EMAIL.kai)
					: actor === "maya"
						? await memberPage(browser, EMAIL.maya)
						: actor === "audrey"
							? await memberPage(browser, EMAIL.audrey)
							: actor === "guestViewer"
								? await guestPage(browser, TOKEN.viewer)
								: actor === "guestSuggester"
									? await guestPage(browser, TOKEN.suggester)
									: actor === "guestEditor"
										? await guestPage(browser, TOKEN.editor)
										: await guestPage(browser, TOKEN.viewer, EMAIL.eve);
		const row: Record<string, string> = {};
		for (const p of reads(T)) {
			const r = await call(page, p.mod, p.fn, p.data);
			row[`T:${p.name}`] = r.ok ? `OK ${JSON.stringify(r.r).length}b` : code(r);
		}
		for (const p of reads(PQ)) {
			const r = await call(page, p.mod, p.fn, p.data);
			row[`PQ:${p.name}`] = r.ok ? `OK ${JSON.stringify(r.r).length}b` : code(r);
		}
		for (const p of writes) {
			const r = await call(page, p.mod, p.fn, p.data);
			row[`W:${p.name}`] = r.ok ? `OK ${JSON.stringify(r.r).slice(0, 120)}` : r.err.slice(0, 120);
		}
		// Cross-trip writes with this session.
		const x = await call(page, MOD.nodes, "updateNode", { nodeId: PQ_NODE, patch: { description: "SEC-probe" } });
		row["X:updateNode(PQ)"] = r2s(x);
		const y = await call(page, MOD.items, "createItem", { tripId: DEMO, dayId: null, title: "SEC-probe" });
		row["X:createItem(DEMO)"] = r2s(y);
		dump[actor] = row;
		await ctx.close();
	}
	writeFileSync(OUT, JSON.stringify(dump, null, 1));
	expect(Object.keys(dump)).toHaveLength(ACTORS.length);
});

function r2s(r: Awaited<ReturnType<typeof call>>) {
	return r.ok ? `OK ${JSON.stringify(r.r).slice(0, 120)}` : r.err.slice(0, 120);
}

// Keep the imports used when probes are trimmed.
void GG_ITEM;
