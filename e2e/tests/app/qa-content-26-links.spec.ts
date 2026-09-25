/** I2 "content" verifier: how can a note get a link? (typed markdown, bare URL, pasted markdown) */
import path from "node:path";
import { expect, test } from "@playwright/test";
import { NOTES_TESTID as NT } from "../../../src/features/notes/testids";
import { TESTID } from "../../../src/lib/testids";
import { expectLive } from "./_helpers/page";

// Needs this verifier's env (QA_AUTH_DIR with qa-* storage states for APP_URL); skipped in a normal `pnpm e2e`.
test.skip(!process.env.QA_AUTH_DIR, "I2 content verifier spec: set QA_AUTH_DIR");

const AUTH = process.env.QA_AUTH_DIR ?? "";
test.use({ storageState: path.join(AUTH, "audrey.json"), permissions: ["clipboard-read", "clipboard-write"] });
test("note links", async ({ page }) => {
	await page.goto("/t/asia-2027?tab=plan");
	await expectLive(page);
	const id = await page.evaluate(() => (window as unknown as { __yonder: { graph: { nodes: { id: string; name: string }[] } } }).__yonder.graph.nodes.find((n) => n.name === "Bar Kuro")?.id);
	await page.goto(`/t/asia-2027?sel=n.${id}`);
	await expectLive(page);
	await page.getByTestId(TESTID.inspector).getByRole("tab", { name: /Notes/ }).click();
	const ed = page.getByTestId(TESTID.notesPanel).getByTestId(NT.editor);
	await expect(ed).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
	await ed.click();
	await page.keyboard.press("Control+End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("bare https://www.japan-guide.com/e/e3011.html then");
	await page.keyboard.press("Enter");
	await page.evaluate(() => {
		const dt = new DataTransfer();
		dt.setData("text/plain", "[pasted guide](https://www.japan-guide.com/e/e3011.html)");
		document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
	});
	await page.waitForTimeout(800);
	const html = await ed.innerHTML();
	console.log("LINKS HTML", html.slice(-600));
	console.log("bare URL autolinked:", /<a [^>]*>https:\/\/www\.japan-guide/.test(html), "pasted markdown link:", /<a [^>]*>pasted guide<\/a>/.test(html));
});
