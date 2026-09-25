/** I2 map-transit: FLT-01…06 on the QA seed's Asia 2027 (agent 23's own db). */
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
import { TRANSIT_TESTID as T } from "../../../src/features/transit/testids";
import { TESTID } from "../../../src/lib/testids";
import { APP, asUser, graph, itemLabel, OUT, onlyHere, shot } from "./qa-map-transit-helpers";

onlyHere();
test.describe.configure({ mode: "serial" });

const LOG = path.join(OUT, "flight-results.txt");
const log = (s: string) => appendFileSync(LOG, `${s}\n`);
test.beforeAll(() => writeFileSync(LOG, `run ${new Date().toISOString()}\n`));

async function pick(page: Page, scope: ReturnType<Page["getByTestId"]>, input: string, typed: string, option: string, text: RegExp | string) {
	const field = scope.getByTestId(input).first();
	await field.fill(typed);
	const opt = page.getByTestId(option).filter({ hasText: text }).first();
	if (!(await opt.isVisible().catch(() => false))) {
		await page.waitForTimeout(800);
		if (!(await opt.isVisible().catch(() => false))) {
			await field.fill("");
			await field.pressSequentially(typed, { delay: 60 });
		}
	}
	await opt.click({ timeout: 8000 });
}

test("FLT-02 then FLT-01/03: Add a flight on an empty day (Fri 22 Oct)", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?days=2027-10-22");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 45_000 });
	await page.waitForTimeout(2500);
	const add = page.getByTestId(PLAN_TESTID.addBetween).first();
	await add.click();
	await page.getByRole("menuitem", { name: /Flight/ }).click();
	const dlg = page.getByTestId(TESTID.addFlightDialog);
	await expect(dlg).toBeVisible();
	const form = dlg.getByTestId(T.flightForm);
	await page.screenshot({ path: shot("flt-dialog-empty") });
	// FLT-02: blank number, bad airport, then arrival before departure.
	await pick(page, form, T.flightAirline, "ANA", T.airlineOption, "ANA");
	await form.getByTestId(T.flightFrom).first().fill("JFKK");
	await form.getByTestId(T.flightTo).first().fill("HND");
	await form.getByTestId(T.flightDepTime).first().fill("02:00");
	await form.getByTestId(T.flightSave).click();
	await page.waitForTimeout(600);
	const errs = await form.getByTestId(T.flightError).allInnerTexts();
	log(`FLT-02 errors #1: ${JSON.stringify(errs)}`);
	await page.screenshot({ path: shot("flt02-errors") });
	// FLT-03 + FLT-01: fill it properly.
	await form.getByTestId(T.flightNumber).first().fill("nh9");
	await form.getByTestId(T.flightNumber).first().blur();
	log(`FLT-03 number normalised to "${await form.getByTestId(T.flightNumber).first().inputValue()}"`);
	await pick(page, form, T.flightFrom, "jfk", T.airportOption, "JFK");
	await pick(page, form, T.flightTo, "hnd", T.airportOption, "HND");
	log(`FLT-03 from="${await form.getByTestId(T.flightFrom).first().inputValue()}" to="${await form.getByTestId(T.flightTo).first().inputValue()}"`);
	await form.getByTestId(T.flightDepDate).first().fill("2027-10-22");
	await form.getByTestId(T.flightDepTime).first().fill("02:00");
	// Arrival before departure (same day 05:00 JST = 16:00 previous day EDT).
	await form.getByTestId(T.flightArrDate).first().fill("2027-10-22");
	await form.getByTestId(T.flightArrTime).first().fill("05:00");
	await form.getByTestId(T.flightSave).click();
	await page.waitForTimeout(600);
	log(`FLT-02 errors #2 (arrival before departure): ${JSON.stringify(await form.getByTestId(T.flightError).allInnerTexts())}`);
	await form.getByTestId(T.flightArrDate).first().fill("2027-10-23");
	await form.getByTestId(T.flightArrTime).first().fill("05:00");
	await page.waitForTimeout(300);
	log(`FLT-03 duration: ${await form.getByTestId(T.flightDuration).first().innerText().catch(() => "?")}`);
	await form.getByTestId(T.flightFromTerminal).first().fill("7").catch(() => log("no from terminal"));
	await form.getByTestId(T.flightToTerminal).first().fill("3").catch(() => log("no to terminal"));
	if (await form.getByTestId(T.flightCabin).count()) {
		await form.getByTestId(T.flightCabin).first().click();
		await page.getByRole("option", { name: "Business" }).click();
	} else log("FLT-01 no cabin field in Add dialog");
	if (await form.getByTestId(T.flightAircraft).count()) await form.getByTestId(T.flightAircraft).first().fill("Boeing 777-300ER");
	const seats = form.getByTestId(T.flightSeat);
	const seatMembers = await seats.evaluateAll((els) => els.map((e) => `${e.getAttribute("data-member")}|${e.getAttribute("aria-label") ?? ""}`));
	log(`FLT-04 seat inputs (Add dialog): ${seatMembers.join(", ")}`);
	const labels = await form.locator("label").allInnerTexts();
	log(`FLT-01 form labels: ${labels.join(" | ").slice(0, 800)}`);
	if (await seats.count()) {
		await seats.nth(0).fill("8d");
		if ((await seats.count()) > 1) await seats.nth(1).fill("8g");
	}
	if (await form.getByTestId(T.flightRef).count()) await form.getByTestId(T.flightRef).first().fill("zk4p7q");
	await page.screenshot({ path: shot("flt01-form"), fullPage: false });
	await dlg.screenshot({ path: shot("flt01-dialog") });
	await form.getByTestId(T.flightSave).click();
	await expect(dlg).toBeHidden({ timeout: 15_000 });
	await page.waitForTimeout(2000);
	log(`FLT-01 url after save ${page.url()}`);
	const insp = (await page.getByTestId(TESTID.inspector).count()) ? await page.getByTestId(TESTID.inspector).innerText() : "(no inspector)";
	writeFileSync(path.join(OUT, "flt01-inspector.txt"), insp);
	const center = await page.getByTestId("center-panel").innerText();
	writeFileSync(path.join(OUT, "flt01-center.txt"), center);
	await page.screenshot({ path: shot("flt01-saved") });
	await page.reload();
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 45_000 });
	await page.waitForTimeout(2500);
	writeFileSync(path.join(OUT, "flt01-inspector-reload.txt"), (await page.getByTestId(TESTID.inspector).count()) ? await page.getByTestId(TESTID.inspector).innerText() : "(no inspector)");
	await page.screenshot({ path: shot("flt01-reload") });
	const g = await graph(page);
	const leg = g.legs.find((l) => l.mode === "flight" && JSON.stringify(l.details).includes("2027-10-22"));
	log(`FLT-01 stored leg ${JSON.stringify(leg ? { mode: leg.mode, details: leg.details } : null).slice(0, 1500)}`);
	log(`FLT-01 errors ${JSON.stringify(errors)}`);
});

