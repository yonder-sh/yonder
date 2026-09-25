/**
 * WP-Plan acceptance (SPEC §18.3 WP-Plan, CONTRACTS §4.3, EXTENSIONS §1.4),
 * each test on its own clone of the demo trip (SPEC §18.5):
 * - card times equal `window.__yonder.schedule`, and a duration change
 *   reflows a second browser live;
 * - a pin conflict shows ONE chip on the card and ONE on the day, and its fix works;
 * - a drop between a flight's items is refused with the toast;
 * - moving a stop detaches its significant leg: "… route unlinked · Undo",
 *   the amber row, and Undo restores it;
 * - unschedule / reschedule, insert and delete a day, never losing items;
 * - the day range and the person filter; typing a new name in the assignee
 *   picker adds a placeholder person (ADDENDUM §8);
 * - area blocks and city bands render;
 * - a viewer link sees the plan with no edit affordances;
 * - screenshots at 1440×900 and 390×844.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { PLAN_TESTID } from "../../../src/features/plan/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole, expectLive, expectNoHorizontalOverflow } from "./_helpers/page";
import { openLink } from "./_helpers/link";

test.use({ storageState: storageStateOf("dev") });

const DAY = {
	d1: "2027-10-03",
	d2: "2027-10-04",
	d3: "2027-10-05",
	d4: "2027-10-06",
	d5: "2027-10-07",
};

const card = (page: Page, itemId: string): Locator =>
	page.locator(`[data-testid="${TESTID.timelineItem}"][data-item-id="${itemId}"]`).first();

type YonderGraph = {
	days: { id: string }[];
	items: { id: string; dayId: string | null; assigneeIds: string[] }[];
	members: { id: string; name: string; status: string }[];
	me: { memberId: string | null };
};
const graphOf = (page: Page) =>
	page.evaluate(() => (window as unknown as { __yonder: { graph: YonderGraph } }).__yonder.graph);

/** "HH:mm" start/end of every scheduled item, in its own zone, from the page's schedule. */
const scheduleTimes = (page: Page) =>
	page.evaluate(() => {
		const y = (window as unknown as {
			__yonder: { schedule: { items: Record<string, { start: Date; end: Date; tz: string }> } };
		}).__yonder;
		const f = (d: Date, tz: string) =>
			new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
		return Object.fromEntries(
			Object.entries(y.schedule.items).map(([id, s]) => [id, [f(s.start, s.tz), f(s.end, s.tz)] as const]),
		);
	});

async function openItemMenu(page: Page, itemId: string) {
	const c = card(page, itemId);
	await c.hover();
	await c.getByTestId(PLAN_TESTID.itemMenu).click();
}

test("card times equal the schedule, and a duration change reflows a second browser live", async ({
	page,
	browser,
}, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout; one run is enough");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	const url = `/t/${c.slug}?lens=place`;
	await page.goto(url);
	await expectLive(page);
	await expect(card(page, I.hands as string)).toBeVisible();

	const times = await scheduleTimes(page);
	expect(Object.keys(times).length).toBeGreaterThan(8);
	for (const [id, [start, end]] of Object.entries(times)) {
		const el = card(page, id);
		if (!(await el.count())) continue; // layover items are drawn as blocks
		await expect(el.getByTestId(TESTID.itemStart)).toHaveText(start);
		await expect(el.getByTestId(TESTID.itemEnd)).toHaveText(end);
	}

	const otherCtx = await browser.newContext({ storageState: storageStateOf("dev") });
	const other = await otherCtx.newPage();
	await other.goto(url);
	await expectLive(other);
	const loftThere = card(other, I.loft as string).getByTestId(TESTID.itemStart);
	await expect(loftThere).toHaveText("09:48");

	// Hands Shibuya 45m → 1h30: Loft moves from 09:48 to 10:33 here and there.
	await card(page, I.hands as string).getByTestId(PLAN_TESTID.itemDuration).getByRole("button").click();
	await page.getByRole("dialog").getByRole("button", { name: "1h30", exact: true }).click();
	await expect(card(page, I.loft as string).getByTestId(TESTID.itemStart)).toHaveText("10:33");
	await expect(loftThere).toHaveText("10:33", { timeout: 10_000 });
	await otherCtx.close();
	expect(logs.messages).toEqual([]);
});

