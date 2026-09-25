/** I2 map-transit: exploration of the QA seed's Asia 2027 map (screenshots + drawn data dumps). */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import { asUser, drawn, edgeName, mapReady, model, names, nm, OUT, onlyHere, settle, shot } from "./qa-map-transit-helpers";

onlyHere();

const SCOPE = process.env.QA_SCOPE ?? "";
const Q = process.env.QA_Q ?? "";
const TAG = process.env.QA_TAG ?? "root";

test("explore: map per lens", async ({ browser }) => {
	const { page, errors } = await asUser(browser, "dennis@asia2027.test");
	const lines: string[] = [];
	for (const lens of (process.env.QA_LENSES ?? "country,city,area,place").split(",")) {
		await page.goto(`/t/asia-2027${SCOPE ? `/${SCOPE}` : ""}?lens=${lens}${Q ? `&${Q}` : ""}`);
		await mapReady(page, lens);
		await settle(page);
		await page.screenshot({ path: shot(`${TAG}-${lens}`) });
		const d = await drawn(page);
		const m = await model(page);
		const n = await names(page);
		lines.push(`== ${lens} pins=${d.pins.length} visiblePins=${d.visiblePins.length} clusters=${d.clusters.length} edgesShown=${d.edges.features.length} allEdges=${d.allEdges.features.length} ghosts=${d.ghosts.features.length}`);
		lines.push(` pins: ${d.pins.map((p) => `${nm(n, p.repId)}${p.hollow ? "(h)" : ""}#${p.number}`).join(", ")}`);
		lines.push(` clusters: ${d.clusters.map((c) => `${c.count}[${c.repIds.map((r) => nm(n, r)).join("/")}]`).join(", ")}`);
		for (const e of m?.edges ?? []) lines.push(`  edge ${edgeName(n, e.key)} kind=${e.kind} mode=${e.mode} est=${e.estimate} count=${e.count} curved=${e.curved} legs=${e.legIds.length}`);
		for (const f of d.ghosts.features) lines.push(`  ghost ${JSON.stringify(f.properties)}`);
	}
	lines.push(`errors: ${JSON.stringify(errors)}`);
	writeFileSync(path.join(OUT, `explore-${TAG}.txt`), lines.join("\n"));
});
