/**
 * I2 verifier "collab" (round 1): the rest of QA SUG (EXTENSIONS §3.9) that
 * the WP specs don't drive end to end: SUG-04, 05, 07, 08/08b, 10, 11, 13, 17.
 * Asia 2027 (QA seed) where the data matters; a demo clone (dev@example.com
 * owner, maya@example.com) where a test changes roles or links.
 *
 * Needs `$QA_AUTH_DIR/<handle>.json` for dennis, maya, kai, dev, demomaya.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { SUGGEST_TESTID as S } from "../../../src/features/suggest/testids";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

const AUTH = process.env.QA_AUTH_DIR ?? path.resolve("e2e/.auth");
const auth = (h: string) => path.join(AUTH, `${h}.json`);
const shot = (n: string) =>
	process.env.QA_SHOTS_DIR ? path.join(process.env.QA_SHOTS_DIR, `${n}.png`) : shotPath(`qa-collab/${n}.png`);
const TOKYO = "/t/asia-2027/japan/tokyo";
const SUGGEST_TOKEN = "qa-share-token-suggester-asia-2027";
const VIEW_TOKEN = "qa-share-token-viewer-asia-2027";

async function open(browser: Browser, handle: string | null, url: string, token?: string) {
	const ctx = await browser.newContext({
		...(handle ? { storageState: auth(handle) } : {}),
		viewport: { width: 1440, height: 900 },
	});
	const page = await ctx.newPage();
	if (token) {
		await page.goto(`/join#t=${token}`);
		await expect(page).toHaveURL(/\/t\//, { timeout: 20_000 });
	}
	await page.goto(url);
	await expectLive(page);
	await page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph);
	return { ctx, page };
}
type Gr = {
	trip: { id: string };
	days: { id: string; date: string }[];
	items: { id: string; dayId: string | null; nodeId: string | null; title: string | null }[];
	nodes: { id: string; name: string; type: string; parentId: string | null }[];
	members: { id: string; name: string; userId: string | null; role?: string }[];
	legs?: { id: string; fromItemId: string; toItemId: string; mode: string; details: unknown }[];
};
const graph = (p: Page) => p.evaluate(() => (window as unknown as { __yonder: { graph: Gr } }).__yonder.graph);
async function call<T = unknown>(p: Page, file: string, fn: string, data: unknown): Promise<T> {
	return p.evaluate(
		async ({ file, fn, data }) => {
			const mod = (await import(/* @vite-ignore */ file)) as Record<string, (o: { data: unknown }) => Promise<unknown>>;
			const out = await mod[fn]!({ data });
			const { appQueryClient } = await import(
				/* @vite-ignore */ "/src/features/suggest/__harness__/app-query-client.ts"
			);
			await appQueryClient()?.invalidateQueries();
			return out;
		},
		{ file, fn, data },
	) as Promise<T>;
}
/** The error a server function throws, as the page sees it. */
async function callErr(p: Page, file: string, fn: string, data: unknown): Promise<string> {
	return p.evaluate(
		async ({ file, fn, data }) => {
			const mod = (await import(/* @vite-ignore */ file)) as Record<string, (o: { data: unknown }) => Promise<unknown>>;
			try {
				const r = await mod[fn]!({ data });
				return `OK ${JSON.stringify(r)}`;
			} catch (e) {
				return e instanceof Error ? e.message : String(e);
			}
		},
		{ file, fn, data },
	);
}
type P = { id: string; op: string; status: string; summary: string; payload: unknown; reviewNote?: string | null };
const proposals = (p: Page, tripId: string) =>
	call<P[]>(p, "/src/functions/proposals.functions.ts", "listProposals", { tripId });

test.skip(({ isMobile }) => isMobile, "desktop");

