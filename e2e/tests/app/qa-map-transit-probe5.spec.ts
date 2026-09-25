/** I2 map-transit: root globe camera with and without an open inspector (deep link to a Japan leg). */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { asUser, graph, itemLabel, mapReady, OUT, onlyHere, settle, shot } from "./qa-map-transit-helpers";

onlyHere();

test("probe globe camera", async ({ browser }) => {
	const { page } = await asUser(browser, "dennis@asia2027.test");
	const out: string[] = [];
	const cam = () =>
		page.evaluate(() => {
			// biome-ignore lint/suspicious/noExplicitAny: introspection
			const m = (window as any).__tripMap;
			const c = m.getCenter();
			const vis = (m.__yonder?.pins ?? []).map((p: { repId: string; lng: number; lat: number }) => {
				const q = m.project([p.lng, p.lat]);
				const W = m.getContainer().clientWidth;
				const H = m.getContainer().clientHeight;
				return `${p.repId.slice(-4)}:${q.x > 0 && q.x < W && q.y > 0 && q.y < H ? "in" : "out"}(${q.x.toFixed(0)},${q.y.toFixed(0)})`;
			});
			return `center=${c.lng.toFixed(1)},${c.lat.toFixed(1)} z=${m.getZoom().toFixed(2)} proj=${m.getProjection?.()?.type ?? "?"} pins=${vis.join(" ")}`;
		});
	await page.goto("/t/asia-2027?tab=plan");
	await mapReady(page, "country");
	await settle(page);
	out.push(`no sel: ${await cam()}`);
	const g = await graph(page);
	const l = g.legs.find((x) => itemLabel(g, x.fromItemId) === "Kappabashi Street");
	await page.goto(`/t/asia-2027?sel=l.${l?.fromItemId}.${l?.toItemId}`);
	await mapReady(page, "country");
	await settle(page);
	out.push(`deep link sel=l (Kappabashi→Nihonbashi): ${await cam()}`);
	await page.screenshot({ path: shot("probe-globe-sel") });
	const names = Object.fromEntries(g.nodes.map((n) => [n.id.slice(-4), n.name]));
	writeFileSync(path.join(OUT, "probe-globe.txt"), out.map((s) => s.replace(/\b([0-9a-f]{4}):/g, (m, k) => `${names[k] ?? k}:`)).join("\n"));
});