test("a pin conflict shows one chip on the card and one on the day, and Unpin fixes it", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await page.goto(`/t/${c.slug}?lens=place&days=${DAY.d1}`);
	await expectLive(page);
	const sky = card(page, I.sky as string);
	await sky.getByRole("button", { name: "Pinned at 17:30" }).click();
	await page.getByLabel("Pinned start").fill("10:00");
	await page.getByRole("button", { name: "Update" }).click();
	await expect(sky.getByTestId(TESTID.itemStart)).toHaveText("10:00");
	await expect(sky.getByTestId(TESTID.conflictBadge)).toHaveCount(1);
	const header = page.getByTestId(PLAN_TESTID.dayHeader).first();
	await expect(header.getByTestId(TESTID.conflictBadge)).toHaveCount(1);
	await page.screenshot({ path: shotPath("plan/conflict-1440.png"), animations: "disabled" });

	await sky.getByTestId(TESTID.conflictBadge).click();
	await page.getByRole("button", { name: /^Unpin/ }).click();
	await expect(sky.getByTestId(TESTID.conflictBadge)).toHaveCount(0);
	await expect(header.getByTestId(TESTID.conflictBadge)).toHaveCount(0);
	await expect(sky.getByLabel("pinned")).toHaveCount(0);
});

test("booked for this date shows a lock on the rail and in the Overview; menu items open their editors in one step", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await page.goto(`/t/${c.slug}?lens=place&days=${DAY.d2}`);
	await expectLive(page);
	const itoya = card(page, I.itoya as string);
	await expect(itoya.getByLabel("Booked for this date")).toHaveCount(0);
	await openItemMenu(page, I.itoya as string);
	await page.getByRole("menuitemcheckbox", { name: "Booked for this date" }).click();
	await expect(itoya.getByLabel("Booked for this date")).toBeVisible();
	// It is stored (the graph carries `fixedDate`), not just drawn.
	await page.reload();
	await expectLive(page);
	await expect(itoya.getByLabel("Booked for this date")).toBeVisible();
	await itoya.click();
	await expect(page.getByTestId(PLAN_TESTID.overviewBooked)).toHaveAttribute("aria-checked", "true");
	await openItemMenu(page, I.itoya as string);
	await expect(page.getByRole("menuitemcheckbox", { name: "Booked for this date" })).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await page.keyboard.press("Escape");

	// The day menu's "Set stay…" opens the stay picker in one step.
	const header = page.getByTestId(PLAN_TESTID.dayHeader).first();
	await header.getByTestId(PLAN_TESTID.dayMenu).click();
	await page.getByRole("menuitem", { name: "Set stay…" }).click();
	await page.getByPlaceholder("Search places…").fill("Ryokan");
	await page.getByRole("option", { name: /Kawaguchiko Ryokan/ }).click();
	await expect(header.getByTestId(PLAN_TESTID.dayStay)).toContainText("Kawaguchiko Ryokan");

	// Menu items that open another surface keep it open (the focus stays there).
	await header.getByTestId(PLAN_TESTID.dayMenu).click();
	await page.getByRole("menuitem", { name: "Add a title…" }).click();
	await expect(page.getByLabel("Day title")).toBeFocused();
	await page.keyboard.type("Knives and pens");
	await page.keyboard.press("Enter");
	await expect(header.getByTestId(PLAN_TESTID.dayTitle)).toHaveText("Knives and pens");
	await openItemMenu(page, I.sensoji as string);
	await page.getByRole("menuitem", { name: "Pin start time…" }).click();
	// The popover's own field and Pin (the selected item's Overview has both too).
	const pin = page.getByRole("dialog").filter({ has: page.getByLabel("Pinned start") });
	await expect(pin.getByLabel("Pinned start")).toBeFocused();
	await pin.getByLabel("Pinned start").fill("09:30");
	await pin.getByRole("button", { name: "Pin", exact: true }).click();
	await expect(card(page, I.sensoji as string).getByTestId(TESTID.itemStart)).toHaveText("09:30");
	expect(logs.messages).toEqual([]);
});

