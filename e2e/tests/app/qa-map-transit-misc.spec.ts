/** I2 map-transit: MAP-06/07, GRAN-05/07/15, TR-10 stay taxi, mobile Japan transit link. */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { asUser, drawn, type G, graph, itemLabel, mapReady, names, nm, OUT, onlyHere, screenPoint, settle, shot } from "./qa-map-transit-helpers";

onlyHere();
test.describe.configure({ mode: "serial" });
const LOG = path.join(OUT, "misc-results.txt");
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
const nodeId = (g: G, name: string) => g.nodes.find((n) => n.name === name)?.id ?? "";
const dayId = (g: G, date: string) => g.days.find((d) => d.date === date)?.id ?? "";
const ready = (page: Page) => page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph, null, { timeout: 45_000 });

test("MAP-06/MAP-07: MapLibre only; timeline hover highlights the pin; pin click scrolls the timeline", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	const gm: string[] = [];
	page.on("request", (r) => {
		if (/maps\.googleapis\.com|google\.com\/maps\/api/.test(r.url())) gm.push(r.url());
	});
	await page.goto("/t/asia-2027/japan/tokyo?lens=place&days=2027-10-05");
	await mapReady(page, "place");
	await settle(page);
	const g = await graph(page);
	const nb = nodeId(g, "Nakano Broadway");
	await page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		(window as any).__tripMap.jumpTo({ center: [139.69, 35.7], zoom: 15 });
	});
	await settle(page);
	const card = page.getByTestId(TESTID.timelineItem).filter({ hasText: "Nakano Broadway" }).first();
	const html0 = await page.evaluate((id) => (document.querySelector(`[data-testid="pin"][data-rep-id="${id}"]`)?.closest(".maplibregl-marker") as HTMLElement | null)?.outerHTML ?? "", nb);
	await card.hover();
	await page.waitForTimeout(500);
	const pinState = await page.evaluate((id) => {
		const el = document.querySelector(`[data-testid="pin"][data-rep-id="${id}"]`) as HTMLElement | null;
		if (!el) return "no pin";
		const attrs = Array.from(el.attributes).map((a) => `${a.name}=${a.value}`).filter((s) => /data-|aria-/.test(s));
		return `${attrs.join(" ")} class=${el.className} tf=${getComputedStyle(el).transform}`;
	}, nb);
	log(`MAP-07 hover Nakano card → pin: ${pinState}`);
	const html1 = await page.evaluate((id) => (document.querySelector(`[data-testid="pin"][data-rep-id="${id}"]`)?.closest(".maplibregl-marker") as HTMLElement | null)?.outerHTML ?? "", nb);
	log(`MAP-07 marker html changed on hover: ${html0 !== html1} ${html0 === html1 ? "" : `\n  before=${html0.slice(0, 400)}\n  after =${html1.slice(0, 400)}`}`);
	await page.screenshot({ path: shot("map07-hover") });
	const yb = nodeId(g, "Yodobashi Camera");
	const pinYb = page.locator(`[data-testid="pin"][data-rep-id="${yb}"]`);
	log(`MAP-07 Yodobashi pin visible=${await pinYb.isVisible()}`);
	if (await pinYb.isVisible()) {
		await pinYb.dispatchEvent("click");
		await page.waitForTimeout(1500);
		const sel = page.url();
		const cardYb = page.getByTestId(TESTID.timelineItem).filter({ hasText: "Yodobashi Camera" }).first();
		const inView = await cardYb.evaluate((el) => {
			const r = el.getBoundingClientRect();
			return { top: r.top, bottom: r.bottom, h: innerHeight, hl: el.getAttribute("data-selected") ?? el.getAttribute("aria-selected") ?? el.className.slice(0, 120) };
		});
		log(`MAP-07 after Yodobashi pin click url=${sel} card=${JSON.stringify(inView)}`);
		await page.screenshot({ path: shot("map07-pinclick") });
	}
	// Zoom + lens changes for MAP-06.
	for (const lens of ["area", "city"]) {
		await page.goto(`/t/asia-2027/japan/tokyo?lens=${lens}`);
		await page.waitForTimeout(2500);
	}
	log(`MAP-06 maplibre class=${await page.locator(".maplibregl-map").count()} attrib="${await page.locator(".maplibregl-ctrl-attrib").innerText().catch(() => "")}" google maps js requests=${gm.length}`);
	log(`MAP-06/07 errors ${JSON.stringify(errors)}`);
});

