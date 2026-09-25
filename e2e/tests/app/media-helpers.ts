/** Small helpers shared by WP-Media's specs (`media-*.spec.ts`). */
import type { Page } from "@playwright/test";

/** Closes any open toasts (so screenshots show the UI, not the confirmation). */
export async function clearToasts(page: Page): Promise<void> {
	const toasts = page.locator("[data-sonner-toast]");
	for (let i = 0; i < 5 && (await toasts.count()) > 0; i++) {
		const close = page.locator("[data-sonner-toast] [data-close-button]").first();
		if (await close.isVisible().catch(() => false)) await close.click({ force: true }).catch(() => {});
		else await page.keyboard.press("Alt+t").catch(() => {});
		await page.waitForTimeout(250);
	}
	await page
		.waitForFunction(() => document.querySelectorAll("[data-sonner-toast]").length === 0, null, { timeout: 6_000 })
		.catch(() => {});
}
