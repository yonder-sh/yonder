/**
 * QA security verifier (I2 round 2): hostile URLs and upload types.
 * Link attachments, shopping-item URLs, node websites and embeds with
 * javascript:/data:/file: schemes or quote-breaking ids; uploads declared as
 * SVG/HTML; then Dennis opens the views and every rendered href/src is checked.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { type Page, test } from "@playwright/test";
import { call, EMAIL, GG, MOD, memberPage, T } from "./qa-security-helpers";

test.skip(!process.env.QA_SEC_DIR, "QA security verifier probes: set QA_SEC_DIR (see qa-security-helpers.ts)");
const DIR = process.env.QA_SEC_DIR ?? "/tmp";

const BAD_URLS = [
	"javascript:alert(document.domain)",
	"JaVaScRiPt:alert(1)",
	" javascript:alert(1)",
	"java\tscript:alert(1)",
	"data:text/html,<script>alert(1)</script>",
	"vbscript:msgbox(1)",
	"file:///etc/passwd",
	"https://www.youtube.com/watch?v=abc\"><img src=x onerror=alert(1)>",
	"https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=\"><script>alert(1)</script>",
	"https://www.tiktok.com/@a/video/123\"onload=\"alert(1)",
	"https://www.instagram.com/reel/abc'onload='alert(1)/",
	"https://evil.example/\"><svg onload=alert(1)>",
];

async function hrefState(page: Page) {
	return page.evaluate(() => {
		const bad = (v: string | null) => !!v && /^\s*(javascript|data|vbscript|file):/i.test(v.replace(/[\t\n\r]/g, ""));
		return {
			badHrefs: [...document.querySelectorAll("a[href]")].filter((a) => bad(a.getAttribute("href"))).map((a) => a.getAttribute("href")),
			badSrcs: [...document.querySelectorAll("iframe[src], img[src], video[src], source[src]")].filter((e) => bad(e.getAttribute("src"))).map((e) => e.getAttribute("src")),
			iframes: [...document.querySelectorAll("iframe[src]")].map((e) => e.getAttribute("src")),
			liveHandlers: [...document.querySelectorAll("[onerror],[onload]")].length,
			xss: (window as unknown as { __xss?: number }).__xss ?? 0,
		};
	});
}

test("hostile URLs and upload types", async ({ browser }) => {
	test.setTimeout(300_000);
	const out: Record<string, unknown> = {};
	const { ctx, page } = await memberPage(browser, EMAIL.audrey);
	const dialogs: string[] = [];
	const writes: Record<string, string> = {};
	for (const url of BAD_URLS) {
		const a = await call(page, MOD.media, "addLink", { tripId: T, target: { kind: "node", nodeId: GG }, url, caption: "hostile link" });
		writes[`addLink ${url}`] = a.ok ? `OK ${JSON.stringify(a.r).slice(0, 200)}` : a.err.slice(0, 100);
		const s = await call(page, MOD.lists, "createListItem", { tripId: T, target: { kind: "node", nodeId: GG }, list: "shopping", text: `hostile shop ${url.slice(0, 20)}`, url });
		writes[`shopping.url ${url}`] = s.ok ? "OK" : s.err.slice(0, 100);
	}
	for (const website of ["javascript:alert(1)", "data:text/html,x", "https://ok.example/\"><img src=x onerror=alert(1)>"]) {
		const r = await call(page, MOD.nodes, "updateNode", { nodeId: GG, patch: { details: { website } } });
		writes[`node.website ${website}`] = r.ok ? "OK" : r.err.slice(0, 100);
	}
	for (const [type, name] of [
		["image/svg+xml", "x.svg"],
		["text/html", "x.html"],
		["application/xhtml+xml", "x.xhtml"],
		["application/javascript", "x.js"],
		["image/jpeg", "../../../etc/passwd.jpg"],
		["application/pdf", "<img src=x onerror=alert(1)>.pdf"],
	] as const) {
		const r = await call(page, MOD.media, "createUpload", { tripId: T, target: { kind: "node", nodeId: GG }, type, size: 1000, name });
		writes[`createUpload ${type} ${name}`] = r.ok ? `OK ${JSON.stringify(r.r).slice(0, 160)}` : r.err.slice(0, 100);
	}
	out.writes = writes;
	await ctx.close();

	const d = await memberPage(browser, EMAIL.dennis, "Dennis", "Tester");
	d.page.on("dialog", async (x) => {
		dialogs.push(`${x.type()}:${x.message()}`);
		await x.dismiss().catch(() => undefined);
	});
	const states: Record<string, unknown> = {};
	await d.page.goto("/t/asia-2027/japan/tokyo/shinjuku/golden-gai");
	await d.page.waitForTimeout(4000);
	for (const tab of ["Media", "Lists", "Plan", "Notes"]) {
		const t = d.page.getByRole("tab", { name: new RegExp(`^${tab}`) }).first();
		if (await t.isVisible().catch(() => false)) {
			await t.click().catch(() => undefined);
			await d.page.waitForTimeout(2500);
			states[tab] = await hrefState(d.page);
			await d.page.screenshot({ path: path.join(DIR, `r2-urls-${tab}.png`) });
		}
	}
	// Overview (website link).
	states.overview = await hrefState(d.page);
	await d.page.goto("/t/asia-2027/rate");
	await d.page.waitForTimeout(4000);
	states.rate = await hrefState(d.page);
	out.states = states;
	out.dialogs = dialogs;
	writeFileSync(path.join(DIR, "r2-urls.json"), JSON.stringify(out, null, 1));
	console.log(JSON.stringify(out, null, 1));
	await d.ctx.close();
});
