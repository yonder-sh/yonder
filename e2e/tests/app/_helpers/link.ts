/**
 * Guests through the trip's link. The trip's address IS its share link (like
 * Google Drive): a guest of role X opens `/t/<slug>` after the test lets the
 * link's next visitors in with X (`POST /api/test/link`, test routes only).
 * Each guest keeps the role they came in with (`pinTestLink`), so a spec can
 * have a viewer guest and an editor guest on one trip at once, as the old
 * per-role share links allowed. The route never gives the address a tail, so
 * the QA seed's fixed `/t/asia-2027` stays put.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { APP_URL, assertNotMainStack } from "./env";

export type LinkRole = "viewer" | "rater" | "suggester" | "editor";

const ROLES: readonly string[] = ["viewer", "rater", "suggester", "editor"];

/**
 * Lets the trip's next link visitors in with `role`, or (null) turns link
 * sharing off as the app does (its guests lose access at once).
 */
export async function setTestLink(
	request: APIRequestContext,
	slug: string,
	role: LinkRole | null,
): Promise<void> {
	assertNotMainStack();
	if (role !== null && !ROLES.includes(role)) throw new Error(`setTestLink: unknown role ${role}`);
	const res = await request.post("/api/test/link", {
		headers: { Origin: APP_URL },
		data: { slug, role },
	});
	if (res.ok()) return;
	const text = await res.text();
	if (res.status() === 404 && text.startsWith("Not found"))
		throw new Error("POST /api/test/link is off: run the app with ENABLE_TEST_ROUTES=1");
	throw new Error(`POST /api/test/link ${res.status()}: ${text}`);
}

/**
 * `page` opens the trip at `slug` through its link as a guest of `role`: an
 * anonymous guest in a fresh browser context, or the account signed in
 * there. `path` follows the slug (`/japan/tokyo?tab=plan`). Resolves once the
 * page has settled (the workspace, the "no access" page, or a redirect such
 * as /welcome), so the guest's grant exists before the spec goes on, as it
 * did when `/join` redirected to the trip.
 */
export async function openLink(page: Page, slug: string, role: LinkRole | string, path = ""): Promise<void> {
	await setTestLink(page.request, slug, role as LinkRole);
	await page.goto(`/t/${slug}${path}`);
	await settled(page);
}

/** The trip page is done loading: the workspace, "no access", or another page. */
export async function settled(page: Page, timeout = 45_000): Promise<void> {
	await page.waitForFunction(
		() =>
			!!document.querySelector('[data-testid="workspace"], [data-testid="trip-no-access"]') ||
			!location.pathname.startsWith("/t/"),
		undefined,
		{ timeout },
	);
}

type Me = { role: string; isGuest: boolean; linkRole?: string; userId?: string | null; name?: string };

/** `graph.me` of the open workspace (null before it loads). */
export function graphMe(page: Page): Promise<Me | null> {
	return page.evaluate(
		() => (window as unknown as { __yonder?: { graph?: { me: Me } } }).__yonder?.graph?.me ?? null,
	);
}

/**
 * Link guests only view (owner, 2026-10-09): a signed-in guest taps "Join the
 * trip" and becomes a member at the link's role.
 */
export async function joinTrip(page: Page): Promise<void> {
	const { expect } = await import("@playwright/test");
	await page.getByTestId("guest-nudge").getByTestId("guest-join-trip").click();
	await expect.poll(async () => (await graphMe(page))?.isGuest, { timeout: 15_000 }).toBe(false);
}

/**
 * An anonymous link guest signs in from the guest line as `email` (an account
 * that exists already, so no name step): that joins them at the link's role.
 * Resolves back on the trip as a member.
 */
export async function signInFromNudge(page: Page, email: string): Promise<void> {
	const { expect } = await import("@playwright/test");
	const { logOffset, readOtp } = await import("./otp");
	const back = new URL(page.url()).pathname;
	await page.getByTestId("guest-nudge").getByRole("link", { name: /^Sign in/ }).click();
	await page.getByTestId("login-email").fill(email);
	const since = logOffset();
	await page.getByTestId("login-submit").click();
	const otp = page.getByTestId("otp-input");
	await expect(otp).toBeVisible({ timeout: 15_000 });
	await otp.click();
	await page.keyboard.type(await readOtp(email, { since }));
	await expect(page).toHaveURL(new RegExp(back.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), { timeout: 30_000 });
	await expect.poll(async () => (await graphMe(page))?.isGuest, { timeout: 20_000 }).toBe(false);
}
