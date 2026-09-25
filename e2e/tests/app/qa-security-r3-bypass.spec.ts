/**
 * QA security verifier (I2 round 3): the suggester bypass through a private
 * to-do, end to end. Maya (suggester) keeps a private to-do with a due date
 * and Dennis + Audrey assigned, then turns it shared; nothing goes to review.
 * Dennis's views (lists, inbox, activity, proposals) and a screenshot of
 * Golden Gai's to-dos show what the owner gets.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { expectLive } from "./_helpers/page";
import { call, EMAIL, GG, IDS, MOD, memberPage, T } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR || !process.env.QA_SEC_IDS, "QA security verifier probes: set QA_SEC_DIR and QA_SEC_IDS");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const r2s = (r: { ok: boolean; r?: unknown; err?: string }) => (r.ok ? `OK ${JSON.stringify(r.r).slice(0, 160)}` : String(r.err).slice(0, 160));

test("suggester: private to-do → shared, with a due date and assignees, skips review", async ({ browser }) => {
	test.setTimeout(240_000);
	const stamp = Date.now().toString(36);
	const text = `Pay the deposit to Maya's friend ${stamp}`;
	const out: Record<string, unknown> = {};
	const maya = await memberPage(browser, EMAIL.maya, "Maya", "Suggester");
	const dennis = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	// Control: the same to-do created shared is only a suggestion.
	const ctl = await call(maya.page, MOD.lists, "createListItem", { tripId: T, target: { kind: "node", nodeId: GG }, list: "todo", text: `control ${stamp}` });
	out.controlSharedCreate = r2s(ctl);
	const c = await call(maya.page, MOD.lists, "createListItem", {
		tripId: T,
		target: { kind: "node", nodeId: GG },
		list: "todo",
		text,
		isPrivate: true,
		dueDate: "2026-09-24",
		dueTime: "09:00",
		dueTz: "Asia/Tokyo",
		url: "https://example.com/pay-here",
		assigneeIds: [IDS.MEMBER?.dennis, IDS.MEMBER?.audrey].filter(Boolean),
	});
	out.createPrivate = r2s(c);
	const id = c.ok ? (c.r as { id: string }).id : "";
	const flip = await call(maya.page, MOD.lists, "updateListItem", { id, patch: { isPrivate: false } });
	out.flipToShared = r2s(flip);
	// And a later edit of the now-shared row: is THAT a suggestion again?
	const later = await call(maya.page, MOD.lists, "updateListItem", { id, patch: { text: `${text} (edited)` } });
	out.laterEdit = r2s(later);
	await dennis.page.waitForTimeout(1500);
	const lists = await call(dennis.page, MOD.lists, "listTripListItems", { tripId: T });
	const row = lists.ok ? (lists.r as { id: string; text: string; isPrivate: boolean; assigneeIds?: string[]; url?: string | null }[]).find((x) => x.id === id) : null;
	out.dennisRow = row ? { text: row.text, isPrivate: row.isPrivate, assignees: row.assigneeIds?.length, url: row.url } : null;
	const inbox = await call(dennis.page, MOD.inbox, "listInbox", { tripId: T });
	out.dennisInboxHasIt = JSON.stringify(inbox).includes(stamp);
	const dl = await call(dennis.page, MOD.dashboard, "listMyDeadlines", {});
	out.dennisDeadlinesHasIt = JSON.stringify(dl).includes(stamp);
	const props = await call(dennis.page, MOD.proposals, "listProposals", { tripId: T });
	out.openProposalsAboutIt = (JSON.stringify(props).match(new RegExp(id, "g")) ?? []).length;
	const act = await call(dennis.page, MOD.graph, "listActivity", { tripId: T, limit: 40 });
	out.activityMentions = act.ok ? (act.r as { summary?: string }[]).filter((a) => JSON.stringify(a).includes(stamp) || JSON.stringify(a).includes(id)).map((a) => a.summary) : act.err;
	await dennis.page.goto(`/t/asia-2027/japan/tokyo/shinjuku/golden-gai?tab=lists&list=todo`);
	await expectLive(dennis.page);
	await dennis.page.waitForTimeout(2500);
	out.dennisPageShowsIt = (await dennis.page.locator("body").innerText()).includes(stamp);
	await dennis.page.screenshot({ path: path.join(DIR, "r3-bypass-dennis-lists.png") });
	await dennis.page.goto("/");
	await dennis.page.waitForTimeout(3000);
	out.dennisDashboardShowsIt = (await dennis.page.locator("body").innerText()).includes(stamp);
	await dennis.page.screenshot({ path: path.join(DIR, "r3-bypass-dennis-dashboard.png") });
	writeFileSync(path.join(DIR, "r3-bypass.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await maya.ctx.close();
	await dennis.ctx.close();
});