test("dropping a stop between a flight's items is refused with the toast", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "mouse drag");
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await page.goto(`/t/${c.slug}?lens=place&days=${DAY.d4}..${DAY.d5}`);
	await expectLive(page);
	const from = card(page, I.kiyomizu as string);
	const to = card(page, I.icn as string);
	await expect(to).toBeVisible();
	const a = await from.boundingBox();
	const b = await to.boundingBox();
	if (!a || !b) throw new Error("no boxes");
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 12, { steps: 4 });
	await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 });
	await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 2, { steps: 2 });
	await page.mouse.up();
	await expect(page.getByText("Flights move with their times — edit the flight.")).toBeVisible();
	// Nothing moved.
	const g = await graphOf(page);
	expect(g.items.find((i) => i.id === I.kiyomizu)?.dayId).toBe(c.ids.days.d4);
});

/** A slow mouse drag from one element's centre to a point (dnd-kit needs real pointer moves). */
async function drag(page: Page, from: Locator, to: { x: number; y: number }) {
	const a = await from.boundingBox();
	if (!a) throw new Error("no source box");
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 10, { steps: 4 });
	await page.mouse.move(to.x, to.y, { steps: 25 });
	await page.mouse.move(to.x, to.y + 1, { steps: 2 });
	await page.mouse.up();
}

test("drag to reorder within a day, and drop a place from the Outline into a day", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "mouse drag");
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await page.goto(`/t/${c.slug}?lens=place&days=${DAY.d2}`);
	await expectLive(page);
	const dayItems = async () => {
		const g = await graphOf(page);
		return g.items.filter((i) => i.dayId === c.ids.days.d2).map((i) => i.id);
	};
	// Itoya (last) above Senso-ji (first).
	const target = await card(page, I.sensoji as string).boundingBox();
	if (!target) throw new Error("no target");
	await drag(page, card(page, I.itoya as string), { x: target.x + target.width / 2, y: target.y + 8 });
	await expect
		.poll(async () => {
			const g = await graphOf(page);
			const order = await page
				.locator(`[data-testid="${PLAN_TESTID.daySection}"] [data-testid="${TESTID.timelineItem}"]`)
				.evaluateAll((els) => els.map((e) => e.getAttribute("data-item-id")));
			return g.items.length > 0 ? order[0] : null;
		})
		.toBe(I.itoya);
	expect((await dayItems()).length).toBe(3);

	// A place dragged from the Outline lands on the day, at the drop point.
	const before = (await graphOf(page)).items.length;
	const row = page.getByTestId(TESTID.outlineRow).filter({ hasText: "Tokyo" }).first();
	await expect(row).toBeVisible();
	const day = await page.getByTestId(PLAN_TESTID.daySection).first().boundingBox();
	if (!day) throw new Error("no day");
	await drag(page, row, { x: day.x + day.width / 2, y: day.y + day.height - 40 });
	await expect.poll(async () => (await graphOf(page)).items.length).toBe(before + 1);
});

