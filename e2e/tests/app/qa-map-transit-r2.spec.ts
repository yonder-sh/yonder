/** I2 map-transit round 2: re-verify the round-1 MT-* defects on a fresh QA seed (agent 23, :5330). */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { asUser, drawn, type G, graph, itemLabel, legBetween, mapReady, OUT, onlyHere, settle, shot } from "./qa-map-transit-helpers";

onlyHere();
test.describe.configure({ mode: "serial" });
const LOG = path.join(OUT, "r2-results.txt");
const log = (s: string) => appendFileSync(LOG, `${s}\n`);
test.beforeAll(() => appendFileSync(LOG, `\n=== run ${new Date().toISOString()} ${process.env.QA_ONLY ?? ""}\n`));
const ready = (page: Page) =>
	page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph, null, { timeout: 45_000 });
const only = (id: string) => test.skip(!!process.env.QA_ONLY && !process.env.QA_ONLY.split(",").includes(id), "filtered");

async function legState(page: Page, from: string, to: string) {
	const g = await graph(page);
	const l = legBetween(g, from, to);
	if (!l) return null;
	const d = l.details as Record<string, unknown> & { route?: { id?: string; label?: string; source?: string }; chosenId?: string; alternatives?: unknown[] };
	return {
		mode: l.mode,
		dur: l.durationMin,
		src: l.source,
		route: d.route ? { id: d.route.id, label: d.route.label, source: d.route.source } : null,
		chosenId: d.chosenId,
		alts: Array.isArray(d.alternatives) ? d.alternatives.length : undefined,
	};
}
async function optionRows(page: Page) {
	const panel = page.getByTestId(T.transitPanel);
	const opts = panel.getByTestId(T.transitOption);
	const n = await opts.count();
	const out: string[] = [];
	for (let i = 0; i < n; i++) {
		const o = opts.nth(i);
		const maps = await o.getByTestId(T.googleMapsLink).count();
		out.push(
			`[${await o.getAttribute("data-source")} chosen=${await o.getAttribute("data-chosen")} gmaps=${maps}] ${(await o.innerText()).replace(/\n+/g, " · ")}`,
		);
	}
	return out;
}

const MT01 = [
	{ day: "2027-10-03", from: "Arrival formalities", to: "Anamori Inari Shrine", tag: "keikyu" },
	{ day: "2027-10-07", from: "Breakfast", to: "Drop bags at ryokan", tag: "fuji" },
	{ day: "2027-10-08", from: "Lunch", to: "Dinner", tag: "shiraito" },
];

test("MT-01/MT-07: imported manual Japan routes survive the first open, Refresh and a reload; reserved wait", async ({ browser }) => {
	only("mt01");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-03");
	await ready(page);
	for (const c of MT01) {
		const g = await graph(page);
		const l = legBetween(g, c.from, c.to);
		log(`MT-01 ${c.tag} before open: ${JSON.stringify(await legState(page, c.from, c.to))}`);
		if (!l) continue;
		await page.goto(`/t/asia-2027?days=${c.day}&sel=l.${l.fromItemId}.${l.toItemId}`);
		const ov = page.getByTestId(TESTID.legOverview);
		await expect(ov).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(3500);
		const rows = await optionRows(page);
		log(`MT-01 ${c.tag} options after 3.5s (${rows.length}):\n   ${rows.join("\n   ")}`);
		log(`MT-01 ${c.tag} door-to-door="${(await page.getByTestId(T.transitDoorToDoor).allInnerTexts()).join("|")}" booking="${(await page.getByTestId(T.chosenBooking).allInnerTexts()).join("|").replace(/\n/g, " ")}"`);
		log(`MT-01 ${c.tag} state after open: ${JSON.stringify(await legState(page, c.from, c.to))}`);
		writeFileSync(path.join(OUT, `mt01-${c.tag}.txt`), await ov.innerText());
		await page.screenshot({ path: shot(`mt01-${c.tag}-open`) });
		const refresh = page.getByTestId(T.transitRefresh);
		if (await refresh.count()) {
			await refresh.first().click();
			await page.waitForTimeout(3000);
			const rows2 = await optionRows(page);
			log(`MT-01 ${c.tag} after Refresh (${rows2.length}): manual=${rows2.filter((r) => r.startsWith("[manual")).length} chosen=${rows2.filter((r) => r.includes("chosen=true")).map((r) => r.slice(0, 80)).join(" | ")}`);
		} else log(`MT-01 ${c.tag} no Refresh button`);
		await page.reload();
		await expect(ov).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(2500);
		const rows3 = await optionRows(page);
		log(`MT-01 ${c.tag} after reload (${rows3.length}): manual=${rows3.filter((r) => r.startsWith("[manual")).length}; state=${JSON.stringify(await legState(page, c.from, c.to))}`);
		const head = (await ov.innerText()).split("\n").slice(0, 8).join(" / ");
		log(`MT-01 ${c.tag} overview head: ${head}`);
	}
	// MT-07 contrast: SP3 (Board SP3 -> Lào Cai Station).
	const g = await graph(page);
	const sp3 = g.legs.find((l) => itemLabel(g, l.fromItemId) === "Board SP3");
	if (sp3) {
		await page.goto(`/t/asia-2027?days=2027-10-26&sel=l.${sp3.fromItemId}.${sp3.toItemId}`);
		await expect(page.getByTestId(TESTID.legOverview)).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(2500);
		log(`MT-07 SP3 door-to-door="${(await page.getByTestId(T.transitDoorToDoor).allInnerTexts()).join("|")}"`);
		writeFileSync(path.join(OUT, "mt07-sp3.txt"), await page.getByTestId(TESTID.legOverview).innerText());
		await page.screenshot({ path: shot("mt07-sp3") });
	}
	log(`MT-01 errors ${JSON.stringify(errors)}`);
});

