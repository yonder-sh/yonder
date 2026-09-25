/**
 * The landing page's static globe art (run after changing the hero's camera
 * or demo route in `src/features/landing/globe/scene.ts`):
 *
 *   - `public/landing/globe-land.svg`: the land and borders under the hero's
 *     route, drawn with d3-geo through the SAME perspective as the page's SVG
 *     route (MapLibre's globe camera), so the two line up;
 *   - `public/og.png`: the 1200 × 630 Open Graph image, the same globe and
 *     route next to the headline, rasterised with resvg and the app's fonts.
 *
 *   pnpm landing:globe
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import {
	type GeoProjection,
	type GeoRawProjection,
	geoPath,
	geoProjection,
} from "d3-geo";
import type { Feature, MultiLineString, MultiPolygon } from "geojson";
import sharp from "sharp";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import countries50 from "world-atlas/countries-50m.json" with { type: "json" };
import { HERO_GLOBE } from "../../src/features/landing/globe/colors";
import {
	buildScene,
	CENTER,
	LAND_BOX,
	scenePerspective,
	sceneProjector,
} from "../../src/features/landing/globe/scene";
import { renderOgSvg } from "./og";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.join(ROOT, "public/landing");

/** Vertical perspective from `P` radii away (d3-geo-projection's satellite, untilted). */
function perspectiveRaw(P: number): GeoRawProjection {
	const forward = (x: number, y: number): [number, number] => {
		const cy = Math.cos(y);
		const k = (P - 1) / (P - cy * Math.cos(x));
		return [k * cy * Math.sin(x), k * Math.sin(y)];
	};
	return forward as GeoRawProjection;
}

export function heroProjection(): GeoProjection {
	const proj = sceneProjector();
	const { P, horizonDeg } = scenePerspective(proj);
	return geoProjection(perspectiveRaw(P))
		.scale(proj.R)
		.translate([proj.cx, proj.cy])
		.rotate([-CENTER[0], -CENTER[1]])
		.clipAngle(horizonDeg - 0.01)
		.precision(0.25);
}

/**
 * d3's absolute path as relative moves in whole viewBox units, dropping the
 * points that round onto the previous one: ~5× smaller, and a unit is under
 * a device pixel at the sizes the hero shows the globe.
 */
function compactPath(d: string | null): string {
	let out = "";
	let px = 0;
	let py = 0;
	for (const m of (d ?? "").matchAll(/([MLZ])([^MLZ]*)/g)) {
		if (m[1] === "Z") {
			out += "z";
			continue;
		}
		const nums = (m[2] ?? "").split(/[ ,]+/).filter(Boolean).map(Number);
		for (let i = 0; i + 1 < nums.length; i += 2) {
			const x = Math.round(nums[i] as number);
			const y = Math.round(nums[i + 1] as number);
			if (m[1] === "M") out += `M${x} ${y}`;
			else if (x !== px || y !== py) out += `l${x - px} ${y - py}`;
			px = x;
			py = y;
		}
	}
	return out.replace(/ -/g, "-");
}

export function landPaths(): { land: string; borders: string } {
	const topo = countries50 as unknown as Topology<{
		countries: GeometryCollection;
		land: GeometryCollection;
	}>;
	const land = feature(
		topo,
		topo.objects.land,
	) as unknown as Feature<MultiPolygon>;
	const borders = mesh(
		topo,
		topo.objects.countries,
		(a, b) => a !== b,
	) as unknown as MultiLineString;
	const p = geoPath(heroProjection());
	return { land: compactPath(p(land)), borders: compactPath(p(borders)) };
}

function main() {
	mkdirSync(OUT_DIR, { recursive: true });
	const { land, borders } = landPaths();
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LAND_BOX.x} ${LAND_BOX.y} ${LAND_BOX.size} ${LAND_BOX.size}"><path d="${land}" fill="${HERO_GLOBE.land}"/><path d="${borders}" fill="none" stroke="${HERO_GLOBE.border}" stroke-width="1.1" stroke-linejoin="round"/></svg>\n`;
	const landFile = path.join(OUT_DIR, "globe-land.svg");
	writeFileSync(landFile, svg);
	console.log(
		`[landing:globe] ${path.relative(ROOT, landFile)} ${(svg.length / 1024).toFixed(1)} kB`,
	);
	return { land, borders };
}

async function og(land: { land: string; borders: string }) {
	const fontDir = path.join(ROOT, "src/features/overview/share/fonts");
	const svg = renderOgSvg({ root: ROOT, scene: buildScene(), land });
	const png = new Resvg(svg, {
		fitTo: { mode: "width", value: 1200 },
		font: {
			loadSystemFonts: false,
			fontFiles: [
				"Parkinsans-700.ttf",
				"Commissioner-400.ttf",
				"Commissioner-600.ttf",
				"AtkinsonHyperlegibleMono-400.ttf",
			].map((f) => path.join(fontDir, f)),
			defaultFontFamily: "Commissioner",
		},
	})
		.render()
		.asPng();
	const out = path.join(ROOT, "public/og.png");
	const optimised = await sharp(png)
		.png({ compressionLevel: 9, palette: false })
		.toBuffer();
	writeFileSync(out, optimised);
	console.log(
		`[landing:globe] public/og.png ${(optimised.length / 1024).toFixed(0)} kB`,
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const land = main();
	await og(land);
}
