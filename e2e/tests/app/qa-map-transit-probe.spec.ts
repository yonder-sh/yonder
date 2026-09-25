/** I2 map-transit: small probes (pin stacking, element at point). */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { asUser, graph, mapReady, OUT, onlyHere, settle, shot } from "./qa-map-transit-helpers";

onlyHere();

test("probe: what is under the Tokyo pin at Japan/city", async ({ browser }) => {
	const { page } = await asUser(browser, "dennis@asia2027.test");
	await page.goto(process.env.QA_URL ?? "/t/asia-2027/japan?lens=city");
	await mapReady(page);
	await settle(page);
	const g = await graph(page);
	const target = process.env.QA_NODE ?? "Tokyo";
	const id = g.nodes.find((n) => n.name === target)?.id ?? "";
	const info = await page.evaluate((id) => {
		const el = document.querySelector(`[data-testid="pin"][data-rep-id="${id}"]`) as HTMLElement | null;
		if (!el) return { found: false };
		const r = el.getBoundingClientRect();
		const pts = [
			[r.left + r.width / 2, r.top + r.height / 2],
			[r.left + r.width * 0.8, r.top + r.height / 2],
			[r.left + r.width * 0.2, r.top + r.height / 2],
		];
		const hits = pts.map(([x, y]) => {
			const h = document.elementFromPoint(x, y) as HTMLElement | null;
			const pin = h?.closest("[data-testid]") as HTMLElement | null;
			return `${x.toFixed(0)},${y.toFixed(0)} -> ${pin?.dataset.testid}:${pin?.dataset.repId ?? ""} (${h?.tagName}.${h?.className?.toString().slice(0, 40)})`;
		});
		const marker = el.closest(".maplibregl-marker") as HTMLElement | null;
		return { found: true, rect: [r.left, r.top, r.width, r.height], hits, z: marker?.style.zIndex, anim: el.getAnimations().length };
	}, id);
	const names = Object.fromEntries(g.nodes.map((n) => [n.id, n.name]));
	const s = JSON.stringify(info, null, 1).replace(/[0-9a-f-]{36}/g, (m) => names[m] ?? m);
	writeFileSync(path.join(OUT, `probe-${target}.txt`), s);
	await page.screenshot({ path: shot(`probe-${target}`) });
});