test("MT-06: walk beats a walk-only 'transit'; Kappabashi → Nihonbashi options are sane; every Japan transit row has Google Maps", async ({ browser }) => {
	only("mt06");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-07");
	await ready(page);
	await page.waitForTimeout(3000);
	log(`MT-06 Oishi→Lake state: ${JSON.stringify(await legState(page, "Oishi Park", "Lake Kawaguchiko"))}`);
	const g = await graph(page);
	// Every Japan transit leg in the graph: is there a Google Maps link on its Plan row?
	for (const pair of [
		["Oishi Park", "Lake Kawaguchiko", "2027-10-07"],
		["Kappabashi Street", "Nihonbashi Nishikawa", "2027-10-04"],
	]) {
		const l = legBetween(g, pair[0], pair[1]);
		if (!l) {
			log(`MT-06 no leg ${pair[0]} → ${pair[1]}`);
			continue;
		}
		await page.goto(`/t/asia-2027?days=${pair[2]}&sel=l.${l.fromItemId}.${l.toItemId}`);
		const ov = page.getByTestId(TESTID.legOverview);
		await expect(ov).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(1500);
		const tr = ov.locator(`[data-testid=${T.modeOption}][data-mode=transit]`);
		const wasTransit = (await tr.getAttribute("aria-pressed")) === "true" || (await tr.getAttribute("data-state")) === "on" || (await tr.getAttribute("aria-checked")) === "true";
		log(`MT-06 ${pair[0]}→${pair[1]} head: ${(await ov.innerText()).split("\n").slice(0, 6).join(" / ")} transitSelected=${wasTransit}`);
		if (!wasTransit) await tr.click();
		await expect(page.getByTestId(T.transitPanel).getByTestId(T.transitOption).first()).toBeVisible({ timeout: 25_000 });
		await page.waitForTimeout(800);
		log(`MT-06 ${pair[0]}→${pair[1]} options:\n   ${(await optionRows(page)).join("\n   ")}`);
		log(`MT-06 ${pair[0]}→${pair[1]} notes: ${(await page.getByTestId(T.japanNote).allInnerTexts()).join(" | ").replace(/\n/g, " ")}`);
		await page.screenshot({ path: shot(`mt06-${pair[0].split(" ")[0].toLowerCase()}`) });
		// put it back without saving anything else: leave (no undo needed for a read)
	}
	log(`MT-06 errors ${JSON.stringify(errors)}`);
});

