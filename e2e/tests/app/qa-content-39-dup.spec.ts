/**
 * I2 "content" verifier, round 2: Audrey duplicates Asia 2027 (ADDENDUM §9):
 * relative booking windows stay relative and move with the new dates; Dennis's
 * private items and private notes never come along; hidden PDFs stay hidden.
 */
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { LISTS_TESTID as L } from "../../../src/features/lists/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";

test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");
const AUTH = process.env.QA_AUTH_DIR ?? "";
const SHOTS = process.env.QA_SHOTS ?? "/tmp";
const shot = (p: Page, n: string) => p.screenshot({ path: path.join(SHOTS, `${n}.png`), animations: "disabled" });
test.use({ storageState: path.join(AUTH, "audrey.json"), viewport: { width: 1440, height: 900 } });
async function call<T>(page: Page, mod: string, fn: string, data: unknown): Promise<T> {
	return page.evaluate(
		async ({ mod, fn, data }) => {
			const m = await import(mod);
			try {
				return await m[fn]({ data });
			} catch (e) {
				return { __error: (e as Error).message };
			}
		},
		{ mod, fn, data },
	) as Promise<T>;
}
type Li = { id: string; text: string; isPrivate: boolean; dueRule: { itemId: string; kind: string } | null; dueDate: string | null };

test("duplicate: relative windows, private items/notes, hidden PDFs", async ({ page }) => {
	test.setTimeout(180_000);
	await page.goto("/t/asia-2027?tab=lists&list=todo");
	await expectLive(page);
	const g = await page.evaluate(() => (window as unknown as { __yonder: { graph: { trip: { id: string } } } }).__yonder.graph);
	// Audrey keeps a private item of her own.
	await call(page, "/src/features/lists/lists.functions.ts", "createListItem", { tripId: g.trip.id, target: { kind: "trip" }, list: "todo", text: "AUDREY own private todo", isPrivate: true });
	const src = await call<Li[]>(page, "/src/features/lists/lists.functions.ts", "listTripListItems", { tripId: g.trip.id });
	const srcRel = src.filter((r) => r.dueRule);
	console.log("source relative rows:", srcRel.length);
	const dup = await call<{ tripId?: string; slug?: string; __error?: string }>(page, "/src/features/home/dashboard.functions.ts", "duplicateTrip", {
		tripId: g.trip.id,
		name: "Asia 2027 copy",
		startDate: "2027-10-09",
		include: { notes: true, lists: true, media: true, budgets: true, placeholders: false },
	});
	console.log("duplicate:", JSON.stringify(dup));
	expect(dup.tripId).toBeTruthy();
	await page.goto(`/t/${dup.slug}?tab=lists&list=todo`);
	await expectLive(page);
	const rows = await call<Li[]>(page, "/src/features/lists/lists.functions.ts", "listTripListItems", { tripId: dup.tripId });
	const txt = JSON.stringify(rows);
	console.log("copy rows", rows.length, "relative:", rows.filter((r) => r.dueRule).length, "PEARL/SURPRISE/GIFTX:", /PEARL|SURPRISE|GIFTX/.test(txt), "Audrey private:", rows.some((r) => r.text === "AUDREY own private todo" && r.isPrivate));
	const ana = page.getByTestId(TESTID.listsTab).getByTestId(L.row).filter({ hasText: "ANA JFK→HND award (depart Oct 2)" }).first();
	console.log("ANA row in copy:", (await ana.innerText().catch(() => "missing")).replace(/\n/g, " | "));
	await shot(page, "39-dup-lists");
	const notes = await call(page, "/src/features/notes/notes.functions.ts", "listTripNotes", { tripId: dup.tripId });
	console.log("copy notes mention SECRET:", /SECRET/.test(JSON.stringify(notes)));
	const media = await call<{ visibility: string; kind: string; title: string | null }[]>(page, "/src/features/media/media.functions.ts", "listTripMedia", { tripId: dup.tripId });
	console.log("copy PDFs:", JSON.stringify(media.filter((m) => m.kind === "pdf").map((m) => `${m.title}:${m.visibility}`)));
	expect(txt).not.toMatch(/PEARL|SURPRISE|GIFTX/);
	expect(JSON.stringify(notes)).not.toMatch(/SECRET/);
	expect(rows.filter((r) => r.dueRule).length).toBe(srcRel.length);
	// Clean up: delete the copy.
	const del = await call(page, "/src/functions/trips.functions.ts", "deleteTrip", { tripId: dup.tripId });
	console.log("delete copy:", JSON.stringify(del).slice(0, 100));
});
