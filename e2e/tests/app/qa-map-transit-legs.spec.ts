/** I2 map-transit: dump every leg of the QA seed and open the key legs' panels (TR-12, FLT-01). */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { asUser, graph, itemLabel, OUT, onlyHere, shot } from "./qa-map-transit-helpers";

onlyHere();

test("dump legs + open key leg panels", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	await page.goto("/t/asia-2027?tab=plan");
	await expect(page.getByTestId("workspace")).toBeVisible({ timeout: 45_000 });
	await page.waitForFunction(() => !!(window as unknown as { __yonder?: { graph?: unknown } }).__yonder?.graph);
	const g = await graph(page);
	const lines = g.legs.map((l) => {
		const d = l.details as Record<string, unknown>;
		const route = (d.route ?? null) as Record<string, unknown> | null;
		return `${itemLabel(g, l.fromItemId)} -> ${itemLabel(g, l.toItemId)} | ${l.mode} ${l.durationMin}m src=${l.source} kind=${d.kind} route=${route ? `${route.source}:${route.label ?? ""}:${(route.segments as unknown[] | undefined)?.length ?? 0}seg:geom=${!!route.geometry}` : "-"} ids=${l.fromItemId}.${l.toItemId}`;
	});
	writeFileSync(path.join(OUT, "legs.txt"), lines.join("\n"));
	const open = async (from: string, to: string, tag: string) => {
		const l = g.legs.find((x) => itemLabel(g, x.fromItemId) === from && itemLabel(g, x.toItemId) === to);
		if (!l) throw new Error(`no leg ${from} -> ${to}`);
		await page.goto(`/t/asia-2027?sel=l.${l.fromItemId}.${l.toItemId}`);
		await expect(page.getByTestId("inspector")).toBeVisible({ timeout: 30_000 });
		await page.waitForTimeout(2500);
		await page.screenshot({ path: shot(`leg-${tag}`) });
		const text = await page.getByTestId("inspector").innerText();
		writeFileSync(path.join(OUT, `leg-${tag}.txt`), text);
	};
	for (const [f, t, tag] of (process.env.QA_OPEN ?? "").split(";").filter(Boolean).map((s) => s.split("|"))) {
		await open(f, t, tag);
	}
	writeFileSync(path.join(OUT, "legs-errors.txt"), errors.join("\n"));
});
