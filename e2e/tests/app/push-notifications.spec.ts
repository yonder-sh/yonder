/**
 * Web Push UI: the in-app permission card, the account's notification
 * settings and the trip menu's "Mute notifications". Playwright can't receive
 * real pushes, so the browser's push plumbing is stubbed in the page
 * (`Notification`, `PushManager`, the service worker registration) and the
 * server's side is checked in `push_subscriptions` / the settings it returns.
 *
 * Needs the app running WITH VAPID keys (`pnpm vapid:keys` into the env):
 * without them push is off and the card never shows (the spec skips).
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import { PUSH_TESTID } from "../../../src/features/push/testids";
import { TESTID } from "../../../src/lib/testids";
import { storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";
import { psql } from "./_helpers/psql";

test.use({ storageState: storageStateOf("dev") });

test.skip(
	!process.env.VAPID_PUBLIC_KEY,
	"push is off: start the app with VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT",
);

/**
 * A push-capable browser that hasn't decided yet. The stub keeps its state in
 * localStorage, so it survives reloads within a test (and each test's fresh
 * context starts undecided).
 */
function stubPush() {
	const KEY = "__pushStub";
	type State = {
		permission: NotificationPermission;
		endpoint: string;
		subscribed: boolean;
		p256dh?: string;
		auth?: string;
	};
	let state: State;
	try {
		state = JSON.parse(localStorage.getItem(KEY) ?? "null") ?? {
			permission: "default",
			endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${Math.random().toString(36).slice(2)}`,
			subscribed: false,
		};
	} catch {
		return;
	}
	const save = () => localStorage.setItem(KEY, JSON.stringify(state));
	save();
	const b64url = (bytes: Uint8Array) =>
		btoa(String.fromCharCode(...bytes))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	/** Real P-256 keys, like a browser's (the server refuses unusable ones). */
	const makeKeys = async () => {
		if (state.p256dh) return;
		const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
		state.p256dh = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
		state.auth = b64url(crypto.getRandomValues(new Uint8Array(16)));
	};
	const sub = () => ({
		endpoint: state.endpoint,
		options: { applicationServerKey: null },
		toJSON: () => ({
			endpoint: state.endpoint,
			keys: { p256dh: state.p256dh, auth: state.auth },
		}),
		unsubscribe: async () => {
			state.subscribed = false;
			save();
			return true;
		},
	});
	const registration = {
		active: {},
		pushManager: {
			getSubscription: async () => (state.subscribed ? sub() : null),
			subscribe: async () => {
				await makeKeys();
				state.subscribed = true;
				save();
				return sub();
			},
		},
	};
	class FakeNotification {
		static get permission() {
			return state.permission;
		}
		static async requestPermission() {
			state.permission = "granted";
			save();
			return "granted";
		}
	}
	Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true });
	Object.defineProperty(window, "PushManager", { value: function PushManager() {}, configurable: true });
	const real = navigator.serviceWorker;
	const fake = {
		getRegistration: async () => registration,
		ready: Promise.resolve(registration),
		register: async () => registration,
		controller: null,
		addEventListener: (...a: Parameters<ServiceWorkerContainer["addEventListener"]>) =>
			real?.addEventListener(...a),
		removeEventListener: (...a: Parameters<ServiceWorkerContainer["removeEventListener"]>) =>
			real?.removeEventListener(...a),
	};
	Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => fake, configurable: true });
}

const stubEndpoint = (page: Page) =>
	page.evaluate(() => (JSON.parse(localStorage.getItem("__pushStub") ?? "{}") as { endpoint?: string }).endpoint ?? "");
const storedDevices = (endpoint: string) =>
	Number(psql(`select count(*) from push_subscriptions where endpoint = '${endpoint.replace(/'/g, "")}'`));

async function openTrip(page: Page, slug: string) {
	await page.addInitScript(stubPush);
	await page.goto(`/t/${slug}?tab=plan`);
	await expectLive(page);
}

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

/** The trip menu: the title ▾ on desktop, "More" on phones. */
async function openTripMenu(page: Page) {
	const menu = page.getByRole("menu");
	await expect(menu).toHaveCount(0);
	const trigger = isMobile(page)
		? page.locator('button[aria-label="More"]')
		: page.getByTestId(TESTID.tripMenu);
	// A click that lands while the last menu hands focus back can be swallowed.
	await expect(async () => {
		if (!(await menu.isVisible())) await trigger.click();
		await expect(menu).toBeVisible({ timeout: 1_500 });
	}).toPass({ timeout: 10_000 });
}

async function openSettings(page: Page) {
	if (isMobile(page)) await openTripMenu(page);
	else await page.getByTestId(TESTID.accountMenu).click();
	await page.getByTestId(PUSH_TESTID.accountItem).click();
	const dialog = page.getByTestId(PUSH_TESTID.dialog);
	await expect(dialog).toBeVisible();
	return dialog;
}

const typeSwitch = (page: Page, type: string) =>
	page.locator(`[data-testid="${PUSH_TESTID.type}"][data-type="${type}"]`);

test("the card asks on first trip open; turning it on stores this device, once", async ({ page, request }) => {
	const c = await cloneFixtureTrip(request);
	await openTrip(page, c.slug);
	const card = page.getByTestId(PUSH_TESTID.card);
	await expect(card).toBeVisible({ timeout: 10_000 });
	await expect(card).toHaveAttribute("data-kind", "ask");
	await expect(card).toContainText("Turn on notifications");
	await card.getByTestId(PUSH_TESTID.cardEnable).click();
	await expect(card).toBeHidden();
	await expect(page.getByText("Notifications are on")).toBeVisible();
	const endpoint = await stubEndpoint(page);
	await expect.poll(() => storedDevices(endpoint)).toBe(1);

	// Decided: no card on the next visit.
	await page.reload();
	await expectLive(page);
	await page.waitForTimeout(2_000);
	await expect(card).toHaveCount(0);
});

test("“Not now” hides the card on this device", async ({ page, request }) => {
	const c = await cloneFixtureTrip(request);
	await openTrip(page, c.slug);
	const card = page.getByTestId(PUSH_TESTID.card);
	await expect(card).toBeVisible({ timeout: 10_000 });
	await card.getByTestId(PUSH_TESTID.cardDismiss).click();
	await expect(card).toBeHidden();
	expect(storedDevices(await stubEndpoint(page))).toBe(0);
	await page.reload();
	await expectLive(page);
	await page.waitForTimeout(2_000);
	await expect(card).toHaveCount(0);
});

test("iPhone Safari in a tab: the card explains Add to Home Screen instead", async ({ browser, request }, info) => {
	test.skip(info.project.name === "mobile", "its own iPhone context");
	const c = await cloneFixtureTrip(request);
	const page = await iphone(browser);
	await page.goto(`/t/${c.slug}?tab=plan`);
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 20_000 });
	const card = page.getByTestId(PUSH_TESTID.card);
	await expect(card).toBeVisible({ timeout: 10_000 });
	await expect(card).toHaveAttribute("data-kind", "ios");
	await expect(card).toContainText("Add to Home Screen");
	await expect(card.getByTestId(PUSH_TESTID.cardEnable)).toHaveCount(0);
	await card.getByTestId(PUSH_TESTID.cardDismiss).click();
	await expect(card).toBeHidden();
	await page.context().close();
});

