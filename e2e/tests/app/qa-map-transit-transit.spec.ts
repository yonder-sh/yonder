/** I2 map-transit: TR-01/04/07/08/10/11/12 + Japan estimate + N02 geometry on the QA seed's Asia 2027. */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { asUser, drawn, type G, graph, itemLabel, mapReady, OUT, onlyHere, settle, shot } from "./qa-map-transit-helpers";

onlyHere();
test.describe.configure({ mode: "serial" });

const LOG = path.join(OUT, "transit-results.txt");
const log = (s: string) => appendFileSync(LOG, `${s}\n`);
test.beforeAll(() => writeFileSync(LOG, `run ${new Date().toISOString()}\n`));

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
/** DurationInput: a pill button that opens a popover with a text field. */
async function setDur(page: Page, scope: ReturnType<Page["getByTestId"]>, text: string) {
	await scope.getByRole("button").filter({ hasText: /\d/ }).first().click();
	const input = page.getByRole("dialog").locator("input").last();
	await input.fill(text);
	await input.press("Enter");
	await page.waitForTimeout(1500);
}
const nodeId = (g: G, name: string) => g.nodes.find((n) => n.name === name)?.id ?? "";
const dayId = (g: G, date: string) => g.days.find((d) => d.date === date)?.id ?? "";
const txt = async (page: Page, id: string) => {
	const l = page.getByTestId(id);
	return (await l.count()) ? l.first().innerText() : "";
};

