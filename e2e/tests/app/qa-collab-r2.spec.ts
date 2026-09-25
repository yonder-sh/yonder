/**
 * I2 verifier "collab" (round 2): what round 1 didn't drive end to end, on the
 * QA seed's Asia 2027 (EXTENSIONS §3.9 SUG, §4 HRS, §5 SHIFT, §6 SUN/CLIM,
 * §9 DIG + one inbox; qa/SCENARIOS RT).
 *
 * Needs the QA seed and `$QA_AUTH_DIR/<handle>.json` storageStates for
 * dennis, audrey, maya, kai. Every test puts the trip back the way it found it.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { INSIGHTS_TESTID as I } from "../../../src/features/insights/testids";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { PLAN_TESTID as P } from "../../../src/features/plan/testids";
import { SHELL_TESTID as SH } from "../../../src/features/shell/testids";
import { SUGGEST_TESTID as S } from "../../../src/features/suggest/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath } from "./_helpers/env";
import { expectLive } from "./_helpers/page";

const AUTH = process.env.QA_AUTH_DIR ?? path.resolve("e2e/.auth");
const auth = (h: string) => path.join(AUTH, `${h}.json`);
const shot = (n: string) =>
	process.env.QA_SHOTS_DIR ? path.join(process.env.QA_SHOTS_DIR, `${n}.png`) : shotPath(`qa-collab/${n}.png`);
const TOKYO = "/t/asia-2027/japan/tokyo";
const SUGGEST_TOKEN = "qa-share-token-suggester-asia-2027";

async function open(
	browser: Browser,
	handle: string | null,
	url: string,
	opts: { token?: string; viewport?: { width: number; height: number }; mobile?: boolean } = {},
) {
	const ctx = await browser.newContext({
		...(handle ? { storageState: auth(handle) } : {}),
		viewport: opts.viewport ?? { width: 1440, height: 900 },
		...(opts.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2.625 } : {}),
	});
	const page = await ctx.newPage();
	if (opts.token) {
		await page.goto(`/join#t=${opts.token}`);
		await expect(page).toHaveURL(/\/t\//, { timeout: 20_000 });
	}
	await page.goto(url);
	await expectLive(page);
	await page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph);
	return { ctx, page };
}

type Gr = {
	trip: { id: string; startDate: string; endDate: string; version?: number };
	me: { role: string; isGuest: boolean; userId: string | null; memberId?: string | null };
	days: { id: string; date: string }[];
	items: { id: string; dayId: string | null; nodeId: string | null; title: string | null; durationMin: number }[];
	nodes: { id: string; name: string; type: string; parentId: string | null; details?: Record<string, unknown> }[];
	members: { id: string; name: string; userId: string | null; role?: string }[];
};
const graph = (p: Page) => p.evaluate(() => (window as unknown as { __yonder: { graph: Gr } }).__yonder.graph);

/** Calls a server function in the page (same module the app uses) and refreshes the app's queries. */
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
/** The error message a server function throws (or `OK <json>`). */
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
/** Puts this tab in (or out of) suggest mode for server calls, like the UI does. */
const suggestMode = (p: Page, tripId: string, on: boolean) =>
	p.evaluate(
		async ({ tripId, on }) => {
			const m = (await import(/* @vite-ignore */ "/src/lib/workspace/suggest-mode.ts")) as {
				setSuggestMode: (t: string | null, s: boolean) => void;
			};
			m.setSuggestMode(tripId, on);
		},
		{ tripId, on },
	);

type Prop = {
	id: string;
	op: string;
	status: string;
	summary: string;
	payload: Record<string, unknown>;
	reviewNote?: string | null;
	lastError?: { reason: string } | null;
	authorName: string;
};
const proposals = async (p: Page, tripId: string) => {
	const out = await call<Prop[] | { proposals: Prop[] }>(p, "/src/functions/proposals.functions.ts", "listProposals", {
		tripId,
	});
	return Array.isArray(out) ? out : out.proposals;
};

async function itemNamed(p: Page, name: string) {
	const g = await graph(p);
	const node = g.nodes.find((n) => n.name === name);
	const it = g.items.find((i) => i.dayId && (i.title === name || (node && i.nodeId === node.id)));
	if (!it) throw new Error(`no item ${name}`);
	return { ...it, date: g.days.find((d) => d.id === it.dayId)?.date ?? null };
}
const dayOf = async (p: Page, date: string) => {
	const d = (await graph(p)).days.find((x) => x.date === date);
	if (!d) throw new Error(`no day ${date}`);
	return d.id;
};
const card = (p: Page, id: string) => p.locator(`[data-testid="${TESTID.timelineItem}"][data-item-id="${id}"]`).first();

/** Withdraws the caller's open suggestions whose summary matches (leftovers of an earlier run). */
async function withdrawMine(p: Page, tripId: string, re: RegExp) {
	for (const x of await proposals(p, tripId))
		if (x.status === "open" && re.test(x.summary))
			await callErr(p, "/src/functions/proposals.functions.ts", "withdrawProposal", { proposalId: x.id });
}
/** A screenshot that never blocks a test (three WebGL maps in one browser can stall the capture). */
const snap = (p: Page, n: string) => p.screenshot({ path: shot(n), timeout: 20_000 }).catch((e) => console.log(`[shot] ${n}: ${e}`));

async function dismissHint(page: Page) {
	const hint = page.getByTestId(S.firstHint);
	if (await hint.isVisible().catch(() => false)) await hint.getByRole("button", { name: "Got it" }).click();
}

test.skip(({ isMobile }) => isMobile, "desktop; the phone checks open their own contexts");

test("SUG-16 + SUG-03: Maya and Audrey suggest different days for one item; the bar lists both; accepting Audrey's puts Maya's under Conflicts; Accept anyway applies it", async ({
	browser,
}) => {
	test.setTimeout(180_000);
	const d = await open(browser, "dennis", `${TOKYO}?days=2027-10-04..2027-10-06`);
	const m = await open(browser, "maya", TOKYO);
	const a = await open(browser, "audrey", TOKYO);
	const g = await graph(d.page);
	const it = await itemNamed(d.page, "Nakano Broadway");
	expect(it.date).toBe("2027-10-05");
	const d4 = await dayOf(d.page, "2027-10-04");
	const d5 = await dayOf(d.page, "2027-10-05");
	const d6 = await dayOf(d.page, "2027-10-06");
	await withdrawMine(m.page, g.trip.id, /Nakano Broadway/);
	await withdrawMine(a.page, g.trip.id, /Nakano Broadway/);
	try {
		// Maya → Wed 6 Oct (she is a suggester: it becomes a proposal).
		const rm = await call<{ proposed?: { id: string } }>(m.page, "/src/functions/items.functions.ts", "moveItem", {
			itemId: it.id,
			dayId: d6,
		});
		expect(rm.proposed?.id).toBeTruthy();
		// Audrey, an editor in Suggesting mode → Mon 4 Oct.
		await suggestMode(a.page, g.trip.id, true);
		const ra = await call<{ proposed?: { id: string } }>(a.page, "/src/functions/items.functions.ts", "moveItem", {
			itemId: it.id,
			dayId: d4,
		});
		expect(ra.proposed?.id, "Audrey's move in suggest mode is a proposal").toBeTruthy();
		await suggestMode(a.page, g.trip.id, false);
		// Nothing moved for real.
		expect((await itemNamed(a.page, "Nakano Broadway")).date).toBe("2027-10-05");

		// Dennis selects the item: the bar lists both alternatives.
		await d.page.goto(`${TOKYO}?days=2027-10-04..2027-10-06&sel=i.${it.id}`);
		await expectLive(d.page);
		const bar = d.page.getByTestId(TESTID.proposalBar);
		await expect(bar).toBeVisible({ timeout: 15_000 });
		await expect(bar).toContainText("Maya");
		await expect(bar).toContainText("Audrey");
		const alts = bar.getByTestId(S.barAlternative);
		await expect(alts).toHaveCount(2);
		const barText = (await bar.innerText()).replace(/\s+/g, " ");
		console.log(`[sug16] bar: ${barText}`);
		// The ghost on the card shows Maya's (the first).
		const ghosts = await d.page
			.locator(`[data-testid="${TESTID.proposalGhost}"]`)
			.evaluateAll((els) =>
				els.map((e) => `${e.getAttribute("data-proposal-id")} ${e.getAttribute("aria-description") ?? ""}`),
			);
		console.log(`[sug16] ghosts: ${ghosts.filter((x) => /Nakano/.test(x)).join(" | ")}`);
		expect(ghosts.some((x) => x.startsWith(rm.proposed?.id as string))).toBe(true);
		await snap(d.page, "r2-sug16-bar");

		// Accept Audrey's alternative.
		const audreyAlt = alts.filter({ hasText: "Audrey" });
		await audreyAlt.getByTestId(S.accept).click();
		await expect.poll(async () => (await itemNamed(d.page, "Nakano Broadway")).date, { timeout: 10_000 }).toBe("2027-10-04");
		const after = await proposals(d.page, g.trip.id);
		const pm = after.find((p) => p.id === rm.proposed?.id);
		expect(pm?.status).toBe("open");
		expect(pm?.lastError?.reason, "Maya's alternative is now a conflict").toBe("changed");

		// ReviewDrawer → Conflicts shows Maya's, with Accept anyway.
		await d.page.getByTestId(TESTID.suggestModeControl).first().click();
		await d.page.getByTestId(S.reviewOpen).click();
		const drawer = d.page.getByTestId(TESTID.reviewDrawer).last();
		await expect(drawer).toBeVisible();
		await drawer.getByRole("tab", { name: /Conflicts/ }).click();
		const row = drawer.getByTestId(S.row).filter({ hasText: "Nakano Broadway" });
		await expect(row).toBeVisible({ timeout: 10_000 });
		await expect(row.getByTestId(S.conflict)).toBeVisible();
		console.log(`[sug03] conflict row: ${(await row.innerText()).replace(/\s+/g, " ")}`);
		await snap(d.page, "r2-sug03-conflicts");
		await row.getByTestId(S.acceptAnyway).click();
		await expect.poll(async () => (await itemNamed(d.page, "Nakano Broadway")).date, { timeout: 10_000 }).toBe("2027-10-06");
		const fin = await proposals(d.page, g.trip.id);
		expect(fin.find((p) => p.id === rm.proposed?.id)?.status).toBe("accepted");
		expect(fin.find((p) => p.id === ra.proposed?.id)?.status).toBe("accepted");
	} finally {
		await withdrawMine(m.page, g.trip.id, /Nakano Broadway/).catch(() => undefined);
		await withdrawMine(a.page, g.trip.id, /Nakano Broadway/).catch(() => undefined);
		const cha = await itemNamed(d.page, "Cha no Ikedaya");
		await call(d.page, "/src/functions/items.functions.ts", "moveItem", { itemId: it.id, dayId: d5, afterItemId: cha.id }).catch(
			() => undefined,
		);
		await a.ctx.close();
		await m.ctx.close();
		await d.ctx.close();
	}
});

