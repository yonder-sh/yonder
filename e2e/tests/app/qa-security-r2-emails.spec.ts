/**
 * QA security verifier (I2 round 2): member emails are the owner's alone
 * (SPEC §11.3 `seeMemberEmails`). Every read an editor/viewer/suggester/guest
 * can make is scanned for other people's addresses, and the workspace's
 * network traffic and HTML too.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { call, EMAIL, guestPage, MOD, memberPage, T, TOKEN } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";

test("no one but the owner sees member emails", async ({ browser }) => {
	test.setTimeout(300_000);
	const out: Record<string, unknown> = {};
	for (const [who, own, open] of [
		["audrey", EMAIL.audrey, () => memberPage(browser, EMAIL.audrey)],
		["kai", EMAIL.kai, () => memberPage(browser, EMAIL.kai)],
		["maya", EMAIL.maya, () => memberPage(browser, EMAIL.maya)],
		["guestEditor", "", () => guestPage(browser, TOKEN.editor)],
	] as const) {
		const { ctx, page } = await open();
		const others = Object.values(EMAIL).filter((e) => e !== own && e !== EMAIL.eve);
		const found: Record<string, string[]> = {};
		for (const [label, mod, fn, data] of [
			["graph", MOD.graph, "getTripGraph", { tripId: T }],
			["sharing", MOD.sharing, "getSharing", { tripId: T }],
			["activity", MOD.graph, "listActivity", { tripId: T, limit: 200 }],
			["digest", MOD.activity, "getDigest", { tripId: T }],
			["money", MOD.money, "listMoney", { tripId: T }],
			["csv", MOD.money, "exportMoneyCsv", { tripId: T }],
			["proposals", MOD.proposals, "listProposals", { tripId: T }],
			["lists", MOD.lists, "listTripListItems", { tripId: T }],
			["media", MOD.media, "listTripMedia", { tripId: T }],
			["myTrips", MOD.dashboard, "listMyTrips", undefined],
			["inbox", MOD.inbox, "listInbox", { tripId: T }],
		] as const) {
			const r = await call(page, mod, fn, data);
			const s = JSON.stringify(r);
			const hits = others.filter((e) => s.includes(e));
			if (hits.length) found[label] = hits;
		}
		const bodies: string[] = [];
		page.on("response", async (res) => {
			const ct = res.headers()["content-type"] ?? "";
			if (/json|html|text/.test(ct) && !/\/(node_modules|@vite|@fs|src)\//.test(res.url())) bodies.push(await res.text().catch(() => ""));
		});
		await page.goto("/t/asia-2027?tab=plan");
		await page.waitForTimeout(5000);
		const all = bodies.join("\n");
		const netHits = others.filter((e) => all.includes(e));
		if (netHits.length) found.network = netHits;
		out[who] = found;
		await ctx.close();
	}
	writeFileSync(path.join(DIR, "r2-emails.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
});