test("a drop below a day's last card goes at the end: a place from the Outline, a card from another day", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "chromium", "mouse drag");
	const c = await cloneFixtureTrip(page.request);
	await page.goto(`/t/${c.slug}?lens=place&days=${DAY.d2}..${DAY.d3}`);
	await expectLive(page);
	const d2 = c.ids.days.d2 as string;
	const d3 = c.ids.days.d3 as string;
	const order = async (dayId: string) =>
		(await graphOf(page)).items.filter((i) => i.dayId === dayId).map((i) => i.id);
	const section = (dayId: string) =>
		page.locator(`[data-testid="${PLAN_TESTID.daySection}"][data-day-id="${dayId}"]`).first();
	/** Just under the day's last card: the owner's "under the last place". */
	const belowLast = async (dayId: string) => {
		const last = (await order(dayId)).at(-1) as string;
		const box = await section(dayId).locator(`[data-item-id="${last}"]`).first().boundingBox();
		if (!box) throw new Error("no last card");
		return { x: box.x + box.width / 2, y: box.y + box.height + 14 };
	};

	// A place from the Outline, dropped under Day 2's last card, becomes its last item.
	const before = await order(d2);
	const row = page.getByTestId(TESTID.outlineRow).filter({ hasText: "Tokyo" }).first();
	await drag(page, row, await belowLast(d2));
	await expect.poll(async () => (await order(d2)).length).toBe(before.length + 1);
	const after = await order(d2);
	expect(after.slice(0, -1)).toEqual(before);

	// A card from Day 3, dropped under Day 2's last card, goes after it too.
	const moved = (await order(d3))[0] as string;
	await drag(page, section(d3).locator(`[data-item-id="${moved}"]`).first(), await belowLast(d2));
	await expect.poll(async () => (await order(d2)).at(-1)).toBe(moved);
	expect((await order(d2)).slice(0, -1)).toEqual(after);
});

test("moving a stop unlinks its route: toast with Undo, the amber row, Undo restores it", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await page.goto(`/t/${c.slug}?lens=place&days=${DAY.d1}..${DAY.d2}`);
	await expectLive(page);
	await openItemMenu(page, I.loft as string);
	await page.getByRole("menuitem", { name: "Move to day" }).click();
	await page.getByRole("menuitem", { name: /D2/ }).click();
	await expect(page.getByText("Hands Shibuya → Shibuya Loft route unlinked")).toBeVisible();
	// Hands → Loft (Day 1) and Itoya → Drop bags (Day 2, now followed by Loft) both unlink.
	await expect(page.getByRole("region", { name: "Day 1" }).getByTestId(PLAN_TESTID.unlinked)).toBeVisible();
	await page.screenshot({ path: shotPath("plan/unlinked-1440.png"), animations: "disabled" });
	await page.getByRole("button", { name: "Undo" }).first().click();
	await expect(page.getByTestId(PLAN_TESTID.unlinked)).toHaveCount(0);
	await expect
		.poll(async () => (await graphOf(page)).items.find((i) => i.id === I.loft)?.dayId)
		.toBe(c.ids.days.d1);
});

test("unschedule and reschedule; insert and delete a day never lose items", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await page.goto(`/t/${c.slug}?lens=place`);
	await expectLive(page);
	const before = await graphOf(page);

	await openItemMenu(page, I.meiji as string);
	await page.getByRole("menuitem", { name: "Unschedule" }).click();
	const unscheduled = page.getByTestId(PLAN_TESTID.unscheduled);
	await expect(unscheduled.locator(`[data-item-id="${I.meiji}"]`)).toBeVisible();
	await expect(unscheduled.locator(`[data-item-id="${I.meiji}"]`).getByTestId(TESTID.itemStart)).toHaveCount(0);

	await openItemMenu(page, I.meiji as string);
	await page.getByRole("menuitem", { name: "Schedule on" }).click();
	await page.getByRole("menuitem", { name: /D2/ }).click();
	await expect
		.poll(async () => (await graphOf(page)).items.find((i) => i.id === I.meiji)?.dayId)
		.toBe(c.ids.days.d2);

	// Insert a day after Day 1, then delete it again.
	const firstHeader = page.getByTestId(PLAN_TESTID.dayHeader).first();
	await firstHeader.getByTestId(PLAN_TESTID.dayMenu).click();
	await page.getByRole("menuitem", { name: "Insert day after" }).click();
	await expect.poll(async () => (await graphOf(page)).days.length).toBe(before.days.length + 1);
	const newHeader = page.getByTestId(PLAN_TESTID.dayHeader).nth(1);
	await expect(newHeader).toContainText("Day 2");
	await newHeader.getByTestId(PLAN_TESTID.dayMenu).click();
	await page.getByRole("menuitem", { name: "Delete day…" }).click();
	await page.getByTestId(PLAN_TESTID.dayDeleteConfirm).getByRole("button", { name: "Delete day" }).click();
	await expect.poll(async () => (await graphOf(page)).days.length).toBe(before.days.length);
	expect((await graphOf(page)).items.length).toBe(before.items.length);
});

