/**
 * The landing page's Open Graph image (1200 × 630) as an SVG string: the
 * hero's globe with the finished demo route beside the headline, on the
 * hero's black. `globe.ts` rasterises it with resvg and the app's own fonts
 * (Parkinsans, Commissioner, Atkinson Hyperlegible Mono).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { HERO_GLOBE } from "../../src/features/landing/globe/colors";
import { type Scene, SIZE } from "../../src/features/landing/globe/scene";

const W = 1200;
const H = 630;

const esc = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The dark lockup (periwinkle mark, apricot point, near-white word) as a nested SVG. */
function lockup(root: string, x: number, y: number, h: number): string {
	const src = readFileSync(
		path.join(root, "brand/logo/yonder-lockup-dark.svg"),
		"utf8",
	);
	const vb = /viewBox="([^"]+)"/.exec(src)?.[1] ?? "0 -74 465.32 101.1";
	const [, , vw = 465.32, vh = 101.1] = vb.split(/\s+/).map(Number);
	const inner = src
		.replace(/^<svg[^>]*>/, "")
		.replace(/<\/svg>\s*$/, "")
		.replace(/<title>.*?<\/title>/, "");
	const w = (h * vw) / vh;
	return `<svg x="${x}" y="${y}" width="${w.toFixed(1)}" height="${h}" viewBox="${vb}">${inner}</svg>`;
}

export function renderOgSvg(o: {
	root: string;
	scene: Scene;
	land: { land: string; borders: string };
}): string {
	const { scene } = o;
	// The planet as on the page: big, right of the headline, running off the
	// right and bottom edges, the route on its western half.
	const k = 400 / scene.silhouette;
	const gx = 960 - scene.cx * k;
	const gy = 372 - scene.cy * k;
	const r = scene.silhouette;
	const halo = r + 90;
	const hops = scene.hops
		.map(
			(h) =>
				`<path d="${h.d}" fill="none" stroke="${h.color}" stroke-opacity="0.16" stroke-width="${h.flight ? 9 : 12}" stroke-linecap="round" stroke-linejoin="round"/>` +
				`<path d="${h.d}" fill="none" stroke="${h.color}" stroke-opacity="${h.flight ? 0.85 : 1}" stroke-width="${h.flight ? 2.6 : 4.4}" stroke-linecap="round" stroke-linejoin="round"/>`,
		)
		.join("");
	const dots = scene.dots
		.map(
			(d) =>
				`<circle cx="${d.x}" cy="${d.y}" r="${(d.r * 1.15 * 2.6).toFixed(1)}" fill="${d.color}" opacity="0.2"/><circle cx="${d.x}" cy="${d.y}" r="${(d.r * 1.15).toFixed(1)}" fill="${d.color}"/>`,
		)
		.join("");
	const labels = scene.dots
		.filter((d) => !d.minor)
		.map((d) => {
			const size = 30;
			const off = d.r + 11;
			const [x, y, anchor] =
				d.label === "right"
					? [d.x + off, d.y + size * 0.35, "start"]
					: d.label === "left"
						? [d.x - off, d.y + size * 0.35, "end"]
						: d.label === "above"
							? [d.x, d.y - off, "middle"]
							: [d.x, d.y + off + size * 0.72, "middle"];
			return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Commissioner" font-weight="600" font-size="${size}" fill="${HERO_GLOBE.label}" stroke="${HERO_GLOBE.space}" stroke-width="7" stroke-opacity="0.85" paint-order="stroke">${esc(d.name)}</text>`;
		})
		.join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<radialGradient id="glow" cx="74%" cy="50%" r="60%"><stop offset="0" stop-color="#1c2840" stop-opacity="0.55"/><stop offset="1" stop-color="#1c2840" stop-opacity="0"/></radialGradient>
<radialGradient id="glow2" cx="6%" cy="0%" r="55%"><stop offset="0" stop-color="#494fa7" stop-opacity="0.22"/><stop offset="1" stop-color="#494fa7" stop-opacity="0"/></radialGradient>
<radialGradient id="halo" cx="${scene.cx}" cy="${scene.cy}" r="${halo}" gradientUnits="userSpaceOnUse"><stop offset="${(r / halo).toFixed(4)}" stop-color="${HERO_GLOBE.halo}" stop-opacity="0.32"/><stop offset="${((r + 22) / halo).toFixed(4)}" stop-color="${HERO_GLOBE.halo}" stop-opacity="0.1"/><stop offset="1" stop-color="${HERO_GLOBE.halo}" stop-opacity="0"/></radialGradient>
<radialGradient id="sea" cx="36%" cy="30%" r="78%"><stop offset="0" stop-color="${HERO_GLOBE.waterLit}"/><stop offset="0.6" stop-color="${HERO_GLOBE.water}"/><stop offset="1" stop-color="#06080b"/></radialGradient>
<radialGradient id="shade" cx="34%" cy="28%" r="82%"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.55"/></radialGradient>
<clipPath id="disc"><circle cx="${scene.cx}" cy="${scene.cy}" r="${r}"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="${HERO_GLOBE.space}"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
<rect width="${W}" height="${H}" fill="url(#glow2)"/>
<g transform="translate(${gx.toFixed(1)} ${gy.toFixed(1)}) scale(${k.toFixed(4)})">
<circle cx="${scene.cx}" cy="${scene.cy}" r="${halo}" fill="url(#halo)"/>
<circle cx="${scene.cx}" cy="${scene.cy}" r="${r}" fill="url(#sea)"/>
<g clip-path="url(#disc)"><path d="${o.land.land}" fill="${HERO_GLOBE.land}"/><path d="${o.land.borders}" fill="none" stroke="${HERO_GLOBE.border}" stroke-width="1.1"/></g>
<path d="${scene.graticule}" fill="none" stroke="#ffffff" stroke-opacity="0.055" stroke-width="1.2"/>
<circle cx="${scene.cx}" cy="${scene.cy}" r="${r}" fill="url(#shade)"/>
<circle cx="${scene.cx}" cy="${scene.cy}" r="${r}" fill="none" stroke="${HERO_GLOBE.halo}" stroke-opacity="0.28" stroke-width="1.5"/>
${hops}${dots}${labels}
</g>
${lockup(o.root, 72, 64, 44)}
<text x="68" y="318" font-family="Parkinsans" font-weight="700" font-size="104" letter-spacing="-4.4" fill="#ffffff">Plan trips</text>
<text x="68" y="418" font-family="Parkinsans" font-weight="700" font-size="104" letter-spacing="-4.4" fill="#ffffff">together.</text>
<text x="72" y="486" font-family="Commissioner" font-size="26" fill="#ffffff" fill-opacity="0.7">One shared plan for the whole group.</text>
<text x="72" y="566" font-family="Atkinson Hyperlegible Mono" font-size="20" letter-spacing="1.5" fill="#ffffff" fill-opacity="0.5">yonder.sh</text>
</svg>`;
}

export const OG_SIZE = { width: W, height: H, globeBox: SIZE };