type Leg = {
	id: string;
	fromItemId: string;
	toItemId: string;
	mode: string | null;
	durationMin: number | null;
	distanceM: number | null;
	source: string;
	estimateMin: number | null;
	isEdited: boolean;
	details: Record<string, unknown> | null;
};

test("DEFECT overlay: a pending move draws a real leg as amber 'Unlinked transit' for the reviewer, and its Discard deletes the real route", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const d = await open(browser, "dennis", `${TOKYO}?days=2027-10-05`);
	const m = await open(browser, "maya", TOKYO);
	const g0 = await graph(d.page);
	const nb = await itemNamed(d.page, "Nakano Broadway");
	const cha = await itemNamed(d.page, "Cha no Ikedaya");
	const d6 = await dayOf(d.page, "2027-10-06");
	const legs0 = (g0 as unknown as { legs: Leg[] }).legs;
	const jr = legs0.find((l) => l.fromItemId === cha.id && l.toItemId === nb.id);
	if (!jr) throw new Error("fixture: no Cha no Ikedaya → Nakano Broadway leg");
	expect(await d.page.getByTestId(P.unlinked).count(), "no unlinked row before the suggestion").toBe(0);
	await withdrawMine(m.page, g0.trip.id, /Nakano Broadway/);
	let discarded = false;
	try {
		const rm = await call<{ proposed?: { id: string } }>(m.page, "/src/functions/items.functions.ts", "moveItem", {
			itemId: nb.id,
			dayId: d6,
		});
		expect(rm.proposed?.id).toBeTruthy();
		// Dennis (suggestions shown, the default): Tue 5 Oct now has an amber row for a leg nobody broke.
		const row = d.page.getByTestId(P.unlinked).filter({ hasText: "Nakano Broadway" });
		await expect(row).toBeVisible({ timeout: 10_000 });
		await row.scrollIntoViewIfNeeded();
		await snap(d.page, "r2-overlay-false-unlinked");
		// The server graph is unchanged: the item is still on Tue 5 Oct, the leg still joins it.
		const real = await graph(d.page);
		expect(real.items.find((i) => i.id === nb.id)?.dayId).toBe(nb.dayId);
		// Discard → Discard route: the REAL reserved JR route is deleted.
		await row.getByRole("button", { name: "Discard" }).click();
		await row.getByRole("button", { name: "Discard route" }).click();
		await expect
			.poll(async () => ((await graph(d.page)) as unknown as { legs: Leg[] }).legs.some((l) => l.id === jr.id), {
				timeout: 10_000,
			})
			.toBe(false);
		discarded = true;
		// Maya withdraws: the item never moved, but its route is gone.
		await withdrawMine(m.page, g0.trip.id, /Nakano Broadway/);
		await d.page.waitForTimeout(1_500);
		const after = await graph(d.page);
		expect(after.items.find((i) => i.id === nb.id)?.dayId).toBe(nb.dayId);
		await snap(d.page, "r2-overlay-route-gone");
		expect.soft(discarded, "a hypothetical move must never offer a destructive action on the real leg").toBe(false);
	} finally {
		await withdrawMine(m.page, g0.trip.id, /Nakano Broadway/).catch(() => undefined);
		if (discarded)
			await call(d.page, "/src/functions/legs.functions.ts", "setLeg", {
				target: { kind: "pair", fromItemId: jr.fromItemId, toItemId: jr.toItemId },
				patch: {
					mode: jr.mode,
					durationMin: jr.durationMin,
					distanceM: jr.distanceM,
					source: jr.source,
					estimateMin: jr.estimateMin,
					isEdited: jr.isEdited,
					...(jr.details ? { details: jr.details } : {}),
				},
			}).catch((e) => console.log(`[restore] ${e}`));
		await m.ctx.close();
		await d.ctx.close();
	}
});

test("SUG-09 + SUG-12: an editor switches to Suggesting in the UI; a rename becomes a ghost, the toast's Undo withdraws it; back in Editing the rename applies", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const d = await open(browser, "dennis", `${TOKYO}?days=2027-10-05`);
	const g = await graph(d.page);
	const day5 = g.days.find((x) => x.date === "2027-10-05");
	const lunch = g.items.find((i) => i.dayId === day5?.id && i.title === "Lunch");
	if (!lunch) throw new Error("no Lunch on Tue 5 Oct");
	await d.page.goto(`${TOKYO}?days=2027-10-05&sel=i.${lunch.id}`);
	await expectLive(d.page);
	const tag = randomBytes(2).toString("hex");
	try {
		// Editing ▾ → Suggesting.
		const ctl = d.page.getByTestId(TESTID.suggestModeControl).first();
		await ctl.click();
		await d.page.getByTestId(S.modeSuggesting).click();
		await expect(ctl).toContainText("Suggesting", { timeout: 5_000 });
		await snap(d.page, "r2-sug09-suggesting-chrome");
		// Rename in the item overview.
		const title = d.page.getByTestId(P.overviewTitle);
		await title.fill(`Lunch ${tag}`);
		await title.press("Enter");
		const toastEl = d.page.locator("[data-sonner-toast]").filter({ hasText: "Suggested" });
		await expect(toastEl).toBeVisible({ timeout: 10_000 });
		console.log(`[sug12] toast: ${(await toastEl.innerText()).replace(/\s+/g, " ")}`);
		// Not applied on the server; one open proposal of mine; a ghost on the card.
		const real = await call<{ items: { id: string; title: string | null }[] }>(
			d.page,
			"/src/functions/graph.functions.ts",
			"getTripGraph",
			{ tripId: g.trip.id },
		).catch(() => null);
		if (real) expect(real.items.find((i) => i.id === lunch.id)?.title).toBe("Lunch");
		const mine = (await proposals(d.page, g.trip.id)).filter((p) => p.status === "open" && p.op === "item.update");
		const p1 = mine.find((p) => JSON.stringify(p.payload).includes(tag));
		expect(p1, "a proposal carries the rename").toBeTruthy();
		await expect(d.page.locator(`[data-testid="${TESTID.proposalGhost}"][data-proposal-id="${p1?.id}"]`).first()).toBeVisible();
		await snap(d.page, "r2-sug09-ghost");
		// SUG-12: Undo in the toast withdraws it and the ghost goes.
		await toastEl.getByRole("button", { name: "Undo" }).click();
		await expect
			.poll(async () => (await proposals(d.page, g.trip.id)).find((p) => p.id === p1?.id)?.status, { timeout: 10_000 })
			.toBe("withdrawn");
		await expect(d.page.locator(`[data-testid="${TESTID.proposalGhost}"][data-proposal-id="${p1?.id}"]`)).toHaveCount(0);
		// Back to Editing: the same rename applies directly.
		await ctl.click();
		await d.page.getByTestId(S.modeEditing).click();
		await title.fill(`Lunch ${tag}`);
		await title.press("Enter");
		await expect.poll(async () => (await graph(d.page)).items.find((i) => i.id === lunch.id)?.title, { timeout: 10_000 }).toBe(
			`Lunch ${tag}`,
		);
		const open2 = (await proposals(d.page, g.trip.id)).filter((p) => p.status === "open" && JSON.stringify(p.payload).includes(tag));
		expect(open2).toEqual([]);
	} finally {
		await suggestMode(d.page, g.trip.id, false).catch(() => undefined);
		await d.page.evaluate(() => localStorage.clear()).catch(() => undefined);
		await call(d.page, "/src/functions/items.functions.ts", "updateItem", { itemId: lunch.id, patch: { title: "Lunch" } }).catch(
			() => undefined,
		);
		await d.ctx.close();
	}
});