test("FLT-04/05: guests never in seat pickers; refs masked and never sent to link users; Kai sees them", async ({ browser }) => {
	// Guest-E joins first (so a guest is "present").
	const bodies: { url: string; text: string }[] = [];
	const guestCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const guest = await guestCtx.newPage();
	guest.on("response", async (r) => {
		const ct = r.headers()["content-type"] ?? "";
		if (/json|html|text|javascript|stream/.test(ct) || r.url().includes("_serverFn")) bodies.push({ url: r.url(), text: await r.text().catch(() => "") });
	});
	await guest.goto(`${APP}/join#t=qa-share-token-editor-asia-2027`);
	await expect(guest).toHaveURL(/\/t\/asia-2027/, { timeout: 30_000 });
	await guest.waitForTimeout(2500);
	const { page } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?tab=plan");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 45_000 });
	const g = await graph(page);
	const nh9 = g.legs.find((l) => itemLabel(g, l.fromItemId) === "Check in (JFK T7)");
	const sel = `sel=l.${nh9?.fromItemId}.${nh9?.toItemId}`;
	await page.goto(`/t/asia-2027?${sel}`);
	await expect(page.getByTestId(TESTID.legOverview)).toBeVisible({ timeout: 30_000 });
	await page.getByTestId(TESTID.legOverview).getByRole("button", { name: "Edit flight" }).click();
	const form = page.getByTestId(TESTID.legOverview).getByTestId(T.flightForm);
	const seatMembers = await form.getByTestId(T.flightSeat).evaluateAll((els) => els.map((e) => e.getAttribute("data-member") ?? ""));
	const memberNames = await page.evaluate((ids) => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		const ms = (window as any).__yonder?.graph?.members ?? [];
		return ids.map((id: string) => {
			const m = ms.find((x: { id: string }) => x.id === id);
			return m ? `${m.firstName ?? m.name ?? "?"} ${m.lastName ?? ""} (${m.role}${m.isGuest ? ",guest" : ""}${m.status ? `,${m.status}` : ""})` : id;
		});
	}, seatMembers);
	log(`FLT-04 seat pickers on NH 9: ${memberNames.join(", ")}`);
	const allMembers = await page.evaluate(() => {
		// biome-ignore lint/suspicious/noExplicitAny: introspection
		return ((window as any).__yonder?.graph?.members ?? []).map((m: Record<string, unknown>) => `${m.firstName ?? m.name} ${m.lastName ?? ""} role=${m.role} guest=${m.isGuest ?? m.kind}`);
	});
	log(`FLT-04 graph members: ${allMembers.join(" | ")}`);
	await page.screenshot({ path: shot("flt04-seats") });
	// FLT-05: the guest opens NH 9.
	await guest.goto(`/t/asia-2027?${sel}`);
	await expect(guest.getByTestId(TESTID.legOverview)).toBeVisible({ timeout: 30_000 });
	await guest.waitForTimeout(2500);
	const gText = await guest.getByTestId(TESTID.legOverview).innerText();
	writeFileSync(path.join(OUT, "flt05-guest-nh9.txt"), gText);
	await guest.screenshot({ path: shot("flt05-guest-nh9") });
	// Viewer link guest too.
	const vCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const v = await vCtx.newPage();
	v.on("response", async (r) => {
		const ct = r.headers()["content-type"] ?? "";
		if (/json|html|text|javascript|stream/.test(ct) || r.url().includes("_serverFn")) bodies.push({ url: `V ${r.url()}`, text: await r.text().catch(() => "") });
	});
	await v.goto(`${APP}/join#t=qa-share-token-viewer-asia-2027`);
	await expect(v).toHaveURL(/\/t\/asia-2027/, { timeout: 30_000 });
	await v.goto(`/t/asia-2027?${sel}`);
	await expect(v.getByTestId(TESTID.legOverview)).toBeVisible({ timeout: 30_000 });
	await v.waitForTimeout(2500);
	writeFileSync(path.join(OUT, "flt05-viewer-nh9.txt"), await v.getByTestId(TESTID.legOverview).innerText());
	await v.screenshot({ path: shot("flt05-viewer-nh9") });
	// Also the Plan cards and the Fuji Excursion + SP3 legs for the guest.
	for (const [f, t] of [["Breakfast", "Drop bags at ryokan"], ["Board SP3", "Lào Cai Station"]]) {
		const l = g.legs.find((x) => itemLabel(g, x.fromItemId) === f && itemLabel(g, x.toItemId) === t);
		await guest.goto(`/t/asia-2027?sel=l.${l?.fromItemId}.${l?.toItemId}`);
		await expect(guest.getByTestId(TESTID.legOverview)).toBeVisible({ timeout: 30_000 });
		await guest.waitForTimeout(2000);
		writeFileSync(path.join(OUT, `flt05-guest-${f.replace(/\W/g, "")}.txt`), await guest.getByTestId(TESTID.legOverview).innerText());
	}
	const leaks = ["ZK4P7Q", "E7K2Q9", "VNR-26X8"].map((s) => `${s}:${bodies.filter((b) => b.text.includes(s)).map((b) => b.url.slice(0, 120)).join(",") || "none"}`);
	log(`FLT-05 leaks in guest responses (${bodies.length} bodies): ${leaks.join(" | ")}`);
	const center = await guest.getByTestId("center-panel").innerText();
	log(`FLT-05 guest plan contains ZK4P7Q: ${center.includes("ZK4P7Q")} 8D: ${/\b8D\b/.test(center)}`);
	// Kai (viewer member) sees them in full.
	const kai = await asUser(browser, "kai@asia2027.test");
	await kai.page.goto(`/t/asia-2027?${sel}`);
	await expect(kai.page.getByTestId(TESTID.legOverview)).toBeVisible({ timeout: 30_000 });
	await kai.page.waitForTimeout(2000);
	const kText = await kai.page.getByTestId(TESTID.legOverview).innerText();
	log(`FLT-05 Kai sees ref: ${kText.includes("ZK4P7Q")} seats: ${kText.includes("8D")}`);
	await kai.page.screenshot({ path: shot("flt05-kai") });
	await guestCtx.close();
	await vCtx.close();
});

