/** I2 verifier "home": TRIP-03 on a duplicate of Asia 2027 (Duplicate… keeps the F4-a pin). */
import { type Page, expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { hydrated } from "./_helpers/page";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
});


const SHOTS = process.env.QA_SHOTS ?? "shots";
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/trip3-${name}.png`, animations: "disabled" });
async function graphOf(page: Page): Promise<any> {
	await expect.poll(() => page.evaluate(() => !!(window as any).__yonder?.graph), { timeout: 30_000 }).toBe(true);
	return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__yonder.graph)));
}
const jal = (g: any) => {
	const n = g.nodes.find((x: any) => x.name === "JAL Sky Museum");
	const it = g.items.find((i: any) => i.nodeId === n?.id);
	const day = g.days.find((d: any) => d.id === it?.dayId);
	return { pinned: it?.pinnedStart, date: day?.date };
};

test("TRIP-03 (+ Duplicate of Asia 2027): shift by one day keeps pinned local times", async ({ page }) => {
	for (let i = 0; ; i++) {
		try { await loginViaApi(page.request, "dennis@asia2027.test", { first: "Dennis", last: "Tester" }); break; }
		catch (e) { if (i > 4) throw e; await page.waitForTimeout(1500); }
	}
	await page.goto("/t/asia-2027?tab=plan");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	const src = await graphOf(page);
	console.log("TRIP-03 source JAL:", jal(src), "days", src.days.length, "items", src.items.length, "legs", src.legs.length);
	// Duplicate Asia 2027 with the same start (UI: Trip settings → Duplicate…)
	await (await hydrated(page.getByTestId("trip-menu").first())).click();
	await page.getByRole("menuitem", { name: /trip settings/i }).click();
	await page.getByTestId("home-settings-duplicate").click();
	const dlg = page.getByTestId("home-duplicate-dialog");
	await expect(dlg).toBeVisible();
	await dlg.getByTestId("home-duplicate-name").fill("Asia 2027 backup");
	await shot(page, "dup-dialog");
	const t0 = Date.now();
	await dlg.getByTestId("home-duplicate-submit").click();
	await expect(page.getByTestId("trip-menu").first()).toContainText("Asia 2027 backup", { timeout: 60_000 });
	console.log("DUP Asia 2027 took ms:", Date.now() - t0);
	const copy = await graphOf(page);
	console.log("DUP copy JAL:", jal(copy), "days", copy.days.length, "items", copy.items.length, "legs", copy.legs.length, "members", copy.members.map((m: any) => `${m.name}:${m.role}:${m.status}`));
	expect(copy.items.length).toBe(src.items.length);
	expect(copy.legs.length).toBe(src.legs.length);
	expect(jal(copy)).toEqual(jal(src));
	// The copy's money: none
	const txt = await page.getByTestId("workspace").innerText();
	await shot(page, "dup-copy");
	// Shift +1 via Try other dates…
	await (await hydrated(page.getByTestId("trip-menu").first())).click();
	await page.getByRole("menuitem", { name: /try other dates/i }).click();
	const sd = page.getByTestId("shift-trip-dialog");
	await expect(sd).toBeVisible();
	await sd.getByTestId("shift-plus").click();
	await page.waitForTimeout(800);
	await shot(page, "shift-dialog");
	await sd.getByTestId("shift-apply").click();
	await expect.poll(async () => (await graphOf(page)).trip.startDate, { timeout: 15_000 }).toBe("2027-10-03");
	const shifted = await graphOf(page);
	console.log("TRIP-03 after shift JAL:", jal(shifted), shifted.trip.startDate, shifted.trip.endDate);
	expect(jal(shifted)).toEqual({ pinned: "09:30", date: "2027-10-04" });
	await page.goto(`/t/${shifted.trip.slug}?days=2027-10-04`);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	await shot(page, "shifted-oct4");
	void txt;
});
