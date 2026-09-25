/**
 * The public landing page (`/`) and the dashboard's move to `/dashboard`:
 * - signed out, `/` is the landing: server-rendered with its search and share
 *   tags, the globe and every section, every screenshot loads, nothing
 *   scrolls sideways, no console errors or warnings, and the CTA leads to
 *   sign-in;
 * - signed in, `/` is the landing too, its links leading to `/dashboard`;
 *   only an older install's `/?source=pwa` start forwards there;
 * - the installed app starts on the dashboard (`/dashboard?source=pwa`).
 */
import { expect, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { storageStateOf } from "./_helpers/env";
import {
	collectConsole,
	expectNoHorizontalOverflow,
	hydrated,
} from "./_helpers/page";

test.describe("signed out", () => {
	test("the landing renders, and its CTA leads to sign-in", async ({ page }) => {
		const log = collectConsole(page);
		const res = await page.goto("/");
		expect(res?.status()).toBe(200);
		expect(new URL(page.url()).pathname).toBe("/");

		// Server-rendered: the HTML itself has the headline, the globe and the tags.
		const html = (await res?.text()) ?? "";
		expect(html).toContain("Plan trips together.");
		expect(html).toContain('id="landing-globe-title"');
		expect(html).toMatch(/<link rel="canonical" href="https?:\/\/[^"]+\/"/);
		expect(html).toMatch(/<meta property="og:image" content="https?:\/\/[^"]+\/og\.png"/);
		expect(html).toContain('name="twitter:card" content="summary_large_image"');
		expect(html).toContain('name="robots" content="index, follow"');
		expect(html).not.toContain("noindex");

		await expect(
			page.getByRole("heading", { level: 1, name: "Plan trips together." }),
		).toBeVisible();
		await expect(
			page.getByRole("img", { name: /globe with an example trip/ }),
		).toBeVisible();
		for (const name of [
			"Decide together",
			"Every day, planned",
			"The whole trip at a glance",
			"Live, together",
			"Everything else, in the same place",
			"Where to next?",
		])
			await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
		await expect(
			page.getByRole("link", { name: "support@yonder.sh" }),
		).toHaveAttribute("href", "mailto:support@yonder.sh");
		await expect(page.getByRole("link", { name: "GitHub" })).toHaveAttribute(
			"href",
			"https://github.com/yonder-sh/yonder",
		);

		// The screenshots are lazy: scroll through, then every shown one has loaded.
		await page.evaluate(async () => {
			for (let y = 0; y < document.body.scrollHeight; y += 500) {
				window.scrollTo(0, y);
				await new Promise((r) => setTimeout(r, 40));
			}
		});
		await expect
			.poll(() =>
				page.evaluate(() =>
					[...document.querySelectorAll("main img")]
						.filter((img) => (img as HTMLElement).offsetParent !== null)
						.filter((img) => !(img as HTMLImageElement).complete || (img as HTMLImageElement).naturalWidth === 0)
						.map((img) => (img as HTMLImageElement).currentSrc),
				),
			)
			.toEqual([]);
		await expectNoHorizontalOverflow(page);

		await page.evaluate(() => window.scrollTo(0, 0));
		const cta = await hydrated(
			page.getByRole("link", { name: /Start planning today/ }).first(),
		);
		await cta.click();
		await expect(page).toHaveURL(/\/login$/);
		await expect(page.getByTestId("login-email")).toBeVisible();
		expect(log.messages).toEqual([]);
	});
});

test.describe("signed in", () => {
	test.use({ storageState: storageStateOf("dev") });

	test("/ is the landing, leading to /dashboard; an older install's start forwards", async ({ page }) => {
		const res = await page.request.get("/", { maxRedirects: 0 });
		expect(res.status()).toBe(200);
		expect(await res.text()).toContain("Plan trips together.");
		const pwa = await page.request.get("/?source=pwa", { maxRedirects: 0 });
		expect(pwa.headers().location).toMatch(/\/dashboard\?source=pwa$/);

		await page.goto("/");
		await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
		await (await hydrated(page.getByRole("link", { name: "Your trips", exact: true }))).click();
		await expect(page).toHaveURL(/\/dashboard$/);
		await expect(page.getByTestId(TESTID.dashboard)).toBeVisible();
		await page.goBack();
		await page.getByRole("link", { name: /Go to your trips/ }).first().click();
		await expect(page).toHaveURL(/\/dashboard$/);
	});

	test("the installed app starts on the dashboard", async ({ page }) => {
		const manifest = (await (
			await page.request.get("/manifest.webmanifest")
		).json()) as { start_url: string; id: string };
		expect(manifest.start_url).toBe("/dashboard?source=pwa");
		await page.goto(manifest.start_url);
		await expect(page).toHaveURL(/\/dashboard\?source=pwa$/);
		await expect(page.getByTestId(TESTID.dashboard)).toBeVisible();
	});
});
