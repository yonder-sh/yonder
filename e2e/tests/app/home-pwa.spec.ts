/**
 * WP-Home PWA and offline (SPEC §16; QA PWA-01, PWA-03, PWA-04, PWA-06,
 * PWA-08, E8 offline share; SPEC §18.3 WP-Home acceptance). These need the PRODUCTION build —
 * `pnpm build && ENABLE_TEST_ROUTES=1 pnpm start` on this checkout's port —
 * and skip themselves against `vite dev`, which has no service worker.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { openSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { HOME_TESTID } from "../../../src/features/home/testids";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import {
	APP_URL,
	REPO_ROOT,
	shotPath,
	storageStateOf,
} from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";

test.use({ storageState: storageStateOf("dev") });
// One worker, in order: the offline test stops the server, which would break
// a test running next to it.
test.describe.configure({ mode: "default" });

test.beforeEach(async ({ request }, info) => {
	test.skip(info.project.name !== "chromium", "service worker checks run once");
	const sw = await request.get("/sw.js");
	test.skip(
		!sw.ok(),
		"needs the production build: pnpm build && ENABLE_TEST_ROUTES=1 pnpm start",
	);
});

/**
 * Playwright's `setOffline` doesn't reach the service worker's own fetches
 * (spikes/pwa gotcha 8), so the offline test stops the production server
 * (`PWA_SERVER_PID`) and starts it again afterwards, like the spike did.
 */
const SERVER_PID = Number(process.env.PWA_SERVER_PID || 0);

async function health(): Promise<boolean> {
	try {
		return (await fetch(`${APP_URL}/api/health`)).ok;
	} catch {
		return false;
	}
}

async function stopServer() {
	process.kill(SERVER_PID, "SIGTERM");
	await expect.poll(health, { timeout: 15_000 }).toBe(false);
}

async function startServer() {
	const log = openSync(path.join(REPO_ROOT, ".data/prod.log"), "a");
	spawn(
		process.execPath,
		["--env-file-if-exists=.env", ".output/server/index.mjs"],
		{
			cwd: REPO_ROOT,
			env: {
				...process.env,
				ENABLE_TEST_ROUTES: "1",
				PORT: new URL(APP_URL).port,
			},
			detached: true,
			stdio: ["ignore", log, log],
		},
	).unref();
	await expect.poll(health, { timeout: 30_000 }).toBe(true);
}

async function swControls(page: Page) {
	await expect
		.poll(
			() =>
				page.evaluate(async () => {
					const reg = await navigator.serviceWorker.getRegistration();
					return !!reg?.active && !!navigator.serviceWorker.controller;
				}),
			{ timeout: 20_000 },
		)
		.toBe(true);
}

test("PWA-01: manifest, icons and a controlling service worker", async ({
	page,
	request,
}) => {
	const sw = await request.get("/sw.js");
	expect(sw.headers()["content-type"]).toContain("text/javascript");
	await page.goto("/dashboard");
	const href = await page
		.locator('link[rel="manifest"]')
		.getAttribute("href");
	expect(href).toBe("/manifest.webmanifest");
	const manifest = await (await request.get(href ?? "")).json();
	expect(manifest.display).toBe("standalone");
	for (const icon of manifest.icons as { src: string }[])
		expect((await request.get(icon.src)).status()).toBe(200);
	await swControls(page);
	// Still in control after a reload.
	await page.reload();
	await swControls(page);
});

test("PWA-03/04/06: the saved trip reads offline, deep links and cold start included", async ({
	page,
	context,
	request,
}) => {
	const c = await cloneFixtureTrip(request);
	await page.goto("/dashboard");
	await swControls(page);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expect(page.getByTestId(TESTID.workspace)).toBeVisible({
		timeout: 20_000,
	});
	// The shell is cached under /t/<slug>, and the trip is the saved one.
	await expect
		.poll(() =>
			page.evaluate(async (slug) => {
				const cache = await caches.open("pages");
				return !!(await cache.match(`/t/${slug}`, { ignoreSearch: true }));
			}, c.slug),
		)
		.toBe(true);
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("yonder:saved-trips") ?? ""),
		)
		.toContain(c.slug);
	// The persisted graph needs a beat to reach IndexedDB.
	await page.waitForTimeout(1500);

	test.skip(
		!SERVER_PID,
		"set PWA_SERVER_PID to the `pnpm start` process: the test stops it to go offline",
	);
	await stopServer();
	await context.setOffline(true);
	try {
		// A never-visited deep scope URL of the saved trip boots from the cache.
		await page.goto(`/t/${c.slug}/japan?lens=area`);
		await expect(page.getByTestId(TESTID.workspace)).toBeVisible({
			timeout: 20_000,
		});
		await expect(page.getByTestId(TESTID.offlineBanner)).toContainText(
			"editing paused",
		);
		await page.screenshot({
			path: shotPath("home/offline-trip-desktop.png"),
			animations: "disabled",
		});
		// Cold start from the home screen goes straight to the saved trip.
		const cold = await context.newPage();
		await cold.goto("/dashboard?source=pwa");
		await expect(cold).toHaveURL(new RegExp(`/t/${c.slug}\\?from=offline`), {
			timeout: 20_000,
		});
		// Another trip isn't available offline (offline.html says so, no loop).
		await cold.goto("/t/some-other-trip?tab=plan");
		await expect(cold.locator("h1")).toHaveText("Not available offline.");
		await cold.screenshot({
			path: shotPath("home/offline-fallback-desktop.png"),
			animations: "disabled",
		});
	} finally {
		await context.setOffline(false);
		await startServer();
	}
});