test("SUG-14: Dennis rejects Maya's suggestion in the drawer with a note; Maya gets a toast live, an inbox row with the note, and Mine shows it rejected with the note", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const d = await open(browser, "dennis", TOKYO);
	const m = await open(browser, "maya", TOKYO);
	const g = await graph(d.page);
	const tag = randomBytes(2).toString("hex");
	const gg = g.nodes.find((n) => n.name === "Golden Gai");
	if (!gg) throw new Error("fixture");
	await dismissHint(m.page);
	const r = await call<{ proposed?: { id: string } }>(m.page, "/src/functions/nodes.functions.ts", "updateNode", {
		nodeId: gg.id,
		patch: { description: `Maya's idea ${tag}` },
		proposal: { message: `why not ${tag}` },
	});
	expect(r.proposed?.id).toBeTruthy();
	try {
		await d.page.getByTestId(TESTID.suggestModeControl).first().click();
		await d.page.getByTestId(S.reviewOpen).click();
		const drawer = d.page.getByTestId(TESTID.reviewDrawer).last();
		const row = drawer.getByTestId(S.row).filter({ hasText: `why not ${tag}` });
		await expect(row).toBeVisible({ timeout: 10_000 });
		await row.getByTestId(S.reject).click();
		await d.page.getByTestId(S.rejectNote).fill(`too touristy ${tag}`);
		await snap(d.page, "r2-sug14-reject-note");
		await d.page.getByTestId(S.rejectConfirm).click();
		// Maya: a toast while online…
		const t = m.page.locator("[data-sonner-toast]").filter({ hasText: /reject/i });
		const toastSeen = await t
			.first()
			.waitFor({ timeout: 10_000 })
			.then(() => true)
			.catch(() => false);
		console.log(`[sug14] maya toast: ${toastSeen ? (await t.first().innerText()).replace(/\s+/g, " ") : "(none)"}`);
		// …the inbox row with the note…
		const bell = m.page.getByTestId(TESTID.inboxBell).first();
		await expect.poll(async () => Number((await bell.getAttribute("data-unread")) ?? 0), { timeout: 15_000 }).toBeGreaterThan(0);
		await bell.click();
		const inboxRow = m.page.getByTestId(SH.inboxPanel).getByTestId(SH.inboxRow).filter({ hasText: `too touristy ${tag}` });
		await expect(inboxRow).toBeVisible({ timeout: 10_000 });
		console.log(`[sug14] maya inbox: ${(await inboxRow.innerText()).replace(/\s+/g, " ")}`);
		await snap(m.page, "r2-sug14-maya-inbox");
		await m.page.keyboard.press("Escape");
		// …and ReviewDrawer → Mine: rejected, with the note.
		await m.page.getByTestId(TESTID.suggestModeControl).first().click();
		const reviewBtn = m.page.getByTestId(S.reviewOpen);
		if (await reviewBtn.isVisible().catch(() => false)) await reviewBtn.click();
		const md = m.page.getByTestId(TESTID.reviewDrawer).last();
		await expect(md).toBeVisible({ timeout: 10_000 });
		await md.getByRole("tab", { name: /Mine/ }).click();
		const mine = md.getByTestId(S.row).filter({ hasText: `why not ${tag}` });
		await expect(mine).toBeVisible({ timeout: 10_000 });
		const mineText = (await mine.innerText()).replace(/\s+/g, " ");
		console.log(`[sug14] maya mine: ${mineText}`);
		expect(mineText).toMatch(/rejected/i);
		expect(mineText).toContain(`too touristy ${tag}`);
		await snap(m.page, "r2-sug14-maya-mine");
	} finally {
		await m.ctx.close();
		await d.ctx.close();
	}
});

test("SUG security: who may do what with suggestions (suggester, viewer, guest suggester, another trip)", async ({ browser }) => {
	test.setTimeout(180_000);
	const d = await open(browser, "dennis", TOKYO);
	const m = await open(browser, "maya", TOKYO);
	const k = await open(browser, "kai", TOKYO);
	const au = await open(browser, "audrey", "/t/phu-quoc-detour?tab=plan").catch(() => null);
	const g = await graph(d.page);
	const gg = g.nodes.find((n) => n.name === "Golden Gai");
	const it = await itemNamed(d.page, "Nakano Broadway");
	const d6 = await dayOf(d.page, "2027-10-06");
	const PF = "/src/functions/proposals.functions.ts";
	const out: Record<string, string> = {};
	const created: string[] = [];
	try {
		// Maya proposes; she can't accept her own; Audrey can't withdraw it.
		const r = await call<{ proposed?: { id: string } }>(m.page, "/src/functions/items.functions.ts", "moveItem", {
			itemId: it.id,
			dayId: d6,
		});
		const pid = r.proposed?.id as string;
		created.push(pid);
		out.mayaAcceptsOwn = await callErr(m.page, PF, "resolveProposal", { proposalId: pid, decision: "accept" });
		out.mayaRejectsOwn = await callErr(m.page, PF, "resolveProposal", { proposalId: pid, decision: "reject" });
		out.kaiWithdraws = await callErr(k.page, PF, "withdrawProposal", { proposalId: pid });
		out.kaiAccepts = await callErr(k.page, PF, "resolveProposal", { proposalId: pid, decision: "accept" });
		// Kai (viewer): no proposals, no edits, not even in "suggest mode".
		out.kaiList = await callErr(k.page, PF, "listProposals", { tripId: g.trip.id });
		out.kaiMove = await callErr(k.page, "/src/functions/items.functions.ts", "moveItem", { itemId: it.id, dayId: d6 });
		await suggestMode(k.page, g.trip.id, true);
		out.kaiMoveSuggest = await callErr(k.page, "/src/functions/items.functions.ts", "moveItem", {
			itemId: it.id,
			dayId: d6,
			proposal: { message: "pls" },
		});
		// Maya: settings, members and links are not hers; hours fetch is edit-only; hours edit is a proposal.
		out.mayaRole = await callErr(m.page, "/src/features/home/sharing.functions.ts", "updateMemberRole", {
			memberId: g.members.find((x) => x.name.startsWith("Kai"))?.id,
			role: "editor",
		});
		out.mayaLink = await callErr(m.page, "/src/features/home/sharing.functions.ts", "setShareLink", {
			tripId: g.trip.id,
			role: "editor",
			enabled: true,
		});
		out.mayaTrip = await callErr(m.page, "/src/functions/trips.functions.ts", "updateTrip", {
			tripId: g.trip.id,
			name: "Hijacked",
		});
		out.mayaFetchHours = await callErr(m.page, "/src/features/insights/insights.functions.ts", "fetchOpeningHours", {
			tripId: g.trip.id,
			nodeIds: [gg?.id],
		});
		out.mayaShift = await callErr(m.page, "/src/functions/trips.functions.ts", "shiftTripDates", {
			tripId: g.trip.id,
			deltaDays: 1,
		});
		// Another trip (Audrey's Phu Quoc detour, Maya isn't a member): nothing, not even a proposal.
		if (au) {
			const pq = await graph(au.page);
			const pqItem = pq.items.find((i) => i.dayId) ?? pq.items[0];
			const pqNode = pq.nodes.find((n) => n.type !== "root") ?? pq.nodes[0];
			console.log(`[sec] phu-quoc: ${pq.items.length} items, ${pq.nodes.length} nodes, ${pq.days.length} days`);
			if (pqItem)
				out.crossMove = await callErr(m.page, "/src/functions/items.functions.ts", "moveItem", {
					itemId: pqItem.id,
					dayId: d6,
				});
			// Maya's own ghost id reused to reach into another trip: an item created in Asia 2027 "on" a PQ day.
			if (pq.days[0])
				out.crossCreate = await callErr(m.page, "/src/functions/items.functions.ts", "createItem", {
					tripId: g.trip.id,
					dayId: pq.days[0].id,
					title: "cross",
				});
			out.crossNode = await callErr(m.page, "/src/functions/nodes.functions.ts", "updateNode", {
				nodeId: pqNode?.id,
				patch: { description: "x" },
			});
			out.crossList = await callErr(m.page, PF, "listProposals", { tripId: pq.trip.id });
		}
		for (const [k2, v] of Object.entries(out)) console.log(`[sec] ${k2}: ${v.slice(0, 160)}`);
		expect(out.mayaAcceptsOwn).toMatch(/FORBIDDEN/);
		expect(out.mayaRejectsOwn).toMatch(/FORBIDDEN/);
		expect(out.kaiWithdraws).toMatch(/FORBIDDEN|NOT_FOUND/);
		expect(out.kaiAccepts).toMatch(/FORBIDDEN|NOT_FOUND/);
		expect(out.kaiList).toBe("OK []");
		expect(out.kaiMove).toMatch(/FORBIDDEN/);
		expect(out.kaiMoveSuggest).toMatch(/FORBIDDEN/);
		expect(out.mayaRole).toMatch(/FORBIDDEN/);
		expect(out.mayaLink).toMatch(/FORBIDDEN/);
		expect(out.mayaTrip).toMatch(/FORBIDDEN|OK \{"proposed/);
		expect(out.mayaFetchHours).toMatch(/FORBIDDEN/);
		expect(out.mayaShift).toMatch(/OK \{"proposed/);
		if (au) {
			if (out.crossMove) expect(out.crossMove).toMatch(/NOT_FOUND|FORBIDDEN/);
			if (out.crossCreate) expect(out.crossCreate).toMatch(/NOT_FOUND|FORBIDDEN|VALIDATION/);
			expect(out.crossNode).toMatch(/NOT_FOUND|FORBIDDEN/);
			expect(out.crossList).toMatch(/NOT_FOUND|FORBIDDEN|OK \[\]/);
		}
		const shiftId = out.mayaShift.match(/"id":"([^"]+)"/)?.[1];
		if (shiftId) created.push(shiftId);
		const tripId2 = out.mayaTrip.match(/"id":"([^"]+)"/)?.[1];
		if (tripId2) created.push(tripId2);
	} finally {
		await suggestMode(k.page, g.trip.id, false).catch(() => undefined);
		for (const id of created) await callErr(m.page, PF, "withdrawProposal", { proposalId: id });
		await au?.ctx.close();
		await k.ctx.close();
		await m.ctx.close();
		await d.ctx.close();
	}
});

test("SUG security: a guest suggester's listProposals never shows an editor's booking ref, seats or cost (and the overview doesn't either)", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const d = await open(browser, "dennis", TOKYO);
	const g = await graph(d.page);
	type L = { id: string; fromItemId: string; toItemId: string; details: { flight?: Record<string, unknown> } | null };
	const legs = (g as unknown as { legs: L[] }).legs;
	const nh9 = legs.find((l) => l.details?.flight?.flightNumber === "NH9");
	if (!nh9?.details?.flight) throw new Error("no NH 9");
	const fl = nh9.details.flight;
	const guest = await open(browser, null, "/t/asia-2027?tab=plan", { token: SUGGEST_TOKEN });
	let pid: string | undefined;
	try {
		await suggestMode(d.page, g.trip.id, true);
		const r = await call<{ proposed?: { id: string } }>(d.page, "/src/features/transit/transit.functions.ts", "saveFlight", {
			target: { kind: "pair", fromItemId: nh9.fromItemId, toItemId: nh9.toItemId },
			flight: { ...fl, bookingRef: "SECRT9", aircraft: "Airbus A380" },
		});
		await suggestMode(d.page, g.trip.id, false);
		pid = r.proposed?.id;
		expect(pid, "Dennis's flight edit in suggest mode is a proposal").toBeTruthy();
		// The member view carries the new ref (they may see booking details)…
		const mine = (await proposals(d.page, g.trip.id)).find((p) => p.id === pid);
		expect(JSON.stringify(mine)).toContain("SECRT9");
		// …the guest suggester's doesn't: no ref (old or new), no seats, no cost.
		const gl = await call<unknown>(guest.page, "/src/functions/proposals.functions.ts", "listProposals", { tripId: g.trip.id });
		const gp = (Array.isArray(gl) ? gl : (gl as { proposals: Prop[] }).proposals).find((p: Prop) => p.id === pid);
		const js = JSON.stringify(gp ?? {});
		console.log(`[sec-guest] ${js.slice(0, 600)}`);
		expect(gp, "the guest suggester lists it").toBeTruthy();
		expect(js).not.toContain("SECRT9");
		expect(js).not.toContain("ZK4P7Q");
		expect(js).not.toMatch(/"8D"|"8G"/);
		// And its overview in the guest's browser.
		await guest.page.goto(`/t/asia-2027?sel=p.${pid}`);
		await expectLive(guest.page);
		const ov = guest.page.getByTestId(TESTID.proposalOverview);
		await expect(ov).toBeVisible({ timeout: 10_000 });
		const txt = await ov.innerText();
		console.log(`[sec-guest] overview: ${txt.replace(/\s+/g, " ").slice(0, 400)}`);
		expect(txt).not.toContain("SECRT9");
		expect(txt).not.toContain("ZK4P7Q");
		await snap(guest.page, "r2-sec-guest-flight-proposal");
	} finally {
		await suggestMode(d.page, g.trip.id, false).catch(() => undefined);
		if (pid) await callErr(d.page, "/src/functions/proposals.functions.ts", "withdrawProposal", { proposalId: pid });
		await guest.ctx.close();
		await d.ctx.close();
	}
});

const LF = "/src/features/lists/lists.functions.ts";
const tomorrow = () => new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);

