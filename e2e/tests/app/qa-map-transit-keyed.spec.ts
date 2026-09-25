/** I2 map-transit: keyed Routes cases through the stub (TR-02/03/05/06/09; Japan never goes to Google). */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, request, test } from "@playwright/test";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { asUser, type G, graph, itemLabel, OUT, onlyHere, shot } from "./qa-map-transit-helpers";

onlyHere();
test.describe.configure({ mode: "serial" });
const STUB = process.env.QA_STUB ?? "http://127.0.0.1:5333";
const LOG = path.join(OUT, "keyed-results.txt");
const log = (s: string) => appendFileSync(LOG, `${s}\n`);
test.beforeAll(() => writeFileSync(LOG, `run ${new Date().toISOString()}\n`));

type Calls = { total: number; walk: number; transit: number; requests: { mode: string; body: Record<string, unknown>; at: string }[] };
async function calls(): Promise<Calls> {
	const r = await request.newContext();
	const c = (await (await r.get(`${STUB}/__stub/calls`)).json()) as Calls;
	await r.dispose();
	return c;
}
async function stubNext(body: Record<string, unknown>) {
	const r = await request.newContext();
	await r.post(`${STUB}/__stub/next`, { data: body });
	await r.dispose();
}
async function stubReset() {
	const r = await request.newContext();
	await r.post(`${STUB}/__stub/reset`);
	await r.dispose();
}
async function createItem(page: Page, data: Record<string, unknown>) {
	return page.evaluate(async (data) => {
		const m = await import("/src/functions/items.functions.ts");
		try {
			return await m.createItem({ data: data as never });
		} catch (e) {
			return { error: String(e) };
		}
	}, data);
}
const nodeId = (g: G, name: string) => g.nodes.find((n) => n.name === name)?.id ?? "";
const dayId = (g: G, date: string) => g.days.find((d) => d.date === date)?.id ?? "";
const ready = (page: Page) => page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph, null, { timeout: 45_000 });

test("TR-02: a Tokyo walk pair is autofilled from Google WALK (one call)", async ({ browser }) => {
	await stubReset();
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-20");
	await ready(page);
	await page.waitForTimeout(3000); // let the load sweep settle
	const c0 = await calls();
	log(`TR-02 stub after load (sweep): total=${c0.total} walk=${c0.walk} transit=${c0.transit}`);
	await stubReset();
	let g = await graph(page);
	const dId = dayId(g, "2027-10-20");
	await createItem(page, { tripId: g.trip.id, dayId: dId, nodeId: nodeId(g, "Omoide Yokocho"), durationMin: 60 });
	await page.reload();
	await ready(page);
	g = await graph(page);
	const aId = g.items.find((i) => i.dayId === dId && i.nodeId === nodeId(g, "Omoide Yokocho"))?.id ?? "";
	await createItem(page, { tripId: g.trip.id, dayId: dId, nodeId: nodeId(g, "Bar Benfiddich"), durationMin: 60, afterItemId: aId });
	let leg: G["legs"][number] | undefined;
	for (let i = 0; i < 20; i++) {
		await page.waitForTimeout(1500);
		await page.reload();
		await ready(page);
		g = await graph(page);
		const bId = g.items.find((x) => x.dayId === dId && x.nodeId === nodeId(g, "Bar Benfiddich"))?.id;
		leg = g.legs.find((l) => l.fromItemId === aId && l.toItemId === bId);
		if (leg?.mode) break;
	}
	const c1 = await calls();
	log(`TR-02 leg ${JSON.stringify(leg ? { mode: leg.mode, dur: leg.durationMin, src: leg.source } : null)} stub total=${c1.total} walk=${c1.walk} transit=${c1.transit} bodies=${JSON.stringify(c1.requests.map((r) => ({ mode: r.mode, o: (r.body.origin as { location?: unknown })?.location, d: (r.body.destination as { location?: unknown })?.location })))}`);
	if (leg) {
		await page.goto(`/t/asia-2027?days=2027-10-20&sel=l.${leg.fromItemId}.${leg.toItemId}`);
		await expect(page.getByTestId(TESTID.legOverview)).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(1500);
		log(`TR-02 panel: ${(await page.getByTestId(TESTID.legOverview).innerText()).replace(/\n/g, " / ").slice(0, 400)}`);
		await page.screenshot({ path: shot("tr02-walk-google") });
	}
	log(`TR-02 errors ${JSON.stringify(errors)}`);
});