test("day range, person filter, and a new person typed into the assignee picker", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const c = await cloneFixtureTrip(page.request);
	const I = c.ids.items;
	await page.goto(`/t/${c.slug}?lens=place`);
	await expectLive(page);

	// FB-08: a click on the header only selects the day; its filter toggle
	// shows that day, and the others fold before and after.
	const header = page.getByTestId(PLAN_TESTID.dayHeader).nth(1);
	await header.getByRole("heading").click();
	await expect(page).toHaveURL(/sel=d\./);
	await expect(page).not.toHaveURL(/days=/);
	await header.hover();
	await header.getByTestId(PLAN_TESTID.dayFilter).click();
	await expect(page).toHaveURL(new RegExp(`days=${DAY.d2}`));
	await expect(page.getByTestId(PLAN_TESTID.daySection)).toHaveCount(1);
	await expect(page.locator(`[data-testid="${PLAN_TESTID.fold}"][data-reason="before"]`)).toBeVisible();
	await page.getByTestId(PLAN_TESTID.rangeBar).getByRole("button", { name: "Show all" }).click();
	await expect(page.getByTestId(PLAN_TESTID.daySection).nth(2)).toBeVisible();

	// Assign Hands to a brand-new person by typing the name (ADDENDUM §8).
	await card(page, I.hands as string).click();
	const overview = page.getByTestId(TESTID.itemOverview);
	await expect(overview).toBeVisible();
	await overview.getByTestId(PLAN_TESTID.overviewAssignees).getByRole("button", { name: "Assign" }).click();
	await page.getByPlaceholder("Search or add a name…").fill("Kenji");
	await page.getByTestId("member-picker-add").click();
	await expect(overview.getByTestId(PLAN_TESTID.overviewAssignees)).toContainText("Kenji");
	await page.keyboard.press("Escape");
	await expect
		.poll(async () => (await graphOf(page)).members.some((m) => m.name === "Kenji" && m.status === "placeholder"))
		.toBe(true);

	// "Me": only my cards (QA TAG-01). Hands is Kenji's and nothing is mine,
	// so the Plan says so (DESIGN §12) and "Show everyone" brings it all back.
	await page.keyboard.press("Escape");
	await page.getByTestId(PLAN_TESTID.whoFilter).getByRole("button", { name: "Me", exact: true }).click();
	await expect(card(page, I.hands as string)).toHaveCount(0);
	await expect(page.getByTestId(TESTID.emptyState)).toContainText(/Nothing assigned to .+ here\./);
	await page.getByRole("button", { name: "Show everyone" }).click();
	await expect(card(page, I.hands as string)).toBeVisible();
	// Kenji's filter: exactly Hands, under its day; the other cards of the day are counted.
	await page.getByTestId(PLAN_TESTID.whoFilter).getByRole("button", { name: /Someone/ }).click();
	await page.getByRole("menuitem", { name: /Kenji/ }).click();
	await expect(page.getByTestId(TESTID.timelineItem)).toHaveCount(1);
	await expect(card(page, I.hands as string)).toBeVisible();
	await expect(page.getByTestId(PLAN_TESTID.dayHidden).first()).toBeVisible();
	await page.getByTestId(PLAN_TESTID.dayHidden).first().click();
	await expect(card(page, I.loft as string)).toBeVisible();
});