test("TR-07/TR-12: build Fuji Excursion 7 by hand (N02 stations), reserved + booking; map track", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-21");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 45_000 });
	await page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph);
	let g = await graph(page);
	const dId = dayId(g, "2027-10-21");
	const b = (await createItem(page, { tripId: g.trip.id, dayId: dId, nodeId: nodeId(g, "Shinjuku"), title: "Breakfast (TR-07)", durationMin: 30, pinnedStart: "07:30" })) as { id?: string; error?: string };
	log(`TR-07 create breakfast ${JSON.stringify(b).slice(0, 200)}`);
	await page.reload();
	await page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph);
	g = await graph(page);
	const bId = g.items.find((i) => i.title === "Breakfast (TR-07)")?.id ?? "";
	const d = (await createItem(page, { tripId: g.trip.id, dayId: dId, nodeId: nodeId(g, "Kawaguchiko Ryokan"), title: "Drop bags (TR-07)", durationMin: 30, afterItemId: bId })) as { error?: string };
	log(`TR-07 create drop bags ${JSON.stringify(d).slice(0, 200)}`);
	await page.reload();
	await page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph);
	g = await graph(page);
	const dropId = g.items.find((i) => i.title === "Drop bags (TR-07)")?.id ?? "";
	await page.waitForTimeout(3000); // autofill may run
	g = await graph(page);
	const pre = g.legs.find((l) => l.fromItemId === bId && l.toItemId === dropId);
	log(`TR-07 leg before: ${JSON.stringify(pre ? { mode: pre.mode, dur: pre.durationMin, src: pre.source } : null)}`);
	await page.goto(`/t/asia-2027?days=2027-10-21&sel=l.${bId}.${dropId}`);
	const ov = page.getByTestId(TESTID.legOverview);
	await expect(ov).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	await page.screenshot({ path: shot("tr07-0-open") });
	writeFileSync(path.join(OUT, "tr07-0-open.txt"), await ov.innerText());
	const overnight = page.getByTestId(T.overnightAddTransit);
	if (await overnight.isVisible().catch(() => false)) await overnight.click();
	await ov.locator(`[data-testid=${T.modeOption}][data-mode=transit]`).click();
	const panel = page.getByTestId(T.transitPanel);
	await expect(panel.getByTestId(T.transitOption).first()).toBeVisible({ timeout: 25_000 });
	await page.waitForTimeout(800);
	const opts = panel.getByTestId(T.transitOption);
	const n = await opts.count();
	const optInfo: string[] = [];
	for (let i = 0; i < n; i++) {
		const o = opts.nth(i);
		optInfo.push(`${await o.getAttribute("data-source")} chosen=${await o.getAttribute("data-chosen")} maps=${await o.getByTestId(T.googleMapsLink).getAttribute("href").catch(() => "NONE")} :: ${(await o.innerText()).replace(/\n/g, " ")}`);
	}
	log(`TR-07 estimate options (${n}):\n  ${optInfo.join("\n  ")}`);
	log(`TR-07 japan note: ${(await txt(page, T.japanNote)).replace(/\n/g, " / ")}`);
	log(`TR-07 attribution: ${await txt(page, T.railAttribution)}`);
	await page.screenshot({ path: shot("tr07-1-estimates") });
	// Build the custom route.
	await panel.getByTestId(T.customRouteAdd).click();
	const bld = panel.getByTestId(T.customRoute);
	await bld.getByTestId(T.customRouteLabel).fill("Fuji Excursion 7");
	await bld.getByTestId(T.customRouteStepMode).first().click();
	await page.getByRole("option", { name: "Walk" }).click();
	await bld.getByTestId(T.customRouteStepMinutes).first().fill("10");
	await bld.getByTestId(T.customRouteAddStep).click();
	// step 2: train (default after a walk)
	await bld.getByTestId(T.customRouteStepLine).last().fill("Fuji Excursion 7");
	await bld.getByTestId(T.customRouteStepFrom).last().fill("Shinjuku");
	const s1 = page.getByTestId(T.stationSuggestion).filter({ hasText: "新宿" }).first();
	await s1.waitFor({ timeout: 10_000 }).catch(() => log("TR-07 no 新宿 suggestion"));
	const fromSug = await page.getByTestId(T.stationSuggestion).allInnerTexts();
	log(`TR-07 'Shinjuku' suggestions: ${fromSug.slice(0, 5).join(" | ").replace(/\n/g, " ")}`);
	if (await s1.isVisible().catch(() => false)) await s1.click();
	await bld.getByTestId(T.customRouteStepTo).last().fill("Kawaguchiko");
	const s2 = page.getByTestId(T.stationSuggestion).filter({ hasText: "河口湖" }).first();
	await s2.waitFor({ timeout: 10_000 }).catch(() => log("TR-07 no 河口湖 suggestion for 'Kawaguchiko'"));
	const toSug = await page.getByTestId(T.stationSuggestion).allInnerTexts();
	log(`TR-07 'Kawaguchiko' suggestions: ${toSug.slice(0, 5).join(" | ").replace(/\n/g, " ")}`);
	if (await s2.isVisible().catch(() => false)) await s2.click();
	await page.waitForTimeout(1500);
	log(`TR-07 ride minutes auto: ${await bld.getByTestId(T.customRouteStepMinutes).last().inputValue()} line=${await bld.getByTestId(T.customRouteStepLine).last().inputValue()}`);
	await bld.getByTestId(T.customRouteStepLine).last().fill("Fuji Excursion 7");
	await bld.getByTestId(T.customRouteStepMinutes).last().fill("116");
	await bld.getByTestId(T.customRouteAddStep).click();
	await bld.getByTestId(T.customRouteStepMode).last().click();
	await page.getByRole("option", { name: "Taxi / car" }).click();
	await bld.getByTestId(T.customRouteStepMinutes).last().fill("10");
	await bld.getByTestId(T.customRouteReserved).click();
	await bld.getByTestId(T.customRouteDepartDate).fill("2027-10-21");
	await bld.getByTestId(T.customRouteDepartTime).fill("08:30");
	await bld.getByTestId(T.customRouteArriveDate).fill("2027-10-21");
	await bld.getByTestId(T.customRouteArriveTime).fill("10:26");
	const acc = bld.getByTestId(T.customRouteAccess);
	if (await acc.count()) log(`TR-07 access="${await acc.inputValue().catch(() => "?")}" egress="${await bld.getByTestId(T.customRouteEgress).inputValue().catch(() => "?")}"`);
	await bld.getByTestId(T.customRouteBooking).click();
	await bld.getByTestId(T.bookingRef).fill("e7k2q9");
	await bld.getByTestId(T.bookingCar).fill("3");
	const seats = bld.getByTestId(T.bookingSeat);
	if (await seats.count()) await seats.nth(0).fill("5a");
	if ((await seats.count()) > 1) await seats.nth(1).fill("5b");
	await page.screenshot({ path: shot("tr07-2-builder") });
	await bld.screenshot({ path: shot("tr07-2-builder-el") }).catch(() => {});
	await bld.getByTestId(T.customRouteSave).click();
	await page.waitForTimeout(2500);
	const ptext = await panel.innerText();
	writeFileSync(path.join(OUT, "tr07-3-saved.txt"), ptext);
	await page.screenshot({ path: shot("tr07-3-saved") });
	const manual = panel.locator(`[data-testid=${T.transitOption}][data-source=manual]`);
	log(`TR-07 manual cards=${await manual.count()} chosen=${await manual.first().getAttribute("data-chosen").catch(() => "?")} doorToDoor="${await txt(page, T.transitDoorToDoor)}" booking="${(await txt(page, T.chosenBooking)).replace(/\n/g, " / ")}"`);
	// Leg summary + Drop bags time in the Plan.
	const center = await page.getByTestId("center-panel").innerText();
	writeFileSync(path.join(OUT, "tr07-4-center.txt"), center);
	const legHead = await ov.innerText();
	log(`TR-07 overview head: ${legHead.split("\n").slice(0, 10).join(" / ")}`);
	// Refresh routes: the manual route must stay.
	const refresh = panel.getByTestId(T.transitRefresh);
	if (await refresh.count()) {
		await refresh.click();
		await page.waitForTimeout(3000);
		log(`TR-07 after Refresh routes: manual cards=${await manual.count()} total=${await panel.getByTestId(T.transitOption).count()}`);
	}
	// Map: the leg's edge at place lens follows N02 track.
	await page.goto(`/t/asia-2027?days=2027-10-21&lens=place`);
	await mapReady(page, "place");
	await settle(page);
	const dd = await drawn(page);
	const f = dd.allEdges.features.find((x) => String(x.properties.pairKey ?? x.properties.sel ?? "").includes(bId));
	log(`TR-07 map edge ${JSON.stringify(f ? { style: f.properties.style, approx: f.properties.approx, track: f.properties.track, est: f.properties.est, pts: f.geometry.coordinates.length } : null)}`);
	await page.screenshot({ path: shot("tr07-5-map") });
	// Also the estimate map edges elsewhere (JAL Sky Museum -> Gotokuji: estimate w/ geometry).
	await page.goto(`/t/asia-2027?days=2027-10-03&lens=place`);
	await mapReady(page, "place");
	await settle(page);
	const d3 = await drawn(page);
	const est = d3.allEdges.features.filter((x) => x.properties.est);
	log(`N02 estimate edges Day 2: ${est.map((x) => `${x.properties.style} track=${x.properties.track} approx=${x.properties.approx} pts=${x.geometry.coordinates.length}`).join(" | ")}`);
	await page.screenshot({ path: shot("n02-day2-map") });
	log(`TR-07 errors ${JSON.stringify(errors)}`);
});

