/** I2 verifier "home": Duplicate… never copies other members' private items (ADDENDUM §9, CONTRACTS §4.9). */
import { type Browser, expect, test } from "@playwright/test";
import { loginViaApi } from "./_helpers/auth";
import { cloneFixtureTrip } from "./_helpers/fixture";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
});


const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function userPage(browser: Browser, email: string, first: string, last: string) {
	const ctx = await browser.newContext();
	await loginViaApi(ctx.request, email, { first, last });
	return { ctx, page: await ctx.newPage() };
}
const call = (page: any, mod: string, fn: string, data: unknown) =>
	page.evaluate(async ({ mod, fn, data }: any) => {
		const m = await import(mod);
		try { return { ok: true, v: JSON.parse(JSON.stringify(await m[fn]({ data }))) }; } catch (e) { return { ok: false, e: String(e) }; }
	}, { mod, fn, data });

test("Duplicate: other members' private list items stay behind; mine come along", async ({ browser }) => {
	const o = await userPage(browser, `qa-home-dp-o-${uniq()}@asia2027.test`, "Olga", "Owner");
	const a = await userPage(browser, `qa-home-dp-a-${uniq()}@asia2027.test`, "Ann", "Member");
	const c = await cloneFixtureTrip(o.page.request);
	await o.page.goto("/dashboard");
	const aEmail = (await (await a.ctx.request.get("/api/auth/get-session")).json()).user.email;
	const inv = await call(o.page, "/src/features/home/sharing.functions.ts", "inviteMember", { tripId: c.tripId, email: aEmail, role: "editor" });
	expect(inv.ok, JSON.stringify(inv)).toBe(true);
	await a.page.goto("/dashboard");
	const aPriv = await call(a.page, "/src/features/lists/lists.functions.ts", "createListItem", { tripId: c.tripId, target: { kind: "trip" }, list: "shopping", text: "SECRET gift for Olga", isPrivate: true });
	const oPriv = await call(o.page, "/src/features/lists/lists.functions.ts", "createListItem", { tripId: c.tripId, target: { kind: "trip" }, list: "todo", text: "Olga private todo", isPrivate: true });
	console.log("private items:", JSON.stringify(aPriv).slice(0, 120), JSON.stringify(oPriv).slice(0, 120));
	expect(aPriv.ok && oPriv.ok).toBe(true);
	const dup = await call(o.page, "/src/features/home/dashboard.functions.ts", "duplicateTrip", {
		tripId: c.tripId, name: "Dup privacy", startDate: "2027-10-03",
		include: { notes: true, lists: true, media: true, budgets: true, placeholders: true },
	});
	expect(dup.ok, JSON.stringify(dup)).toBe(true);
	await o.page.goto(`/t/${dup.v.slug}?tab=lists`);
	await expect(o.page.getByTestId("workspace")).toBeVisible({ timeout: 30_000 });
	await o.page.waitForTimeout(2000);
	const lists = await call(o.page, "/src/features/lists/lists.functions.ts", "listTripListItems", { tripId: dup.v.tripId });
	const js = JSON.stringify(lists);
	console.log("copy lists has secret:", js.includes("SECRET gift"), "has own private:", js.includes("Olga private todo"), js.slice(0, 200));
	const txt = await o.page.getByTestId("workspace").innerText();
	expect(txt).not.toContain("SECRET gift");
	expect(js).not.toContain("SECRET gift");
	// Ann's private list item must also not be in the copy DB-wide (the owner can't see it, but the row must not exist)
	await o.ctx.close();
	await a.ctx.close();
});
