/**
 * Foundation check 5, in real browsers on one cloned trip:
 * - two editors' collab providers on the trip's root note sync;
 * - a viewer's provider on the same note is read-only and its writes never
 *   reach anyone;
 * - a server-function mutation (rename via the trip settings dialog) publishes
 *   after COMMIT and the other browser receives the stateless `invalidate` on
 *   the trip channel and shows the new name without a reload.
 *
 * The provider code is the app's own `collab-client.ts`, imported from the
 * Vite dev server inside each page (so this spec needs `pnpm dev`).
 */
import { randomBytes } from "node:crypto";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { loginViaApi } from "./_helpers/auth";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { expectLive } from "./_helpers/page";
import { openLink } from "./_helpers/link";

type Probe = {
	write(text: string): void;
	text(): string;
	readOnly(): boolean;
	synced(): boolean;
	messages(): { type: string; keys?: string[]; by?: string }[];
};

/** Opens `docName` (and the channel) with the page's own collab client and exposes a probe. */
async function attachProbe(page: Page, tripId: string, docName: string): Promise<void> {
	await page.evaluate(
		async ({ tripId, docName }) => {
			const m = await import("/src/lib/realtime/collab-client.ts");
			const client = m.getCollabClient();
			if (!client) throw new Error("no collab client");
			const note = client.acquire(docName);
			const channel = client.acquire(`trip/${tripId}`);
			const messages: unknown[] = [];
			channel.onStateless((raw: string) => messages.push(JSON.parse(raw)));
			(window as unknown as { __probe: Probe }).__probe = {
				write: (t: string) => note.doc.getText("e2e-probe").insert(0, t),
				text: () => note.doc.getText("e2e-probe").toString(),
				readOnly: () => note.getSnapshot().readOnly,
				synced: () => note.getSnapshot().synced,
				messages: () => messages as ReturnType<Probe["messages"]>,
			};
		},
		{ tripId, docName },
	);
	await page.waitForFunction(() => (window as unknown as { __probe?: Probe }).__probe?.synced());
}

/** Runs `fn(window.__probe)` in the page (the function is sent as source). */
const probe = <T>(page: Page, fn: (p: Probe) => T) =>
	page.evaluate(`(${fn.toString()})(window.__probe)`) as Promise<T>;

async function open(browser: Browser, handle: string | null, url: string) {
	const ctx = await browser.newContext(handle ? { storageState: storageStateOf(handle) } : {});
	const page = await ctx.newPage();
	await page.goto(url);
	await expectLive(page);
	return { ctx, page };
}

test("notes sync, viewers are read-only, mutations reach the other browser", async ({ browser }, info) => {
	test.skip(info.project.name !== "chromium", "one browser run is enough");
	const owner = await browser.newContext({ storageState: storageStateOf("dev") });
	const trip = await cloneFixtureTrip(owner.request);
	await owner.close();

	// The viewer: a fresh named account that opens the clone's viewer link, so it
	// reads the trip with the viewer role (SPEC §11.3) without being a member.
	const viewerEmail = `viewer-${randomBytes(3).toString("hex")}@example.com`;
	const viewerCtx = await browser.newContext();
	await loginViaApi(viewerCtx.request, viewerEmail, { first: "Vera", last: "Viewer" });

	const url = `/t/${trip.slug}?tab=plan`;
	const a = await open(browser, "dev", url);
	const b = await open(browser, "maya", url);
	const vPage = await viewerCtx.newPage();
	await openLink(vPage, trip.slug, "viewer");
	await expect(vPage).toHaveURL(new RegExp(`/t/${trip.slug}`), { timeout: 20_000 });
	await expectLive(vPage);

	const note = `trip/${trip.tripId}/root`;
	await attachProbe(a.page, trip.tripId, note);
	await attachProbe(b.page, trip.tripId, note);
	await attachProbe(vPage, trip.tripId, note);

	// Two editors sync.
	expect(await probe(a.page, (p) => p.readOnly())).toBe(false);
	await probe(a.page, (p) => p.write("hello from A|"));
	await expect.poll(() => probe(b.page, (p) => p.text()), { timeout: 5_000 }).toContain("hello from A|");
	await probe(b.page, (p) => p.write("B was here|"));
	await expect.poll(() => probe(a.page, (p) => p.text()), { timeout: 5_000 }).toContain("B was here|");
	await expect.poll(() => probe(vPage, (p) => p.text()), { timeout: 5_000 }).toContain("B was here|");

	// The viewer is read-only: its write stays local.
	expect(await probe(vPage, (p) => p.readOnly())).toBe(true);
	await probe(vPage, (p) => p.write("viewer tried|"));
	await a.page.waitForTimeout(1500);
	expect(await probe(a.page, (p) => p.text())).not.toContain("viewer tried|");
	expect(await probe(b.page, (p) => p.text())).not.toContain("viewer tried|");

	// A server-function mutation in A → Redis → collab → B's channel → B refetches.
	const newName = `Renamed ${randomBytes(2).toString("hex")}`;
	await a.page.getByTestId(TESTID.tripMenu).click();
	await a.page.getByRole("menuitem", { name: "Trip settings" }).click();
	const dialog = a.page.getByTestId(TESTID.tripSettingsDialog);
	// The settings dialog grew more fields (slug, currency…): the name field by its id.
	await dialog.getByTestId("home-settings-name").fill(newName);
	const t0 = Date.now();
	await dialog.getByRole("button", { name: /save/i }).click();
	await expect(b.page.getByTestId(TESTID.tripMenu)).toContainText(newName, { timeout: 5_000 });
	const ms = Date.now() - t0;
	const got = await probe(b.page, (p) => p.messages());
	expect(got.some((m) => m.type === "invalidate" && m.keys?.includes("graph"))).toBe(true);
	console.log(`[realtime] rename visible in the other browser after ${ms} ms`);
	await vPage.screenshot({ path: shotPath("foundation/viewer.png") });

	await a.ctx.close();
	await b.ctx.close();
	await viewerCtx.close();
});
