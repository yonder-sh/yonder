/**
 * Money › Per person on phones (owner's report on the full draft: the Net
 * column was cut off at 390 px, "$7.2K$0.00$0.0…"). The name cell's points
 * line ("60,000 Aeroplan · 110,000 United") was as wide as its text, so the
 * table grew past the sheet and the numbers ran into each other. Now the name
 * truncates, the amounts keep a gap, and nothing is clipped at 390 or 320 px.
 */
import { expect, type Page, test } from "@playwright/test";
import { MONEY_TESTID as M } from "../../../src/features/money/testids";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";

test.use({ storageState: storageStateOf("dev") });

async function callFn<T>(page: Page, fn: string, data: unknown): Promise<T> {
	const r = await page.evaluate(
		async ({ fn, data }) => {
			try {
				const m = await import(/* @vite-ignore */ "/src/features/money/money.functions.ts");
				return { ok: true as const, value: await m[fn]({ data }) };
			} catch (e) {
				return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
			}
		},
		{ fn, data },
	);
	if (!r.ok) throw new Error(`${fn}: ${r.error}`);
	return r.value as T;
}

for (const width of [390, 320]) {
	test(`Per person fits a ${width} px phone: names truncate, Net is never cut off`, async ({ page }, info) => {
		test.skip(info.project.name !== "mobile", "phone layout");
		const c = await cloneFixtureTrip(page.request);
		await page.setViewportSize({ width, height: 844 });
		await page.goto(`/t/${c.slug}?tab=money`);
		await expectLive(page);
		const O = c.members.owner;
		const Y = c.members.maya as string;
		const A = c.members.audrey;
		const add = (data: Record<string, unknown>) =>
			callFn(page, "createExpense", { tripId: c.tripId, target: { kind: "trip" }, ...data });
		// Big planned costs, and two points bookings for the owner (the long line).
		await add({ title: "Ryokan", amountMinor: 723_456, currency: "USD", split: { mode: "equal", shares: [{ memberId: O }, { memberId: Y }, { memberId: A }] } });
		await add({
			title: "JFK → HND",
			amountMinor: 8_000,
			currency: "USD",
			points: { program: "Aeroplan", points: 60_000, cashValueMinor: 600_000, cashValueCurrency: "USD" },
			split: { mode: "equal", shares: [{ memberId: O }] },
		});
		await add({
			title: "TPE → IST",
			amountMinor: 5_600,
			currency: "USD",
			points: { program: "United MileagePlus", points: 110_000, cashValueMinor: 400_000, cashValueCurrency: "USD" },
			split: { mode: "equal", shares: [{ memberId: O }] },
		});
		// Made through the server functions: this tab learns of them on reload.
		await page.reload();
		await expectLive(page);
		await page.evaluate(async () => {
			const m = await import(/* @vite-ignore */ "/src/lib/workspace/ui-store.ts");
			m.useUi.getState().setSheetSnap(0.92);
		});
		const people = page.getByTestId(M.people).first();
		await expect(people).toBeVisible();
		await expect(people.getByTestId(M.personRow)).toHaveCount(3);
		await expect(people).toContainText("Aeroplan");
		await people.evaluate((el) => el.scrollIntoView({ block: "center" }));
		await page.waitForTimeout(400);
		await people.screenshot({ path: shotPath(`money/per-person-${width}.png`), animations: "disabled" });

		// Every number is whole, inside the section, and apart from its neighbour.
		const geo = await people.evaluate((section) => {
			const s = section.getBoundingClientRect();
			return [...section.querySelectorAll("tr")].map((tr) =>
				[...tr.querySelectorAll("td, th")].slice(1).map((td) => {
					const b = td.getBoundingClientRect();
					// The text as drawn (a hidden label has no boxes, so it doesn't count).
					const r = document.createRange();
					r.selectNodeContents(td);
					const t = r.getBoundingClientRect();
					// Visible through every clipping ancestor up to the section?
					let visRight = s.right;
					for (let el = td.parentElement; el && el !== section; el = el.parentElement)
						if (getComputedStyle(el).overflowX !== "visible")
							visRight = Math.min(visRight, el.getBoundingClientRect().right);
					return {
						text: (td as HTMLElement).innerText.trim(),
						left: t.left,
						right: t.right,
						sectionRight: s.right,
						clipped: t.right > b.right + 0.5 || t.left < b.left - 0.5 || t.right > visRight + 0.5,
					};
				}),
			);
		});
		for (const row of geo) {
			for (const [i, cell] of row.entries()) {
				expect(cell.right, `"${cell.text}" inside the section`).toBeLessThanOrEqual(cell.sectionRight + 0.5);
				expect(cell.clipped, `"${cell.text}" not clipped`).toBe(false);
				const next = row[i + 1];
				if (next) expect(next.left - cell.right, `gap after "${cell.text}"`).toBeGreaterThanOrEqual(6);
			}
		}
		// The page itself never scrolls sideways.
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		expect(overflow).toBeLessThanOrEqual(0);
		await expect(page.getByTestId(TESTID.moneyTab)).toBeVisible();
	});
}