test("FLT-06: Audrey moves NH 9's arrival to 05:40; Dennis sees it ripple", async ({ browser }) => {
	const d = await asUser(browser, "dennis@asia2027.test");
	const a = await asUser(browser, "audrey@asia2027.test");
	await d.page.goto("/t/asia-2027?days=2027-10-03");
	await expect(d.page.getByTestId("workspace")).toBeVisible({ timeout: 45_000 });
	const g = await graph(d.page);
	const nh9 = g.legs.find((l) => itemLabel(g, l.fromItemId) === "Check in (JFK T7)");
	await a.page.goto(`/t/asia-2027?sel=l.${nh9?.fromItemId}.${nh9?.toItemId}`);
	await expect(a.page.getByTestId(TESTID.legOverview)).toBeVisible({ timeout: 30_000 });
	await d.page.waitForTimeout(2000);
	const before = await d.page.getByTestId("center-panel").innerText();
	writeFileSync(path.join(OUT, "flt06-before.txt"), before);
	await a.page.getByTestId(TESTID.legOverview).getByRole("button", { name: "Edit flight" }).click();
	const form = a.page.getByTestId(TESTID.legOverview).getByTestId(T.flightForm);
	await form.getByTestId(T.flightArrTime).first().fill("05:40");
	await form.getByTestId(T.flightSave).click();
	const t0 = Date.now();
	let seen = -1;
	for (let i = 0; i < 25; i++) {
		const txt = await d.page.getByTestId("center-panel").innerText();
		if (txt.includes("05:40")) {
			seen = Date.now() - t0;
			break;
		}
		await d.page.waitForTimeout(200);
	}
	log(`FLT-06 Dennis saw 05:40 after ${seen}ms`);
	await d.page.waitForTimeout(1000);
	const after = await d.page.getByTestId("center-panel").innerText();
	writeFileSync(path.join(OUT, "flt06-after.txt"), after);
	await d.page.screenshot({ path: shot("flt06-dennis") });
	// Revert.
	await a.page.getByTestId(TESTID.legOverview).getByRole("button", { name: "Edit flight" }).click();
	await a.page.getByTestId(TESTID.legOverview).getByTestId(T.flightForm).getByTestId(T.flightArrTime).first().fill("05:00");
	await a.page.getByTestId(TESTID.legOverview).getByTestId(T.flightForm).getByTestId(T.flightSave).click();
	await a.page.waitForTimeout(1500);
	log(`FLT-06 errors d=${JSON.stringify(d.errors)} a=${JSON.stringify(a.errors)}`);
});