test("ONE inbox: a shared to-do due tomorrow reaches Dennis's bell and opens the to-do; Audrey's private one never does (bell, digest, activity)", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const d = await open(browser, "dennis", TOKYO);
	const a = await open(browser, "audrey", TOKYO);
	const g = await graph(a.page);
	const gg = g.nodes.find((n) => n.name === "Golden Gai");
	if (!gg) throw new Error("fixture");
	const tag = randomBytes(2).toString("hex");
	const ids: string[] = [];
	const dg0 = await call<{ rows: { summary: string }[] }>(d.page, "/src/functions/activity.functions.ts", "getDigest", {
		tripId: g.trip.id,
	});
	try {
		const shared = await call<{ id: string }>(a.page, LF, "createListItem", {
			tripId: g.trip.id,
			target: { kind: "node", nodeId: gg.id },
			list: "todo",
			text: `Book Bar Kuro seats ${tag}`,
			dueDate: tomorrow(),
			dueTime: "18:00",
			dueTz: "America/New_York",
		});
		const priv = await call<{ id: string }>(a.page, LF, "createListItem", {
			tripId: g.trip.id,
			target: { kind: "node", nodeId: gg.id },
			list: "todo",
			text: `Surprise party for Dennis ${tag}`,
			dueDate: tomorrow(),
			isPrivate: true,
		});
		for (const x of [shared, priv]) if (x?.id) ids.push(x.id);
		console.log(`[inbox-due] created ${JSON.stringify([shared, priv])}`);
		// Dennis's feed: the shared one as "due", never the private one.
		await expect
			.poll(async () => JSON.stringify(await call(d.page, "/src/functions/inbox.functions.ts", "listInbox", {})), {
				timeout: 15_000,
			})
			.toContain(`Book Bar Kuro seats ${tag}`);
		const feed = await call<{ items: { kind: string; title: string; link: unknown; key: string }[] }>(
			d.page,
			"/src/functions/inbox.functions.ts",
			"listInbox",
			{},
		);
		const due = feed.items.find((i) => i.title.includes(`Book Bar Kuro seats ${tag}`));
		console.log(`[inbox-due] ${JSON.stringify(due)}`);
		expect(due?.kind).toBe("due");
		expect(JSON.stringify(feed)).not.toContain(`Surprise party`);
		// Audrey's own feed has both (the private one is hers).
		const af = JSON.stringify(await call(a.page, "/src/functions/inbox.functions.ts", "listInbox", {}));
		expect(af).toContain(`Surprise party for Dennis ${tag}`);
		// Digest and activity: nothing about the private one.
		const dg = await call<{ rows: { summary: string }[] }>(d.page, "/src/functions/activity.functions.ts", "getDigest", {
			tripId: g.trip.id,
		});
		expect(JSON.stringify(dg)).not.toContain("Surprise party");
		expect(dg.rows.length - dg0.rows.length, "one new digest row (the shared to-do)").toBeLessThanOrEqual(1);
		const act = await call(d.page, "/src/functions/graph.functions.ts", "listActivity", { tripId: g.trip.id, limit: 50 });
		expect(JSON.stringify(act)).not.toContain("Surprise party");
		// The bell: the row is there and opens the to-do in Lists.
		const bell = d.page.getByTestId(TESTID.inboxBell).first();
		await bell.click();
		const panel = d.page.getByTestId(SH.inboxPanel);
		await expect(panel).toBeVisible();
		await d.page.waitForTimeout(600);
		const row = panel.getByTestId(SH.inboxRow).filter({ hasText: `Book Bar Kuro seats ${tag}` });
		await expect(row).toBeVisible({ timeout: 10_000 });
		console.log(`[inbox-due] row: ${(await row.innerText()).replace(/\s+/g, " ")}`);
		await expect(panel).not.toContainText("Surprise party");
		await snap(d.page, "r2-inbox-due");
		await row.click();
		await d.page.waitForTimeout(1_500);
		const url = d.page.url();
		console.log(`[inbox-due] after click: ${url}`);
		expect(url).toMatch(/tab=lists/);
		await expect(d.page.getByText(`Book Bar Kuro seats ${tag}`).first()).toBeVisible({ timeout: 10_000 });
		await snap(d.page, "r2-inbox-due-opened");
	} finally {
		for (const id of ids) await callErr(a.page, LF, "deleteListItem", { id });
		await a.ctx.close();
		await d.ctx.close();
	}
});