test("TR-07/MT-05/MT-04: build Fuji Excursion 7 by hand with N02 stations; line name kept; stations bilingual; N02 attribution on the map", async ({ browser }) => {
	only("mt05");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-21");
	await ready(page);
	let g = await graph(page);
	const dId = g.days.find((d) => d.date === "2027-10-21")?.id ?? "";
	const nid = (name: string) => g.nodes.find((n) => n.name === name)?.id ?? "";
	const mk = (data: Record<string, unknown>) =>
		page.evaluate(async (data) => {
			const m = await import("/src/functions/items.functions.ts");
			try {
				return await m.createItem({ data: data as never });
			} catch (e) {
				return { error: String(e) };
			}
		}, data);
	if (!g.items.some((i) => i.title === "Breakfast (R2)")) {
		const b = (await mk({ tripId: g.trip.id, dayId: dId, nodeId: nid("Shinjuku"), title: "Breakfast (R2)", durationMin: 30, pinnedStart: "07:30" })) as { itemId?: string };
		await mk({ tripId: g.trip.id, dayId: dId, nodeId: nid("Kawaguchiko Ryokan"), title: "Drop bags (R2)", durationMin: 30, afterItemId: b.itemId });
	}
	await page.reload();
	await ready(page);
	await page.waitForTimeout(3000);
	g = await graph(page);
	const bId = g.items.find((i) => i.title === "Breakfast (R2)")?.id ?? "";
	const dropId = g.items.find((i) => i.title === "Drop bags (R2)")?.id ?? "";
	await page.goto(`/t/asia-2027?days=2027-10-21&sel=l.${bId}.${dropId}`);
	const ov = page.getByTestId(TESTID.legOverview);
	await expect(ov).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	const overnight = page.getByTestId(T.overnightAddTransit);
	if (await overnight.isVisible().catch(() => false)) await overnight.click();
	await ov.locator(`[data-testid=${T.modeOption}][data-mode=transit]`).click();
	const panel = page.getByTestId(T.transitPanel);
	await expect(panel.getByTestId(T.transitOption).first()).toBeVisible({ timeout: 25_000 });
	await panel.getByTestId(T.customRouteAdd).click();
	const bld = panel.getByTestId(T.customRoute);
	await bld.getByTestId(T.customRouteLabel).fill("Fuji Excursion 7");
	await bld.getByTestId(T.customRouteStepMode).first().click();
	await page.getByRole("option", { name: "Walk" }).click();
	await bld.getByTestId(T.customRouteStepMinutes).first().fill("10");
	await bld.getByTestId(T.customRouteAddStep).click();
	await bld.getByTestId(T.customRouteStepLine).last().fill("Fuji Excursion 7");
	await bld.getByTestId(T.customRouteStepFrom).last().fill("Shinjuku");
	const s1 = page.getByTestId(T.stationSuggestion).filter({ hasText: "新宿" }).first();
	await s1.waitFor({ timeout: 10_000 });
	log(`MT-05 'Shinjuku' suggestions: ${(await page.getByTestId(T.stationSuggestion).allInnerTexts()).slice(0, 5).join(" | ").replace(/\n/g, " ")}`);
	await s1.click();
	await page.waitForTimeout(500);
	log(`MT-05 after From pick: line="${await bld.getByTestId(T.customRouteStepLine).last().inputValue()}" from="${await bld.getByTestId(T.customRouteStepFrom).last().inputValue()}"`);
	await bld.getByTestId(T.customRouteStepTo).last().fill("Kawaguchiko");
	const s2 = page.getByTestId(T.stationSuggestion).filter({ hasText: "河口湖" }).first();
	await s2.waitFor({ timeout: 10_000 });
	log(`MT-05 'Kawaguchiko' suggestions: ${(await page.getByTestId(T.stationSuggestion).allInnerTexts()).slice(0, 5).join(" | ").replace(/\n/g, " ")}`);
	await s2.click();
	await page.waitForTimeout(1500);
	log(`MT-05 after To pick: line="${await bld.getByTestId(T.customRouteStepLine).last().inputValue()}" to="${await bld.getByTestId(T.customRouteStepTo).last().inputValue()}" minutes="${await bld.getByTestId(T.customRouteStepMinutes).last().inputValue()}"`);
	await bld.screenshot({ path: shot("mt05-builder-after-picks") }).catch(() => {});
	await bld.getByTestId(T.customRouteStepMinutes).last().fill("116");
	await bld.getByTestId(T.customRouteAddStep).click();
	await bld.getByTestId(T.customRouteStepMode).last().click();
	await page.getByRole("option", { name: /Taxi/ }).click();
	await bld.getByTestId(T.customRouteStepMinutes).last().fill("10");
	await bld.getByTestId(T.customRouteReserved).click();
	await bld.getByTestId(T.customRouteDepartDate).fill("2027-10-21");
	await bld.getByTestId(T.customRouteDepartTime).fill("08:30");
	await bld.getByTestId(T.customRouteArriveDate).fill("2027-10-21");
	await bld.getByTestId(T.customRouteArriveTime).fill("10:26");
	await bld.getByTestId(T.customRouteBooking).click();
	await bld.getByTestId(T.bookingRef).fill("e7k2q9");
	await bld.getByTestId(T.bookingCar).fill("3");
	const seats = bld.getByTestId(T.bookingSeat);
	if (await seats.count()) await seats.nth(0).fill("5a");
	if ((await seats.count()) > 1) await seats.nth(1).fill("5b");
	await bld.screenshot({ path: shot("mt05-builder-full") }).catch(() => {});
	await bld.getByTestId(T.customRouteSave).click();
	await page.waitForTimeout(2500);
	await page.screenshot({ path: shot("mt05-saved") });
	g = await graph(page);
	const leg = g.legs.find((l) => l.fromItemId === bId && l.toItemId === dropId);
	const route = (leg?.details as { route?: { label?: string; segments?: Record<string, unknown>[] } })?.route;
	log(`MT-05 stored route label="${route?.label}" segments=${JSON.stringify(route?.segments?.map((s) => ({ mode: s.mode, line: s.lineName, short: s.lineShort, from: (s.from as { name?: string; localName?: string })?.name, fromLocal: (s.from as { localName?: string })?.localName, to: (s.to as { name?: string })?.name, toLocal: (s.to as { localName?: string })?.localName, vt: s.vehicleType, dur: s.durationMin, track: Array.isArray(s.polyline) || !!s.geometry || !!s.track })))}`);
	log(`MT-05 manual card: ${(await optionRows(page)).filter((r) => r.startsWith("[manual")).join(" | ")}`);
	log(`TR-07 door-to-door="${(await page.getByTestId(T.transitDoorToDoor).allInnerTexts()).join("|")}" booking="${(await page.getByTestId(T.chosenBooking).allInnerTexts()).join("|").replace(/\n/g, " ")}"`);
	const center = await page.getByTestId("center-panel").innerText();
	const iDrop = center.indexOf("Drop bags (R2)");
	log(`TR-07 plan around Drop bags: ${center.slice(Math.max(0, iDrop - 260), iDrop + 40).replace(/\n/g, " / ")}`);
	writeFileSync(path.join(OUT, "mt05-leg.json"), JSON.stringify(leg?.details, null, 1));
	// Map: place lens for that day: N02 track + attribution.
	await page.goto("/t/asia-2027?days=2027-10-21&lens=place");
	await mapReady(page, "place");
	await settle(page);
	const dd = await drawn(page);
	const f = dd.allEdges.features.find((x) => JSON.stringify(x.properties).includes(bId));
	log(`MT-04 edge ${JSON.stringify(f ? { props: f.properties, pts: f.geometry.coordinates.length } : null).slice(0, 600)}`);
	const attrib = await page.locator(".maplibregl-ctrl-attrib").innerText().catch(() => "");
	const attribHtml = await page.locator(".maplibregl-ctrl-attrib").innerHTML().catch(() => "");
	log(`MT-04 map attribution: "${attrib.replace(/\n/g, " ")}" has N02=${/N02|MLIT|国土数値/.test(attribHtml)}`);
	await page.screenshot({ path: shot("mt04-map-day") });
	// Open the attribution if collapsed
	const btn = page.locator(".maplibregl-ctrl-attrib-button");
	if (await btn.isVisible().catch(() => false)) {
		await btn.click();
		await page.waitForTimeout(400);
		log(`MT-04 attribution expanded: "${(await page.locator(".maplibregl-ctrl-attrib").innerText()).replace(/\n/g, " ")}"`);
		await page.screenshot({ path: shot("mt04-map-attrib") });
	}
	log(`MT-05 errors ${JSON.stringify(errors)}`);
});

test("TR-07b: the hand-built route with the day starting 07:30 (F4-c conditions)", async ({ browser }) => {
	only("tr07b");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-21");
	await ready(page);
	let g = await graph(page);
	const dId = g.days.find((d) => d.date === "2027-10-21")?.id ?? "";
	const r = await page.evaluate(async (dayId) => {
		const m = await import("/src/functions/days.functions.ts");
		try {
			return await m.updateDay({ data: { dayId, startTime: "07:30" } as never });
		} catch (e) {
			return { error: String(e) };
		}
	}, dId);
	log(`TR-07b updateDay: ${JSON.stringify(r).slice(0, 200)}`);
	await page.reload();
	await ready(page);
	await page.waitForTimeout(2500);
	g = await graph(page);
	const bId = g.items.find((i) => i.title === "Breakfast (R2)")?.id ?? "";
	const dropId = g.items.find((i) => i.title === "Drop bags (R2)")?.id ?? "";
	await page.goto(`/t/asia-2027?days=2027-10-21&sel=l.${bId}.${dropId}`);
	await expect(page.getByTestId(TESTID.legOverview)).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(2000);
	log(`TR-07b door-to-door="${(await page.getByTestId(T.transitDoorToDoor).allInnerTexts()).join("|")}"`);
	const center = await page.getByTestId("center-panel").innerText();
	const iDrop = center.indexOf("Drop bags (R2)");
	log(`TR-07b plan: ${center.slice(Math.max(0, iDrop - 300), iDrop + 30).replace(/\n/g, " / ")}`);
	await page.screenshot({ path: shot("tr07b") });
	log(`TR-07b errors ${JSON.stringify(errors)}`);
});