test("TR-01/TR-04: Seoul pair without a key — walk, transit (no provider), taxi", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-18");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 45_000 });
	await page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph);
	let g = await graph(page);
	const dId = dayId(g, "2027-10-18");
	await createItem(page, { tripId: g.trip.id, dayId: dId, nodeId: nodeId(g, "Hannam"), title: "Hannam walk (TR-04)", durationMin: 60 });
	await page.reload();
	await page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph);
	g = await graph(page);
	const aId = g.items.find((i) => i.title === "Hannam walk (TR-04)" && i.dayId === dId)?.id ?? "";
	await createItem(page, { tripId: g.trip.id, dayId: dId, nodeId: nodeId(g, "Starfield Library (COEX)"), durationMin: 60, afterItemId: aId });
	await page.reload();
	await page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph);
	await page.waitForTimeout(4000);
	g = await graph(page);
	const bId = g.items.find((i) => i.dayId === dId && i.id !== aId && i.nodeId === nodeId(g, "Starfield Library (COEX)"))?.id ?? "";
	const pre = g.legs.find((l) => l.fromItemId === aId && l.toItemId === bId);
	log(`TR-04 seoul leg after autofill: ${JSON.stringify(pre ? { mode: pre.mode, dur: pre.durationMin, src: pre.source } : null)}`);
	writeFileSync(path.join(OUT, "tr04-0-center.txt"), await page.getByTestId("center-panel").innerText());
	await page.screenshot({ path: shot("tr04-0-plan") });
	await page.goto(`/t/asia-2027?days=2027-10-18&sel=l.${aId}.${bId}`);
	const ov = page.getByTestId(TESTID.legOverview);
	await expect(ov).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	writeFileSync(path.join(OUT, "tr04-1-open.txt"), await ov.innerText());
	const mode = (m: string) => ov.locator(`[data-testid=${T.modeOption}][data-mode=${m}]`);
	const startOfB = async () => {
		const gg = await graph(page);
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		const s = await page.evaluate((id) => (window as any).__yonder?.schedule?.items?.[id], bId);
		return { s: s ? { start: String(s.start), end: String(s.end) } : null, leg: gg.legs.find((l) => l.fromItemId === aId && l.toItemId === bId) };
	};
	// Transit (no key outside Japan).
	await mode("transit").click();
	await page.waitForTimeout(2000);
	const tp = page.getByTestId(T.transitPanel);
	writeFileSync(path.join(OUT, "tr04-2-transit.txt"), await tp.innerText());
	await page.screenshot({ path: shot("tr04-2-transit") });
	log(`TR-04 transit panel: ${(await tp.innerText()).replace(/\n/g, " / ")}`);
	await setDur(page, tp.getByTestId(T.transitTime), "25m").catch((e) => log(`TR-01 transit dur failed ${e}`));
	log(`TR-04 transit panel after 25m: ${(await tp.innerText()).replace(/\n/g, " / ")}`);
	log(`TR-01 after transit 25: ${JSON.stringify(await startOfB())}`);
	// Walk with a typed time.
	await mode("walk").click();
	await page.waitForTimeout(2500);
	const wp = page.getByTestId(T.walkPanel);
	writeFileSync(path.join(OUT, "tr04-3-walk.txt"), await wp.innerText().catch(() => "(no walk panel)"));
	log(`TR-04 walk panel: ${(await wp.innerText().catch(() => "")).replace(/\n/g, " / ")}`);
	await setDur(page, wp, "40m").catch((e) => log(`TR-01 walk dur failed ${e}`));
	log(`TR-01 after walk 40: ${JSON.stringify(await startOfB())}`);
	await page.screenshot({ path: shot("tr04-3-walk") });
	// Other: taxi 20.
	await mode("other").click();
	await page.waitForTimeout(1000);
	const op = page.getByTestId(T.otherPanel);
	const kinds = await op.getByTestId(T.otherKind).evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
	log(`TR-10 other kinds: ${kinds.join(",")}`);
	const taxi = op.locator(`[data-testid=${T.otherKind}][data-kind=taxi]`);
	if (await taxi.count()) await taxi.click();
	await setDur(page, op.getByTestId(T.otherMinutes), "20m").catch((e) => log(`TR-01 other dur failed ${e}`));
	log(`TR-01 after taxi 20: ${JSON.stringify(await startOfB())}`);
	writeFileSync(path.join(OUT, "tr04-4-taxi.txt"), await ov.innerText());
	writeFileSync(path.join(OUT, "tr04-4-center.txt"), await page.getByTestId("center-panel").innerText());
	await page.screenshot({ path: shot("tr04-4-taxi") });
	log(`TR-01/04 errors ${JSON.stringify(errors)}`);
});

