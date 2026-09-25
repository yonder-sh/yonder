/**
 * QA security verifier (I2 round 1): SEC-04. An editor (Audrey) and a guest
 * editor store script payloads in every free-text field they can reach; the
 * owner (Dennis) then walks the views that render them. Nothing may run
 * (`window.__xss` stays unset, no dialog), `javascript:` links never become
 * clickable, and the SSR HTML carries no live markup.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { call, EMAIL, GG, guestPage, IDS, MEMBER, MOD, memberPage, T, TOKEN } from "./qa-security-helpers";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const DAY3: string = IDS.DAY3 ?? "01a0cf13-e767-7497-89b7-5bb1612dc071";
const TOKYO: string = IDS.TOKYO ?? "01a0cf13-e763-7519-9ffa-a1ac2e9cc1d3";
const TAG = `X${Date.now().toString(36)}`;
const IMG = `<img src=x onerror="window.__xss=(window.__xss||0)+1;alert('img')">`;
const SCRIPT = `<script>window.__xss=(window.__xss||0)+10;alert('script')</script>`;
const JSLINK = `[${TAG}-jslink](javascript:window.__xss=100;alert('link'))`;
const SVG = `<svg onload="window.__xss=1000;alert('svg')"></svg>`;
const IFRAME = `<iframe src="javascript:alert('iframe')"></iframe>`;
const ALL = `${TAG} ${IMG} ${SCRIPT} ${JSLINK} ${SVG} ${IFRAME}`;

async function arm(page: Page, dialogs: string[]) {
	page.on("dialog", async (d) => {
		dialogs.push(`${d.type()}:${d.message()}`);
		await d.dismiss().catch(() => undefined);
	});
}

async function xssState(page: Page) {
	return page.evaluate(() => ({
		xss: (window as unknown as { __xss?: number }).__xss ?? 0,
		jsHrefs: [...document.querySelectorAll("a[href]")].filter((a) => /^\s*(javascript|data|vbscript):/i.test(a.getAttribute("href") ?? "")).length,
		liveImgs: [...document.querySelectorAll("img[onerror], svg[onload], iframe[src^='javascript']")].length,
		scripts: [...document.querySelectorAll("script")].filter((s) => s.textContent?.includes("__xss")).length,
	}));
}

test("stored script payloads never run", async ({ browser }) => {
	test.setTimeout(600_000);
	const out: Record<string, unknown> = { tag: TAG };

	// ---- Audrey (editor) stores the payloads -------------------------------
	const audrey = await memberPage(browser, EMAIL.audrey);
	const w: Record<string, string> = {};
	const put = async (label: string, mod: string, fn: string, data: unknown) => {
		const r = await call(audrey.page, mod, fn, data);
		w[label] = r.ok ? "OK" : r.err.slice(0, 100);
		return r;
	};
	const node = await put("createNode", MOD.nodes, "createNode", {
		tripId: T, parentId: TOKYO, type: "place", name: `${TAG} ${IMG}`.slice(0, 200), description: `${JSLINK} ${IMG}`.slice(0, 500),
		details: { website: "https://example.com/ok" },
	});
	const nodeId = node.ok ? (node.r as { id: string }).id : null;
	await put("createItem", MOD.items, "createItem", { tripId: T, dayId: DAY3, title: `${TAG} ${SVG}`.slice(0, 200), note: ALL, durationMin: 30 });
	if (nodeId) await put("createItem(node)", MOD.items, "createItem", { tripId: T, dayId: DAY3, nodeId, durationMin: 30 });
	await put("createListItem(todo)", MOD.lists, "createListItem", { tripId: T, target: { kind: "node", nodeId: GG }, list: "todo", text: `${TAG} ${IMG}`.slice(0, 500), note: ALL });
	await put("createListItem(shopping)", MOD.lists, "createListItem", { tripId: T, target: { kind: "node", nodeId: GG }, list: "shopping", text: `${TAG} ${SCRIPT}`.slice(0, 500), url: "https://example.com/shop" });
	await put("addLink", MOD.media, "addLink", { tripId: T, target: { kind: "node", nodeId: GG }, url: `https://example.com/${TAG}?q=%3Cscript%3E`, caption: ALL });
	await put("setNodePriority(comment)", MOD.nodes, "setNodePriority", { nodeId: GG, memberId: MEMBER.audrey, priority: "must", comment: `${TAG} ${IMG} ${JSLINK}`.slice(0, 280) });
	await put("createExpense", MOD.money, "createExpense", { tripId: T, target: { kind: "node", nodeId: GG }, title: `${TAG} ${IMG}`.slice(0, 120), amountMinor: 1000, currency: "JPY", note: ALL.slice(0, 2000) });
	await put("addPlaceholder", MOD.sharing, "addPlaceholder", { tripId: T, displayName: `${TAG}<img src=x onerror=alert(9)>`.slice(0, 60) });
	await put("proposeNoteAppend(suggest mode)", MOD.suggest, "proposeNoteAppend", { tripId: T, target: { kind: "node", nodeId: GG }, markdown: ALL });
	await put("updateDay(title)", MOD.days, "updateDay", { dayId: DAY3, title: `${TAG} ${IMG}`.slice(0, 120) });
	out.writes = w;
	await audrey.ctx.close();

	// ---- A guest editor renames themselves with a payload ------------------
	const g = await guestPage(browser, TOKEN.editor);
	const rn = await call(g.page, MOD.share, "renameGuest", { name: `<img src=x onerror=alert(8)>${TAG}` });
	out.renameGuest = rn.ok ? rn.r : rn.err;
	// Stay connected (presence) while Dennis looks.
	await g.page.goto("/t/asia-2027?tab=plan");

	// ---- Dennis walks the views --------------------------------------------
	const dennis = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	const dialogs: string[] = [];
	await arm(dennis.page, dialogs);
	const views: [string, string][] = [
		["plan-day3", "/t/asia-2027/japan/tokyo?day=2027-10-04"],
		["tokyo", "/t/asia-2027/japan/tokyo"],
		["golden-gai", `/t/asia-2027/japan/tokyo/shinjuku/golden-gai`],
		["rate", "/t/asia-2027/rate"],
		["root", "/t/asia-2027"],
	];
	const states: Record<string, unknown> = {};
	for (const [name, url] of views) {
		await dennis.page.goto(url);
		await dennis.page.waitForTimeout(3500);
		for (const tab of ["Plan", "Media", "Lists", "Notes", "Money", "Overview"]) {
			const t = dennis.page.getByRole("tab", { name: new RegExp(`^${tab}`) }).first();
			if (await t.isVisible().catch(() => false)) {
				await t.click().catch(() => undefined);
				await dennis.page.waitForTimeout(1200);
				states[`${name}:${tab}`] = await xssState(dennis.page);
			}
		}
		states[name] = await xssState(dennis.page);
		await dennis.page.screenshot({ path: path.join(DIR, `xss-${name}.png`) });
	}
	// Click every rendered payload link (a javascript: href must not survive).
	const links = dennis.page.getByText(`${TAG}-jslink`);
	out.jslinkCount = await links.count();
	for (let i = 0; i < Math.min(await links.count(), 3); i++) await links.nth(i).click({ force: true }).catch(() => undefined);
	await dennis.page.waitForTimeout(1000);
	out.afterClicks = await xssState(dennis.page);
	// SSR HTML.
	const html = await (await dennis.page.request.get("/t/asia-2027/japan/tokyo")).text();
	out.ssr = {
		rawImg: html.includes(`onerror="window.__xss`),
		rawScript: html.includes(`<script>window.__xss`),
	};
	out.states = states;
	out.dialogs = dialogs;
	writeFileSync(path.join(DIR, "xss.json"), JSON.stringify(out, null, 1));
	expect(dialogs).toEqual([]);
	await g.ctx.close();
	await dennis.ctx.close();
});