test("area blocks and city bands render; desktop screenshots", async ({ page }, info) => {
	test.skip(info.project.name !== "chromium", "desktop layout");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/t/${c.slug}/japan/tokyo?lens=area`);
	await expectLive(page);
	await expect(page.getByTestId(PLAN_TESTID.areaBlock).first()).toContainText("Shibuya");
	await expect(page.locator(`[data-testid="${PLAN_TESTID.fold}"]`).first()).toBeVisible();
	await page.screenshot({ path: shotPath("plan/area-1440.png"), animations: "disabled" });

	await page.goto(`/t/${c.slug}?lens=city`);
	await expectLive(page);
	await expect(page.getByTestId(PLAN_TESTID.band).first()).toContainText("Tokyo");
	await expect(page.getByTestId(PLAN_TESTID.bandLink).first()).toBeVisible();
	await page.screenshot({ path: shotPath("plan/bands-1440.png"), animations: "disabled" });

	await page.goto(`/t/${c.slug}?lens=place&days=${DAY.d4}..${DAY.d5}`);
	await expectLive(page);
	await expect(page.getByTestId(PLAN_TESTID.flightStub)).toBeVisible();
	await page.screenshot({ path: shotPath("plan/flight-1440.png"), animations: "disabled" });

	await page.goto(`/t/${c.slug}?lens=place&sel=i.${c.ids.items.sky}`);
	await expectLive(page);
	await expect(page.getByTestId(TESTID.itemOverview)).toBeVisible();
	await page.screenshot({ path: shotPath("plan/place-1440.png"), animations: "disabled" });
	await expectNoHorizontalOverflow(page);
	expect(logs.messages).toEqual([]);
});

test("a viewer link sees the plan without edit affordances", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough");
	const ownerCtx = await browser.newContext({ storageState: storageStateOf("dev") });
	const c = await cloneFixtureTrip(ownerCtx.request);
	await ownerCtx.close();
	// A fresh, signed-out browser (test.use's storageState would otherwise apply).
	const guestCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const guest = await guestCtx.newPage();
	await openLink(guest, c.slug, "viewer");
	await expect(guest.getByTestId(TESTID.workspace)).toBeVisible({ timeout: 20_000 });
	await guest.goto(`${new URL(guest.url()).pathname}?lens=place`);
	await expect(guest.getByTestId(TESTID.timelineItem).first()).toBeVisible();
	await expect(guest.getByTestId(PLAN_TESTID.addBetween)).toHaveCount(0);
	await expect(guest.getByTestId(PLAN_TESTID.itemResize)).toHaveCount(0);
	await expect(guest.getByTestId(PLAN_TESTID.itemDuration).first().getByRole("button")).toBeDisabled();
	await guestCtx.close();
});

test("mobile: the plan in the sheet at 390×844", async ({ page }, info) => {
	test.skip(info.project.name !== "mobile", "mobile layout");
	const logs = collectConsole(page);
	const c = await cloneFixtureTrip(page.request);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/t/${c.slug}?lens=place`);
	await expectLive(page);
	const sheet = page.getByTestId(TESTID.mobileSheet);
	await expect(sheet.getByTestId(TESTID.dayChips)).toBeVisible();
	await expect(sheet.getByTestId(TESTID.nowNext)).toContainText("Starts in");
	await page.screenshot({ path: shotPath("plan/mobile-peek-390.png"), animations: "disabled" });
	// Drag the sheet up to its top snap.
	const handle = await sheet.boundingBox();
	if (!handle) throw new Error("no sheet");
	await page.mouse.move(195, handle.y + 8);
	await page.mouse.down();
	await page.mouse.move(195, handle.y - 300, { steps: 8 });
	await page.mouse.move(195, 60, { steps: 8 });
	await page.mouse.up();
	await expect(sheet.getByTestId(TESTID.timelineItem).first()).toBeVisible();
	await page.waitForTimeout(400);
	await page.screenshot({ path: shotPath("plan/mobile-plan-390.png"), animations: "disabled" });
	await expectNoHorizontalOverflow(page);
	expect(logs.messages).toEqual([]);
});