test("TR-08 walk override + reset; TR-10 taxi before Chureito; TR-11 SP3 card", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-04");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 45_000 });
	await page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph);
	const g = await graph(page);
	const w = g.legs.find((l) => itemLabel(g, l.fromItemId) === "Senso-ji Temple" && itemLabel(g, l.toItemId) === "Kappabashi Street");
	await page.goto(`/t/asia-2027?days=2027-10-04&sel=l.${w?.fromItemId}.${w?.toItemId}`);
	const ov = page.getByTestId(TESTID.legOverview);
	await expect(ov).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	const wp = page.getByTestId(T.walkPanel);
	log(`TR-08 walk panel before: ${(await wp.innerText()).replace(/\n/g, " / ")}`);
	await setDur(page, wp, "20m").catch((e) => log(`TR-08 walk dur failed ${e}`));
	log(`TR-08 walk panel after 20: ${(await wp.innerText()).replace(/\n/g, " / ")}`);
	await page.screenshot({ path: shot("tr08-edited") });
	const plan = await page.getByTestId("center-panel").innerText();
	log(`TR-08 plan row mentions 20m: ${/20m/.test(plan)}`);
	const reset = wp.getByTestId(T.walkReset);
	log(`TR-08 reset button: ${(await reset.count()) ? await reset.innerText() : "NONE"}`);
	if (await reset.count()) {
		await reset.click();
		await page.waitForTimeout(1500);
		log(`TR-08 after reset: ${(await wp.innerText()).replace(/\n/g, " / ")}`);
	}
	// TR-11: SP3 card on Tue 26 Oct.
	await page.goto("/t/asia-2027?days=2027-10-26..2027-10-27");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 45_000 });
	await page.waitForTimeout(2500);
	const c26 = await page.getByTestId("center-panel").innerText();
	writeFileSync(path.join(OUT, "tr11-center.txt"), c26);
	await page.screenshot({ path: shot("tr11-sp3") });
	log(`TR-11 plan has 'Soft sleeper': ${c26.includes("Soft sleeper")} berths: ${/berth|Berth|1 2|1, 2/.test(c26)}`);
	log(`TR-08/11 errors ${JSON.stringify(errors)}`);
});
