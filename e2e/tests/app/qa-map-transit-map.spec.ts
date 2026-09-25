/** I2 map-transit: QA MAP-0x / GRAN-xx on the QA seed's Asia 2027 (agent 23's own db). */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { MAP_TESTID } from "../../../src/features/map/testids";
import { TESTID } from "../../../src/lib/testids";
import {
	asUser,
	drawn,
	edgeName,
	type G,
	graph,
	itemLabel,
	mapReady,
	model,
	names,
	nm,
	OUT,
	onlyHere,
	screenPoint,
	settle,
	shot,
} from "./qa-map-transit-helpers";

onlyHere();
test.describe.configure({ mode: "serial" });

const LOG = path.join(OUT, "map-results.txt");
const log = (s: string) => appendFileSync(LOG, `${s}\n`);
test.beforeAll(() => writeFileSync(LOG, `run ${new Date().toISOString()}\n`));

const nodeId = (g: G, name: string, type?: string) =>
	g.nodes.find((n) => n.name === name && (!type || n.type === type))?.id ?? "";

async function clickEdge(page: Page, match: (p: Record<string, unknown>) => boolean) {
	const d = await drawn(page);
	const f = d.edges.features.find((x) => match(x.properties));
	if (!f) throw new Error("edge not drawn");
	const cs = f.geometry.coordinates;
	const cands: number[][] =
		cs.length === 2
			? [0.5, 0.4, 0.6, 0.3, 0.7].map((t) => [cs[0][0] + (cs[1][0] - cs[0][0]) * t, cs[0][1] + (cs[1][1] - cs[0][1]) * t])
			: [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9].map((t) => cs[Math.floor(cs.length * t)]);
	const box = await page.locator(".maplibregl-map").boundingBox();
	for (const c of cands) {
		const p = await screenPoint(page, c);
		if (box && p.x > box.x + 20 && p.x < box.x + box.width - 60 && p.y > box.y + 20 && p.y < box.y + box.height - 20) {
			await page.mouse.click(p.x, p.y);
			return f.properties;
		}
	}
	throw new Error("edge not on screen");
}
const inspectorText = async (page: Page) => {
	const l = page.getByTestId(TESTID.inspector);
	await expect(l).toBeVisible({ timeout: 15_000 });
	await page.waitForTimeout(1200);
	return l.innerText();
};

test("MAP-03 pin details (Golden Gai place, Tokyo city)", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027/japan/tokyo/shinjuku?lens=place");
	await mapReady(page, "place");
	await settle(page);
	const g = await graph(page);
	const gg = nodeId(g, "Golden Gai");
	const d = await drawn(page);
	log(`MAP-03 shinjuku place visiblePins=${d.visiblePins.length} clusters=${d.clusters.map((c) => c.count).join(",")}`);
	await page.screenshot({ path: shot("map03-shinjuku") });
	// Golden Gai may be clustered: zoom in to it first.
	const p = g.nodes.find((n) => n.id === gg);
	await page.evaluate((c) => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		(window as any).__tripMap.jumpTo({ center: c, zoom: 17 });
	}, [p?.lng ?? 0, p?.lat ?? 0]);
	await settle(page);
	await page.locator(`[data-testid="${TESTID.pin}"][data-rep-id="${gg}"]`).click();
	const t = await inspectorText(page);
	await page.screenshot({ path: shot("map03-goldengai") });
	writeFileSync(path.join(OUT, "map03-goldengai.txt"), t);
	log(`MAP-03 url=${page.url()}`);
	// Tokyo city pin at city lens.
	await page.goto("/t/asia-2027/japan?lens=city");
	await mapReady(page, "city");
	await settle(page);
	await page.locator(`[data-testid="${TESTID.pin}"][data-rep-id="${nodeId(g, "Tokyo", "city")}"]`).click({ position: { x: 8, y: 20 }, force: true });
	const t2 = await inspectorText(page);
	await page.screenshot({ path: shot("map03-tokyo") });
	writeFileSync(path.join(OUT, "map03-tokyo.txt"), t2);
	log(`MAP-03 errors ${JSON.stringify(errors)}`);
});