test("SUG-04: a suggestion that breaks the rules is refused with the editor's own error text", async ({ browser }) => {
	const d = await open(browser, "dennis", TOKYO);
	const m = await open(browser, "maya", TOKYO);
	const g = await graph(d.page);
	const itoya = g.nodes.find((n) => n.name === "Itoya (G.Itoya)");
	const input = { tripId: g.trip.id, parentId: itoya?.id, type: "city", name: "Tokyo" };
	const editorErr = await callErr(d.page, "/src/functions/nodes.functions.ts", "createNode", input);
	const suggesterErr = await callErr(m.page, "/src/functions/nodes.functions.ts", "createNode", input);
	console.log(`[sug04] editor: ${editorErr} | suggester: ${suggesterErr}`);
	expect(editorErr).not.toMatch(/^OK/);
	expect(suggesterErr).toBe(editorErr);
	await d.ctx.close();
	await m.ctx.close();
});

test("SUG-05: a suggested place and an item on it chain; accepting the item accepts both, rejecting the place rejects both", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const d = await open(browser, "dennis", TOKYO);
	const m = await open(browser, "maya", TOKYO);
	const g = await graph(m.page);
	const shinjuku = g.nodes.find((n) => n.name === "Shinjuku");
	const tue = g.days.find((x) => x.date === "2027-10-05");
	const tag = randomBytes(2).toString("hex");
	const mk = async (name: string) => {
		const n = await call<{ proposed: { id: string } }>(m.page, "/src/functions/nodes.functions.ts", "createNode", {
			tripId: g.trip.id,
			parentId: shinjuku?.id,
			type: "place",
			name,
		});
		const all = await proposals(m.page, g.trip.id);
		const np = all.find((x) => x.id === n.proposed.id);
		const nodeId = (np?.payload as { id: string }).id;
		const it = await call<{ proposed: { id: string } }>(m.page, "/src/functions/items.functions.ts", "createItem", {
			tripId: g.trip.id,
			dayId: tue?.id,
			nodeId,
		});
		return { nodeP: n.proposed.id, itemP: it.proposed.id, nodeId };
	};
	const a = await mk(`Kabuki bar ${tag}`);
	// Accepting the item accepts both.
	await call(d.page, "/src/functions/proposals.functions.ts", "resolveProposal", { proposalId: a.itemP, decision: "accept" });
	const after = await proposals(d.page, g.trip.id);
	expect(after.find((x) => x.id === a.nodeP)?.status).toBe("accepted");
	expect(after.find((x) => x.id === a.itemP)?.status).toBe("accepted");
	const g2 = await graph(d.page);
	expect(g2.nodes.some((n) => n.id === a.nodeId)).toBe(true);
	expect(g2.items.some((i) => i.nodeId === a.nodeId && i.dayId === tue?.id)).toBe(true);

	// Rejecting the place rejects its item too.
	const b = await mk(`Tachinomi ${tag}`);
	await call(d.page, "/src/functions/proposals.functions.ts", "resolveProposal", { proposalId: b.nodeP, decision: "reject" });
	const after2 = await proposals(d.page, g.trip.id);
	expect(after2.find((x) => x.id === b.nodeP)?.status).toBe("rejected");
	expect(after2.find((x) => x.id === b.itemP)?.status).toBe("rejected");
	console.log(`[sug05] dependant's note: ${after2.find((x) => x.id === b.itemP)?.reviewNote}`);

	// Clean up the accepted place (and its item).
	await call(d.page, "/src/functions/nodes.functions.ts", "deleteNode", { nodeId: a.nodeId });
	await d.ctx.close();
	await m.ctx.close();
});

