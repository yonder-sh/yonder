import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { proxiedStyle } from "../styles/proxy";
import light from "../styles/yonder-light.json";
import satellite from "../styles/yonder-satellite.json";

const PROXY = "http://localhost:7099/__map";

describe("proxiedStyle (e2e map cache)", () => {
	it("leaves the style alone without a proxy", () => {
		const s = light as unknown as StyleSpecification;
		expect(proxiedStyle(s, undefined)).toBe(s);
	});

	it("points OpenFreeMap and Esri at the proxy, placeholders kept", () => {
		const s = proxiedStyle(satellite as unknown as StyleSpecification, PROXY);
		const src = s.sources as Record<string, { url?: string; tiles?: string[] }>;
		expect(src.openmaptiles?.url).toBe(`${PROXY}/ofm/planet`);
		expect(src.satellite?.tiles?.[0]).toBe(
			`${PROXY}/arcgis/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
		);
		expect(s.glyphs).toBe(`${PROXY}/ofm/fonts/{fontstack}/{range}.pbf`);
		expect(JSON.stringify(s)).not.toMatch(/openfreemap\.org|arcgisonline/);
		// The imported style itself is untouched (it's shared by every map).
		expect(
			(satellite.sources as Record<string, { url?: string }>).openmaptiles?.url,
		).toBe("https://tiles.openfreemap.org/planet");
	});
});