test("MAP-04 edge click: Fuji Excursion at area lens, NH 9 at city", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027/japan?lens=area&days=2027-10-07");
	await mapReady(page, "area");
	await settle(page);
	const n = await names(page);
	const d = await drawn(page);
	for (const f of d.edges.features) log(`MAP-04 area d7 edge ${edgeName(n, String(f.properties.edgeKey))} style=${f.properties.style} sel=${f.properties.sel} est=${f.properties.est} approx=${f.properties.approx} track=${f.properties.track} pts=${f.geometry.coordinates.length}`);
	const props = await clickEdge(page, (x) => x.style === "transit" && String(x.edgeKey).endsWith(nodeIdByName(n, "area:Kawaguchiko")));
	log(`MAP-04 clicked ${JSON.stringify(props)} url=${page.url()}`);
	const t = await inspectorText(page);
	await settle(page);
	await page.screenshot({ path: shot("map04-fuji-edge") });
	writeFileSync(path.join(OUT, "map04-fuji-edge.txt"), t);
	// NH 9 at root city lens.
	await page.goto("/t/asia-2027?lens=city");
	await mapReady(page, "city");
	await settle(page);
	const props2 = await clickEdge(page, (x) => x.style === "flight" && String(x.edgeKey).startsWith(nodeIdByName(n, "city:New York")));
	log(`MAP-04 NH9 clicked ${JSON.stringify(props2)} url=${page.url()}`);
	const t2 = await inspectorText(page);
	await settle(page);
	await page.screenshot({ path: shot("map04-nh9-edge") });
	writeFileSync(path.join(OUT, "map04-nh9-edge.txt"), t2);
	log(`MAP-04 errors ${JSON.stringify(errors)}`);
});

// names() map → reverse lookups
function await_g(n: Record<string, string>) {
	return {
		nodes: Object.entries(n)
			.filter(([, v]) => !v.startsWith("item:") && !v.startsWith("day:"))
			.map(([id, v]) => ({ id, name: v.split(":").slice(1).join(":"), type: v.split(":")[0] })),
	} as unknown as G;
}
const nodeIdByName = (n: Record<string, string>, v: string) => Object.entries(n).find(([, x]) => x === v)?.[0] ?? "none";

test("MAP-05 numbering + reorder updates edges live; GRAN-04/06/13", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?lens=place&days=2027-10-05");
	await mapReady(page, "place");
	await settle(page);
	const g = await graph(page);
	const n = await names(page);
	let d = await drawn(page);
	log(`MAP-05 pins ${d.pins.map((p) => `${nm(n, p.repId)}#${p.number}`).join(", ")}`);
	log(`MAP-05 edges ${d.allEdges.features.map((f) => edgeName(n, String(f.properties.edgeKey))).join(" | ")}`);
	// GRAN-06: hover the Nakano Broadway -> Yodobashi edge: tooltip "via Lunch".
	await page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		(window as any).__tripMap.jumpTo({ center: [139.69, 35.7], zoom: 14.2 });
	});
	await settle(page);
	const nb = nodeId(g, "Nakano Broadway");
	const f = (await drawn(page)).edges.features.find((x) => String(x.properties.edgeKey).startsWith(`${nb}>`));
	if (f) {
		const cs = f.geometry.coordinates;
		const mid = [(cs[0][0] + cs[cs.length - 1][0]) / 2, (cs[0][1] + cs[cs.length - 1][1]) / 2];
		const pt = await screenPoint(page, mid);
		await page.mouse.move(pt.x, pt.y);
		await page.waitForTimeout(600);
		const tip = page.getByTestId(MAP_TESTID.edgeTip);
		log(`GRAN-06 tooltip visible=${await tip.isVisible()} text=${(await tip.innerText().catch(() => "")).replace(/\n/g, " / ")}`);
		await page.screenshot({ path: shot("gran06-tip") });
		await page.mouse.click(pt.x, pt.y);
		const t = await inspectorText(page);
		writeFileSync(path.join(OUT, "gran13-edge.txt"), t);
		await page.screenshot({ path: shot("gran13-edge") });
		log(`GRAN-13 url ${page.url()}`);
	} else log("GRAN-06 edge Nakano Broadway> not drawn");
	// Reorder: Golden Gai above Bar Benfiddich (server fn, like a drop).
	const items = g.items.filter((i) => i.dayId === g.days.find((x) => x.date === "2027-10-05")?.id);
	const ggItem = items.find((i) => itemLabel(g, i.id) === "Golden Gai");
	const bbItem = items.find((i) => itemLabel(g, i.id) === "Bar Benfiddich");
	const res = await page.evaluate(
		async ({ itemId, beforeItemId, dayId }) => {
			const m = await import("/src/functions/items.functions.ts");
			try {
				return await m.moveItem({ data: { itemId, dayId, beforeItemId } });
			} catch (e) {
				return { error: String(e) };
			}
		},
		{ itemId: ggItem?.id ?? "", beforeItemId: bbItem?.id ?? "", dayId: ggItem?.dayId ?? "" },
	);
	log(`MAP-05 move result ${JSON.stringify(res)}`);
	await page.waitForTimeout(2500);
	d = await drawn(page);
	log(`MAP-05 after pins ${d.pins.map((p) => `${nm(n, p.repId)}#${p.number}`).join(", ")}`);
	log(`MAP-05 after edges ${d.allEdges.features.map((f) => edgeName(n, String(f.properties.edgeKey))).join(" | ")}`);
	// Move it back.
	await page.evaluate(
		async ({ itemId, afterItemId, dayId }) => {
			const m = await import("/src/functions/items.functions.ts");
			return m.moveItem({ data: { itemId, dayId, afterItemId } });
		},
		{ itemId: ggItem?.id ?? "", afterItemId: bbItem?.id ?? "", dayId: ggItem?.dayId ?? "" },
	);
	await page.waitForTimeout(2000);
	d = await drawn(page);
	log(`MAP-05 restored pins ${d.pins.map((p) => `${nm(n, p.repId)}#${p.number}`).join(", ")}`);
	log(`MAP-05 errors ${JSON.stringify(errors)}`);
});