test("TR-03/TR-05/TR-06/TR-09: Seoul transit via Google (stub) + errors + cache; Japan never hits Google", async ({ browser }) => {
	await stubReset();
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-15");
	await ready(page);
	let g = await graph(page);
	const dId = dayId(g, "2027-10-15");
	await createItem(page, { tripId: g.trip.id, dayId: dId, nodeId: nodeId(g, "Hannam"), title: "Hannam (TR-05)", durationMin: 60, pinnedStart: "10:10" });
	await page.reload();
	await ready(page);
	g = await graph(page);
	const aId = g.items.find((i) => i.title === "Hannam (TR-05)")?.id ?? "";
	await createItem(page, { tripId: g.trip.id, dayId: dId, nodeId: nodeId(g, "Starfield Library (COEX)"), title: "COEX (TR-05)", durationMin: 60, afterItemId: aId });
	await page.reload();
	await ready(page);
	g = await graph(page);
	const bId = g.items.find((i) => i.title === "COEX (TR-05)")?.id ?? "";
	await page.waitForTimeout(6000); // autofill (transit suggestion → Google via the worker)
	await page.reload();
	await ready(page);
	g = await graph(page);
	let leg = g.legs.find((l) => l.fromItemId === aId && l.toItemId === bId);
	const cA = await calls();
	log(`TR-03 autofilled leg: ${JSON.stringify(leg ? { mode: leg.mode, dur: leg.durationMin, src: leg.source } : null)} stub total=${cA.total} walk=${cA.walk} transit=${cA.transit}`);
	for (const r of cA.requests.filter((x) => x.mode === "TRANSIT")) log(`TR-05 transit request departureTime=${r.body.departureTime} (now ${new Date().toISOString()})`);
	await page.goto(`/t/asia-2027?days=2027-10-15&sel=l.${aId}.${bId}`);
	const ov = page.getByTestId(TESTID.legOverview);
	await expect(ov).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	if (!leg?.mode) {
		await ov.locator(`[data-testid=${T.modeOption}][data-mode=transit]`).click();
		await page.waitForTimeout(4000);
	}
	const panel = page.getByTestId(T.transitPanel);
	writeFileSync(path.join(OUT, "tr03-seoul.txt"), await ov.innerText());
	await page.screenshot({ path: shot("tr03-seoul") });
	const opts = panel.getByTestId(T.transitOption);
	const info: string[] = [];
	for (let i = 0; i < (await opts.count()); i++) info.push(`${await opts.nth(i).getAttribute("data-source")} chosen=${await opts.nth(i).getAttribute("data-chosen")} fastest=${await opts.nth(i).getAttribute("data-fastest")} :: ${(await opts.nth(i).innerText()).replace(/\n/g, " ")}`);
	log(`TR-03 options:\n  ${info.join("\n  ")}`);
	const cB = await calls();
	for (const r of cB.requests.filter((x) => x.mode === "TRANSIT")) log(`TR-05 transit request departureTime=${r.body.departureTime}`);
	log(`TR-03 stub after open: total=${cB.total} transit=${cB.transit}`);
	// Pick the second (Chuo-Sobu Local 19).
	if ((await opts.count()) > 1) {
		const second = opts.nth(1);
		await second.getByTestId(T.transitOptionChoose).click().catch(async () => second.click());
		await page.waitForTimeout(2000);
		g = await graph(page);
		leg = g.legs.find((l) => l.fromItemId === aId && l.toItemId === bId);
		log(`TR-03 after choosing 2nd: dur=${leg?.durationMin} src=${leg?.source}`);
	}
	// TR-09: reopen → no new calls (cache).
	const before = (await calls()).total;
	await page.reload();
	await ready(page);
	await page.waitForTimeout(2500);
	log(`TR-09 reopen calls delta=${(await calls()).total - before}`);
	// TR-06: 429 / 500 / empty on Refresh.
	for (const [label, body] of [["429", { status: 429 }], ["500", { status: 500 }], ["empty", { empty: true }]] as const) {
		await stubNext({ ...body, times: 1 });
		// A different departure bucket isn't guaranteed: a cache hit would hide the failure; note it.
		const b0 = (await calls()).total;
		await panel.getByTestId(T.transitRefresh).click();
		await page.waitForTimeout(2500);
		const msg = (await panel.getByTestId(T.transitError).count()) ? await panel.getByTestId(T.transitError).innerText() : "(no error message)";
		const txt = await panel.innerText();
		log(`TR-06 ${label}: stub called=${(await calls()).total - b0} msg="${msg}" noRoute=${/No route found/.test(txt)} options=${await opts.count()}`);
		await page.screenshot({ path: shot(`tr06-${label}`) });
	}
	// Japan leg with a key: never Google transit.
	const t0 = (await calls()).transit;
	const j = g.legs.find((l) => itemLabel(g, l.fromItemId) === "Kappabashi Street" && itemLabel(g, l.toItemId) === "Nihonbashi Nishikawa");
	await page.goto(`/t/asia-2027?sel=l.${j?.fromItemId}.${j?.toItemId}`);
	await expect(page.getByTestId(TESTID.legOverview)).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	await page.getByTestId(T.transitPanel).getByTestId(T.transitRefresh).click();
	await page.waitForTimeout(3000);
	log(`JP with key: google transit calls delta=${(await calls()).transit - t0}; sources=${(await page.getByTestId(T.transitOption).evaluateAll((els) => els.map((e) => e.getAttribute("data-source")))).join(",")}`);
	log(`TR-03.. errors ${JSON.stringify(errors)}`);
});