test("MT-02: clicking the centre of the Tokyo pin at Japan/city opens Tokyo; marker z-indexes are integers", async ({ browser }) => {
	only("mt02");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027/japan?lens=city");
	await mapReady(page, "city");
	await settle(page);
	const g = await graph(page);
	const names = Object.fromEntries(g.nodes.map((n) => [n.id, n.name]));
	const rows = await page.evaluate(() =>
		Array.from(document.querySelectorAll(".maplibregl-marker")).map((m) => {
			const pin = m.querySelector('[data-testid="pin"]') as HTMLElement | null;
			return { rep: pin?.dataset.repId ?? "-", styleZ: (m as HTMLElement).style.zIndex, cz: getComputedStyle(m).zIndex, hollow: !!m.querySelector(".is-hollow") };
		}),
	);
	const frac = rows.filter((r) => r.styleZ && !/^-?\d+$/.test(r.styleZ));
	log(`MT-02 markers=${rows.length} fractional=${frac.length} sample=${rows.slice(0, 8).map((r) => `${names[r.rep] ?? r.rep}:${r.styleZ}/${r.cz}${r.hollow ? "(idea)" : ""}`).join(", ")}`);
	const tokyo = g.nodes.find((n) => n.name === "Tokyo")?.id ?? "";
	const pin = page.locator(`[data-testid="pin"][data-rep-id="${tokyo}"]`);
	const box = await pin.boundingBox();
	const hit = await page.evaluate((b) => {
		if (!b) return "no box";
		const h = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) as HTMLElement | null;
		const p = h?.closest('[data-testid="pin"]') as HTMLElement | null;
		return p?.dataset.repId ?? `${h?.tagName}.${String(h?.className).slice(0, 40)}`;
	}, box);
	log(`MT-02 element at Tokyo pin centre: ${names[hit] ?? hit}`);
	if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await page.waitForTimeout(1500);
	const sel = new URL(page.url()).searchParams.get("sel") ?? "";
	log(`MT-02 after click: sel=${sel} -> ${names[sel.replace(/^n\./, "")] ?? sel}; inspector title="${(await page.getByTestId(TESTID.inspector).innerText().catch(() => "")).split("\n")[0]}"`);
	await page.screenshot({ path: shot("mt02-tokyo-click") });
	log(`MT-02 errors ${JSON.stringify(errors)}`);
});

test("MT-03: root globe with a leg deep link points at the trip, not the far side", async ({ browser }) => {
	only("mt03");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	const cam = () =>
		page.evaluate(() => {
			// biome-ignore lint/suspicious/noExplicitAny: introspection
			const m = (window as any).__tripMap;
			const c = m.getCenter();
			const W = m.getContainer().clientWidth;
			const H = m.getContainer().clientHeight;
			const pins = m.__yonder?.pins ?? [];
			let inView = 0;
			for (const p of pins) {
				if (p.lng == null) continue;
				const q = m.project([p.lng, p.lat]);
				if (q.x > 0 && q.x < W && q.y > 0 && q.y < H) inView++;
			}
			return `center=${c.lng.toFixed(1)},${c.lat.toFixed(1)} z=${m.getZoom().toFixed(2)} proj=${m.getProjection?.()?.type ?? "?"} pinsInView=${inView}/${pins.length}`;
		});
	await page.goto("/t/asia-2027?tab=plan");
	await mapReady(page, "country");
	await settle(page);
	log(`MT-03 no sel: ${await cam()}`);
	await page.screenshot({ path: shot("mt03-nosel") });
	const g = await graph(page);
	for (const [from, label] of [
		["Kappabashi Street", "kappabashi"],
		["Check in (JFK T7)", "nh9"],
		["Board SP3", "sp3"],
	]) {
		const l = g.legs.find((x) => itemLabel(g, x.fromItemId) === from);
		if (!l) continue;
		await page.goto(`/t/asia-2027?sel=l.${l.fromItemId}.${l.toItemId}`);
		await mapReady(page);
		await settle(page);
		await page.waitForTimeout(1000);
		log(`MT-03 deep link ${label}: ${await cam()}`);
		await page.screenshot({ path: shot(`mt03-sel-${label}`) });
	}
	// Reload with a leg selected.
	await page.reload();
	await mapReady(page);
	await settle(page);
	await page.waitForTimeout(1000);
	log(`MT-03 reload with sp3 selected: ${await cam()}`);
	log(`MT-03 errors ${JSON.stringify(errors)}`);
});

test("MT-09: hovering a timeline card highlights its pin (MAP-07)", async ({ browser }) => {
	only("mt09");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027/japan/tokyo?lens=place&days=2027-10-05");
	await mapReady(page, "place");
	await settle(page);
	const g = await graph(page);
	const nb = g.nodes.find((n) => n.name === "Nakano Broadway")?.id ?? "";
	const pinInfo = () =>
		page.evaluate((id) => {
			const el = document.querySelector(`[data-testid="pin"][data-rep-id="${id}"]`) as HTMLElement | null;
			if (!el) return "no pin";
			const mk = el.closest(".maplibregl-marker") as HTMLElement | null;
			const attrs = Array.from(el.attributes).map((a) => `${a.name}=${a.value}`).filter((s) => /^(data-(?!tsd)|aria-|class)/.test(s));
			return `${attrs.join(" ")} z=${mk?.style.zIndex} tf=${getComputedStyle(el).transform} shadow=${getComputedStyle(el).boxShadow.slice(0, 60)}`;
		}, nb);
	const before = await pinInfo();
	const card = page.getByTestId(TESTID.timelineItem).filter({ hasText: "Nakano Broadway" }).first();
	await card.hover();
	await page.waitForTimeout(600);
	const during = await pinInfo();
	const hover = await page.evaluate(async () => {
		const m = await import("/src/lib/workspace/ui-store.ts");
		return JSON.stringify(m.useUi.getState().hover);
	});
	log(`MT-09 before: ${before}`);
	log(`MT-09 hover:  ${during}`);
	log(`MT-09 ui.hover=${hover}`);
	await page.screenshot({ path: shot("mt09-hover") });
	const pin = page.locator(`[data-testid="pin"][data-rep-id="${nb}"]`);
	await pin.screenshot({ path: shot("mt09-hover-pin") }).catch(() => {});
	await page.mouse.move(5, 5);
	await page.waitForTimeout(500);
	log(`MT-09 after leave: ${await pinInfo()}`);
	// Leg row hover highlights the edge?
	const legRow = page.getByTestId(TESTID.leg).first();
	if (await legRow.count()) {
		await legRow.hover();
		await page.waitForTimeout(400);
		const h2 = await page.evaluate(async () => {
			const m = await import("/src/lib/workspace/ui-store.ts");
			return JSON.stringify(m.useUi.getState().hover);
		});
		log(`MT-09 leg row hover ui.hover=${h2}`);
	}
	log(`MT-09 errors ${JSON.stringify(errors)}`);
});

