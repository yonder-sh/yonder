#!/usr/bin/env node
// WP-Home screenshot helper (not a spec): signs in as a fixture user through
// the saved storageState, opens a path, logs console errors, and saves
// screenshots at 1440×900 and 390×844.
//   cd e2e && ./pw.sh node tests/app/home-shot.mjs <path> <name> [--user dev] [--click <css>] [--full]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const [path = "/dashboard", name = "shot"] = args.filter((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
const opt = (k, d) => {
	const i = args.indexOf(`--${k}`);
	return i >= 0 ? args[i + 1] : d;
};
const user = opt("user", "dev");
const click = opt("click", null);
const full = args.includes("--full");
const dark = args.includes("--dark");
const base = process.env.APP_URL ?? "http://localhost:5190";
const browser = await chromium.launch();
for (const [label, viewport, mobile] of [
	["desktop", { width: 1440, height: 900 }, false],
	["mobile", { width: 390, height: 844 }, true],
]) {
	const ctx = await browser.newContext({
		viewport,
		deviceScaleFactor: mobile ? 2 : 1,
		isMobile: mobile,
		hasTouch: mobile,
		colorScheme: dark ? "dark" : "light",
		storageState: user === "none" ? undefined : resolve(`.auth/${user}.json`),
	});
	const page = await ctx.newPage();
	page.on("console", (m) => {
		if (m.type() === "error" || m.type() === "warning") console.log(`[${label}] ${m.type()}: ${m.text()}`);
	});
	page.on("pageerror", (e) => console.log(`[${label}] pageerror: ${e.message}`));
	await page.goto(base + path, { waitUntil: "load" });
	await page.waitForTimeout(2500);
	if (click) {
		await page.locator(click).first().click();
		await page.waitForTimeout(1200);
	}
	const out = resolve(`shots/home/${name}-${label}${dark ? "-dark" : ""}.png`);
	mkdirSync(dirname(out), { recursive: true });
	await page.screenshot({ path: out, fullPage: full, animations: "disabled" });
	console.log(out);
	await ctx.close();
}
await browser.close();