test("TR-06: Routes 429 / 500 / no route on fresh pairs", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-17");
	await ready(page);
	let g = await graph(page);
	const dId = dayId(g, "2027-10-17");
	const pairs: [string, string, Record<string, unknown>][] = [
		["Itaewon", "Seongsu", { status: 429, times: 3 }],
		["Seongsu", "Gangnam", { status: 500, times: 3 }],
		["Gangnam", "Itaewon", { empty: true, times: 3 }],
	];
	let prev: string | undefined;
	for (const [a] of pairs) {
		await createItem(page, { tripId: g.trip.id, dayId: dId, nodeId: nodeId(g, a), title: `${a} (TR-06)`, durationMin: 60, ...(prev ? { afterItemId: prev } : {}) });
		await page.reload();
		await ready(page);
		g = await graph(page);
		prev = g.items.find((i) => i.title === `${a} (TR-06)`)?.id;
	}
	await createItem(page, { tripId: g.trip.id, dayId: dId, nodeId: nodeId(g, "Itaewon"), title: "Itaewon end (TR-06)", durationMin: 60, afterItemId: prev });
	await page.reload();
	await ready(page);
	g = await graph(page);
	const ids = ["Itaewon (TR-06)", "Seongsu (TR-06)", "Gangnam (TR-06)", "Itaewon end (TR-06)"].map((t) => g.items.find((i) => i.title === t)?.id ?? "");
	await page.waitForTimeout(5000); // let autofill run (it may consume queued failures)
	for (let k = 0; k < 3; k++) {
		const [, , fail] = pairs[k];
		await stubReset();
		await stubNext(fail);
		await page.goto(`/t/asia-2027?days=2027-10-17&sel=l.${ids[k]}.${ids[k + 1]}`);
		const ov = page.getByTestId(TESTID.legOverview);
		await expect(ov).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(1000);
		const g2 = await graph(page);
		const l = g2.legs.find((x) => x.fromItemId === ids[k] && x.toItemId === ids[k + 1]);
		if (l?.mode !== "transit") await ov.locator(`[data-testid=${T.modeOption}][data-mode=transit]`).click();
		await page.waitForTimeout(1000);
		const panel = page.getByTestId(T.transitPanel);
		const find = panel.getByTestId(T.transitRefresh);
		if (await find.count()) await find.click();
		await page.waitForTimeout(3000);
		const c = await calls();
		const msg = (await panel.getByTestId(T.transitError).count()) ? await panel.getByTestId(T.transitError).innerText() : "(none)";
		log(`TR-06 ${JSON.stringify(fail)}: stubCalls=${c.total} msg="${msg}" panel="${(await panel.innerText()).replace(/\n/g, " / ").slice(0, 300)}" manualForm=${await panel.getByTestId(T.customRouteAdd).count()}`);
		await page.screenshot({ path: shot(`tr06-${k}`) });
	}
	log(`TR-06 errors ${JSON.stringify(errors)}`);
});