test("TR-11/MT-10: SP3 card shows class and berths; SP4", async ({ browser }) => {
	only("mt10");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-26..2027-10-29");
	await ready(page);
	await page.waitForTimeout(3000);
	const g = await graph(page);
	for (const from of ["Board SP3", "Board SP4"]) {
		const l = g.legs.find((x) => itemLabel(g, x.fromItemId) === from);
		log(`TR-11 ${from} leg: ${JSON.stringify(l ? { mode: l.mode, dur: l.durationMin, details: l.details } : null).slice(0, 900)}`);
	}
	const rows = page.getByTestId(TESTID.leg);
	const n = await rows.count();
	for (let i = 0; i < n; i++) {
		const t = (await rows.nth(i).innerText()).replace(/\n/g, " / ");
		if (/SP3|SP4/.test(t)) log(`TR-11 leg row: ${t}`);
	}
	await page.screenshot({ path: shot("tr11-plan") });
	const sp3 = page.getByTestId(TESTID.leg).filter({ hasText: "SP3" }).first();
	if (await sp3.count()) {
		await sp3.scrollIntoViewIfNeeded();
		await sp3.screenshot({ path: shot("tr11-sp3-row") });
	}
	log(`TR-11 errors ${JSON.stringify(errors)}`);
});

test("MT-03b: with the inspector open on the root globe, which pins sit under the inspector", async ({ browser }) => {
	only("mt03b");
	const { page } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?tab=plan");
	await mapReady(page, "country");
	const g = await graph(page);
	const l = g.legs.find((x) => itemLabel(g, x.fromItemId) === "Kappabashi Street");
	await page.goto(`/t/asia-2027?sel=l.${l?.fromItemId}.${l?.toItemId}`);
	await mapReady(page, "country");
	await settle(page);
	await page.waitForTimeout(800);
	const v = await page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		const m = (window as any).__tripMap;
		const insp = document.querySelector("[data-testid=inspector]")?.getBoundingClientRect();
		const map = m.getContainer().getBoundingClientRect();
		const free = insp ? insp.left - map.left : map.width;
		return {
			free,
			pins: (m.__yonder?.pins ?? []).map((p: { name: string; lng: number; lat: number }) => {
				const q = m.project([p.lng, p.lat]);
				return `${p.name}:x=${q.x.toFixed(0)}${q.x > free - 12 ? "(UNDER INSPECTOR)" : ""}`;
			}),
		};
	});
	log(`MT-03b free width=${v.free.toFixed(0)} pins: ${v.pins.join(", ")}`);
});

test("MT-11/12/13: stay leg after the ghost with a day range; day stubs; cluster chips", async ({ browser }) => {
	only("mt11");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-08");
	await ready(page);
	await page.waitForTimeout(2500);
	const stay = page.getByTestId(PLAN_TESTID.stayLeg);
	const ghost = page.getByTestId(PLAN_TESTID.ghost);
	log(`MT-11 Fri 8 Oct day range: stayLeg rows=${await stay.count()} "${(await stay.allInnerTexts()).join(" | ").replace(/\n/g, " ")}" ghost rows=${await ghost.count()} "${(await ghost.allInnerTexts()).join(" | ").replace(/\n/g, " ")}"`);
	await page.screenshot({ path: shot("mt11-fri8") });
	for (const lens of ["area", "place"]) {
		await page.goto(`/t/asia-2027?lens=${lens}&days=2027-10-05`);
		await mapReady(page, lens);
		await settle(page);
		const d = await drawn(page);
		log(`MT-12 ${lens} ghosts: ${d.ghosts.features.map((f) => String(f.properties.label)).join(" | ")}`);
	}
	const chips = await page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		const m = (window as any).__tripMap;
		return (m?.__yonder?.clusters ?? []).map((c: { lng: number; lat: number; count: number }) => ({ ...m.project([c.lng, c.lat]), n: c.count }));
	});
	let minGap = Number.POSITIVE_INFINITY;
	for (let i = 0; i < chips.length; i++)
		for (let j = i + 1; j < chips.length; j++) minGap = Math.min(minGap, Math.hypot(chips[i].x - chips[j].x, chips[i].y - chips[j].y));
	log(`MT-13 place Tue 5 Oct clusters=${chips.length} (${chips.map((c: { n: number }) => c.n).join(",")}) min gap=${minGap.toFixed(0)}px`);
	await page.screenshot({ path: shot("mt13-clusters") });
	log(`MT-11/12/13 errors ${JSON.stringify(errors)}`);
});

test("MT-15: flight form errors clear as the fields are fixed", async ({ browser }) => {
	only("mt15");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-24");
	await ready(page);
	await page.waitForTimeout(2000);
	await page.getByTestId(PLAN_TESTID.addBetween).first().click();
	await page.getByRole("menuitem", { name: /Flight/ }).click();
	const dlg = page.getByTestId(TESTID.addFlightDialog);
	await expect(dlg).toBeVisible();
	const form = dlg.getByTestId(T.flightForm);
	await form.getByTestId(T.flightFrom).first().fill("JFKK");
	await form.getByTestId(T.flightSave).click();
	await page.waitForTimeout(600);
	const e1 = await form.getByTestId(T.flightError).allInnerTexts();
	log(`MT-15 after bad save: ${JSON.stringify(e1)}`);
	await form.getByTestId(T.flightNumber).first().fill("NH 9");
	await page.waitForTimeout(300);
	log(`MT-15 after number: ${JSON.stringify(await form.getByTestId(T.flightError).allInnerTexts())}`);
	await form.getByTestId(T.flightFrom).first().fill("JFK");
	const opt = page.getByTestId(T.airportOption).filter({ hasText: "JFK" }).first();
	if (await opt.isVisible({ timeout: 3000 }).catch(() => false)) await opt.click();
	await page.waitForTimeout(300);
	log(`MT-15 after from=JFK: ${JSON.stringify(await form.getByTestId(T.flightError).allInnerTexts())}`);
	await dlg.screenshot({ path: shot("mt15-dialog") });
	await page.keyboard.press("Escape");
	log(`MT-15 errors ${JSON.stringify(errors)}`);
});

