/** I2 map-transit round 3: re-verify the round-2 map-transit defects on a fresh QA seed (agent 23, :5330). */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { asUser, type G, graph, itemLabel, legBetween, mapReady, OUT, onlyHere, settle, shot } from "./qa-map-transit-helpers";

onlyHere();
test.describe.configure({ mode: "serial" });
const LOG = path.join(OUT, "r3-results.txt");
const log = (s: string) => appendFileSync(LOG, `${s}\n`);
test.beforeAll(() => appendFileSync(LOG, `\n=== run ${new Date().toISOString()} ${process.env.QA_ONLY ?? ""}\n`));
const ready = (page: Page) =>
	page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph, null, { timeout: 45_000 });
const only = (id: string) => test.skip(!!process.env.QA_ONLY && !process.env.QA_ONLY.split(",").includes(id), "filtered");

/** Every yonder edge layer: its dash, and the rendered features in it. */
async function edgeLayers(page: Page) {
	return page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		const m = (window as any).__tripMap;
		const out: string[] = [];
		for (const l of m.getStyle().layers as { id: string; type: string }[]) {
			if (!l.id.startsWith("yonder-edges") || l.type !== "line") continue;
			const dash = m.getPaintProperty(l.id, "line-dasharray");
			const gap = m.getPaintProperty(l.id, "line-gap-width");
			const feats = m.queryRenderedFeatures(undefined, { layers: [l.id] }) as { properties: Record<string, unknown> }[];
			const seen = new Set<string>();
			const summary: string[] = [];
			for (const f of feats) {
				const p = f.properties;
				const k = `${p.style}${p.est ? "(est)" : ""}:${String(p.label ?? p.title ?? p.key ?? "").slice(0, 40)}`;
				if (seen.has(k)) continue;
				seen.add(k);
				summary.push(k);
			}
			out.push(`${l.id} dash=${JSON.stringify(dash ?? null)} gap=${JSON.stringify(gap ?? null)} n=${seen.size} ${summary.slice(0, 8).join(" | ")}`);
		}
		return out;
	});
}

async function propsSample(page: Page) {
	return page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		const m = (window as any).__tripMap;
		const f = (m.__yonder?.edges?.features ?? []).slice(0, 3);
		return JSON.stringify(f.map((x: { properties: unknown }) => x.properties)).slice(0, 1200);
	});
}

test("DASH: known flights / other legs are solid on the map; only estimates, unset and proposals dashed", async ({ browser }) => {
	only("dash");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	for (const [label, url, lens] of [
		["root-country", "/t/asia-2027?tab=plan", "country"],
		["root-city", "/t/asia-2027?lens=city", "city"],
		["oct03-place", "/t/asia-2027?days=2027-10-03&lens=place", "place"],
		["oct08-place", "/t/asia-2027?days=2027-10-08&lens=place", "place"],
		["oct27-place", "/t/asia-2027?days=2027-10-26..2027-10-28&lens=place", "place"],
	] as const) {
		await page.goto(url);
		await mapReady(page, lens);
		await settle(page);
		await page.waitForTimeout(800);
		log(`DASH ${label}:\n   ${(await edgeLayers(page)).join("\n   ")}`);
		if (label === "root-country") log(`DASH edge props sample: ${await propsSample(page)}`);
		await page.screenshot({ path: shot(`r3-dash-${label}`) });
	}
	log(`DASH errors ${JSON.stringify(errors)}`);
});