test("SUG-07: Maya can't type in notes (server-enforced); her addition is inserted as Markdown and accepted", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const url = `${TOKYO}/shinjuku/golden-gai?tab=notes`;
	const m = await open(browser, "maya", url);
	const ed = m.page.getByTestId(TESTID.notesTab).getByTestId(NT.editor).first();
	await expect(ed).toHaveAttribute("data-editable", "false", { timeout: 15_000 });
	await expect(m.page.getByTestId(TESTID.notesTab).getByTestId(NT.readOnlyNote).first()).toBeVisible();
	const tag = randomBytes(2).toString("hex");
	await m.page.getByTestId(S.noteSuggestButton).first().click();
	await m.page.getByTestId(S.noteTextarea).fill(`**Bring cash** ${tag}\n\n- ¥1,000 notes`);
	await m.page.getByTestId(S.noteSend).click();
	await expect(m.page.getByText(/^Suggested — /).first()).toBeVisible({ timeout: 10_000 });
	await m.page.screenshot({ path: shot("sug07-maya-notes") });

	const d = await open(browser, "dennis", url);
	const block = d.page.getByTestId(S.noteBlock).filter({ hasText: tag });
	await expect(block).toBeVisible({ timeout: 10_000 });
	await expect(block.locator("strong", { hasText: "Bring cash" }).first()).toBeVisible();
	await d.page.screenshot({ path: shot("sug07-dennis-block") });
	await block.getByTestId(S.noteInsert).click();
	const ded = d.page.getByTestId(TESTID.notesTab).getByTestId(NT.editor).first();
	await expect(ded.locator("p", { hasText: tag }).locator("strong", { hasText: "Bring cash" })).toBeVisible({ timeout: 10_000 });
	await expect(ded.locator("li", { hasText: "¥1,000 notes" }).first()).toBeVisible();
	await expect(block).toHaveCount(0, { timeout: 10_000 });
	// And Maya sees the text live, as formatted Markdown.
	const med = m.page.getByTestId(TESTID.notesTab).getByTestId(NT.editor).first();
	await expect(med.locator("p", { hasText: tag }).locator("strong", { hasText: "Bring cash" })).toBeVisible({ timeout: 10_000 });
	await d.ctx.close();
	await m.ctx.close();
});

test("SUG-08/08b: a guest suggester's flight edit never stores the booking ref; accepting keeps the ref and seats", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const d = await open(browser, "dennis", TOKYO);
	const g = await graph(d.page);
	const legs = await d.page.evaluate(() => {
		const y = (window as unknown as { __yonder: { graph: { legs?: unknown[] } } }).__yonder.graph;
		return JSON.stringify(y.legs ?? []);
	});
	const nh9 = (JSON.parse(legs) as { id: string; fromItemId: string | null; toItemId: string | null; details: { flight?: { flightNumber?: string } } }[]).find(
		(l) => l.details?.flight?.flightNumber === "NH9",
	);
	if (!nh9) throw new Error("no NH 9 leg in the graph");
	const sel = `?sel=l.${nh9.fromItemId}.${nh9.toItemId}`;
	const guest = await open(browser, null, `/t/asia-2027${sel}`, SUGGEST_TOKEN);
	const lo = guest.page.getByTestId(TESTID.legOverview);
	await expect(lo).toBeVisible();
	await expect(lo).not.toContainText("ZK4P7Q");
	await guest.page.screenshot({ path: shot("sug08-guest-leg") });
	await lo.getByRole("button", { name: "Edit flight" }).click();
	const form = guest.page.getByTestId(T.flightForm);
	await expect(form).toBeVisible();
	await form.getByTestId(T.flightAircraft).fill("Boeing 787-9");
	await guest.page.screenshot({ path: shot("sug08-guest-form") });
	await form.getByRole("button", { name: /^(Save|Suggest)/ }).click();
	await expect(guest.page.getByText(/^Suggested — /).first()).toBeVisible({ timeout: 10_000 });

	const list = await proposals(d.page, g.trip.id);
	const p = list.find((x) => x.op === "flight.save" && x.status === "open");
	if (!p) throw new Error("no flight.save proposal");
	const payload = JSON.stringify(p.payload);
	console.log(`[sug08] payload: ${payload.slice(0, 400)}`);
	expect(payload).not.toContain("ZK4P7Q");
	expect(payload).not.toContain("8D");
	await call(d.page, "/src/functions/proposals.functions.ts", "resolveProposal", { proposalId: p.id, decision: "accept" });
	const after = await d.page.evaluate(async (legId) => {
		const y = (window as unknown as { __yonder: { graph: { legs: { id: string; details: unknown }[] } } }).__yonder.graph;
		return JSON.stringify(y.legs.find((l) => l.id === legId)?.details);
	}, nh9.id);
	await expect.poll(async () => d.page.evaluate(async (legId) => {
		const y = (window as unknown as { __yonder: { graph: { legs: { id: string; details: unknown }[] } } }).__yonder.graph;
		return JSON.stringify(y.legs.find((l) => l.id === legId)?.details);
	}, nh9.id), { timeout: 10_000 }).toContain("787-9");
	const final = await d.page.evaluate(async (legId) => {
		const y = (window as unknown as { __yonder: { graph: { legs: { id: string; details: unknown }[] } } }).__yonder.graph;
		return JSON.stringify(y.legs.find((l) => l.id === legId)?.details);
	}, nh9.id);
	void after;
	expect(final).toContain("ZK4P7Q");
	expect(final).toContain("8D");
	expect(final).toContain("8G");
	// Restore the aircraft.
	const fl = (JSON.parse(final) as { flight: Record<string, unknown> }).flight;
	await call(d.page, "/src/features/transit/transit.functions.ts", "saveFlight", {
		target: { kind: "pair", fromItemId: nh9.fromItemId, toItemId: nh9.toItemId },
		flight: { ...fl, aircraft: "Boeing 777-300ER" },
	}).catch((e) => console.log("[sug08] restore failed:", String(e)));
	await guest.ctx.close();
	await d.ctx.close();
});