test("Privacy: making a to-do private after Maya suggested an edit to it still shows its text to every reviewer (open proposal + activity)", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const d = await open(browser, "dennis", TOKYO);
	const a = await open(browser, "audrey", TOKYO);
	const m = await open(browser, "maya", TOKYO);
	const g = await graph(a.page);
	const gg = g.nodes.find((n) => n.name === "Golden Gai");
	if (!gg) throw new Error("fixture");
	const tag = randomBytes(2).toString("hex");
	let id: string | undefined;
	let pid: string | undefined;
	try {
		const li = await call<{ id: string }>(a.page, LF, "createListItem", {
			tripId: g.trip.id,
			target: { kind: "node", nodeId: gg.id },
			list: "todo",
			text: `Gift idea ${tag}`,
		});
		id = li.id;
		const r = await call<{ proposed?: { id: string } }>(m.page, LF, "updateListItem", {
			id,
			patch: { text: `Gift idea ${tag}: a Montblanc pen for Dennis` },
		});
		pid = r.proposed?.id;
		expect(pid, "Maya's edit is a proposal").toBeTruthy();
		// Audrey hides it from everyone.
		await call(a.page, LF, "updateListItem", { id, patch: { isPrivate: true } });
		// Dennis can no longer see the to-do…
		const lists = await call(d.page, LF, "listTripListItems", { tripId: g.trip.id }).catch(() => null);
		if (lists) expect(JSON.stringify(lists)).not.toContain(`Gift idea ${tag}`);
		// …but the suggestion about it, and its activity line, still quote it.
		const props = await proposals(d.page, g.trip.id);
		const leaked = props.find((p) => p.id === pid);
		console.log(`[private-proposal] Dennis sees: ${JSON.stringify(leaked && { status: leaked.status, summary: leaked.summary, payload: leaked.payload })}`);
		const act = JSON.stringify(await call(d.page, "/src/functions/graph.functions.ts", "listActivity", { tripId: g.trip.id, limit: 50 }));
		const actLeak = act.includes(`Gift idea ${tag}`);
		console.log(`[private-proposal] activity quotes it: ${actLeak}`);
		await d.page.getByTestId(TESTID.suggestModeControl).first().click();
		await d.page.getByTestId(S.reviewOpen).click();
		const drawer = d.page.getByTestId(TESTID.reviewDrawer).last();
		await expect(drawer).toBeVisible();
		await d.page.waitForTimeout(800);
		const inDrawer = (await drawer.innerText()).includes(`Gift idea ${tag}`);
		console.log(`[private-proposal] drawer shows it: ${inDrawer}`);
		await snap(d.page, "r2-private-proposal-drawer");
		expect.soft(leaked?.status === "open" && JSON.stringify(leaked).includes("Montblanc"), "proposal about a now-private item").toBe(false);
		expect.soft(actLeak, "activity about a now-private item").toBe(false);
		expect.soft(inDrawer, "review drawer shows the private item's text").toBe(false);
	} finally {
		if (pid) await callErr(m.page, "/src/functions/proposals.functions.ts", "withdrawProposal", { proposalId: pid });
		if (id) await callErr(a.page, LF, "deleteListItem", { id });
		await m.ctx.close();
		await a.ctx.close();
		await d.ctx.close();
	}
});

// ---------------------------------------------------------------------------
// Realtime (qa/SCENARIOS RT)
// ---------------------------------------------------------------------------
const GG = "/t/asia-2027/japan/tokyo/shinjuku/golden-gai";
const topEditor = (p: Page) => p.getByTestId(TESTID.notesTab).getByTestId(NT.editor).first();
type Ed = {
	editor?: {
		state: { doc: { textBetween: (a: number, b: number, sep: string) => string; content: { size: number } } };
		commands: { focus: (p: "start" | "end") => boolean };
	};
};
const noteText = (p: Page) =>
	topEditor(p).evaluate((e) => {
		const d = (e as unknown as Ed).editor?.state.doc;
		return d ? d.textBetween(0, d.content.size, "\n") : "";
	});
async function caretAt(p: Page, where: "start" | "end") {
	const ed = topEditor(p);
	await expect(ed).toHaveAttribute("data-editable", "true", { timeout: 15_000 });
	await ed.click();
	await ed.evaluate((e, w) => (e as unknown as Ed).editor?.commands.focus(w), where);
}

test("RT-10 (COLLAB-1): two people press Enter at the end of the same note at the same moment and type — two paragraphs, each person's text whole", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const tag = randomBytes(2).toString("hex");
	const d = await open(browser, "dennis", `${GG}?tab=notes`);
	const a = await open(browser, "audrey", `${GG}?tab=notes`);
	const before = await noteText(d.page);
	try {
		await caretAt(d.page, "end");
		await caretAt(a.page, "end");
		await Promise.all([d.page.keyboard.press("Enter"), a.page.keyboard.press("Enter")]);
		const sD = `Dennis line ${tag}`;
		const sA = `Audrey line ${tag}`;
		await Promise.all([d.page.keyboard.type(sD, { delay: 60 }), a.page.keyboard.type(sA, { delay: 70 })]);
		await expect.poll(async () => [await noteText(d.page), await noteText(a.page)].every((t) => t.includes(sD) && t.includes(sA)), {
			timeout: 8_000,
		}).toBe(true);
		const t = await noteText(d.page);
		expect(await noteText(a.page)).toBe(t);
		const lines = t.split("\n");
		console.log(`[rt10] tail: ${JSON.stringify(lines.slice(-3))}`);
		expect(lines).toContain(sD);
		expect(lines).toContain(sA);
		await snap(d.page, "r2-rt10-enter-same-moment");
	} finally {
		// Put the note back: remove the two lines.
		await topEditor(d.page).evaluate((e, tg) => {
			const ed = (e as unknown as { editor?: { state: { doc: { descendants: (f: (n: { isTextblock: boolean; textContent: string; nodeSize: number }, pos: number) => void) => void } }; chain: () => { deleteRange: (r: { from: number; to: number }) => { run: () => boolean } } } }).editor;
			if (!ed) return;
			const ranges: { from: number; to: number }[] = [];
			ed.state.doc.descendants((n, pos) => {
				if (n.isTextblock && n.textContent.includes(tg as string)) ranges.push({ from: pos, to: pos + n.nodeSize });
			});
			for (const r of ranges.reverse()) ed.chain().deleteRange(r).run();
		}, tag);
		await d.page.waitForTimeout(1_000);
		console.log(`[rt10] restored: ${(await noteText(d.page)) === before}`);
		await a.ctx.close();
		await d.ctx.close();
	}
});

test("RT-07 per ADDENDUM (offline is read-only, notes included) + RT-09: offline Dennis gets a saved copy and can't type; Audrey's line arrives on reconnect; a late joiner sees it", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const tag = randomBytes(2).toString("hex");
	const d = await open(browser, "dennis", `${GG}?tab=notes`);
	const a = await open(browser, "audrey", `${GG}?tab=notes`);
	const sA = `Online Audrey ${tag}`;
	try {
		await caretAt(d.page, "end");
		await d.ctx.setOffline(true);
		await expect
			.poll(async () => d.page.getByTestId(TESTID.connectionPill).first().getAttribute("data-status").catch(() => null), {
				timeout: 20_000,
			})
			.toBe("offline");
		await expect(d.page.getByText("Saved copy · editing paused").first()).toBeVisible({ timeout: 10_000 });
		await d.page.keyboard.type(`typed offline ${tag}`);
		await snap(d.page, "r2-rt07-offline-readonly");
		await caretAt(a.page, "end");
		await a.page.keyboard.press("Enter");
		await a.page.keyboard.type(sA, { delay: 30 });
		await d.ctx.setOffline(false);
		await expect.poll(async () => (await noteText(d.page)).includes(sA), { timeout: 10_000 }).toBe(true);
		const merged = await noteText(d.page);
		expect(merged).not.toContain(`typed offline ${tag}`);
		expect(await noteText(a.page)).toBe(merged);
		const k = await open(browser, "kai", `${GG}?tab=notes`);
		await expect.poll(() => noteText(k.page), { timeout: 15_000 }).toBe(merged);
		await k.ctx.close();
	} finally {
		await d.ctx.setOffline(false).catch(() => undefined);
		await topEditor(a.page).evaluate((e, tg) => {
			const ed = (e as unknown as { editor?: { state: { doc: { descendants: (f: (n: { isTextblock: boolean; textContent: string; nodeSize: number }, pos: number) => void) => void } }; chain: () => { deleteRange: (r: { from: number; to: number }) => { run: () => boolean } } } }).editor;
			if (!ed) return;
			const ranges: { from: number; to: number }[] = [];
			ed.state.doc.descendants((n, pos) => {
				if (n.isTextblock && n.textContent.includes(tg as string)) ranges.push({ from: pos, to: pos + n.nodeSize });
			});
			for (const r of ranges.reverse()) ed.chain().deleteRange(r).run();
		}, tag).catch(() => undefined);
		await a.page.waitForTimeout(1_000);
		await a.ctx.close();
		await d.ctx.close();
	}
});

