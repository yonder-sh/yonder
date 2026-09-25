/** Proposal ownership, private expenses and private budgets under direct API calls. */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { call, EMAIL, GG, guestPage, MEMBER, MOD, memberPage, PRIVATE_EXPENSE, T, TOKEN } from "./qa-security-helpers";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const MAYA_PROPOSAL = "01a0cf14-005c-76a8-b2fa-43caa088a8c6"; // Akihabara 4h → 3h
const r2s = (r: Awaited<ReturnType<typeof call>>) => (r.ok ? `OK ${JSON.stringify(r.r).slice(0, 80)}` : r.err.slice(0, 90));

test("ownership rules under direct calls", async ({ browser }) => {
	test.setTimeout(240_000);
	const out: Record<string, string> = {};
	const dennis = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	// Dennis: a private personal budget of 123456 (minor units).
	out["dennis:setBudgetLine(own)"] = r2s(await call(dennis.page, MOD.money, "setBudgetLine", { tripId: T, nodeId: null, category: null, memberId: MEMBER.dennis, amountMinor: 123456, kind: "total" }));
	out["dennis:setBudgetPrivate"] = r2s(await call(dennis.page, MOD.money, "setBudgetPrivate", { tripId: T, private: true }));

	const audrey = await memberPage(browser, EMAIL.audrey);
	out["audrey:withdraw(maya's)"] = r2s(await call(audrey.page, MOD.proposals, "withdrawProposal", { proposalId: MAYA_PROPOSAL }));
	out["audrey:updateExpense(dennis private)"] = r2s(await call(audrey.page, MOD.money, "updateExpense", { id: PRIVATE_EXPENSE, patch: { title: "hijack" } }));
	out["audrey:deleteExpense(dennis private)"] = r2s(await call(audrey.page, MOD.money, "deleteExpense", { id: PRIVATE_EXPENSE }));
	out["audrey:markExpensePaid(dennis private)"] = r2s(await call(audrey.page, MOD.money, "markExpensePaid", { id: PRIVATE_EXPENSE }));
	out["audrey:refundOf(dennis private)"] = r2s(await call(audrey.page, MOD.money, "createExpense", { tripId: T, target: { kind: "trip" }, title: "refund", amountMinor: -100, currency: "USD", refundOfId: PRIVATE_EXPENSE }));
	out["audrey:receipt on dennis private"] = r2s(await call(audrey.page, MOD.media, "createUpload", { tripId: T, target: { kind: "expense", expenseId: PRIVATE_EXPENSE }, type: "image/jpeg", size: 100, name: "r.jpg" }));
	out["audrey:setBudgetLine(for maya)"] = r2s(await call(audrey.page, MOD.money, "setBudgetLine", { tripId: T, nodeId: null, category: null, memberId: MEMBER.maya, amountMinor: 1, kind: "total" }));
	const money = await call(audrey.page, MOD.money, "listMoney", { tripId: T });
	out["audrey:sees dennis private budget amount"] = String(JSON.stringify(money).includes("123456"));
	await audrey.ctx.close();

	const maya = await memberPage(browser, EMAIL.maya);
	out["maya:setBudgetLine(trip default)"] = r2s(await call(maya.page, MOD.money, "setBudgetLine", { tripId: T, nodeId: null, category: null, memberId: null, amountMinor: 1, kind: "total" }));
	out["maya:resolve(own)"] = r2s(await call(maya.page, MOD.proposals, "resolveProposal", { proposalId: MAYA_PROPOSAL, decision: "accept" }));
	await maya.ctx.close();
	const kai = await memberPage(browser, EMAIL.kai);
	out["kai:resolve"] = r2s(await call(kai.page, MOD.proposals, "resolveProposal", { proposalId: MAYA_PROPOSAL, decision: "reject" }));
	out["kai:createSettlement"] = r2s(await call(kai.page, MOD.money, "createSettlement", { tripId: T, fromMemberId: MEMBER.audrey, toMemberId: MEMBER.dennis, amountMinor: 100, currency: "USD", settledAt: "2026-09-23T10:00:00Z", settledTz: "UTC" }));
	await kai.ctx.close();
	const gs = await guestPage(browser, TOKEN.suggester);
	out["guestSuggester:resolve"] = r2s(await call(gs.page, MOD.proposals, "resolveProposal", { proposalId: MAYA_PROPOSAL, decision: "reject" }));
	out["guestSuggester:withdraw(maya's)"] = r2s(await call(gs.page, MOD.proposals, "withdrawProposal", { proposalId: MAYA_PROPOSAL }));
	out["guestSuggester:x-yonder-mode edit→updateNode"] = r2s(await call(gs.page, MOD.nodes, "updateNode", { nodeId: GG, patch: { description: "direct?" } }, { "x-yonder-mode": "edit" }));
	await gs.ctx.close();
	out["dennis:setBudgetPrivate(off)"] = r2s(await call(dennis.page, MOD.money, "setBudgetPrivate", { tripId: T, private: false }));
	writeFileSync(path.join(process.env.QA_SEC_DIR ?? "/tmp", "misc.json"), JSON.stringify(out, null, 1));
	await dennis.ctx.close();
});
