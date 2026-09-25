/**
 * I2 verifier "collab" (round 1): the one-line digest and the one inbox on the
 * QA seed's Asia 2027 (EXTENSIONS §9 QA DIG, ADDENDUM §10).
 *
 * Needs the QA seed and `$QA_AUTH_DIR/<handle>.json` storageStates.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { SHELL_TESTID as SH } from "../../../src/features/shell/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath } from "./_helpers/env";
import { collectConsole, expectLive } from "./_helpers/page";
import { openLink } from "./_helpers/link";

const AUTH = process.env.QA_AUTH_DIR ?? path.resolve("e2e/.auth");
const auth = (h: string) => path.join(AUTH, `${h}.json`);
const shot = (n: string) =>
	process.env.QA_SHOTS_DIR ? path.join(process.env.QA_SHOTS_DIR, `${n}.png`) : shotPath(`qa-collab/${n}.png`);
const TOKYO = "/t/asia-2027/japan/tokyo";

async function open(browser: Browser, handle: string, url: string) {
	const ctx = await browser.newContext({ storageState: auth(handle), viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await page.goto(url);
	await expectLive(page);
	await page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph);
	return { ctx, page };
}

type Gr = {
	trip: { id: string };
	nodes: { id: string; name: string; type: string }[];
	members: { id: string; name: string; userId: string | null }[];
};
const graph = (p: Page) => p.evaluate(() => (window as unknown as { __yonder: { graph: Gr } }).__yonder.graph);

async function call<T = unknown>(p: Page, file: string, fn: string, data: unknown): Promise<T> {
	return p.evaluate(
		async ({ file, fn, data }) => {
			const mod = (await import(/* @vite-ignore */ file)) as Record<string, (o: { data: unknown }) => Promise<unknown>>;
			return mod[fn]!({ data });
		},
		{ file, fn, data },
	) as Promise<T>;
}

const banner = (p: Page) => p.getByTestId(SH.digestBanner);
async function bannerText(p: Page): Promise<string | null> {
	return (await banner(p).count()) ? (await banner(p).innerText()).replace(/\s+/g, " ").trim() : null;
}
async function clearDigest(p: Page) {
	await p.reload();
	await expectLive(p);
	await p.waitForTimeout(1_500);
	if (await banner(p).count()) {
		await p.getByTestId(SH.digestGotIt).click();
		await expect(banner(p)).toHaveCount(0);
	}
}

test.skip(({ isMobile }) => isMobile, "desktop");

test("DIG-01/02/03/06: other people's changes are one line on the next open, never mid-session; Got it sticks; my own never count", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const d = await open(browser, "dennis", TOKYO);
	const logs = collectConsole(d.page);
	await clearDigest(d.page);
	const before = await bannerText(d.page);
	expect(before).toBeNull();

	// Audrey adds 3 Kyoto places while Dennis is looking.
	const a = await open(browser, "audrey", TOKYO);
	const g = await graph(a.page);
	const kyoto = g.nodes.find((n) => n.name === "Kyoto" && n.type === "city");
	if (!kyoto) throw new Error("no Kyoto");
	const tag = randomBytes(2).toString("hex");
	const made: string[] = [];
	for (const name of [`Fushimi test ${tag}`, `Nishiki test ${tag}`, `Kinkaku test ${tag}`]) {
		const r = await call<{ nodeId: string }>(a.page, "/src/functions/nodes.functions.ts", "createNode", {
			tripId: g.trip.id,
			parentId: kyoto.id,
			type: "place",
			name,
		});
		made.push(r.nodeId);
	}
	// DIG-06: the open session's banner doesn't appear or grow.
	await d.page.waitForTimeout(4_000);
	expect(await bannerText(d.page), "banner mid-session").toBeNull();
	await d.page.screenshot({ path: shot("dig06-dennis-mid-session") });

	// DIG-01: next open → one line.
	await d.page.reload();
	await expectLive(d.page);
	await expect(banner(d.page)).toBeVisible({ timeout: 5_000 });
	const line = (await bannerText(d.page)) ?? "";
	expect(line).toMatch(/^3 changes since you last looked Got it$/);
	await d.page.screenshot({ path: shot("dig01-dennis-banner") });
	// The line links to the activity view.
	await banner(d.page).getByRole("button", { name: /changes since you last looked/ }).click();
	const act = d.page.getByTestId(SH.activityDialog);
	await expect(act).toBeVisible();
	await expect(act).toContainText(`Nishiki test ${tag}`);
	await d.page.screenshot({ path: shot("dig01-activity") });
	await d.page.keyboard.press("Escape");

	// DIG-02: Got it clears it across reloads.
	await d.page.getByTestId(SH.digestGotIt).click();
	await expect(banner(d.page)).toHaveCount(0);
	await d.page.reload();
	await expectLive(d.page);
	await d.page.waitForTimeout(2_000);
	expect(await bannerText(d.page)).toBeNull();

	// DIG-03: Dennis's own changes never count (he deletes Audrey's three).
	expect(made.every(Boolean)).toBe(true);
	for (const id of made) await call(d.page, "/src/functions/nodes.functions.ts", "deleteNode", { nodeId: id });
	await d.page.reload();
	await expectLive(d.page);
	await d.page.waitForTimeout(2_000);
	expect(await bannerText(d.page)).toBeNull();
	expect(logs.messages).toEqual([]);
	await a.ctx.close();
	await d.ctx.close();
});