/**
 * RT-12 needs a hook to stop and start the realtime service:
 * `QA_COLLAB_STOP` and `QA_COLLAB_START` are shell commands (the verifier
 * runs collab as its own process group). Skipped without them.
 */
test("RT-12: the realtime server stops for ~6 s while Dennis types; he sees Reconnecting, his text stays, it syncs once; live plan events resume", async ({
	browser,
}) => {
	test.skip(!process.env.QA_COLLAB_STOP || !process.env.QA_COLLAB_START, "needs QA_COLLAB_STOP/START");
	test.setTimeout(180_000);
	const { execSync } = await import("node:child_process");
	const tag = randomBytes(2).toString("hex");
	const d = await open(browser, "dennis", `${GG}?tab=notes`);
	const a = await open(browser, "audrey", `${GG}?tab=notes`);
	const s1 = `Before ${tag}`;
	const s2 = ` during ${tag}`;
	const s3 = ` after ${tag}`;
	try {
		await caretAt(d.page, "end");
		await d.page.keyboard.press("Enter");
		await d.page.keyboard.type(s1, { delay: 20 });
		await expect.poll(async () => (await noteText(a.page)).includes(s1), { timeout: 5_000 }).toBe(true);
		execSync(process.env.QA_COLLAB_STOP as string, { stdio: "inherit", shell: "/bin/sh" });
		const pill = d.page.getByTestId(TESTID.connectionPill).first();
		await expect.poll(async () => pill.getAttribute("data-status"), { timeout: 10_000 }).toBe("reconnecting");
		console.log(`[rt12] pill text: ${(await pill.innerText().catch(() => "")).trim()}`);
		await snap(d.page, "r2-rt12-reconnecting");
		// What Dennis SEES (the live editor is hidden while reconnecting; a saved copy shows instead).
		const visible = await d.page.getByTestId(TESTID.notesTab).evaluate((el) => (el as HTMLElement).innerText);
		const seesOwnLine = visible.includes(s1);
		console.log(`[rt12] still sees the line he just typed: ${seesOwnLine}`);
		await d.page.keyboard.type(s2, { delay: 40 });
		const kept = (await noteText(d.page)).includes(`${s1}${s2}`);
		console.log(`[rt12] typing while reconnecting kept: ${kept}`);
		execSync(process.env.QA_COLLAB_START as string, { stdio: "inherit", shell: "/bin/sh" });
		await expect.poll(async () => pill.getAttribute("data-status"), { timeout: 40_000 }).toBe("live");
		await expect(topEditor(d.page)).toHaveAttribute("data-editable", "true", { timeout: 10_000 });
		await caretAt(d.page, "end");
		await d.page.keyboard.type(s3, { delay: 20 });
		await expect.poll(async () => (await noteText(a.page)).includes(s3), { timeout: 15_000 }).toBe(true);
		const t = await noteText(a.page);
		expect(t.split(s1).length - 1, "synced once").toBe(1);
		expect(await noteText(d.page)).toBe(t);
		expect.soft(seesOwnLine, "RT-12: his typed text stays in the editor").toBe(true);
		expect.soft(kept, "RT-12: typing continues while Reconnecting…").toBe(true);
		// Live plan events after the restart: Audrey's rename reaches Dennis without a reload.
		const g = await graph(a.page);
		const gg = g.nodes.find((n) => n.name === "Golden Gai");
		await call(a.page, "/src/functions/nodes.functions.ts", "updateNode", { nodeId: gg?.id, patch: { description: `live ${tag}` } });
		await expect
			.poll(async () => JSON.stringify((await graph(d.page)).nodes.find((n) => n.id === gg?.id) ?? {}), { timeout: 10_000 })
			.toContain(`live ${tag}`);
		await snap(d.page, "r2-rt12-after");
	} finally {
		await topEditor(d.page).evaluate((e, tg) => {
			const ed = (e as unknown as { editor?: { state: { doc: { descendants: (f: (n: { isTextblock: boolean; textContent: string; nodeSize: number }, pos: number) => void) => void } }; chain: () => { deleteRange: (r: { from: number; to: number }) => { run: () => boolean } } } }).editor;
			if (!ed) return;
			const ranges: { from: number; to: number }[] = [];
			ed.state.doc.descendants((n, pos) => {
				if (n.isTextblock && n.textContent.includes(tg as string)) ranges.push({ from: pos, to: pos + n.nodeSize });
			});
			for (const r of ranges.reverse()) ed.chain().deleteRange(r).run();
		}, tag).catch(() => undefined);
		await d.page.waitForTimeout(1_000);
		await a.ctx.close();
		await d.ctx.close();
	}
});

// ---------------------------------------------------------------------------
// E1 hours
// ---------------------------------------------------------------------------
test("HRS-06 + suggested hours: Maya marks Bar Benfiddich closed on Tue 5 Oct in the dialog (Suggest hours); Dennis sees it on the week, accepts; the card and day warn; removing the hours clears it", async ({
	browser,
}) => {
	test.setTimeout(180_000);
	const m = await open(browser, "maya", TOKYO);
	const g = await graph(m.page);
	const bb = g.nodes.find((n) => n.name === "Bar Benfiddich");
	if (!bb) throw new Error("fixture");
	const it = await itemNamed(m.page, "Bar Benfiddich");
	expect(it.date).toBe("2027-10-05");
	await m.page.goto(`${TOKYO}?sel=n.${bb.id}`);
	await expectLive(m.page);
	const d = await open(browser, "dennis", `${TOKYO}?days=2027-10-05&sel=n.${bb.id}`);
	let pid: string | undefined;
	try {
		await m.page.getByTestId(I.hoursTableEdit).click();
		const dlg = m.page.getByTestId(TESTID.hoursEditorDialog);
		await expect(dlg).toBeVisible();
		await m.page.getByTestId(I.hoursEditorAddException).click();
		await m.page.getByRole("button", { name: "Special date" }).click();
		const cal = m.page.locator('[data-slot="popover-content"]').last();
		await expect(cal).toContainText("October 2027");
		await cal.getByRole("button", { name: /October 5(th)?, 2027|Tuesday, October 5/ }).first().click().catch(async () => {
			await cal.locator("button", { hasText: /^5$/ }).first().click();
		});
		await m.page.waitForTimeout(300);
		await snap(m.page, "r2-hrs06-maya-exception");
		const save = m.page.getByTestId(I.hoursEditorSave);
		await expect(save).toHaveText(/Suggest/);
		await save.click();
		await expect(m.page.locator("[data-sonner-toast]").filter({ hasText: /Suggested/ }).first()).toBeVisible({ timeout: 10_000 });
		const p = (await proposals(d.page, g.trip.id)).find((x) => x.status === "open" && x.op === "node.hours");
		pid = p?.id;
		expect(pid, "a node.hours proposal").toBeTruthy();
		console.log(`[hrs06] proposal: ${p?.summary} ${JSON.stringify(p?.payload).slice(0, 300)}`);
		// Dennis: the suggestion shows above the week; no warning yet (nothing applied).
		await d.page.reload();
		await expectLive(d.page);
		const sug = d.page.getByTestId(I.hoursSuggested);
		await expect(sug).toBeVisible({ timeout: 10_000 });
		console.log(`[hrs06] dennis sees: ${(await sug.innerText()).replace(/\s+/g, " ")}`);
		await snap(d.page, "r2-hrs06-dennis-suggested");
		await call(d.page, "/src/functions/proposals.functions.ts", "resolveProposal", { proposalId: pid, decision: "accept" });
		pid = undefined;
		// The card and the day now warn "Closed" (a real conflict: amber).
		const chip = card(d.page, it.id).getByTestId(TESTID.hoursChip);
		await expect(chip).toBeVisible({ timeout: 10_000 });
		const chipText = (await chip.innerText()).replace(/\s+/g, " ");
		console.log(`[hrs06] card chip: ${chipText}`);
		expect(chipText).toMatch(/Closed/i);
		const dayBadge = d.page.getByTestId(TESTID.dayHoursBadge).first();
		const dayText = (await dayBadge.innerText().catch(() => "")) || (await d.page.getByTestId(TESTID.conflictBadge).first().innerText().catch(() => ""));
		console.log(`[hrs06] day header: ${dayText.replace(/\s+/g, " ")}`);
		await card(d.page, it.id).scrollIntoViewIfNeeded();
		await snap(d.page, "r2-hrs06-dennis-closed");
	} finally {
		if (pid) await callErr(m.page, "/src/functions/proposals.functions.ts", "withdrawProposal", { proposalId: pid });
		await call(d.page, "/src/features/insights/insights.functions.ts", "setOpeningHours", { nodeId: bb.id, hours: null }).catch(
			(e) => console.log(`[hrs06] restore: ${e}`),
		);
		await d.ctx.close();
		await m.ctx.close();
	}
});