test("GRAN-03 ward lens return trip; MAP-09 overnight; GRAN-14 stubs", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?lens=area&days=2027-10-05");
	await mapReady(page, "area");
	await settle(page);
	const n = await names(page);
	let d = await drawn(page);
	for (const f of d.edges.features) log(`GRAN-03 edge ${edgeName(n, String(f.properties.edgeKey))} ${JSON.stringify({ style: f.properties.style, curved: f.properties.curved, sel: f.properties.sel })}`);
	await page.screenshot({ path: shot("gran03-ward") });
	const e = d.edges.features;
	for (let k = 0; k < e.length; k++) {
		await page.goto("/t/asia-2027?lens=area&days=2027-10-05");
		await mapReady(page, "area");
		await settle(page);
		await clickEdge(page, (x) => x.fid === e[k].properties.fid);
		const t = await inspectorText(page);
		writeFileSync(path.join(OUT, `gran03-edge${k}.txt`), t);
		log(`GRAN-03 click ${k} url=${page.url()}`);
	}
	// MAP-09: scope Tokyo, place lens — the overnight connector Golden Gai -> Meiji Jingu.
	await page.goto("/t/asia-2027/japan/tokyo?lens=place");
	await mapReady(page, "place");
	await settle(page);
	d = await drawn(page);
	const on = d.allEdges.features.filter((f) => f.properties.style === "overnight");
	log(`MAP-09 overnight edges: ${on.map((f) => edgeName(n, String(f.properties.edgeKey))).join(" | ")}`);
	const gg = on.find((f) => edgeName(n, String(f.properties.edgeKey)).includes("Golden Gai"));
	if (gg) {
		await page.evaluate((cs) => {
			// biome-ignore lint/suspicious/noExplicitAny: introspection
			(window as any).__tripMap.fitBounds([cs[0], cs[cs.length - 1]].sort((a: number[], b: number[]) => a[0] - b[0]), { padding: 200, duration: 0 });
		}, gg.geometry.coordinates);
		await settle(page);
		const fid = gg.properties.fid;
		await clickEdge(page, (x) => x.fid === fid).catch((err) => log(`MAP-09 click fail ${err}`));
		const t = await inspectorText(page).catch(() => "(no inspector)");
		writeFileSync(path.join(OUT, "map09-overnight.txt"), t);
		await page.screenshot({ path: shot("map09-overnight") });
		log(`MAP-09 url=${page.url()} text0=${t.slice(0, 200).replace(/\n/g, " / ")}`);
	}
	// GRAN-14: scope Tokyo at area lens: ghost stubs for NH 9 (in) and Fuji Excursion (out).
	await page.goto("/t/asia-2027/japan/tokyo?lens=area");
	await mapReady(page, "area");
	await settle(page);
	d = await drawn(page);
	for (const f of d.ghosts.features) log(`GRAN-14 ghost ${JSON.stringify(f.properties)}`);
	log(`GRAN-14 pins ${d.pins.filter((p) => !p.hollow).map((p) => nm(n, p.repId)).join(", ")}`);
	await page.screenshot({ path: shot("gran14-tokyo-area") });
	log(`GRAN-03/MAP-09/GRAN-14 errors ${JSON.stringify(errors)}`);
});

