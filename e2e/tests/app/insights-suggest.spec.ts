/**
 * WP-Insights for suggesters (EXTENSIONS §3, §4.4, §5): Maya is a suggester
 * on a cloned demo trip. "Suggest shift" and "Suggest hours" go through the
 * real propose gate (nothing changes; a suggestion appears), trip settings
 * stay edit-only, and the owner sees the suggested hours on the place.
 * Reviewing them is WP-Suggest's (SHIFT-04 lives there).
 */
import { expect, test } from "@playwright/test";
import { TESTID } from "../../../src/lib/testids";
import { shotPath, storageStateOf } from "./_helpers/env";
import { cloneFixtureTrip } from "./_helpers/fixture";
import { collectConsole } from "./_helpers/page";
import { callFn, INSIGHTS_TESTID as T, openHarness, refreshGraph, setSheetHours } from "./insights-helpers";

test.use({ storageState: storageStateOf("dev") });

test("a suggester's shift and hours become suggestions; settings stay edit-only", async ({ page, browser }, info) => {
	test.skip(info.project.name !== "chromium", "one run is enough (mobile covers the same components elsewhere)");
	const c = await cloneFixtureTrip(page.request, { mayaRole: "suggester" });
	const itoya = c.ids.nodes.itoya as string;
	await openHarness(page, c, { nodeId: itoya });
	await setSheetHours(page, itoya, "10:00–20:00; closed Tue");

	const ctx = await browser.newContext({ storageState: storageStateOf("maya"), viewport: { width: 1440, height: 900 } });
	const maya = await ctx.newPage();
	const logs = collectConsole(maya);
	await openHarness(maya, c, { nodeId: itoya });

	// Try other dates → +1 → "Suggest shift": the dates stay, a suggestion is made.
	await maya.getByTestId("harness-try-dates").click();
	const dialog = maya.getByTestId(TESTID.shiftTripDialog);
	await dialog.getByTestId(T.shiftPlus).click();
	const apply = dialog.getByTestId(T.shiftApply);
	await expect(apply).toHaveText("Suggest shift");
	await apply.click();
	await expect(dialog).toBeHidden();
	await expect(maya.getByText(/^Suggested — /).first()).toBeVisible();
	await expect(maya.locator("[data-testid=harness-day] h3").first()).toHaveText("Sun 3 Oct");
	await expect(maya.getByTestId(TESTID.whatIfChip)).toHaveCount(0);

	// Confirm the sheet hours → "Suggest hours": still the sheet's, with a dashed suggestion.
	const table = maya.getByTestId(TESTID.hoursTable);
	await expect(table).toHaveAttribute("data-source", "sheet");
	await table.getByTestId(T.hoursTableConfirm).click();
	const editor = maya.getByTestId(TESTID.hoursEditorDialog);
	const save = editor.getByTestId(T.hoursEditorSave);
	await expect(save).toHaveText("Suggest hours");
	await save.click();
	await expect(editor).toBeHidden();
	await expect(table).toHaveAttribute("data-source", "sheet");
	const mine = table.getByTestId(T.hoursSuggested);
	await expect(mine.getByRole("button")).toHaveAttribute(
		"aria-description",
		/^Suggested by Maya.*: Mon 10:00–20:00 · Closed Tue · Wed–Sun 10:00–20:00$/,
	);
	await expect(mine).toContainText("Waiting for review");
	await maya.screenshot({ path: shotPath("insights/suggest-hours-1440.png"), animations: "disabled" });

	// Trip settings are edit-only.
	await expect(maya.getByTestId("harness-settings").getByTestId(T.holidayAdd)).toBeDisabled();
	expect(logs.messages).toEqual([]);
	await ctx.close();

	// Nothing was applied; both suggestions are open for the owner.
	const list = await callFn<{ op: string; status: string }[]>(page, "/src/functions/proposals.functions.ts", "listProposals", {
		tripId: c.tripId,
	});
	if (!list.ok) throw new Error(list.error);
	expect(list.value.filter((p) => p.status === "open").map((p) => p.op).sort()).toEqual(["node.hours", "trip.shift"]);
	await page.evaluate(async () => {
		const r = (globalThis as unknown as {
			__TSR_ROUTER__?: { options: { context: { queryClient: { invalidateQueries: (o: unknown) => Promise<void> } } } };
		}).__TSR_ROUTER__;
		await r?.options.context.queryClient.invalidateQueries();
	});
	await refreshGraph(page);
	const owner = page.getByTestId(TESTID.hoursTable).getByTestId(T.hoursSuggested);
	await expect(owner).toContainText("Maya");
	await expect(owner).toContainText("Review");
	await expect(page.locator("[data-testid=harness-day] h3").first()).toHaveText("Sun 3 Oct");
});