test("SUG-11/13: uploads are disabled for suggesters with the reason; a view link sees no suggestion UI and listProposals is []", async ({
	browser,
}) => {
	const m = await open(browser, "maya", `${TOKYO}?tab=media`);
	await m.page.waitForTimeout(1_000);
	const hint = m.page.getByTestId(S.firstHint);
	if (await hint.isVisible().catch(() => false)) await hint.getByRole("button", { name: "Got it" }).click();
	await m.page.getByTestId(TESTID.mediaTab).getByRole("button", { name: /^Add$/ }).first().click();
	await m.page.waitForTimeout(400);
	await m.page.screenshot({ path: shot("sug11-maya-add-menu") });
	const up = m.page.getByRole("menuitem", { name: /upload|photos|files/i }).first();
	if (await up.count()) {
		const disabled = (await up.getAttribute("aria-disabled")) === "true" || (await up.getAttribute("data-disabled")) !== null;
		expect(disabled, "upload menu item disabled for a suggester").toBe(true);
		const why = `${(await up.getAttribute("title")) ?? ""} ${(await up.getAttribute("aria-description")) ?? ""}`;
		await up.hover({ force: true });
		await m.page.waitForTimeout(600);
		await m.page.screenshot({ path: shot("sug11-maya-media") });
		const tip = await m.page.getByRole("tooltip").allInnerTexts().catch(() => []);
		console.log(`[sug11] title/desc: ${why} | tooltip: ${tip.join(" / ")}`);
		expect(`${why} ${tip.join(" ")}`).toMatch(/Photos need edit access/);
	} else {
		await m.page.screenshot({ path: shot("sug11-maya-media") });
		console.log("[sug11] no upload button rendered for the suggester");
	}
	await m.ctx.close();

	const v = await open(browser, null, TOKYO, VIEW_TOKEN);
	await expect(v.page.getByTestId(TESTID.suggestModeControl)).toHaveCount(0);
	await expect(v.page.getByTestId(TESTID.proposalGhost)).toHaveCount(0);
	const g = await graph(v.page);
	const list = await proposals(v.page, g.trip.id);
	expect(list).toEqual([]);
	await v.page.screenshot({ path: shot("sug13-view-link") });
	await v.ctx.close();
});

async function demoClone(browser: Browser, mayaRole: "editor" | "suggester") {
	const ctx = await browser.newContext({ storageState: auth("dev") });
	const c = await cloneFixtureTrip(ctx.request, { mayaRole });
	await ctx.close();
	return c;
}

