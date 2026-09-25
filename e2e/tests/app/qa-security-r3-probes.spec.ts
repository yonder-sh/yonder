/**
 * QA security verifier (I2 round 3): new adversarial probes on the QA seed
 * (Asia 2027; ids via QA_SEC_IDS, see qa-security-helpers.ts).
 *
 * 1. Suggester bypass through a private to-do: Maya (suggester) may write her
 *    OWN private rows directly (ADDENDUM §7.2). Can she then flip one to shared
 *    (and rewrite it) without a review?
 * 2. A private to-do assigned to someone else: does it reach them (inbox,
 *    dashboard deadlines, counts, lists)?
 * 3. A guest suggester's private to-do (guests can't keep private rows).
 * 4. Booking details in a suggested flight change: a suggester changes NH 9's
 *    booking ref and seats; what do link guests get through proposals, graph,
 *    activity, inbox and the rendered page?
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { expectLive } from "./_helpers/page";
import { call, EMAIL, FLIGHT_LEG, GG, guestPage, IDS, MOD, memberPage, T, TOKEN } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR || !process.env.QA_SEC_IDS, "QA security verifier probes: set QA_SEC_DIR and QA_SEC_IDS");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const r2s = (r: { ok: boolean; r?: unknown; err?: string }) => (r.ok ? `OK ${JSON.stringify(r.r).slice(0, 220)}` : String(r.err).slice(0, 220));

test("suggester: a private to-do made shared, and a private to-do assigned to others", async ({ browser }) => {
	test.setTimeout(300_000);
	const stamp = Date.now().toString(36);
	const out: Record<string, unknown> = {};
	const maya = await memberPage(browser, EMAIL.maya, "Maya", "Suggester");
	const dennis = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	const audrey = await memberPage(browser, EMAIL.audrey, "Audrey", "Tester");

	// 1. Private create (direct, allowed), then flip it to shared.
	const secretText = `R3-PRIV-${stamp}`;
	const c1 = await call(maya.page, MOD.lists, "createListItem", { tripId: T, target: { kind: "node", nodeId: GG }, list: "todo", text: secretText, isPrivate: true });
	out.mayaCreatePrivate = r2s(c1);
	const id1 = c1.ok ? ((c1.r as { id?: string }).id ?? null) : null;
	const bypassText = `R3-BYPASS-${stamp} (shared without review)`;
	if (id1) {
		const u = await call(maya.page, MOD.lists, "updateListItem", { id: id1, patch: { isPrivate: false, text: bypassText } });
		out.mayaMakeShared = r2s(u);
		out.mayaMakeSharedWasProposal = u.ok && !!(u.r as { proposed?: unknown }).proposed;
	}
	const dl = await call(dennis.page, MOD.lists, "listTripListItems", { tripId: T });
	const row = dl.ok ? (dl.r as { id: string; text: string; isPrivate: boolean; createdBy?: string }[]).find((x) => x.id === id1) : undefined;
	out.dennisSeesRow = row ? { text: row.text, isPrivate: row.isPrivate } : null;
	const dp = await call(dennis.page, MOD.proposals, "listProposals", { tripId: T });
	out.openProposalForRow = JSON.stringify(dp).includes(id1 ?? "none");
	const act = await call(dennis.page, MOD.graph, "listActivity", { tripId: T, limit: 30 });
	out.activityLine = act.ok ? JSON.stringify(act.r).match(new RegExp(`[^"]{0,60}R3-BYPASS-${stamp}[^"]{0,30}`))?.[0] ?? null : act.err;

	// 1b. The same trick with a new private row created directly WITH a due date, targets and assignees, then shared.
	// 2. A private to-do assigned to Dennis and Audrey, due in two days.
	const giftText = `R3-GIFT-${stamp}`;
	const c2 = await call(maya.page, MOD.lists, "createListItem", {
		tripId: T,
		target: { kind: "node", nodeId: GG },
		list: "todo",
		text: giftText,
		isPrivate: true,
		dueDate: "2026-09-25",
		dueTime: "10:00",
		dueTz: "Asia/Tokyo",
		assigneeIds: [IDS.MEMBER?.dennis, IDS.MEMBER?.audrey].filter(Boolean),
	});
	out.mayaCreatePrivateAssigned = r2s(c2);
	await dennis.page.waitForTimeout(1500);
	for (const [who, p] of [["dennis", dennis.page], ["audrey", audrey.page]] as const) {
		const hits: Record<string, boolean | string> = {};
		const probes: [string, string, string, unknown][] = [
			["inboxTrip", MOD.inbox, "listInbox", { tripId: T }],
			["inboxAll", MOD.inbox, "listInbox", {}],
			["deadlines", MOD.dashboard, "listMyDeadlines", {}],
			["lists", MOD.lists, "listTripListItems", { tripId: T }],
			["counts", MOD.graph, "getTripCounts", { tripId: T }],
			["activity", MOD.graph, "listActivity", { tripId: T, limit: 50 }],
			["digest", MOD.activity, "getDigest", { tripId: T }],
			["proposals", MOD.proposals, "listProposals", { tripId: T }],
			["myTrips", MOD.dashboard, "listMyTrips", {}],
		];
		for (const [name, mod, fn, data] of probes) {
			const r = await call(p, mod, fn, data);
			hits[name] = r.ok ? JSON.stringify(r.r).includes(giftText) || JSON.stringify(r.r).includes(`R3-PRIV-${stamp}`) : `ERR ${r.err.slice(0, 60)}`;
		}
		// The assigned count: does Dennis's "assigned to me" number change?
		out[`${who}Sees`] = hits;
	}
	// The dashboard page itself as Audrey.
	await audrey.page.goto("/dashboard");
	await audrey.page.waitForTimeout(3000);
	out.audreyDashboardShowsGift = (await audrey.page.locator("body").innerText()).includes(giftText);
	await audrey.page.screenshot({ path: path.join(DIR, "r3-probe-audrey-dashboard.png") });

	// 3. A guest suggester's "private" to-do.
	const gs = await guestPage(browser, TOKEN.suggester);
	const c3 = await call(gs.page, MOD.lists, "createListItem", { tripId: T, target: { kind: "node", nodeId: GG }, list: "todo", text: `R3-GUESTPRIV-${stamp}`, isPrivate: true });
	out.guestSuggesterCreatePrivate = r2s(c3);
	const dp2 = await call(dennis.page, MOD.proposals, "listProposals", { tripId: T });
	out.guestPrivateReachedReviewers = JSON.stringify(dp2).includes(`R3-GUESTPRIV-${stamp}`);

	writeFileSync(path.join(DIR, "r3-probe-private-todo.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	for (const x of [maya, dennis, audrey, gs]) await x.ctx.close();
	expect(out.mayaMakeSharedWasProposal, "a suggester's private row turned shared must go through review").toBe(true);
});

test("booking details in a suggested flight change never reach link guests", async ({ browser }) => {
	test.setTimeout(300_000);
	const out: Record<string, unknown> = {};
	const REF = "R3SECRETREF";
	const SEAT = "77K";
	const dennis = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	const pair = { kind: "pair", fromItemId: IDS.PAIR_FROM, toItemId: IDS.PAIR_TO };
	const leg = await call(dennis.page, MOD.legs, "getLeg", { target: pair });
	const details = leg.ok ? (leg.r as { leg?: { details?: { flight?: Record<string, unknown> } }; details?: { flight?: Record<string, unknown> } }) : null;
	const flight = details?.leg?.details?.flight ?? details?.details?.flight;
	out.flightFound = !!flight;
	out.legKeys = leg.ok ? Object.keys(leg.r as object) : leg.err;
	const maya = await memberPage(browser, EMAIL.maya, "Maya", "Suggester");
	if (flight) {
		const seats = Array.isArray(flight.seats) && flight.seats.length ? (flight.seats as { seat: string }[]).map((s, i) => (i === 0 ? { ...s, seat: SEAT } : s)) : [{ seat: SEAT }];
		const next = { ...flight, bookingRef: REF, seats, cost: { amount: 4321.5, currency: "USD" } };
		delete (next as Record<string, unknown>).connection;
		const p = await call(maya.page, MOD.transit, "saveFlight", { target: pair, flight: next, proposal: { message: "moved seats" } });
		out.mayaSaveFlight = r2s(p);
	}
	const needles = [REF, SEAT, "4321.5", "4321"];
	for (const [who, token] of [["guestViewer", TOKEN.viewer], ["guestSuggester", TOKEN.suggester], ["guestEditor", TOKEN.editor]] as const) {
		const g = await guestPage(browser, token);
		const hits: Record<string, string[] | string> = {};
		for (const [name, mod, fn, data] of [
			["proposals", MOD.proposals, "listProposals", { tripId: T }],
			["graph", MOD.graph, "getTripGraph", { tripId: T }],
			["activity", MOD.graph, "listActivity", { tripId: T, limit: 50 }],
			["inbox", MOD.inbox, "listInbox", { tripId: T }],
			["digest", MOD.activity, "getDigest", { tripId: T }],
			["leg", MOD.legs, "getLeg", { target: pair }],
		] as [string, string, string, unknown][]) {
			const r = await call(g.page, mod, fn, data);
			const s = r.ok ? JSON.stringify(r.r) : "";
			hits[name] = r.ok ? needles.filter((n) => s.includes(n)) : `ERR ${r.err.slice(0, 50)}`;
		}
		// The page: the flight selected with suggestions shown.
		await g.page.goto(`/t/asia-2027?sel=l.${IDS.PAIR_FROM}.${IDS.PAIR_TO}`);
		await expectLive(g.page);
		await g.page.waitForTimeout(2500);
		const txt = await g.page.locator("body").innerText();
		const html = await g.page.content();
		hits.pageText = needles.filter((n) => txt.includes(n));
		hits.pageHtml = needles.filter((n) => html.includes(n));
		await g.page.screenshot({ path: path.join(DIR, `r3-probe-flight-${who}.png`) });
		out[who] = hits;
		await g.ctx.close();
	}
	// Dennis (owner) does see the suggestion with the new ref (control).
	const dp = await call(dennis.page, MOD.proposals, "listProposals", { tripId: T });
	out.ownerSeesRef = JSON.stringify(dp).includes(REF);
	// Clean up: withdraw Maya's suggestion.
	const mp = await call(maya.page, MOD.proposals, "listProposals", { tripId: T });
	const mine = mp.ok ? JSON.stringify(mp.r).match(/"id":"([0-9a-f-]{36})","tripId":"[0-9a-f-]{36}","op":"flight\.save"/) : null;
	if (mine?.[1]) out.withdraw = r2s(await call(maya.page, MOD.proposals, "withdrawProposal", { proposalId: mine[1] }));
	writeFileSync(path.join(DIR, "r3-probe-flight.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	for (const x of [dennis, maya]) await x.ctx.close();
	void FLIGHT_LEG;
});