test("DIG-08/09: a mention, a suggestion to review and a rejected suggestion reach ONE bell; opening marks read everywhere; a private item's mention never does", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const d = await open(browser, "dennis", TOKYO);
	const a = await open(browser, "audrey", TOKYO);
	const m = await open(browser, "maya", TOKYO);
	const g = await graph(a.page);
	const dennisMember = g.members.find((x) => x.name.startsWith("Dennis"));
	const gg = g.nodes.find((n) => n.name === "Golden Gai");
	if (!dennisMember || !gg) throw new Error("fixture");
	const tag = randomBytes(2).toString("hex");
	const bell = (p: Page) => p.getByTestId(TESTID.inboxBell).first();
	const unread = async (p: Page) => Number((await bell(p).getAttribute("data-unread")) ?? 0);
	const u0 = await unread(d.page);

	// Audrey: a shared to-do mentioning Dennis, and a PRIVATE one that also mentions him.
	const tok = `[@Dennis Tester](mention:${dennisMember.id})`;
	await call(a.page, "/src/features/lists/lists.functions.ts", "createListItem", {
		tripId: g.trip.id,
		target: { kind: "node", nodeId: gg.id },
		list: "todo",
		text: `Ask ${tok} about the cover charge ${tag}`,
	});
	await call(a.page, "/src/features/lists/lists.functions.ts", "createListItem", {
		tripId: g.trip.id,
		target: { kind: "node", nodeId: gg.id },
		list: "todo",
		text: `Gift for ${tok} secret ${tag}`,
		isPrivate: true,
	});
	// Maya suggests a change → a review item for Dennis.
	const rn = await call<{ proposed?: { id: string } }>(m.page, "/src/functions/nodes.functions.ts", "updateNode", {
		nodeId: gg.id,
		patch: { description: `Maya's idea ${tag}` },
	});
	expect(rn.proposed?.id, "Maya's edit became a suggestion").toBeTruthy();

	await expect.poll(() => unread(d.page), { timeout: 20_000 }).toBeGreaterThan(u0);
	await bell(d.page).click();
	const panel = d.page.getByTestId(SH.inboxPanel);
	await expect(panel).toBeVisible();
	await expect(panel.getByTestId(SH.inboxRow).filter({ hasText: `cover charge ${tag}` })).toBeVisible({ timeout: 10_000 });
	await expect(panel.getByTestId(SH.inboxRow).filter({ hasText: /suggestions? to review/ })).toBeVisible();
	await expect(panel.getByTestId(SH.inboxRow).filter({ hasText: `secret ${tag}` })).toHaveCount(0);
	await d.page.screenshot({ path: shot("dig08-dennis-bell") });

	// DIG-09 at the source: no mention row, no inbox item for the private one — also via the API.
	const feed = await call<{ items: { key: string; kind: string; text?: string; title?: string }[] }>(
		d.page,
		"/src/functions/inbox.functions.ts",
		"listInbox",
		{},
	);
	expect(JSON.stringify(feed)).not.toContain(`secret ${tag}`);

	// Opening the mention marks it read; the dashboard agrees.
	const u1 = await unread(d.page);
	await panel.getByTestId(SH.inboxRow).filter({ hasText: `cover charge ${tag}` }).click();
	await expect.poll(() => unread(d.page), { timeout: 10_000 }).toBe(u1 - 1);
	await d.page.screenshot({ path: shot("dig08-dennis-after-open") });
	const feed2 = await call<{ items: { key: string; read?: boolean; readAt?: string | null; text?: string }[]; unread: number }>(
		d.page,
		"/src/functions/inbox.functions.ts",
		"listInbox",
		{},
	);
	expect(feed2.unread).toBe(u1 - 1);

	// Dennis rejects Maya's suggestion with a note → Maya's bell has the result, with the note.
	await call(d.page, "/src/functions/proposals.functions.ts", "resolveProposal", {
		proposalId: rn.proposed?.id,
		decision: "reject",
		note: `not now ${tag}`,
	});
	await expect.poll(async () => {
		const f = await call<{ items: unknown[] }>(m.page, "/src/functions/inbox.functions.ts", "listInbox", {});
		return JSON.stringify(f).includes(`not now ${tag}`);
	}, { timeout: 15_000 }).toBe(true);
	await bell(m.page).click();
	await expect(m.page.getByTestId(SH.inboxPanel).getByTestId(SH.inboxRow).filter({ hasText: `not now ${tag}` })).toBeVisible();
	await m.page.screenshot({ path: shot("dig08-maya-bell") });

	// The dashboard's card for Dennis: no more unread mention dot from this one.
	await d.page.goto("/dashboard");
	await d.page.waitForTimeout(2_000);
	await d.page.screenshot({ path: shot("dig04-dashboard") });

	await a.ctx.close();
	await m.ctx.close();
	await d.ctx.close();
});