test("TR-06b (keyed): a fresh Seoul pair whose Routes answer is empty says 'No route found'", async ({ browser }) => {
	only("tr06b");
	const STUB = process.env.QA_STUB ?? "http://127.0.0.1:5333";
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.request.post(`${STUB}/__stub/reset`);
	await page.request.post(`${STUB}/__stub/next`, { data: { empty: true, times: 10 } });
	await page.goto("/t/asia-2027?days=2027-10-16");
	await ready(page);
	let g = await graph(page);
	const dId = g.days.find((d) => d.date === "2027-10-16")?.id ?? "";
	const nid = (name: string) => g.nodes.find((n) => n.name === name)?.id ?? "";
	const mk = (data: Record<string, unknown>) =>
		page.evaluate(async (data) => {
			const m = await import("/src/functions/items.functions.ts");
			return m.createItem({ data: data as never });
		}, data);
	const a = (await mk({ tripId: g.trip.id, dayId: dId, nodeId: nid("Seongsu"), title: "Seongsu (TR-06b)", durationMin: 60 })) as { itemId: string };
	const b = (await mk({ tripId: g.trip.id, dayId: dId, nodeId: nid("Hannam"), title: "Hannam (TR-06b)", durationMin: 60, afterItemId: a.itemId })) as { itemId: string };
	await page.waitForTimeout(6000);
	await page.goto(`/t/asia-2027?days=2027-10-16&sel=l.${a.itemId}.${b.itemId}`);
	const ov = page.getByTestId(TESTID.legOverview);
	await expect(ov).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	g = await graph(page);
	const l = g.legs.find((x) => x.fromItemId === a.itemId && x.toItemId === b.itemId);
	log(`TR-06b leg after autofill: ${JSON.stringify(l ? { mode: l.mode, dur: l.durationMin, src: l.source } : null)}`);
	if (l?.mode !== "transit") await ov.locator(`[data-testid=${T.modeOption}][data-mode=transit]`).click();
	await page.waitForTimeout(3500);
	const calls = await (await page.request.get(`${STUB}/__stub/calls`)).json();
	log(`TR-06b stub calls total=${calls.total} transit=${calls.transit}; panel="${(await page.getByTestId(T.transitPanel).innerText()).replace(/\n/g, " / ")}"`);
	await page.screenshot({ path: shot("tr06b-empty") });
	await page.request.post(`${STUB}/__stub/reset`);
	log(`TR-06b errors ${JSON.stringify(errors)}`);
});

test("ADDENDUM §5: every Japan transit row in the Plan has Open in Google Maps", async ({ browser }) => {
	only("jpgmaps");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-03..2027-10-14");
	await ready(page);
	await page.waitForTimeout(4000);
	// Scroll through the plan so virtualised rows render.
	const rows: { text: string; mode: string; link: boolean; href: string }[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < 60; i++) {
		const batch = await page.evaluate(() =>
			Array.from(document.querySelectorAll('[data-testid="leg"],[data-testid="plan-stay-leg"],[data-testid="plan-flight-continued"]')).map((el) => {
				const modeEl = el.querySelector('[data-testid="leg-mode"]') as HTMLElement | null;
				const a = el.querySelector('a[aria-label="Open in Google Maps"], a[href*="google.com/maps"]') as HTMLAnchorElement | null;
				return {
					key: (el as HTMLElement).dataset.legKey ?? el.getAttribute("data-key") ?? el.textContent?.slice(0, 80) ?? "",
					text: (el.textContent ?? "").replace(/\s+/g, " ").slice(0, 120),
					mode: modeEl?.dataset.mode ?? (el as HTMLElement).dataset.mode ?? (el.querySelector("[data-mode]") as HTMLElement | null)?.dataset.mode ?? "?",
					link: !!a,
					href: a?.href ?? "",
				};
			}),
		);
		for (const r of batch)
			if (!seen.has(r.key + r.text)) {
				seen.add(r.key + r.text);
				rows.push(r);
			}
		const done = await page.evaluate(() => {
			const sc = document.querySelector('[data-testid="center-panel"] [data-radix-scroll-area-viewport], [data-testid="center-panel"] .overflow-y-auto, [data-testid="center-panel"]') as HTMLElement | null;
			const el = (Array.from(document.querySelectorAll('[data-testid="center-panel"] *')) as HTMLElement[]).find((e) => e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY)) ?? sc;
			if (!el) return true;
			const before = el.scrollTop;
			el.scrollTop += 600;
			return el.scrollTop === before;
		});
		await page.waitForTimeout(250);
		if (done) break;
	}
	const gg = await graph(page);
	const jDays = new Set(gg.days.filter((d) => d.date >= "2027-10-03" && d.date <= "2027-10-14").map((d) => d.id));
	const jItems = new Set(gg.items.filter((i) => i.dayId && jDays.has(i.dayId)).map((i) => i.id));
	const jLegs = gg.legs.filter((l) => jItems.has(l.fromItemId ?? "") || jItems.has(l.toItemId ?? ""));
	log(`JP-GMAPS graph legs on Japan days: ${jLegs.length} (transit ${jLegs.filter((l) => l.mode === "transit").length}); rendered leg rows seen=${rows.length}`);
	const transit = rows.filter((r) => r.mode === "transit");
	const missing = transit.filter((r) => !r.link);
	log(`JP-GMAPS rows=${rows.length} transit=${transit.length} missing=${missing.length}`);
	for (const r of missing) log(`   MISSING: ${r.text}`);
	for (const r of rows.filter((x) => x.mode !== "transit" && x.link)) log(`   link on non-transit (${r.mode}): ${r.text}`);
	for (const r of rows.filter((x) => x.mode === "unset" || x.mode === "?").slice(0, 12)) log(`   ${r.mode} row link=${r.link}: ${r.text}`);
	log(`JP-GMAPS sample href: ${transit[0]?.href}`);
	log(`JP-GMAPS errors ${JSON.stringify(errors)}`);
});

