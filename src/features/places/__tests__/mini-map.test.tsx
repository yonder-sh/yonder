/**
 * The mini-map (PLAN-I2-16, VIS-21): the Yonder basemap (never the raw
 * OpenFreeMap style URLs), and a still map is an image with nothing
 * focusable inside it (the attribution links sit outside `role="img"`).
 * MapLibre itself is stubbed: happy-dom has no WebGL.
 */
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import yonderDark from "@/features/map/styles/yonder-dark.json";
import yonderLight from "@/features/map/styles/yonder-light.json";

const seen: { mapStyle: unknown; interactive: unknown; locale: unknown }[] = [];

vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));
vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url", () => ({
	default: "worker.js",
}));
vi.mock("@vis.gl/react-maplibre", async () => {
	const React = await import("react");
	return {
		Map: React.forwardRef(function MapStub(
			props: {
				mapStyle: unknown;
				interactive?: boolean;
				locale?: unknown;
				children?: ReactNode;
			},
			_ref,
		) {
			seen.push({
				mapStyle: props.mapStyle,
				interactive: props.interactive,
				locale: props.locale,
			});
			return <div data-stub="map">{props.children}</div>;
		}),
		Marker: ({ children }: { children?: ReactNode }) => <>{children}</>,
	};
});

const { default: MiniMapImpl } = await import("../ui/mini-map.impl");

describe("MiniMap", () => {
	it("draws the Yonder basemap, and a still map has nothing focusable inside its image", async () => {
		seen.length = 0;
		document.documentElement.classList.remove("dark");
		render(
			<MiniMapImpl
				lat={35.69}
				lng={139.7}
				interactive={false}
				label="Map of Shinjuku"
			/>,
		);
		await waitFor(() => expect(seen.length).toBeGreaterThan(0));
		const last = seen.at(-1);
		expect(last?.mapStyle).toEqual(yonderLight);
		expect(JSON.stringify(last?.mapStyle)).not.toMatch(/styles\/positron/);
		expect(last?.interactive).toBe(false);
		const img = screen.getByRole("img", { name: "Map of Shinjuku" });
		expect(img.querySelector("a,button,[tabindex]")).toBeNull();
		// The OSM credit is still there, outside the image.
		const credit = screen.getByRole("link", { name: "OSM" });
		expect(img.contains(credit)).toBe(false);
	});

	it("follows the dark theme; a pannable map's canvas carries the label", async () => {
		seen.length = 0;
		document.documentElement.classList.add("dark");
		render(<MiniMapImpl lat={35.69} lng={139.7} label="Map of Shibuya" />);
		await waitFor(() => expect(seen.length).toBeGreaterThan(0));
		expect(seen.at(-1)?.mapStyle).toEqual(yonderDark);
		expect(seen.at(-1)?.interactive).toBe(true);
		expect(seen.at(-1)?.locale).toEqual({ "Map.Title": "Map of Shibuya" });
		// No role="img" around focusable content.
		expect(screen.queryByRole("img")).toBeNull();
		document.documentElement.classList.remove("dark");
	});
});