test("GRAN-07/GRAN-05: Bar Kuro (no coordinates) after Golden Gai; GRAN-15 Nara at ward lens", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-05");
	await ready(page);
	let g = await graph(page);
	const kuro = g.nodes.find((n) => n.name === "Bar Kuro");
	log(`GRAN-07 Bar Kuro node: ${JSON.stringify(kuro)}`);
	const gg = g.items.find((i) => itemLabel(g, i.id) === "Golden Gai" && i.dayId === dayId(g, "2027-10-05"));
	if (!g.items.some((i) => i.nodeId === kuro?.id && i.dayId === dayId(g, "2027-10-05")))
		log(`GRAN-07 create: ${JSON.stringify(await createItem(page, { tripId: g.trip.id, dayId: dayId(g, "2027-10-05"), nodeId: kuro?.id, durationMin: 60, afterItemId: gg?.id }))}`);
	await page.goto("/t/asia-2027?days=2027-10-05&lens=place");
	await mapReady(page, "place");
	await settle(page);
	const n = await names(page);
	const d = await drawn(page);
	const kp = d.pins.find((p) => p.repId === kuro?.id);
	const ggp = d.pins.find((p) => p.repId === nodeId(g, "Golden Gai"));
	log(`GRAN-07 place pins: ${d.pins.map((p) => `${nm(n, p.repId)}#${p.number}${p.hollow ? "(h)" : ""}`).join(", ")}`);
	log(`GRAN-07 kuro pin ${JSON.stringify(kp)} golden gai pin ${JSON.stringify(ggp ? { lat: ggp.lat, lng: ggp.lng } : null)}`);
	// Kuro pin DOM
	const kdom = await page.evaluate((id) => {
		const el = document.querySelector(`[data-testid="pin"][data-rep-id="${id}"]`) as HTMLElement | null;
		return el ? `${el.getAttribute("aria-label")} | ${el.className} | ${Array.from(el.attributes).map((a) => `${a.name}=${a.value}`).join(" ").slice(0, 300)}` : "no DOM pin";
	}, kuro?.id);
	log(`GRAN-07 kuro DOM: ${kdom}`);
	// Select Bar Kuro → details text.
	await page.goto(`/t/asia-2027?days=2027-10-05&lens=place&sel=n.${kuro?.id}`);
	await expect(page.getByTestId(TESTID.inspector)).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	const t = await page.getByTestId(TESTID.inspector).innerText();
	log(`GRAN-07 Bar Kuro details: ${t.replace(/\n/g, " / ").slice(0, 600)}`);
	await page.screenshot({ path: shot("gran07-kuro") });
	// Ward lens: Golden Gai + Bar Kuro roll into Shinjuku.
	await page.goto("/t/asia-2027?days=2027-10-05&lens=area");
	await mapReady(page, "area");
	const da = await drawn(page);
	log(`GRAN-05 area pins: ${da.pins.map((p) => `${nm(n, p.repId)}#${p.number}`).join(", ")}`);
	// GRAN-15: Nara day at ward lens.
	g = await graph(page);
	const nd = dayId(g, "2027-10-24");
	if (!g.items.some((i) => i.dayId === nd)) {
		await createItem(page, { tripId: g.trip.id, dayId: nd, nodeId: nodeId(g, "Todai-ji"), durationMin: 90 });
		await page.reload();
		await ready(page);
		g = await graph(page);
		const td = g.items.find((i) => i.dayId === nd)?.id;
		await createItem(page, { tripId: g.trip.id, dayId: nd, nodeId: nodeId(g, "Nara Park"), durationMin: 60, afterItemId: td });
	}
	await page.goto("/t/asia-2027?days=2027-10-24&lens=area");
	await mapReady(page, "area");
	await settle(page);
	const dn = await drawn(page);
	const n2 = await names(page);
	log(`GRAN-15 area pins: ${dn.pins.map((p) => `${nm(n2, p.repId)}#${p.number}`).join(", ")} edges=${dn.allEdges.features.length}`);
	await page.screenshot({ path: shot("gran15-nara") });
	log(`GRAN-05/07/15 errors ${JSON.stringify(errors)}`);
});

test("TR-10: the morning stay leg Kawaguchiko Ryokan → Chureito Pagoda as a 15 min taxi", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027/japan/mt-fuji?lens=place");
	await ready(page);
	const g = await graph(page);
	const fri = dayId(g, "2027-10-08");
	await page.goto(`/t/asia-2027/japan/mt-fuji?lens=place&sel=s.${fri}.start`);
	const ov = page.getByTestId(TESTID.legOverview);
	await expect(ov).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	log(`TR-10 stay leg panel: ${(await ov.innerText()).replace(/\n/g, " / ").slice(0, 500)}`);
	await ov.locator(`[data-testid=${T.modeOption}][data-mode=other]`).click();
	await page.waitForTimeout(800);
	const op = page.getByTestId(T.otherPanel);
	await op.locator(`[data-testid=${T.otherKind}][data-kind=taxi]`).click();
	await page.waitForTimeout(800);
	await op.getByTestId(T.otherMinutes).getByRole("button").first().click();
	const input = page.getByRole("dialog").locator("input").last();
	await input.fill("15m");
	await input.press("Enter");
	await page.waitForTimeout(2000);
	log(`TR-10 after taxi 15: ${(await ov.innerText()).replace(/\n/g, " / ").slice(0, 400)}`);
	await page.getByText("Taxi ~15 min at ~5:30").first().scrollIntoViewIfNeeded();
	await page.waitForTimeout(800);
	const center = await page.getByTestId("center-panel").innerText();
	const i = center.indexOf("from Kawaguchiko Ryokan");
	log(`TR-10 plan around the stay leg: ${center.slice(Math.max(0, i - 80), i + 200).replace(/\n/g, " / ")}`);
	await page.screenshot({ path: shot("tr10-taxi") });
	log(`TR-10 errors ${JSON.stringify(errors)}`);
});

test("mobile 390: Japan transit leg keeps Open in Google Maps; map tap", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test", { viewport: { width: 390, height: 844 } });
	await page.goto("/t/asia-2027?days=2027-10-05");
	await ready(page);
	const g = await graph(page);
	const l = g.legs.find((x) => itemLabel(g, x.fromItemId) === "Cha no Ikedaya" && itemLabel(g, x.toItemId) === "Nakano Broadway");
	await page.waitForTimeout(1500);
	await page.screenshot({ path: shot("m-plan") });
	await page.goto(`/t/asia-2027?days=2027-10-05&sel=l.${l?.fromItemId}.${l?.toItemId}`);
	await page.waitForTimeout(3500);
	await page.screenshot({ path: shot("m-leg") });
	const links = await page.getByTestId(T.googleMapsLink).evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.getAttribute("href")));
	log(`mobile Google Maps links visible: ${links.length} ${links[0] ?? ""}`);
	const ww = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
	log(`mobile overflow ${JSON.stringify(ww)}`);
	log(`mobile errors ${JSON.stringify(errors)}`);
});