test("MT-03 residual: root globe with a leg inspector open keeps every pin clear of the inspector", async ({ browser }) => {
	only("mt03");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?tab=plan");
	await mapReady(page, "country");
	const g = await graph(page);
	for (const [from, label] of [
		["Kappabashi Street", "kappabashi"],
		["Check in (JFK T7)", "nh9"],
		["Board SP3", "sp3"],
		["Layover", "tk11"],
	]) {
		const l = g.legs.find((x) => itemLabel(g, x.fromItemId) === from);
		if (!l) {
			log(`MT-03 ${label}: no leg`);
			continue;
		}
		await page.goto(`/t/asia-2027?sel=l.${l.fromItemId}.${l.toItemId}`);
		await mapReady(page, "country");
		await settle(page);
		await page.waitForTimeout(1200);
		const v = await page.evaluate(() => {
			// biome-ignore lint/suspicious/noExplicitAny: introspection
			const m = (window as any).__tripMap;
			const insp = document.querySelector("[data-testid=inspector]")?.getBoundingClientRect();
			const map = m.getContainer().getBoundingClientRect();
			const free = insp ? insp.left - map.left : map.width;
			const c = m.getCenter();
			const pins = (m.__yonder?.pins ?? []) as { repId: string; name?: string; lng: number; lat: number }[];
			const els = Array.from(document.querySelectorAll('[data-testid="pin"]')) as HTMLElement[];
			const rows = pins.map((p) => {
				const q = m.project([p.lng, p.lat]);
				const el = els.find((e) => e.dataset.repId === p.repId);
				const r = el?.getBoundingClientRect();
				const right = r ? r.right - map.left : q.x;
				const left = r ? r.left - map.left : q.x;
				const flag = left < 0 ? "(OFF LEFT)" : right > free ? (left > free ? "(UNDER INSPECTOR)" : "(PARTLY UNDER INSPECTOR)") : "";
				return `${p.name ?? p.repId.slice(-5)}:x=${q.x.toFixed(0)} [${left.toFixed(0)}..${right.toFixed(0)}]${flag}`;
			});
			return { free: free.toFixed(0), cam: `centre=${c.lng.toFixed(1)},${c.lat.toFixed(1)} z=${m.getZoom().toFixed(2)}`, rows };
		});
		log(`MT-03 ${label}: free=${v.free} ${v.cam}\n   ${v.rows.join(", ")}`);
		await page.screenshot({ path: shot(`r3-mt03-${label}`) });
	}
	log(`MT-03 errors ${JSON.stringify(errors)}`);
});

test("MT-06: Thu 7 Oct — the Oishi Park → Lake Kawaguchiko leg and the Ropeway pin", async ({ browser }) => {
	only("mt06");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-07&lens=place");
	await ready(page);
	await page.waitForTimeout(3000);
	const g = await graph(page);
	for (const [a, b] of [
		["Lunch", "Oishi Park"],
		["Oishi Park", "Lake Kawaguchiko"],
		["Lake Kawaguchiko", "Mt. Fuji Panoramic Ropeway"],
	]) {
		const l = legBetween(g, a, b);
		log(`MT-06 leg ${a} → ${b}: ${JSON.stringify(l ? { mode: l.mode, dur: l.durationMin, src: l.source } : null)}`);
	}
	const center = page.getByTestId("center-panel");
	const text = (await center.innerText()).replace(/\n+/g, " / ");
	const iO = text.indexOf("Oishi Park");
	log(`MT-06 plan around Oishi: ${text.slice(Math.max(0, iO - 200), iO + 600)}`);
	const issues = await page.getByTestId(PLAN_TESTID.dayIssues).allInnerTexts();
	log(`MT-06 day issues chips: ${JSON.stringify(issues)}`);
	const rope = page.getByTestId(TESTID.timelineItem).filter({ hasText: "Panoramic Ropeway" }).first();
	log(`MT-06 Ropeway card: ${(await rope.innerText()).replace(/\n+/g, " / ")}`);
	await page.screenshot({ path: shot("r3-mt06-thu7") });
	const l = legBetween(g, "Oishi Park", "Lake Kawaguchiko");
	const oishi = g.items.find((i) => i.title === "Oishi Park")?.id;
	const lake = g.items.find((i) => i.title === "Lake Kawaguchiko")?.id;
	await page.goto(`/t/asia-2027?days=2027-10-07&lens=place&sel=l.${l?.fromItemId ?? oishi}.${l?.toItemId ?? lake}`);
	const ov = page.getByTestId(TESTID.legOverview);
	await expect(ov).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(2500);
	log(`MT-06 leg overview: ${(await ov.innerText()).replace(/\n+/g, " / ").slice(0, 700)}`);
	const tr = ov.locator(`[data-testid=${T.modeOption}][data-mode=transit]`);
	if (await tr.count()) {
		await tr.click();
		await page.waitForTimeout(3500);
		const panel = page.getByTestId(T.transitPanel);
		log(`MT-06 transit panel: ${(await panel.innerText().catch(() => "")).replace(/\n+/g, " / ").slice(0, 900)}`);
		await page.screenshot({ path: shot("r3-mt06-transit-tab") });
	}
	log(`MT-06 errors ${JSON.stringify(errors)}`);
});