// ---------------------------------------------------------------------------
// E3 sun + climate
// ---------------------------------------------------------------------------
test("SUN-01/02/03: Tokyo and Hanoi header times, the full line in the day overview; a nature stop pinned after sunset gets the muted info glyph (not amber)", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const d = await open(browser, "dennis", "/t/asia-2027?days=2027-10-15");
	const sunOf = async (date: string) => {
		await d.page.goto(`/t/asia-2027?days=${date}`);
		await expectLive(d.page);
		const s = d.page.getByTestId(TESTID.daySun).first();
		await expect(s).toBeVisible({ timeout: 10_000 });
		return (await s.innerText()).replace(/\s+/g, " ").trim();
	};
	const tokyo = await sunOf("2027-10-05");
	const seoul = await sunOf("2027-10-15");
	const hanoi = await sunOf("2027-10-30");
	console.log(`[sun] Tokyo 5 Oct: ${tokyo} | Seoul 15 Oct: ${seoul} | Hanoi 30 Oct: ${hanoi}`);
	expect(tokyo).toMatch(/05:3\d.17:2\d/);
	expect(hanoi).toMatch(/05:5\d.17:2\d/);
	expect(hanoi).not.toBe(tokyo);
	// The day overview's full line.
	const g = await graph(d.page);
	const d5 = g.days.find((x) => x.date === "2027-10-05");
	await d.page.goto(`/t/asia-2027?days=2027-10-05&sel=d.${d5?.id}`);
	await expectLive(d.page);
	const ovSun = d.page.getByTestId(TESTID.dayOverview).getByTestId(TESTID.daySun).first();
	await expect(ovSun).toBeVisible({ timeout: 10_000 });
	const ovVisible = await ovSun.evaluate((e) =>
		[...e.querySelectorAll("span")].filter((x) => !x.classList.contains("sr-only") && x.getAttribute("aria-hidden") === "true").map((x) => x.textContent).join(""),
	);
	console.log(`[sun] day overview shows: "${ovVisible}" full=${await ovSun.getAttribute("data-full")}`);
	await snap(d.page, "r2-sun-day-overview");
	expect.soft(await ovSun.getAttribute("data-full"), "EXTENSIONS §6: the day Overview repeats the full line").not.toBeNull();
	// SUN-03: Oishi Park (nature) pinned at 18:00 on Thu 7 Oct (sunset ~17:23 at Kawaguchiko).
	const oishi = await itemNamed(d.page, "Oishi Park");
	const before = g.items.find((i) => i.id === oishi.id) as unknown as { pinnedStart?: string | null };
	try {
		await call(d.page, "/src/functions/items.functions.ts", "updateItem", { itemId: oishi.id, patch: { pinnedStart: "18:00" } });
		await d.page.goto(`/t/asia-2027/japan?days=2027-10-07`);
		await expectLive(d.page);
		const chip = card(d.page, oishi.id).getByTestId(TESTID.hoursChip);
		await expect(chip).toBeVisible({ timeout: 10_000 });
		const cls = await chip.evaluate((e) => `${e.className} ${e.querySelector("svg")?.getAttribute("class") ?? ""} ${e.getAttribute("data-severity") ?? ""}`);
		const txt = (await chip.innerText()).trim();
		console.log(`[sun03] chip: "${txt}" ${cls.slice(0, 200)}`);
		expect(cls).not.toMatch(/text-warning/);
		await chip.hover();
		await d.page.waitForTimeout(700);
		let tip = await d.page.locator('[role="tooltip"], [data-slot="tooltip-content"]').first().innerText({ timeout: 1_000 }).catch(() => "");
		if (!tip) {
			await chip.click();
			tip = await d.page.getByTestId(I.hoursPopover).innerText({ timeout: 5_000 }).catch(() => "");
		}
		console.log(`[sun03] tooltip: ${tip.replace(/\s+/g, " ")}`);
		expect(tip).toMatch(/dark|sunset/i);
		await snap(d.page, "r2-sun03-after-dark");
	} finally {
		await call(d.page, "/src/functions/items.functions.ts", "updateItem", {
			itemId: oishi.id,
			patch: { pinnedStart: before?.pinnedStart ?? null },
		}).catch((e) => console.log(`[sun03] restore ${e}`));
		await d.ctx.close();
	}
});

test("SUN-04 on a phone (390px): the day header shows only the sunset glyph and time", async ({ browser }) => {
	const p = await open(browser, "dennis", "/t/asia-2027?days=2027-10-05", {
		viewport: { width: 390, height: 844 },
		mobile: true,
	});
	const s = p.page.getByTestId(TESTID.daySun).first();
	await expect(s).toBeVisible({ timeout: 15_000 });
	const txt = (await s.innerText()).replace(/\s+/g, " ").trim();
	console.log(`[sun04] ${txt} compact=${await s.getAttribute("data-compact")}`);
	expect(await s.getAttribute("data-compact")).toBe("true");
	const shown = await s.evaluate((e) =>
		[...e.querySelectorAll("span[aria-hidden]")].map((x) => x.textContent).join(""),
	);
	console.log(`[sun04] shown: "${shown}"`);
	expect(shown).toMatch(/^(Sunset )?\d\d:\d\d$/);
	await snap(p.page, "r2-sun04-phone");
	await p.ctx.close();
});

test("CLIM-03/04: a city shows one line for its visit month, a place none, the root and Japan a city table; the caption credits Open-Meteo", async ({
	browser,
}) => {
	test.setTimeout(120_000);
	const d = await open(browser, "dennis", "/t/asia-2027?sel=root");
	const g = await graph(d.page);
	const byName = (n: string) => g.nodes.find((x) => x.name === n);
	const cc = () => d.page.getByTestId(TESTID.inspector).getByTestId(TESTID.climateCard);
	const look = async (sel: string, label: string) => {
		await d.page.goto(`/t/asia-2027?sel=${sel}`);
		await expectLive(d.page);
		await d.page.waitForTimeout(2_500);
		const n = await cc().count();
		const t = n ? (await cc().first().innerText()).replace(/\s+/g, " ") : "(none)";
		console.log(`[clim] ${label}: ${t.slice(0, 300)}`);
		return { n, t };
	};
	// The trip's table moved from the root inspector to the Overview page (docs/OVERVIEW.md §7).
	await d.page.goto("/t/asia-2027?tab=overview");
	await expectLive(d.page);
	const rootCard = d.page.getByTestId("overview").getByTestId(TESTID.climateCard);
	await expect(rootCard).toBeVisible({ timeout: 20_000 });
	const root = { t: (await rootCard.innerText()).replace(/\s+/g, " ") };
	expect(root.t).toMatch(/Tokyo/);
	expect(root.t).toMatch(/Open-Meteo/);
	const japan = await look(`n.${byName("Japan")?.id}`, "Japan");
	expect(japan.t).toMatch(/Tokyo/);
	expect(japan.t).toMatch(/Kyoto|Osaka|Nagoya/);
	const tokyo = await look(`n.${byName("Tokyo")?.id}`, "Tokyo");
	expect(tokyo.t).toMatch(/Typical October/);
	expect(tokyo.t).toMatch(/Open-Meteo/);
	await snap(d.page, "r2-clim-tokyo");
	const place = await look(`n.${byName("Golden Gai")?.id}`, "Golden Gai");
	expect(place.n).toBe(0);
	const seoul = await look(`n.${byName("Seoul")?.id}`, "Seoul");
	expect(seoul.t).toMatch(/October/);
	await d.ctx.close();
});

// ---------------------------------------------------------------------------
// Digest (E6)
// ---------------------------------------------------------------------------
test("DIG-04: the dashboard card's change count matches the banner on the next open (Dennis, Audrey, Kai, Maya)", async ({ browser }) => {
	test.setTimeout(180_000);
	for (const h of ["dennis", "audrey", "kai", "maya"]) {
		const ctx = await browser.newContext({ storageState: auth(h), viewport: { width: 1440, height: 900 } });
		const page = await ctx.newPage();
		await page.goto("/dashboard");
		await expect(page.getByTestId(TESTID.dashboard)).toBeVisible({ timeout: 20_000 });
		await page.waitForTimeout(2_000);
		const cardText = (await page.getByTestId(TESTID.dashboard).innerText()).replace(/\s+/g, " ").split("Upcoming deadlines")[0] ?? "";
		const cardN = cardText.match(/(\d+\+?) changes?/)?.[1] ?? "0";
		await page.screenshot({ path: shot(`r2-dig04-dashboard-${h}`), timeout: 20_000 }).catch(() => undefined);
		await page.goto("/t/asia-2027?tab=plan");
		await expectLive(page);
		await page.waitForTimeout(2_000);
		const b = page.getByTestId(SH.digestBanner);
		const bannerText = (await b.count()) ? (await b.innerText()).replace(/\s+/g, " ") : "";
		const bannerN = bannerText.match(/(\d+\+?) changes?/)?.[1] ?? "0";
		console.log(`[dig04] ${h}: card "${cardText.slice(0, 160)}" → ${cardN} | banner "${bannerText}" → ${bannerN}`);
		expect.soft(bannerN, `${h}: dashboard vs banner`).toBe(cardN);
		await ctx.close();
	}
});