test("GRAN-09: Hands Shibuya + Shibuya Loft cluster at z<=13 and spread on click; MAP-08 legend/dash", async ({ browser }) => {
	only("gran09");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?lens=place&days=2027-10-03");
	await mapReady(page, "place");
	await settle(page);
	const g = await graph(page);
	const names = Object.fromEntries(g.nodes.map((n) => [n.id, n.name]));
	await page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		(window as any).__tripMap.jumpTo({ center: [139.7005, 35.661], zoom: 13 });
	});
	await settle(page);
	let d = await drawn(page);
	log(`GRAN-09 z13 clusters: ${d.clusters.map((c) => `${c.count}[${c.repIds.map((r) => names[r] ?? r).join("/")}]`).join(", ")}`);
	const chip = page.getByTestId("map-cluster").first();
	log(`GRAN-09 cluster chip text: ${await chip.innerText().catch(() => "(none)")}`);
	await page.screenshot({ path: shot("gran09-z13") });
	if (await chip.count()) {
		await chip.click();
		await settle(page);
		await page.waitForTimeout(800);
		d = await drawn(page);
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		const z = await page.evaluate(() => (window as any).__tripMap.getZoom());
		log(`GRAN-09 after click z=${z.toFixed(2)} clusters=${d.clusters.length} visible=${d.visiblePins.map((r) => names[r] ?? r).join(", ")}`);
		await page.screenshot({ path: shot("gran09-after") });
	}
	// MAP-08: legend entries, and the NH 9 arc's dash at the city lens.
	await page.goto("/t/asia-2027?lens=city");
	await mapReady(page, "city");
	await settle(page);
	const styles = await page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		const m = (window as any).__tripMap;
		return m
			.getStyle()
			.layers.filter((l: { id: string }) => /edge/.test(l.id))
			.map((l: { id: string; paint?: Record<string, unknown> }) => `${l.id}:${JSON.stringify(l.paint?.["line-dasharray"] ?? null)}`);
	});
	log(`MAP-08 edge layers dash: ${styles.join(" | ")}`);
	await page.getByTestId("map-layers-button").click();
	await page.waitForTimeout(500);
	const legend = page.getByTestId("map-legend");
	log(`MAP-08 legend: ${(await legend.innerText().catch(() => "(none)")).replace(/\n/g, " / ")}`);
	await legend.screenshot({ path: shot("map08-legend") }).catch(() => {});
	await page.keyboard.press("Escape");
	await page.screenshot({ path: shot("map08-city") });
	log(`GRAN-09/MAP-08 errors ${JSON.stringify(errors)}`);
});

test("N02 geometry: estimate transit edges follow the rail track at place lens (Sun 3 / Mon 4 Oct)", async ({ browser }) => {
	only("n02");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	for (const day of ["2027-10-03", "2027-10-04", "2027-10-06"]) {
		await page.goto(`/t/asia-2027?days=${day}&lens=place`);
		await mapReady(page, "place");
		await settle(page);
		const d = await drawn(page);
		const g = await graph(page);
		const names = Object.fromEntries(g.nodes.map((n) => [n.id, n.name]));
		const rows = d.allEdges.features
			.filter((f) => f.properties.style === "transit")
			.map((f) => `${names[String(f.properties.from)] ?? "?"}→${names[String(f.properties.to)] ?? "?"} est=${f.properties.est} track=${f.properties.track} approx=${f.properties.approx} pts=${f.geometry.coordinates.length}`);
		log(`N02 ${day}: ${rows.join(" | ")}`);
		const attr = await page.locator(".maplibregl-ctrl-attrib").innerText().catch(() => "");
		log(`N02 ${day} attribution: ${attr.replace(/\n/g, " ")}`);
		await page.screenshot({ path: shot(`n02-${day}`) });
	}
	log(`N02 errors ${JSON.stringify(errors)}`);
});

test("MT-03c: country-lens globe with a day + the NH 9 leg selected keeps both ends in view", async ({ browser }) => {
	only("mt03c");
	const { page } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?tab=plan");
	await mapReady(page, "country");
	const g = await graph(page);
	const nh9 = g.legs.find((x) => itemLabel(g, x.fromItemId) === "Check in (JFK T7)");
	const view = () =>
		page.evaluate(() => {
			// biome-ignore lint/suspicious/noExplicitAny: introspection
			const m = (window as any).__tripMap;
			const insp = document.querySelector("[data-testid=inspector]")?.getBoundingClientRect();
			const map = m.getContainer().getBoundingClientRect();
			const free = insp ? insp.left - map.left : map.width;
			const c = m.getCenter();
			const toRad = (d: number) => (d * Math.PI) / 180;
			return `center=${c.lng.toFixed(1)},${c.lat.toFixed(1)} z=${m.getZoom().toFixed(2)} free=${free.toFixed(0)} pins: ${(m.__yonder?.pins ?? [])
				.filter((p: { hollow: boolean }) => !p.hollow)
				.map((p: { name: string; lng: number; lat: number }) => {
					const q = m.project([p.lng, p.lat]);
					const cosD = Math.sin(toRad(c.lat)) * Math.sin(toRad(p.lat)) + Math.cos(toRad(c.lat)) * Math.cos(toRad(p.lat)) * Math.cos(toRad(p.lng - c.lng));
					return `${p.name}(x=${q.x.toFixed(0)},y=${q.y.toFixed(0)}${cosD < 0 ? ",FAR SIDE" : ""}${q.x > free - 10 ? ",UNDER INSPECTOR" : ""})`;
				})
				.join(" ")}`;
		});
	for (const url of [
		"/t/asia-2027?days=2027-10-02",
		`/t/asia-2027?days=2027-10-02&sel=l.${nh9?.fromItemId}.${nh9?.toItemId}`,
		`/t/asia-2027?sel=l.${nh9?.fromItemId}.${nh9?.toItemId}`,
		"/t/asia-2027?days=2027-10-02..2027-10-03",
	]) {
		await page.goto(url);
		await mapReady(page);
		await settle(page);
		await page.waitForTimeout(800);
		log(`MT-03c ${url.replace(/[0-9a-f-]{36}/g, "…")}: ${await view()}`);
		await page.screenshot({ path: shot(`mt03c-${url.includes("sel") ? "sel" : "nosel"}-${url.includes("days") ? "day" : "trip"}`) });
	}
});