test("CHIP: the seeded Fuji Excursion 7 route shows its taxi step as 'Taxi'", async ({ browser }) => {
	only("chip");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-07");
	await ready(page);
	const g = await graph(page);
	const l = legBetween(g, "Breakfast", "Drop bags at ryokan");
	await page.goto(`/t/asia-2027?days=2027-10-07&sel=l.${l?.fromItemId}.${l?.toItemId}`);
	const ov = page.getByTestId(TESTID.legOverview);
	await expect(ov).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(3000);
	const opts = page.getByTestId(T.transitOption);
	const n = await opts.count();
	for (let i = 0; i < n; i++) {
		const o = opts.nth(i);
		log(`CHIP option ${i} [${await o.getAttribute("data-source")} chosen=${await o.getAttribute("data-chosen")} gmaps=${await o.getByTestId(T.googleMapsLink).count()}]: ${(await o.innerText()).replace(/\n+/g, " · ")}`);
	}
	log(`CHIP door-to-door="${(await page.getByTestId(T.transitDoorToDoor).allInnerTexts()).join("|")}"`);
	const rowTxt = await page.getByTestId(TESTID.leg).filter({ hasText: "Fuji Excursion" }).allInnerTexts();
	log(`CHIP plan leg rows: ${JSON.stringify(rowTxt.map((t) => t.replace(/\n+/g, " / ")))}`);
	await page.screenshot({ path: shot("r3-chip-fuji") });
	const chosen = page.locator(`[data-testid=${T.transitOption}][data-chosen=true]`).first();
	if (await chosen.count()) await chosen.screenshot({ path: shot("r3-chip-fuji-card") });
	log(`CHIP errors ${JSON.stringify(errors)}`);
});

test("LATE: a reserved route missed by almost a day reads in hours, not '1420 min'", async ({ browser }) => {
	only("late");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-21");
	await ready(page);
	let g: G = await graph(page);
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
	if (!g.items.some((i) => i.title === "Breakfast (R3)")) {
		const b = (await mk({ tripId: g.trip.id, dayId: dId, nodeId: nid("Shinjuku"), title: "Breakfast (R3)", durationMin: 30, pinnedStart: "07:30" })) as { itemId?: string };
		log(`LATE createItem breakfast ${JSON.stringify(b).slice(0, 200)}`);
		const d = await mk({ tripId: g.trip.id, dayId: dId, nodeId: nid("Kawaguchiko Ryokan"), title: "Drop bags (R3)", durationMin: 30, afterItemId: b.itemId });
		log(`LATE createItem drop ${JSON.stringify(d).slice(0, 200)}`);
	}
	await page.reload();
	await ready(page);
	await page.waitForTimeout(3000);
	g = await graph(page);
	const bId = g.items.find((i) => i.title === "Breakfast (R3)")?.id ?? "";
	const dropId = g.items.find((i) => i.title === "Drop bags (R3)")?.id ?? "";
	await page.goto(`/t/asia-2027?days=2027-10-21&sel=l.${bId}.${dropId}`);
	const ov = page.getByTestId(TESTID.legOverview);
	await expect(ov).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	const overnight = page.getByTestId(T.overnightAddTransit);
	if (await overnight.isVisible().catch(() => false)) await overnight.click();
	await ov.locator(`[data-testid=${T.modeOption}][data-mode=transit]`).click();
	const panel = page.getByTestId(T.transitPanel);
	await expect(panel.getByTestId(T.transitOption).first()).toBeVisible({ timeout: 25_000 });
	const estRows = await panel.getByTestId(T.transitOption).allInnerTexts();
	log(`LATE estimate options (${estRows.length}): ${estRows.map((t) => t.replace(/\n+/g, " · ").slice(0, 140)).join(" || ")}`);
	log(`LATE gmaps links on options: ${await panel.getByTestId(T.transitOption).getByTestId(T.googleMapsLink).count()} / ${estRows.length}`);
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
	log(`LATE 'Shinjuku' suggestions: ${(await page.getByTestId(T.stationSuggestion).allInnerTexts()).slice(0, 5).join(" | ").replace(/\n/g, " ")}`);
	await s1.click();
	await page.waitForTimeout(500);
	await bld.getByTestId(T.customRouteStepTo).last().fill("Kawaguchiko");
	const s2 = page.getByTestId(T.stationSuggestion).filter({ hasText: "河口湖" }).first();
	await s2.waitFor({ timeout: 10_000 });
	await s2.click();
	await page.waitForTimeout(1500);
	log(`LATE after picks: line="${await bld.getByTestId(T.customRouteStepLine).last().inputValue()}" from="${await bld.getByTestId(T.customRouteStepFrom).last().inputValue()}" to="${await bld.getByTestId(T.customRouteStepTo).last().inputValue()}" min="${await bld.getByTestId(T.customRouteStepMinutes).last().inputValue()}"`);
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
	await bld.getByTestId(T.customRouteSave).click();
	await page.waitForTimeout(3000);
	await page.screenshot({ path: shot("r3-late-saved") });
	const opts = await page.getByTestId(T.transitOption).allInnerTexts();
	log(`LATE options after save: ${opts.map((t) => t.replace(/\n+/g, " · ").slice(0, 200)).join(" || ")}`);
	const center = (await page.getByTestId("center-panel").innerText()).replace(/\n+/g, " / ");
	const iM = center.indexOf("Misses");
	log(`LATE plan 'Misses' text: ${iM >= 0 ? center.slice(Math.max(0, iM - 80), iM + 120) : "(none)"}`);
	const iDrop = center.indexOf("Drop bags (R3)");
	log(`LATE plan around Drop bags: ${center.slice(Math.max(0, iDrop - 400), iDrop + 80)}`);
	const badges = await page.getByTestId(TESTID.conflictBadge).allInnerTexts();
	log(`LATE conflict badges: ${JSON.stringify(badges)}`);
	const chip = page.getByTestId(TESTID.leg).filter({ hasText: "Fuji Excursion" }).first();
	if (await chip.count()) {
		await chip.scrollIntoViewIfNeeded();
		await chip.screenshot({ path: shot("r3-late-legrow") }).catch(() => {});
		log(`LATE leg row: ${(await chip.innerText()).replace(/\n+/g, " / ")}`);
	}
	const legIssues = await page.getByTestId(PLAN_TESTID.dayIssues).allInnerTexts();
	log(`LATE day issues: ${JSON.stringify(legIssues)}`);
	writeFileSync(path.join(OUT, "r3-late-center.txt"), center);
	log(`LATE errors ${JSON.stringify(errors)}`);
});

