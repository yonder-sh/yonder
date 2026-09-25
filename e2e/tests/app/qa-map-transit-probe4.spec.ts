/** I2 map-transit: marker z-index as applied in the DOM. */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { asUser, graph, mapReady, OUT, onlyHere, settle } from "./qa-map-transit-helpers";

onlyHere();

test("probe marker z", async ({ browser }) => {
	const { page } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027/japan?lens=city");
	await mapReady(page, "city");
	await settle(page);
	const g = await graph(page);
	const names = Object.fromEntries(g.nodes.map((n) => [n.id, n.name]));
	const rows = await page.evaluate(() =>
		Array.from(document.querySelectorAll(".maplibregl-marker")).map((m, i) => {
			const pin = m.querySelector('[data-testid="pin"]') as HTMLElement | null;
			return `${i} rep=${pin?.dataset.repId ?? "-"} styleZ="${(m as HTMLElement).style.zIndex}" computedZ=${getComputedStyle(m).zIndex} hollow=${!!m.querySelector(".is-hollow")}`;
		}),
	);
	writeFileSync(path.join(OUT, "probe-z.txt"), rows.map((r) => r.replace(/[0-9a-f-]{36}/g, (x) => names[x] ?? x)).join("\n"));
});