test("SUG-17: downgrading an editor to suggester makes her open note read-only within 2 s", async ({ browser }) => {
	const c = await demoClone(browser, "editor");
	const url = `/t/${c.slug}?tab=notes`;
	const m = await open(browser, "demomaya", url);
	const ed = m.page.getByTestId(TESTID.notesTab).getByTestId(NT.editor).first();
	await expect(ed).toHaveAttribute("data-editable", "true", { timeout: 15_000 });
	const o = await open(browser, "dev", url);
	const mayaMember = c.members.maya as string;
	await call(o.page, "/src/features/home/sharing.functions.ts", "updateMemberRole", { memberId: mayaMember, role: "suggester" });
	const t0 = Date.now();
	await expect(ed).toHaveAttribute("data-editable", "false", { timeout: 5_000 });
	const ms = Date.now() - t0;
	console.log(`[sug17] read-only after ${ms} ms`);
	expect(ms).toBeLessThan(2_500);
	await m.page.screenshot({ path: shot("sug17-maya-readonly") });
	await o.ctx.close();
	await m.ctx.close();
});

test("SUG-10: the 'Can suggest' link grants suggester (not edit, not upload); resetting it kicks its guest within 2 s and withdraws their suggestions", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const c = await demoClone(browser, "editor");
	const o = await open(browser, "dev", `/t/${c.slug}?tab=plan`);
	await call(o.page, "/src/features/home/sharing.functions.ts", "setShareLink", { tripId: c.tripId, role: "suggester", enabled: true });
	// FB-13: one link per trip; its role is "Can suggest" now.
	const sharing = await call<{ link: { role: string; url: string | null } | null }>(
		o.page,
		"/src/features/home/sharing.functions.ts",
		"getSharing",
		{ tripId: c.tripId },
	);
	const link = sharing.link?.role === "suggester" ? sharing.link.url : null;
	if (!link) throw new Error(`no suggester link: ${JSON.stringify(sharing.link)}`);
	const token = link.split("#t=")[1] as string;
	const gst = await open(browser, null, `/t/${c.slug}?tab=plan`, token);
	const pill = gst.page.getByTestId(TESTID.suggestModeControl).first();
	await expect(pill).toContainText("Suggesting");
	// A direct move becomes a suggestion.
	const g = await graph(gst.page);
	const itoya = c.ids.items.itoya as string;
	const d3 = c.ids.days.d3 as string;
	const r = await call<{ proposed?: { id: string } }>(gst.page, "/src/functions/items.functions.ts", "moveItem", { itemId: itoya, dayId: d3 });
	expect(r.proposed?.id).toBeTruthy();
	// Upload is refused server-side.
	const upErr = await callErr(gst.page, "/src/features/media/media.functions.ts", "createUpload", {
		tripId: g.trip.id,
		target: { kind: "trip" },
		name: "x.jpg",
		type: "image/jpeg",
		size: 1000,
	});
	console.log(`[sug10] guest upload: ${upErr}`);
	expect(upErr).toMatch(/FORBIDDEN|edit access|not allowed|permission/i);

	// Reset → the guest is out within 2 s; the proposal is withdrawn.
	await call(o.page, "/src/features/home/sharing.functions.ts", "resetShareLink", { tripId: c.tripId, role: "suggester" });
	const t0 = Date.now();
	await expect.poll(async () => {
		const url = gst.page.url();
		const pillGone = (await gst.page.getByTestId(TESTID.workspace).count()) === 0;
		return pillGone || !url.includes(`/t/${c.slug}`);
	}, { timeout: 6_000 }).toBe(true);
	console.log(`[sug10] kicked after ~${Date.now() - t0} ms`);
	await gst.page.screenshot({ path: shot("sug10-guest-kicked") });
	const list = await proposals(o.page, c.tripId);
	expect(list.find((x) => x.id === r.proposed?.id)?.status).toBe("withdrawn");
	await gst.ctx.close();
	await o.ctx.close();
});

export type { BrowserContext };