test("DIG-05: a link guest's digest never counts money changes; guests have no bell", async ({ browser }) => {
	test.setTimeout(120_000);
	const gctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const gp = await gctx.newPage();
	await openLink(gp, "asia-2027", "editor");
	await expect(gp).toHaveURL(/\/t\/asia-2027/, { timeout: 20_000 });
	await expectLive(gp);
	const g0 = await graph(gp);
	// The guest's first digest call records "seen now".
	await call(gp, "/src/functions/activity.functions.ts", "getDigest", { tripId: g0.trip.id });
	await expect(gp.getByTestId(TESTID.inboxBell)).toHaveCount(0);

	const d = await open(browser, "dennis", TOKYO);
	const tag = randomBytes(2).toString("hex");
	const exp = await call<{ id: string }>(d.page, "/src/features/money/money.functions.ts", "createExpense", {
		tripId: g0.trip.id,
		target: { kind: "trip" },
		title: `Taxi ${tag}`,
		amountMinor: 3000,
		currency: "JPY",
	});
	const kyoto = (await graph(d.page)).nodes.find((n) => n.name === "Kyoto");
	const made = await call<{ nodeId: string }>(d.page, "/src/functions/nodes.functions.ts", "createNode", {
		tripId: g0.trip.id,
		parentId: kyoto?.id,
		type: "place",
		name: `Digest probe ${tag}`,
	});

	const dig = await call<{ rows: { verb: string; summary: string }[] }>(gp, "/src/functions/activity.functions.ts", "getDigest", {
		tripId: g0.trip.id,
	});
	const verbs = dig.rows.map((r) => r.verb);
	console.log(`[dig05] guest digest verbs: ${verbs.join(",")}`);
	expect(verbs.some((v) => v.startsWith("expense."))).toBe(false);
	expect(JSON.stringify(dig)).not.toContain(`Taxi ${tag}`);
	expect(dig.rows.length).toBeGreaterThanOrEqual(1);
	// Dennis's dashboard count vs a member's digest (DIG-04) is exercised in the J-journeys; here: clean up.
	await call(d.page, "/src/features/money/money.functions.ts", "deleteExpense", { id: exp.id }).catch((e) =>
		console.log("[dig05] delete expense:", String(e)),
	);
	await call(d.page, "/src/functions/nodes.functions.ts", "deleteNode", { nodeId: made.nodeId });
	await gctx.close();
	await d.ctx.close();
});
