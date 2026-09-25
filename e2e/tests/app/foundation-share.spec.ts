/**
 * Foundation check 6: share links end to end.
 * The owner creates a trip, turns on its "Can view" link in the Share dialog;
 * an anonymous browser opens the link, becomes a guest and can view but not
 * edit (the UI guard is disabled, the server refuses the write, the note is
 * read-only); the owner turns the link off and the guest's access ends at
 * once (socket closed, no refetch possible, the trip URL says no access).
 */
import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { collectConsole, expectLive, hydrated } from "./_helpers/page";

/** Calls a server function from inside the page (the real HTTP path: CSRF, middleware, authz). */
async function callFn(page: Page, module: string, fn: string, data: unknown) {
	return page.evaluate(
		async ({ module, fn, data }) => {
			try {
				const m = await import(module);
				return { ok: true, value: await m[fn]({ data }) };
			} catch (e) {
				return { ok: false, error: e instanceof Error ? e.message : String(e) };
			}
		},
		{ module, fn, data },
	);
}

test("viewer link: a guest can view, can't edit, and loses access when it's turned off", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "one browser run is enough");
	const ownerCtx = await browser.newContext({ storageState: storageStateOf("dev") });
	const owner = await ownerCtx.newPage();
	const ownerConsole = collectConsole(owner);

	// A fresh trip: it has no share links yet.
	await owner.goto("/dashboard");
	await (await hydrated(owner.getByTestId(TESTID.newTripButton))).click();
	const tripName = `Share test ${randomBytes(2).toString("hex")}`;
	await owner.getByTestId(TESTID.newTripName).fill(tripName);
	await owner.getByTestId(TESTID.newTripSubmit).click();
	await expect(owner.getByTestId(TESTID.workspace)).toBeVisible();
	await owner.keyboard.press("Escape");
	const tripUrl = new URL(owner.url()).pathname;

	// Create the viewer link in the Share dialog.
	await owner.getByTestId(TESTID.shareButton).click();
	const viewerRow = owner.locator(`[data-testid=${TESTID.shareLinkRow}][data-role=viewer]`);
	await expect(viewerRow.getByTestId(TESTID.shareLinkSwitch)).not.toBeChecked();
	await viewerRow.getByTestId(TESTID.shareLinkSwitch).click();
	await expect(viewerRow.getByTestId(TESTID.shareLinkSwitch)).toBeChecked();
	const urlInput = viewerRow.getByTestId(TESTID.shareLinkUrl);
	await expect(urlInput).toHaveValue(/\/join#t=[A-Za-z0-9_-]{43}$/);
	const link = await urlInput.inputValue();
	// The link expires (SECURITY §2), with an Extend action.
	await expect(viewerRow.getByTestId(TESTID.shareLinkExpiry)).toContainText("Works until");
	// Screenshot only once the switch has settled (no mid-animation frames).
	await expect(viewerRow.getByTestId(TESTID.shareLinkSwitch)).toHaveAttribute("data-state", "checked");
	await owner.screenshot({ path: shotPath("foundation/share-dialog.png"), animations: "disabled" });
	await owner.keyboard.press("Escape");

	// An anonymous browser opens it: guest session, then the trip, read-only.
	const guestCtx = await browser.newContext();
	const guest = await guestCtx.newPage();
	const guestConsole = collectConsole(guest, [
		// Expected on the refused writes below and after the revocation.
		/Failed to load resource: the server responded with a status of 40[34]/,
	]);
	await guest.goto(link);
	await expect(guest).toHaveURL(new RegExp(`${tripUrl}(/|\\?|$)`), { timeout: 20_000 });
	await expect(guest.getByTestId(TESTID.tripMenu)).toContainText(tripName);
	await expectLive(guest);
	// The token never stays in the address bar.
	expect(guest.url()).not.toContain("#t=");

	const slug = tripUrl.split("/")[2] ?? "";
	const resolved = await callFn(guest, "/src/functions/trips.functions.ts", "resolveTripSlug", { slug });
	expect(resolved.ok).toBe(true);
	const id = (resolved as { value: { tripId: string } }).value.tripId;

	// The UI guard: the trip settings Save is disabled with the reason.
	await guest.getByTestId(TESTID.tripMenu).click();
	await guest.getByRole("menuitem", { name: "Trip settings" }).click();
	await expect(guest.getByTestId(TESTID.tripSettingsDialog).getByRole("button", { name: "Save" })).toBeDisabled();
	await guest.keyboard.press("Escape");
	await expect(guest.getByTestId(TESTID.tripSettingsDialog)).toBeHidden();
	await expect(guest.getByRole("menu")).toBeHidden();

	// The server refuses writes from the viewer guest.
	const write = await callFn(guest, "/src/functions/trips.functions.ts", "updateTrip", { tripId: id, name: "hacked" });
	expect(write.ok).toBe(false);
	expect((write as { error: string }).error).toMatch(/^FORBIDDEN/);
	const item = await callFn(guest, "/src/functions/items.functions.ts", "createItem", { tripId: id, dayId: null, title: "hack" });
	expect((item as { error?: string }).error).toMatch(/^FORBIDDEN/);
	// Reads work.
	const read = await callFn(guest, "/src/functions/graph.functions.ts", "getTripGraph", { tripId: id });
	expect(read.ok).toBe(true);
	expect((read as { value: { me: { role: string; isGuest: boolean } } }).value.me).toMatchObject({ role: "viewer", isGuest: true });
	await guest.screenshot({ path: shotPath("foundation/guest-view.png"), animations: "disabled" });

	// The owner turns the link off: the guest is cut off.
	await owner.getByTestId(TESTID.shareButton).click();
	await viewerRow.getByTestId(TESTID.shareLinkSwitch).click();
	await expect(viewerRow.getByTestId(TESTID.shareLinkSwitch)).not.toBeChecked();
	// The collab server closes the guest's socket; the re-auth is refused and the
	// page says the link no longer works (QA LINK-04), never the sign-in page.
	await expect(guest).toHaveURL(/\/join$/, { timeout: 10_000 });
	await expect(guest.getByText("This link no longer works.")).toBeVisible();
	const after = await callFn(guest, "/src/functions/graph.functions.ts", "getTripGraph", { tripId: id });
	expect(after.ok).toBe(false);
	expect((after as { error: string }).error).toMatch(/^NOT_FOUND/);
	await guest.goto(tripUrl);
	await expect(guest.getByText("This link is no longer active.")).toBeVisible({ timeout: 15_000 });
	await guest.screenshot({ path: shotPath("foundation/guest-revoked.png"), animations: "disabled" });

	// Expected paths (refused writes, revocation, not-found) stay quiet: no
	// React error boundaries or route-match errors in the console.
	expect(guestConsole.messages).toEqual([]);
	expect(ownerConsole.messages).toEqual([]);
	await guestCtx.close();
	await ownerCtx.close();
});
