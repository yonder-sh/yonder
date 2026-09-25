/**
 * QA security verifier (I2 round 2): live access changes on OPEN collab
 * sockets (SEC-03, SHARE-04/05). A member's note socket must turn read-only
 * the moment the owner lowers their role, and every socket (note + channel)
 * must be cut when they are removed. Uses the app's own CollabClient in the
 * page (real cookies, same-origin /collab) and a Yjs text field as the probe.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { call, MOD } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const DIR = process.env.QA_SEC_DIR ?? "/tmp";

async function userPage(browser: Browser, email: string, first: string, last: string) {
	const ctx = await browser.newContext();
	await loginViaApi(ctx.request, email, { first, last });
	const page = await ctx.newPage();
	await page.goto("/login");
	await page.waitForLoadState("domcontentloaded");
	return { ctx, page };
}

/** Opens a CollabClient lease on `name` in the page; keeps it on window.__qa[name]. */
async function openDoc(page: Page, name: string) {
	await page.evaluate(async (name) => {
		const w = window as unknown as { __qa?: Record<string, unknown>; __qaClient?: unknown; __qaStateless?: Record<string, string[]> };
		const m = await import(/* @vite-ignore */ "/src/lib/realtime/collab-client.ts");
		w.__qaClient ??= new m.CollabClient();
		w.__qa ??= {};
		w.__qaStateless ??= {};
		const lease = (w.__qaClient as { acquire(n: string): { onStateless(cb: (p: string) => void): void } }).acquire(name);
		w.__qaStateless[name] = [];
		lease.onStateless((p: string) => w.__qaStateless?.[name]?.push(p));
		w.__qa[name] = lease;
	}, name);
	await expect
		.poll(() => snap(page, name), { timeout: 20_000 })
		.toMatchObject({ status: "authenticated" });
}

const snap = (page: Page, name: string) =>
	page.evaluate((name) => {
		const l = (window as unknown as { __qa: Record<string, { getSnapshot(): unknown }> }).__qa[name];
		return JSON.parse(JSON.stringify(l.getSnapshot()));
	}, name);

const write = (page: Page, name: string, s: string) =>
	page.evaluate(
		({ name, s }) => {
			const l = (window as unknown as { __qa: Record<string, { doc: { getText(k: string): { insert(i: number, s: string): void; length: number } } }> }).__qa[name];
			const t = l.doc.getText("qa-probe");
			t.insert(t.length, ` ${s}`);
		},
		{ name, s },
	);

const read = (page: Page, name: string) =>
	page.evaluate((name) => {
		const l = (window as unknown as { __qa: Record<string, { doc: { getText(k: string): { toString(): string } } }> }).__qa[name];
		return l.doc.getText("qa-probe").toString();
	}, name);

const stateless = (page: Page, name: string) =>
	page.evaluate((name) => (window as unknown as { __qaStateless: Record<string, string[]> }).__qaStateless[name]?.length ?? 0, name);

test("role changes and removal take effect on open collab sockets", async ({ browser }) => {
	test.setTimeout(300_000);
	const out: Record<string, unknown> = {};
	const stamp = Date.now().toString(36);
	const owner = await userPage(browser, `qa-sec-r2-owner-${stamp}@example.com`, "Olga", "Owner");
	const c = await cloneFixtureTrip(owner.page.request, { mayaRole: "editor" });
	const maya = await userPage(browser, "maya@example.com", "Maya", "Chen");
	const nodeId = Object.values(c.ids.nodes)[0] as string;
	const note = `trip/${c.tripId}/node/${nodeId}`;
	const channel = `trip/${c.tripId}`;
	await openDoc(owner.page, note);
	await openDoc(maya.page, note);
	await openDoc(maya.page, channel);
	out.mayaInitial = await snap(maya.page, note);

	// Control: an editor's write reaches the owner.
	await write(maya.page, note, `EDITOR-${stamp}`);
	await expect.poll(() => read(owner.page, note), { timeout: 10_000 }).toContain(`EDITOR-${stamp}`);

	// 1. Owner lowers Maya to "Can suggest", then "Can view": her open socket must stop writing.
	for (const role of ["suggester", "viewer"] as const) {
		const r = await call(owner.page, MOD.sharing, "updateMemberRole", { memberId: c.members.maya, role });
		out[`set:${role}`] = r.ok ? "OK" : r.err;
		await maya.page.waitForTimeout(2500);
		out[`maya:${role}:snapshot`] = await snap(maya.page, note);
		await write(maya.page, note, `AS-${role.toUpperCase()}-${stamp}`);
		await owner.page.waitForTimeout(4000);
		out[`maya:${role}:writeReachedOwner`] = (await read(owner.page, note)).includes(`AS-${role.toUpperCase()}-${stamp}`);
	}
	// 2. A viewer still receives the owner's text (control for the removal step).
	await write(owner.page, note, `OWNER-1-${stamp}`);
	await expect.poll(() => read(maya.page, note), { timeout: 10_000 }).toContain(`OWNER-1-${stamp}`);

	// 3. Owner removes Maya: note + channel sockets must be cut, nothing more reaches her.
	const rm = await call(owner.page, MOD.sharing, "removeMember", { memberId: c.members.maya });
	out.remove = rm.ok ? "OK" : rm.err;
	await maya.page.waitForTimeout(3000);
	out.mayaAfterRemoveNote = await snap(maya.page, note);
	out.mayaAfterRemoveChannel = await snap(maya.page, channel);
	const eventsBefore = await stateless(maya.page, channel);
	await write(owner.page, note, `OWNER-2-${stamp}`);
	const it = await call(owner.page, MOD.items, "createItem", { tripId: c.tripId, dayId: null, title: `after-remove ${stamp}` });
	out.ownerCreateItem = it.ok ? "OK" : it.err;
	await maya.page.waitForTimeout(5000);
	out.mayaGotOwnerTextAfterRemove = (await read(maya.page, note)).includes(`OWNER-2-${stamp}`);
	out.mayaChannelEventsAfterRemove = (await stateless(maya.page, channel)) - eventsBefore;
	await write(maya.page, note, `REMOVED-WRITE-${stamp}`);
	await owner.page.waitForTimeout(4000);
	out.removedWriteReachedOwner = (await read(owner.page, note)).includes(`REMOVED-WRITE-${stamp}`);
	writeFileSync(path.join(DIR, "r2-collab.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));

	expect.soft(out["maya:suggester:writeReachedOwner"], "a suggester's write went through").toBe(false);
	expect.soft(out["maya:viewer:writeReachedOwner"], "a viewer's write went through").toBe(false);
	expect.soft(out.mayaGotOwnerTextAfterRemove, "a removed member still receives note updates").toBe(false);
	expect.soft(out.removedWriteReachedOwner, "a removed member still writes").toBe(false);
	await owner.ctx.close();
	await maya.ctx.close();
});