test("GRAN-08 NH 9 across the Pacific; GRAN-10 Mt. Fuji scope; GRAN-11 single pin; GRAN-12 unscheduled/dropped", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?lens=city");
	await mapReady(page, "city");
	await settle(page);
	const n = await names(page);
	const d = await drawn(page);
	const nh9 = d.allEdges.features.find((f) => f.properties.style === "flight" && edgeName(n, String(f.properties.edgeKey)).startsWith("city:New York"));
	if (nh9) {
		const cs = nh9.geometry.coordinates;
		let maxJump = 0;
		for (let i = 1; i < cs.length; i++) maxJump = Math.max(maxJump, Math.abs(cs[i][0] - cs[i - 1][0]));
		const lats = cs.map((c) => c[1]);
		const lngs = cs.map((c) => c[0]);
		log(`GRAN-08 nh9 pts=${cs.length} maxJump=${maxJump.toFixed(2)} lngRange=${Math.min(...lngs).toFixed(1)}..${Math.max(...lngs).toFixed(1)} maxLat=${Math.max(...lats).toFixed(1)} first=${cs[0]} last=${cs[cs.length - 1]}`);
	} else log("GRAN-08 no NH 9 edge");
	await page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		(window as any).__tripMap.jumpTo({ center: [180, 45], zoom: 1.6 });
	});
	await settle(page);
	await page.screenshot({ path: shot("gran08-pacific") });
	// GRAN-10: scope Mt. Fuji.
	for (const lens of ["place", "area", "city", "country"]) {
		await page.goto(`/t/asia-2027/japan/mt-fuji?lens=${lens}`);
		await mapReady(page).catch(() => {});
		await settle(page).catch(() => {});
		const ok = await page
			.evaluate(() => {
				// biome-ignore lint/suspicious/noExplicitAny: introspection
				const m = (window as any).__tripMap;
				return m?.__yonder ? { lens: m.__yonder.lens, pins: m.__yonder.pins.length, edges: m.__yonder.allEdges.features.length } : null;
			})
			.catch(() => null);
		const hint = (await page.getByTestId(MAP_TESTID.scopeHint).count()) ? await page.getByTestId(MAP_TESTID.scopeHint).innerText() : "(none)";
		const url = page.url();
		log(`GRAN-10 lens=${lens} url=${url} drawn=${JSON.stringify(ok)} hint=${hint}`);
		const nn = await names(page);
		const dd = await drawn(page).catch(() => null);
		if (dd) log(`GRAN-10   pins=${dd.pins.filter((p) => !p.hollow).map((p) => nm(nn, p.repId)).join(", ")} edges=${dd.allEdges.features.map((f) => edgeName(nn, String(f.properties.edgeKey))).join(" | ")}`);
		await page.screenshot({ path: shot(`gran10-${lens}`) });
	}
	// GRAN-11: scope Golden Gai.
	await page.goto("/t/asia-2027/japan/tokyo/shinjuku/golden-gai");
	await page.waitForTimeout(3500);
	const z = await page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		const m = (window as any).__tripMap;
		return m ? { z: m.getZoom(), lens: m.__yonder?.lens, pins: m.__yonder?.pins.length } : null;
	});
	log(`GRAN-11 golden gai url=${page.url()} ${JSON.stringify(z)}`);
	await page.screenshot({ path: shot("gran11-goldengai") });
	// GRAN-12: Tokyo place, show unscheduled.
	await page.goto("/t/asia-2027/japan/tokyo?lens=place");
	await mapReady(page, "place");
	await settle(page);
	const d12 = await drawn(page);
	const hollow = d12.pins.filter((p) => p.hollow).map((p) => nm(n, p.repId));
	log(`GRAN-12 Tokyo place hollow=${hollow.length}: ${hollow.join(", ")}`);
	await page.getByTestId(MAP_TESTID.layersButton).click();
	await page.waitForTimeout(500);
	const menu = (await page.getByTestId(MAP_TESTID.layerMenu).count()) ? await page.getByTestId(MAP_TESTID.layerMenu).innerText() : "(none)";
	log(`GRAN-12 layer menu: ${menu.replace(/\n/g, " / ")}`);
	await page.screenshot({ path: shot("gran12-layers") });
	log(`GRAN-08/10/11/12 errors ${JSON.stringify(errors)}`);
});