test("Custom routes: edit the imported Keikyu route (10 → 12 min ripples), choose an estimate and back, delete + undo", async ({ browser }) => {
	only("mtedit");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-03");
	await ready(page);
	let g = await graph(page);
	const l = legBetween(g, "Anamori Inari Shrine", "Breakfast");
	const toId = l?.toItemId ?? "";
	const startOf = () =>
		page.evaluate((id) => {
			// biome-ignore lint/suspicious/noExplicitAny: introspection
			const s = (window as any).__yonder?.schedule?.items?.[id];
			return s ? new Date(s.start).toISOString().slice(11, 16) : null;
		}, toId);
	log(`EDIT Anamori→Breakfast before: ${JSON.stringify(await legState(page, "Anamori Inari Shrine", "Breakfast"))} breakfast starts ${await startOf()}Z`);
	await page.goto(`/t/asia-2027?days=2027-10-03&sel=l.${l?.fromItemId}.${l?.toItemId}`);
	const ov = page.getByTestId(TESTID.legOverview);
	await expect(ov).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(2500);
	const panel = page.getByTestId(T.transitPanel);
	const manual = panel.locator(`[data-testid=${T.transitOption}][data-source=manual]`).first();
	await manual.getByTestId(T.transitOptionEdit).click();
	const bld = panel.getByTestId(T.customRoute);
	await expect(bld).toBeVisible();
	const mins = bld.getByTestId(T.customRouteMinutes);
	const stepMins = bld.getByTestId(T.customRouteStepMinutes);
	log(`EDIT builder: label="${await bld.getByTestId(T.customRouteLabel).inputValue()}" minutes=${(await mins.count()) ? await mins.inputValue() : "-"} steps=${await stepMins.count()} stepVals=${(await stepMins.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).join(",")}`);
	await bld.screenshot({ path: shot("mtedit-builder") }).catch(() => {});
	if (await stepMins.count()) await stepMins.last().fill("12");
	else await mins.fill("12");
	await bld.getByTestId(T.customRouteSave).click();
	await page.waitForTimeout(2000);
	g = await graph(page);
	log(`EDIT after 12: ${JSON.stringify(await legState(page, "Anamori Inari Shrine", "Breakfast"))} breakfast starts ${await startOf()}Z; options=${(await optionRows(page)).length}`);
	// Choose the fastest estimate, then back to the manual one.
	const est = panel.locator(`[data-testid=${T.transitOption}][data-source=estimate]`).first();
	if (await est.count()) {
		await est.getByTestId(T.transitOptionChoose).click();
		await page.waitForTimeout(1500);
		log(`EDIT chose estimate: ${JSON.stringify(await legState(page, "Anamori Inari Shrine", "Breakfast"))} breakfast ${await startOf()}Z`);
		await panel.locator(`[data-testid=${T.transitOption}][data-source=manual]`).first().getByTestId(T.transitOptionChoose).click();
		await page.waitForTimeout(1500);
		log(`EDIT back to manual: ${JSON.stringify(await legState(page, "Anamori Inari Shrine", "Breakfast"))} breakfast ${await startOf()}Z`);
	}
	// Delete the manual route, then Undo.
	await panel.locator(`[data-testid=${T.transitOption}][data-source=manual]`).first().getByTestId(T.transitOptionDelete).click();
	await page.waitForTimeout(1500);
	log(`EDIT after delete: ${JSON.stringify(await legState(page, "Anamori Inari Shrine", "Breakfast"))} manual cards=${await panel.locator(`[data-testid=${T.transitOption}][data-source=manual]`).count()}`);
	const undo = page.getByRole("button", { name: /Undo/ }).first();
	log(`EDIT undo visible=${await undo.isVisible().catch(() => false)}`);
	await page.screenshot({ path: shot("mtedit-deleted") });
	if (await undo.isVisible().catch(() => false)) {
		await undo.click();
		await page.waitForTimeout(2000);
		log(`EDIT after undo: ${JSON.stringify(await legState(page, "Anamori Inari Shrine", "Breakfast"))} manual cards=${await panel.locator(`[data-testid=${T.transitOption}][data-source=manual]`).count()}`);
	}
	log(`EDIT errors ${JSON.stringify(errors)}`);
});

test("Viewer (Kai) and suggester (Maya) open Japan transit legs: no fetch, no errors, Google Maps present", async ({ browser }) => {
	only("roles");
	for (const email of ["kai@asia2027.test", "maya@asia2027.test"]) {
		const { page, errors } = await asUser(browser, email);
		const fetches: string[] = [];
		page.on("request", (r) => {
			if (/transit|Transit/.test(r.url()) && r.method() === "POST") fetches.push(r.url().replace(/.*\/_serverFn\//, "").slice(0, 80));
		});
		await page.goto("/t/asia-2027?days=2027-10-04");
		await ready(page);
		const g = await graph(page);
		const l = legBetween(g, "Kappabashi Street", "Nihonbashi Nishikawa");
		await page.goto(`/t/asia-2027?days=2027-10-04&sel=l.${l?.fromItemId}.${l?.toItemId}`);
		await expect(page.getByTestId(TESTID.legOverview)).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(3000);
		const rows = await optionRows(page);
		const btns = await page.getByTestId(TESTID.legOverview).getByRole("button").evaluateAll((els) => els.filter((e) => !(e as HTMLButtonElement).disabled && e.getAttribute("aria-disabled") !== "true").map((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 30)));
		log(`ROLES ${email}: options=${rows.length} gmaps=${rows.filter((r) => r.includes("gmaps=1")).length} enabled buttons=[${btns.join(" | ")}] transit POSTs=${fetches.length} ${fetches.slice(0, 3).join(",")}`);
		await page.screenshot({ path: shot(`roles-${email.split("@")[0]}`) });
		log(`ROLES ${email} errors ${JSON.stringify(errors)}`);
		await page.context().close();
	}
});
