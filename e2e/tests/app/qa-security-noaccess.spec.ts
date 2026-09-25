/**
 * QA security verifier (I2 round 1): ERR-01, ERR-02, SEC-01 (UI side). Eve,
 * signed in but not on Asia 2027, opens its URLs: a friendly "no access", and
 * neither the page, its title, the HTML nor any network response reveals the
 * trip's name, dates, places or members. An existing-but-forbidden trip and a
 * missing one must look the same.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { EMAIL, GG, IDS, memberPage } from "./qa-security-helpers";

// Probes against the isolated QA-security stack (fixed QA-seed ids, own ports): opt-in only.
test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");

const DIR = process.env.QA_SEC_DIR ?? "/tmp";
const SECRETS = ["Asia 2027", "Golden Gai", "Shinjuku", "Dennis Tester", "Audrey Tester", "2027-10-02", "2027-11-05", "ZK4P7Q"];
const PHOTO: string = IDS.PHOTO ?? "01a0cf13-e76d-7683-9c36-f643a9647ff6";

test("a non-member learns nothing about a trip", async ({ browser }) => {
	test.setTimeout(180_000);
	const eve = await memberPage(browser, `qa-sec-outsider-${Date.now().toString(36)}@example.com`, "Eve", "Outsider");
	const out: Record<string, unknown> = {};
	const bodies: { url: string; body: string }[] = [];
	eve.page.on("response", async (r) => {
		const ct = r.headers()["content-type"] ?? "";
		if (/json|html|text\/x-component|octet|javascript/.test(ct) && !/\/(node_modules|@vite|@fs|src)\//.test(r.url()))
			bodies.push({ url: r.url(), body: await r.text().catch(() => "") });
	});
	for (const [label, url] of [
		["existing", "/t/asia-2027/japan/tokyo/shinjuku/golden-gai"],
		["missing", "/t/no-such-trip-xyz/japan/tokyo"],
		["rate", "/t/asia-2027/rate"],
		["uuid", "/t/00000000-0000-0000-0000-000000000000"],
	] as const) {
		const res = await eve.page.goto(url);
		await eve.page.waitForTimeout(3000);
		const html = (await res?.text()) ?? "";
		out[label] = {
			status: res?.status(),
			title: await eve.page.title(),
			text: (await eve.page.locator("body").innerText()).slice(0, 160),
			htmlLeaks: SECRETS.filter((s) => html.includes(s)),
			htmlBytes: html.length,
		};
		await eve.page.screenshot({ path: path.join(DIR, `noaccess-${label}.png`) });
	}
	out.networkLeaks = bodies.filter((b) => SECRETS.some((s) => b.body.includes(s))).map((b) => ({ url: b.url.slice(0, 120), hits: SECRETS.filter((s) => b.body.includes(s)) }));
	for (const [label, url] of [
		["photoRoute(existing node)", `/api/places/photo?nodeId=${GG}&idx=0&w=400`],
		["photoRoute(missing node)", `/api/places/photo?nodeId=00000000-0000-7000-8000-00000000abcd&idx=0&w=400`],
		["media(existing)", `/media/${PHOTO}/thumb`],
		["media(missing)", `/media/00000000-0000-7000-8000-00000000abcd/thumb`],
	] as const)
		out[label] = (await eve.page.request.get(url, { maxRedirects: 0 })).status();
	writeFileSync(path.join(DIR, "noaccess.json"), JSON.stringify(out, null, 1));
	await eve.ctx.close();
});