test("PWA-08: signing out removes the offline copy", async ({ browser }) => {
	// A fresh account: signing out revokes the session, so never the shared one.
	const ctx = await browser.newContext({ baseURL: APP_URL });
	await loginViaApi(
		ctx.request,
		`pwa-${randomBytes(3).toString("hex")}@example.test`,
		{ first: "Pia", last: "Offline" },
	);
	const c = await cloneFixtureTrip(ctx.request);
	const page = await ctx.newPage();
	await page.goto("/dashboard");
	await swControls(page);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expect(page.getByTestId(TESTID.workspace)).toBeVisible({
		timeout: 20_000,
	});
	await expect
		.poll(() => page.evaluate(() => caches.has("pages")))
		.toBe(true);
	await page.goto("/dashboard");
	await page.getByTestId(TESTID.accountMenu).click();
	await page.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(page).toHaveURL(/\/login/);
	const left = await page.evaluate(async () => ({
		pages: await caches.has("pages"),
		saved: localStorage.getItem("yonder:saved-trips"),
	}));
	expect(left).toEqual({ pages: false, saved: null });
	await ctx.close();
});

test("PWA-08: a trip lost while away loses its offline copy when the app next opens online", async ({
	browser,
}) => {
	const hex = randomBytes(3).toString("hex");
	const owner = await browser.newContext({ baseURL: APP_URL });
	await loginViaApi(owner.request, `pwa-o-${hex}@example.test`, {
		first: "Olga",
		last: "Owner",
	});
	const kai = await browser.newContext({ baseURL: APP_URL });
	const kaiEmail = `pwa-k-${hex}@example.test`;
	await loginViaApi(kai.request, kaiEmail, { first: "Kai", last: "Member" });
	const c = await cloneFixtureTrip(owner.request);
	const op = await owner.newPage();
	await op.goto(`/t/${c.slug}?tab=plan`);
	await expect(op.getByTestId(TESTID.workspace)).toBeVisible({
		timeout: 20_000,
	});
	await op.getByTestId(TESTID.shareButton).first().click();
	const dlg = op.getByTestId(TESTID.shareDialog);
	await dlg.getByTestId(HOME_TESTID.inviteEmail).fill(kaiEmail);
	await dlg.getByTestId(HOME_TESTID.inviteSubmit).click();
	const row = dlg
		.getByTestId(HOME_TESTID.memberRow)
		.filter({ hasText: "Kai Member" });
	await expect(row).toBeVisible();
	// Kai opens the trip online: it's his offline copy now.
	const kp = await kai.newPage();
	await kp.goto("/dashboard");
	await swControls(kp);
	await kp.goto(`/t/${c.slug}?tab=plan`);
	await expect(kp.getByTestId(TESTID.workspace)).toBeVisible({
		timeout: 20_000,
	});
	const offlineCopy = () =>
		kp.evaluate(async (slug) => {
			const cache = await caches.open("pages");
			return {
				saved: (localStorage.getItem("yonder:saved-trips") ?? "").includes(
					slug,
				),
				shell: !!(await cache.match(`/t/${slug}`, { ignoreSearch: true })),
			};
		}, c.slug);
	await expect.poll(offlineCopy).toEqual({ saved: true, shell: true });
	await kp.goto("about:blank");
	// The owner removes him while he's away.
	await row.getByTestId(HOME_TESTID.memberMenu).click();
	await op.getByRole("menuitem", { name: /remove from trip/i }).click();
	await expect(row).toBeHidden({ timeout: 10_000 });
	// He opens the app online at "/dashboard" (never the trip): the copy is gone, so an
	// offline start can't open it any more.
	await kp.goto("/dashboard");
	await expect(kp.getByTestId(TESTID.dashboard)).toBeVisible({
		timeout: 20_000,
	});
	await expect
		.poll(offlineCopy, { timeout: 15_000 })
		.toEqual({ saved: false, shell: false });
	await owner.close();
	await kai.close();
});

test("E8: a share sent offline opens the inbox, kept on this device", async ({
	page,
	context,
}) => {
	await page.goto("/dashboard");
	await swControls(page);
	await expect(page.getByTestId(TESTID.dashboard)).toBeVisible();
	// The worker keeps the /share shell while signed in (activate + WARM_SHARE).
	await expect
		.poll(
			() =>
				page.evaluate(
					async () => !!(await (await caches.open("pages")).match("/share")),
				),
			{ timeout: 15_000 },
		)
		.toBe(true);
	test.skip(
		!SERVER_PID,
		"set PWA_SERVER_PID to the `pnpm start` process: the test stops it to go offline",
	);
	await stopServer();
	await context.setOffline(true);
	try {
		// What the OS share sheet does: a multipart POST to the share target.
		await page.evaluate(() => {
			const form = document.createElement("form");
			form.method = "POST";
			form.action = "/share";
			form.enctype = "multipart/form-data";
			for (const [k, v] of [
				["title", "Offline share"],
				["url", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
			]) {
				const i = document.createElement("input");
				i.type = "hidden";
				i.name = k as string;
				i.value = v as string;
				form.appendChild(i);
			}
			document.body.appendChild(form);
			form.submit();
		});
		await expect(page).toHaveURL(/\/share\?id=/, { timeout: 15_000 });
		await expect(page.getByTestId(TESTID.shareInbox)).toContainText(
			"kept on this device",
			{ timeout: 20_000 },
		);
	} finally {
		await context.setOffline(false);
		await startServer();
	}
});