test("MT-06b: Thu 7 Oct — accept the suggestion on Oishi Park → Lake Kawaguchiko, then open it", async ({ browser }) => {
	only("mt06b");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-07&lens=place");
	await ready(page);
	await page.waitForTimeout(2500);
	const rows = page.getByTestId(TESTID.leg);
	const n = await rows.count();
	let target = -1;
	for (let i = 0; i < n; i++) {
		const t = await rows.nth(i).innerText();
		log(`MT-06b leg row ${i}: ${t.replace(/\n+/g, " / ")}`);
	}
	// The leg row right after the Oishi Park card.
	const idx = await page.evaluate(() => {
		const all = Array.from(document.querySelectorAll('[data-testid="timeline-item"], [data-testid="leg"]')) as HTMLElement[];
		const i = all.findIndex((e) => e.dataset.testid === "timeline-item" && e.innerText.includes("Oishi Park"));
		const legs = Array.from(document.querySelectorAll('[data-testid="leg"]'));
		for (let j = i + 1; j < all.length; j++) if (all[j].dataset.testid === "leg") return legs.indexOf(all[j]);
		return -1;
	});
	target = idx;
	log(`MT-06b Oishi→Lake row index ${target}`);
	if (target < 0) return;
	const row = rows.nth(target);
	await row.scrollIntoViewIfNeeded();
	await row.screenshot({ path: shot("r3-mt06b-row-before") });
	await row.getByTestId(PLAN_TESTID.legAccept).first().click();
	await page.waitForTimeout(6000);
	const g = await graph(page);
	const l = legBetween(g, "Oishi Park", "Lake Kawaguchiko");
	log(`MT-06b after accept: ${JSON.stringify(l ? { mode: l.mode, dur: l.durationMin, src: l.source, route: (l.details as { route?: { label?: string; segments?: { mode: string; durationMin: number }[] } }).route?.segments?.map((s) => `${s.mode}:${s.durationMin}`) } : null)}`);
	log(`MT-06b row after: ${(await rows.nth(target).innerText()).replace(/\n+/g, " / ")}`);
	const rope = page.getByTestId(TESTID.timelineItem).filter({ hasText: "Panoramic Ropeway" }).first();
	log(`MT-06b Ropeway after: ${(await rope.innerText()).replace(/\n+/g, " / ").slice(0, 200)}`);
	log(`MT-06b day issues: ${JSON.stringify(await page.getByTestId(PLAN_TESTID.dayIssues).allInnerTexts())}`);
	await page.screenshot({ path: shot("r3-mt06b-after-accept") });
	if (l) {
		await page.goto(`/t/asia-2027?days=2027-10-07&lens=place&sel=l.${l.fromItemId}.${l.toItemId}`);
		const ov = page.getByTestId(TESTID.legOverview);
		await expect(ov).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(3500);
		log(`MT-06b overview: ${(await ov.innerText()).replace(/\n+/g, " / ").slice(0, 900)}`);
		await page.screenshot({ path: shot("r3-mt06b-overview") });
		// Walk tab
		await ov.locator(`[data-testid=${T.modeOption}][data-mode=walk]`).click();
		await page.waitForTimeout(6000);
		const g2 = await graph(page);
		const l2 = legBetween(g2, "Oishi Park", "Lake Kawaguchiko");
		log(`MT-06b after Walk: ${JSON.stringify(l2 ? { mode: l2.mode, dur: l2.durationMin, src: l2.source } : null)} panel="${(await page.getByTestId(T.walkPanel).innerText().catch(() => "")).replace(/\n+/g, " / ")}"`);
		await page.screenshot({ path: shot("r3-mt06b-walk") });
	}
	log(`MT-06b errors ${JSON.stringify(errors)}`);
});

