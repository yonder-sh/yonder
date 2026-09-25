/** I2 verifier "home": AUTH-13 (a signed-out server-function call gets 401 and no trip data). */
import { expect, test } from "@playwright/test";
import { hydrated } from "./_helpers/page";

test.beforeEach(({}, info) => {
	test.skip(info.project.name === "mobile", "qa-home specs run on the desktop project");
});


const SHOTS = process.env.QA_SHOTS ?? "shots";

test("AUTH-13b: a signed-out server-function call is refused with no trip data", async ({ page }) => {
	await page.goto("/login");
	await hydrated(page.getByTestId("login-email"));
	const bodies: { url: string; status: number; body: string }[] = [];
	page.on("response", async (r) => {
		if (r.url().includes("/_serverFn/")) bodies.push({ url: r.url(), status: r.status(), body: (await r.text().catch(() => "")).slice(0, 300) });
	});
	const r = await page.evaluate(async () => {
		const m = await import("/src/functions/graph.functions.ts");
		try { return { ok: true, v: await m.getTripGraph({ data: { tripId: "01a0cea5-d26d-7713-a5c8-ede8e15b9662" } }) }; } catch (e) { return { ok: false, e: String(e) }; }
	});
	await page.waitForTimeout(500);
	console.log("AUTH-13b:", JSON.stringify(r).slice(0, 200), JSON.stringify(bodies));
	expect(r.ok).toBe(false);
	expect(bodies.some((b) => b.status === 401)).toBe(true);
	expect(JSON.stringify(bodies)).not.toMatch(/Golden Gai|Shibuya/);
});