async function iphone(browser: Browser): Promise<Page> {
	const ctx = await browser.newContext({
		storageState: storageStateOf("dev"),
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	return ctx.newPage();
}

test("settings: per-type switches persist; this device turns off", async ({ page, request }) => {
	const c = await cloneFixtureTrip(request);
	await openTrip(page, c.slug);
	await page.getByTestId(PUSH_TESTID.card).getByTestId(PUSH_TESTID.cardEnable).click();
	await expect(page.getByText("Notifications are on")).toBeVisible();
	const endpoint = await stubEndpoint(page);

	let dialog = await openSettings(page);
	const device = dialog.getByTestId(PUSH_TESTID.device);
	await expect(device).toHaveAttribute("data-state", "checked");
	// Every type starts on.
	await expect(dialog.getByTestId(PUSH_TESTID.type)).toHaveCount(10);
	const countdown = typeSwitch(page, "countdown");
	await expect(countdown).toHaveAttribute("data-state", "checked");
	await countdown.click();
	await expect(countdown).toHaveAttribute("data-state", "unchecked");

	// Stored on the account: still off after a reload.
	await page.reload();
	await expectLive(page);
	dialog = await openSettings(page);
	await expect(typeSwitch(page, "countdown")).toHaveAttribute("data-state", "unchecked");
	await expect(typeSwitch(page, "mention")).toHaveAttribute("data-state", "checked");
	await typeSwitch(page, "countdown").click();
	await expect(typeSwitch(page, "countdown")).toHaveAttribute("data-state", "checked");

	// This device off: the server forgets it.
	await dialog.getByTestId(PUSH_TESTID.device).click();
	await expect(dialog.getByTestId(PUSH_TESTID.device)).toHaveAttribute("data-state", "unchecked");
	await expect.poll(() => storedDevices(endpoint)).toBe(0);
});

test("the trip menu mutes one trip; the settings list it and unmute it", async ({ page, request }) => {
	const c = await cloneFixtureTrip(request);
	await openTrip(page, c.slug);
	await page.getByTestId(PUSH_TESTID.card).getByTestId(PUSH_TESTID.cardDismiss).click();

	await openTripMenu(page);
	const item = page.getByTestId(PUSH_TESTID.muteItem);
	await expect(item).toHaveText(/Mute notifications/);
	await item.click();
	await expect(page.getByText(/Notifications muted for/)).toBeVisible();
	await expect(page.getByRole("menu")).toHaveCount(0);
	await openTripMenu(page);
	await expect(page.getByTestId(PUSH_TESTID.muteItem)).toHaveText(/Unmute notifications/);
	await page.keyboard.press("Escape");
	await expect.poll(() => Number(psql(`select count(*) from notification_mutes where trip_id = '${c.tripId}'`))).toBe(1);

	const dialog = await openSettings(page);
	const muted = dialog.locator(`[data-testid="${PUSH_TESTID.mutedTrip}"][data-trip-id="${c.tripId}"]`);
	await expect(muted).toHaveCount(1);
	await muted.getByRole("button", { name: "Unmute" }).click();
	await expect(muted).toHaveCount(0);
	await expect.poll(() => Number(psql(`select count(*) from notification_mutes where trip_id = '${c.tripId}'`))).toBe(0);
});