test("P502: which request answers 502 on the Tokyo/Shinjuku maps", async ({ browser }) => {
	only("p502");
	const { page } = await asUser(browser, "dennis@asia2027.test");
	const bad: string[] = [];
	page.on("response", (r) => {
		if (r.status() >= 500) bad.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 200)}`);
	});
	for (const url of ["/t/asia-2027/japan/tokyo/shinjuku?lens=place", "/t/asia-2027/japan?lens=city", "/t/asia-2027/japan/tokyo?lens=place&days=2027-10-05"]) {
		await page.goto(url);
		await mapReady(page);
		await settle(page);
		await page.waitForTimeout(1500);
	}
	log(`P502 ${JSON.stringify(bad)}`);
});

test("PLANX: overnight day headers and carry-over rows (2 Oct, 26 Oct, 28 Oct, 4 Nov)", async ({ browser }) => {
	only("planx");
	const { page } = await asUser(browser, "dennis@asia2027.test");
	for (const d of ["2027-10-02", "2027-10-26", "2027-10-28", "2027-11-04"]) {
		await page.goto(`/t/asia-2027?days=${d}&lens=place`);
		await ready(page);
		await page.waitForTimeout(2000);
		const header = (await page.getByTestId(PLAN_TESTID.dayHeader).first().innerText()).replace(/\n+/g, " / ");
		const center = (await page.getByTestId("center-panel").innerText()).replace(/\n+/g, " / ");
		const i = center.indexOf("→ / to ");
		log(`PLANX ${d} header: ${header}`);
		log(`PLANX ${d} tail: ${center.slice(Math.max(0, center.length - 900))}`);
		await page.screenshot({ path: shot(`r3-planx-${d}`) });
		void i;
	}
});

test("BANDLINK: connection rows between bands vs the flight tickets", async ({ browser }) => {
	only("bandlink");
	const { page } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?tab=plan");
	await ready(page);
	await page.waitForTimeout(2500);
	const links = await page.getByTestId(PLAN_TESTID.bandLink).allInnerTexts();
	log(`BANDLINK rows (${links.length}): ${links.map((t) => t.replace(/\n+/g, " ")).join(" || ")}`);
	const g = await graph(page);
	for (const l of g.legs.filter((x) => x.mode === "flight")) {
		const f = (l.details as { flight?: { airline?: { iata?: string }; number?: string; depLocal?: string; arrLocal?: string } }).flight;
		log(`BANDLINK flight ${itemLabel(g, l.fromItemId)} → ${itemLabel(g, l.toItemId)} ${f?.airline?.iata ?? ""} ${f?.number ?? ""} ${f?.depLocal} → ${f?.arrLocal}`);
	}
	const first = page.getByTestId(PLAN_TESTID.bandLink).first();
	if (await first.count()) {
		await first.scrollIntoViewIfNeeded();
		const box = await first.boundingBox();
		if (box) await page.screenshot({ path: shot("r3-bandlink-nh9"), clip: { x: 264, y: Math.max(0, box.y - 200), width: 520, height: 260 } });
	}
});

test("PROP: Maya's leg suggestion draws a dashed proposed edge; Dennis sees it", async ({ browser }) => {
	only("prop");
	const m = await asUser(browser, "maya@asia2027.test");
	await m.page.goto("/t/asia-2027?days=2027-10-04");
	await ready(m.page);
	const g = await graph(m.page);
	const l = legBetween(g, "Kappabashi Street", "Nihonbashi Nishikawa");
	await m.page.goto(`/t/asia-2027?days=2027-10-04&lens=place&sel=l.${l?.fromItemId}.${l?.toItemId}`);
	const ov = m.page.getByTestId(TESTID.legOverview);
	await expect(ov).toBeVisible({ timeout: 30_000 });
	await m.page.waitForTimeout(2500);
	const choose = ov.getByRole("button", { name: /Choose .*Asakusa/ }).first();
	log(`PROP maya choose visible=${await choose.isVisible().catch(() => false)}`);
	if (await choose.isVisible().catch(() => false)) await choose.click();
	await m.page.waitForTimeout(3000);
	log(`PROP maya after: ${(await ov.innerText()).replace(/\n+/g, " / ").slice(0, 400)}`);
	await m.page.screenshot({ path: shot("r3-prop-maya") });
	const d = await asUser(browser, "dennis@asia2027.test");
	await d.page.goto("/t/asia-2027?days=2027-10-04&lens=place");
	await mapReady(d.page, "place");
	await settle(d.page);
	await d.page.waitForTimeout(1500);
	const prop = await d.page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		const mp = (window as any).__tripMap;
		const f = mp.queryRenderedFeatures(undefined, { layers: ["yonder-edges-proposed"] }) as { properties: Record<string, unknown> }[];
		const all = (mp.__yonder?.edges?.features ?? []) as { properties: Record<string, unknown> }[];
		return { rendered: f.length, dash: mp.getPaintProperty("yonder-edges-proposed", "line-dasharray"), withProp: all.filter((x) => x.properties.proposed).map((x) => `${x.properties.style}:${x.properties.proposed}`) };
	});
	log(`PROP dennis map: ${JSON.stringify(prop)}`);
	const banner = await d.page.getByTestId(PLAN_TESTID.proposalBanner).allInnerTexts();
	log(`PROP dennis banners: ${JSON.stringify(banner.map((b) => b.replace(/\n+/g, " / ")))}`);
	await d.page.screenshot({ path: shot("r3-prop-dennis") });
	log(`PROP errors m=${JSON.stringify(m.errors)} d=${JSON.stringify(d.errors)}`);
});

test("GMAPS2: item overview Travel rows and the map edge overview for Japan transit carry Google Maps", async ({ browser }) => {
	only("gmaps2");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-03&lens=place");
	await ready(page);
	await page.getByTestId(TESTID.timelineItem).filter({ hasText: "JAL Sky Museum" }).first().click();
	await page.waitForTimeout(1500);
	const insp = page.getByTestId(TESTID.inspector);
	const txt = (await insp.innerText()).replace(/\n+/g, " / ");
	const i = txt.indexOf("TRAVEL");
	log(`GMAPS2 JAL overview travel: ${txt.slice(i, i + 300)}`);
	log(`GMAPS2 JAL overview gmaps links: ${await insp.getByTestId(T.googleMapsLink).count()} (any link text: ${await insp.getByRole("link", { name: /Google Maps/ }).count()})`);
	await insp.screenshot({ path: shot("r3-gmaps2-jal") });
	// Map edge at area lens for Oct 4 (Asakusa → Nihonbashi est.)
	await page.goto("/t/asia-2027?days=2027-10-04&lens=area");
	await mapReady(page, "area");
	await settle(page);
	const pt = await page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		const m = (window as any).__tripMap;
		const fs = (m.__yonder?.edges?.features ?? []) as { properties: Record<string, unknown>; geometry: { coordinates: number[][] } }[];
		const f = fs.find((x) => x.properties.style === "transit");
		if (!f) return null;
		const c = f.geometry.coordinates;
		const mid = c[Math.floor(c.length / 2)];
		const p = m.project(mid);
		const r = m.getContainer().getBoundingClientRect();
		return { x: r.left + p.x, y: r.top + p.y, sel: f.properties.sel };
	});
	log(`GMAPS2 edge point ${JSON.stringify(pt)}`);
	if (pt) {
		await page.mouse.click(pt.x, pt.y);
		await page.waitForTimeout(2000);
		const eo = page.getByTestId(TESTID.edgeOverview);
		const lo = page.getByTestId(TESTID.legOverview);
		const which = (await eo.count()) ? eo : lo;
		log(`GMAPS2 edge click url=${page.url().replace(/.*\?/, "?")} overview: ${(await which.innerText().catch(() => "")).replace(/\n+/g, " / ").slice(0, 300)} gmaps=${await which.getByTestId(T.googleMapsLink).count()}`);
		await page.screenshot({ path: shot("r3-gmaps2-edge") });
	}
	log(`GMAPS2 errors ${JSON.stringify(errors)}`);
});

test("FILTER: the shared ?f= filter on the Tokyo map (place lens)", async ({ browser }) => {
	only("filter");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	const snap = async (label: string, url: string) => {
		await page.goto(url);
		await mapReady(page, "place");
		await settle(page);
		await page.waitForTimeout(800);
		const s = await page.evaluate(() => {
			// biome-ignore lint/suspicious/noExplicitAny: introspection
			const m = (window as any).__tripMap;
			const pins = (m.__yonder?.pins ?? []) as { name: string; hollow: boolean; filteredOut: boolean; opacity: number; category: string | null }[];
			const dom = Array.from(document.querySelectorAll('[data-testid="pin"]')).length;
			return {
				total: pins.length,
				dom,
				ideasShown: pins.filter((p) => p.hollow && !p.filteredOut).map((p) => `${p.name}(${p.category})`).slice(0, 12),
				ideasOut: pins.filter((p) => p.hollow && p.filteredOut).length,
				schedOut: pins.filter((p) => !p.hollow && p.filteredOut).map((p) => `${p.name}(${p.category})@${p.opacity}`).slice(0, 8),
				schedIn: pins.filter((p) => !p.hollow && !p.filteredOut).map((p) => `${p.name}(${p.category})`).slice(0, 12),
			};
		});
		log(`FILTER ${label}: ${JSON.stringify(s)}`);
		await page.screenshot({ path: shot(`r3-filter-${label}`) });
	};
	await snap("none", "/t/asia-2027/japan/tokyo?lens=place");
	await snap("bar", "/t/asia-2027/japan/tokyo?lens=place&f=g:bar");
	await snap("must", "/t/asia-2027/japan/tokyo?lens=place&f=p:must");
	await snap("ns", "/t/asia-2027/japan/tokyo?lens=place&f=ns");
	log(`FILTER errors ${JSON.stringify(errors)}`);
});

test("MT-06c: choosing the rail estimate's walk-only option for Oishi Park → Lake Kawaguchiko", async ({ browser }) => {
	only("mt06c");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-07&lens=place");
	await ready(page);
	const g = await graph(page);
	const l = legBetween(g, "Oishi Park", "Lake Kawaguchiko");
	log(`MT-06c before: ${JSON.stringify(l ? { mode: l.mode, dur: l.durationMin, src: l.source } : null)}`);
	await page.goto(`/t/asia-2027?days=2027-10-07&lens=place&sel=l.${l?.fromItemId}.${l?.toItemId}`);
	const ov = page.getByTestId(TESTID.legOverview);
	await expect(ov).toBeVisible({ timeout: 30_000 });
	await ov.locator(`[data-testid=${T.modeOption}][data-mode=transit]`).click();
	await page.waitForTimeout(4000);
	const panel = page.getByTestId(T.transitPanel);
	log(`MT-06c transit panel: ${(await panel.innerText().catch(() => "")).replace(/\n+/g, " / ").slice(0, 500)}`);
	const opt = panel.getByTestId(T.transitOption).first();
	const choose = opt.getByTestId(T.transitOptionChoose);
	if (await choose.count()) await choose.first().click();
	else await opt.click();
	await page.waitForTimeout(3000);
	const g2 = await graph(page);
	const l2 = legBetween(g2, "Oishi Park", "Lake Kawaguchiko");
	log(`MT-06c after choosing option 1: ${JSON.stringify(l2 ? { mode: l2.mode, dur: l2.durationMin, src: l2.source, label: (l2.details as { route?: { label?: string } }).route?.label } : null)}`);
	const center = (await page.getByTestId("center-panel").innerText()).replace(/\n+/g, " / ");
	const i = center.indexOf("Oishi Park");
	log(`MT-06c plan: ${center.slice(i, i + 250)}`);
	await page.screenshot({ path: shot("r3-mt06c") });
	log(`MT-06c errors ${JSON.stringify(errors)}`);
});

test("DIST: a walk switched to a transit estimate keeps the walk's distance?", async ({ browser }) => {
	only("dist");
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-04&lens=place");
	await ready(page);
	const g = await graph(page);
	const l = legBetween(g, "Nihonbashi Nishikawa", "Itoya (G.Itoya)");
	await page.goto(`/t/asia-2027?days=2027-10-04&lens=place&sel=l.${l?.fromItemId}.${l?.toItemId}`);
	const ov = page.getByTestId(TESTID.legOverview);
	await expect(ov).toBeVisible({ timeout: 30_000 });
	await ov.locator(`[data-testid=${T.modeOption}][data-mode=transit]`).click();
	await page.waitForTimeout(4000);
	const panel = page.getByTestId(T.transitPanel);
	const opts = await panel.getByTestId(T.transitOption).allInnerTexts();
	log(`DIST options: ${opts.map((o) => o.replace(/\n+/g, " · ").slice(0, 120)).join(" || ")}`);
	const g2 = await graph(page);
	const l2 = legBetween(g2, "Nihonbashi Nishikawa", "Itoya (G.Itoya)") as unknown as { mode: string; durationMin: number; source: string; distanceM?: number; details: { route?: { label?: string } } };
	log(`DIST after Transit tab: ${JSON.stringify({ mode: l2.mode, dur: l2.durationMin, src: l2.source, dist: l2.distanceM, label: l2.details.route?.label })}`);
	log(`DIST header: ${(await ov.innerText()).split("\n").slice(0, 3).join(" / ")}`);
	await page.screenshot({ path: shot("r3-dist") });
	log(`DIST errors ${JSON.stringify(errors)}`);
});

test("GLOBE: which country pins are behind the globe on the default trip view", async ({ browser }) => {
	only("globe");
	const { page } = await asUser(browser, "dennis@asia2027.test");
	for (const url of ["/t/asia-2027", "/t/asia-2027?sel=root"]) {
		await page.goto(url);
		await mapReady(page, "country");
		await settle(page);
		await page.waitForTimeout(1500);
		const r = await page.evaluate(() => {
			// biome-ignore lint/suspicious/noExplicitAny: introspection
			const m = (window as any).__tripMap;
			const c = m.getCenter();
			const pins = (m.__yonder?.pins ?? []) as { repId: string; name: string; lng: number; lat: number }[];
			const rad = Math.PI / 180;
			return {
				cam: `${c.lng.toFixed(1)},${c.lat.toFixed(1)} z=${m.getZoom().toFixed(2)}`,
				pins: pins.map((p) => {
					const el = document.querySelector(`[data-testid="pin"][data-rep-id="${p.repId}"]`)?.closest(".maplibregl-marker") as HTMLElement | null;
					const cosd = Math.sin(c.lat * rad) * Math.sin(p.lat * rad) + Math.cos(c.lat * rad) * Math.cos(p.lat * rad) * Math.cos((p.lng - c.lng) * rad);
					return `${p.name}: ${(Math.acos(cosd) / rad).toFixed(0)}° from centre, marker opacity=${el?.style.opacity ?? "?"}`;
				}),
			};
		});
		log(`GLOBE ${url} cam=${r.cam}\n   ${r.pins.join("\n   ")}`);
		await page.screenshot({ path: shot(`r3-globe-${url.includes("sel") ? "selroot" : "plain"}`) });
	}
});