test("DIG-07: Eve (who already has a digest row as a signed-in link guest) opens the edit link anonymously, then signs in as Eve: the merge works and her digest keeps going", async ({
	browser,
}) => {
	test.setTimeout(180_000);
	const EDIT = "qa-share-token-editor-asia-2027";
	// 1. Eve, signed in, through the link: her own trip_seen row.
	const e1 = await open(browser, "eve", "/t/asia-2027?tab=plan", { token: EDIT });
	const g = await graph(e1.page);
	const d0 = await call<{ seenVersion: number; currentVersion: number }>(e1.page, "/src/functions/activity.functions.ts", "getDigest", {
		tripId: g.trip.id,
	});
	console.log(`[dig07] eve row: seen ${d0.seenVersion} / ${d0.currentVersion}; me ${JSON.stringify(g.me)}`);
	await e1.ctx.close();
	// 2. An anonymous guest in a fresh browser: a second row (the anonymous user's).
	const anon = await open(browser, null, "/t/asia-2027?tab=plan", { token: EDIT });
	const ga = await graph(anon.page);
	expect(ga.me.isGuest).toBe(true);
	await call(anon.page, "/src/functions/activity.functions.ts", "getDigest", { tripId: g.trip.id });
	// 3. Audrey changes something so there is a digest line to show.
	const a = await open(browser, "audrey", TOKYO);
	const gg = (await graph(a.page)).nodes.find((n) => n.name === "Golden Gai");
	const tag = randomBytes(2).toString("hex");
	await call(a.page, "/src/functions/nodes.functions.ts", "updateNode", { nodeId: gg?.id, patch: { description: `dig07 ${tag}` } });
	// 4. The anonymous guest signs in as Eve.
	const errors: string[] = [];
	anon.page.on("pageerror", (e) => errors.push(e.message));
	anon.page.on("response", (r) => {
		if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
	});
	await anon.page.getByText("Sign in to keep this trip").click();
	await anon.page.getByTestId("login-email").fill("eve@asia2027.test");
	await anon.page.getByTestId("login-submit").click();
	const otp = anon.page.getByTestId("otp-input");
	await expect(otp).toBeVisible({ timeout: 15_000 });
	await otp.click();
	await anon.page.keyboard.type("000000");
	await expect(anon.page).toHaveURL(/\/t\/asia-2027/, { timeout: 30_000 });
	await expectLive(anon.page);
	await anon.page.waitForTimeout(1_500);
	const gm = await graph(anon.page);
	console.log(`[dig07] after sign-in me: ${JSON.stringify(gm.me)}; errors: ${JSON.stringify(errors)}`);
	await snap(anon.page, "r2-dig07-after-signin");
	const dg = await call<{ seenVersion: number; currentVersion: number; rows: { summary: string }[] }>(
		anon.page,
		"/src/functions/activity.functions.ts",
		"getDigest",
		{ tripId: g.trip.id },
	);
	console.log(`[dig07] eve digest: seen ${dg.seenVersion} / ${dg.currentVersion}, ${dg.rows.length} rows`);
	expect(dg.seenVersion).toBeGreaterThanOrEqual(d0.seenVersion);
	expect(errors).toEqual([]);
	await a.ctx.close();
	await anon.ctx.close();
});

test("ReviewDrawer 'Accept all' on Maya's batch (a new place + an item on it + a rename) applies all three in order; Mark all read empties Maya's bell", async ({
	browser,
}) => {
	test.setTimeout(180_000);
	const d = await open(browser, "dennis", `${TOKYO}?days=2027-10-06`);
	const m = await open(browser, "maya", TOKYO);
	const g = await graph(m.page);
	const shinjuku = g.nodes.find((n) => n.name === "Shinjuku");
	const d6 = g.days.find((x) => x.date === "2027-10-06");
	const tag = randomBytes(2).toString("hex");
	const nodeId = crypto.randomUUID();
	const created: { nodeId?: string; itemId?: string } = {};
	try {
		// Keep only this batch open from Maya (leave the seeded two alone: they are in an older batch).
		const r1 = await call<{ proposed?: { id: string } }>(m.page, "/src/functions/nodes.functions.ts", "createNode", {
			tripId: g.trip.id,
			id: nodeId,
			parentId: shinjuku?.id,
			type: "place",
			name: `Bar Test ${tag}`,
			category: "bar",
		});
		const r2 = await call<{ proposed?: { id: string } }>(m.page, "/src/functions/items.functions.ts", "createItem", {
			tripId: g.trip.id,
			dayId: d6?.id,
			nodeId,
		});
		const r3 = await call<{ proposed?: { id: string } }>(m.page, "/src/functions/nodes.functions.ts", "updateNode", {
			nodeId,
			patch: { name: `Bar Test ${tag} (renamed)` },
		});
		console.log(`[acceptall] ${JSON.stringify([r1, r2, r3])}`);
		expect(r1.proposed?.id && r2.proposed?.id).toBeTruthy();
		created.nodeId = nodeId;
		await d.page.getByTestId(TESTID.suggestModeControl).first().click();
		await d.page.getByTestId(S.reviewOpen).click();
		const drawer = d.page.getByTestId(TESTID.reviewDrawer).last();
		const grp = drawer.getByTestId(S.group).filter({ hasText: `Bar Test ${tag}` });
		await expect(grp).toBeVisible({ timeout: 10_000 });
		console.log(`[acceptall] group: ${(await grp.innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
		await snap(d.page, "r2-accept-all-before");
		await grp.getByTestId(S.groupAcceptAll).click();
		await expect
			.poll(async () => (await graph(d.page)).nodes.find((n) => n.id === nodeId)?.name ?? null, { timeout: 15_000 })
			.toBe(`Bar Test ${tag} (renamed)`);
		const it = (await graph(d.page)).items.find((i) => i.nodeId === nodeId);
		expect(it?.dayId).toBe(d6?.id);
		created.itemId = it?.id;
		const after = await proposals(d.page, g.trip.id);
		for (const r of [r1, r2]) expect(after.find((p) => p.id === r.proposed?.id)?.status).toBe("accepted");
		await snap(d.page, "r2-accept-all-after");
		// Maya: Mark all read.
		const bell = m.page.getByTestId(TESTID.inboxBell).first();
		await expect.poll(async () => Number((await bell.getAttribute("data-unread")) ?? 0), { timeout: 15_000 }).toBeGreaterThan(0);
		await bell.click();
		await m.page.getByTestId(SH.inboxMarkAll).click();
		await expect.poll(async () => Number((await bell.getAttribute("data-unread")) ?? 0), { timeout: 10_000 }).toBe(0);
		const feed = await call<{ unread: number }>(m.page, "/src/functions/inbox.functions.ts", "listInbox", {});
		expect(feed.unread).toBe(0);
	} finally {
		if (created.itemId) await callErr(d.page, "/src/functions/items.functions.ts", "deleteItem", { itemId: created.itemId });
		if (created.nodeId) await callErr(d.page, "/src/functions/nodes.functions.ts", "deleteNode", { nodeId: created.nodeId });
		await withdrawMine(m.page, g.trip.id, new RegExp(`Bar Test ${tag}`));
		await m.ctx.close();
		await d.ctx.close();
	}
});

test("Privacy: an expense made private afterwards still shows its title to others in activity and the digest", async ({ browser }) => {
	test.setTimeout(120_000);
	const d = await open(browser, "dennis", TOKYO);
	const a = await open(browser, "audrey", TOKYO);
	const g = await graph(a.page);
	const tag = randomBytes(2).toString("hex");
	const MF = "/src/features/money/money.functions.ts";
	let id: string | undefined;
	try {
		const e = await call<{ id: string }>(a.page, MF, "createExpense", {
			tripId: g.trip.id,
			target: { kind: "trip" },
			title: `Engagement ring ${tag}`,
			amountMinor: 250000,
			currency: "USD",
		});
		id = e.id;
		await call(a.page, MF, "updateExpense", { id, patch: { isPrivate: true } });
		const money = JSON.stringify(await call(d.page, MF, "listMoney", { tripId: g.trip.id }));
		expect(money, "Dennis's money view hides it").not.toContain(`Engagement ring ${tag}`);
		const act = JSON.stringify(await call(d.page, "/src/functions/graph.functions.ts", "listActivity", { tripId: g.trip.id, limit: 50 }));
		const dig = JSON.stringify(await call(d.page, "/src/functions/activity.functions.ts", "getDigest", { tripId: g.trip.id }));
		console.log(`[private-expense] activity quotes it: ${act.includes(`Engagement ring ${tag}`)}; digest: ${dig.includes(`Engagement ring ${tag}`)}`);
		await d.page.goto("/t/asia-2027?sel=root");
		await expectLive(d.page);
		await d.page.waitForTimeout(1_500);
		const onScreen = (await d.page.getByTestId(TESTID.inspector).innerText()).includes(`Engagement ring ${tag}`);
		console.log(`[private-expense] root overview Recent shows it: ${onScreen}`);
		await snap(d.page, "r2-private-expense-recent");
		expect.soft(act.includes(`Engagement ring ${tag}`), "activity quotes a now-private expense").toBe(false);
		expect.soft(dig.includes(`Engagement ring ${tag}`), "digest quotes a now-private expense").toBe(false);
	} finally {
		if (id) await callErr(a.page, MF, "deleteExpense", { id });
		await a.ctx.close();
		await d.ctx.close();
	}
});
