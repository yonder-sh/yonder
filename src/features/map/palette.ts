/**
 * Map colours as hex (MapLibre paint properties can't read CSS variables or
 * oklch; BRAND.md gotcha). Mirrors DESIGN §2.3 (`--map-*`, `--mode-*`), the
 * brand tokens (`brand/tokens/tokens.json`) and §2.2 presence colours.
 */
export type MapTheme = "light" | "dark";

/** The basemap: the app theme's light or dark, or satellite (`UserPrefs.mapStyle`). */
export type MapStyle = "light" | "dark" | "satellite";
export const MAP_STYLES: readonly MapStyle[] = ["light", "dark", "satellite"];

/**
 * The basemap drawn: satellite when it's switched on (synced to the account,
 * ADDENDUM §7.2), else the app theme's light or dark (owner, 2026-09-25: the
 * map follows the theme; an old saved "light" or "dark" no longer counts).
 */
export const effectiveMapStyle = (
	saved: MapStyle | null | undefined,
	appTheme: MapTheme,
): MapStyle => (saved === "satellite" ? "satellite" : appTheme);

/** The tone of pins, lines and labels over a basemap: satellite imagery is dark. */
export const mapTone = (style: MapStyle): MapTheme =>
	style === "light" ? "light" : "dark";

export type LinePalette = {
	walk: string;
	transit: string;
	flight: string;
	other: string;
	/** unset, estimate and overnight lines (`--muted-foreground`). */
	muted: string;
	casing: string;
	/** `--selected-edge`: the underlay of a selected edge. */
	selected: string;
	primary: string;
	ink: string;
	card: string;
	land: string;
	label: string;
	labelHalo: string;
};

export const LINES: Record<MapTheme, LinePalette> = {
	light: {
		walk: "#008a63",
		transit: "#4f54bc",
		flight: "#d05418",
		other: "#5c6375",
		muted: "#5c6375",
		casing: "#ffffff",
		selected: "rgba(24, 29, 47, 0.22)",
		primary: "#494fa7",
		ink: "#181d2f",
		card: "#ffffff",
		land: "#f0f2f7",
		label: "#6b7285",
		labelHalo: "#f0f2f7",
	},
	dark: {
		walk: "#56d1a3",
		transit: "#9eaafd",
		flight: "#ffa566",
		other: "#a3a3a3",
		muted: "#a3a3a3",
		casing: "#0a0a0a",
		selected: "rgba(238, 240, 246, 0.26)",
		primary: "#9fabf7",
		ink: "#eef0f6",
		card: "#171717",
		land: "#141414",
		label: "#8f8f8f",
		labelHalo: "#141414",
	},
};

/** `--presence-1…8` (DESIGN §2.2); dark mode raises them ~8% toward white. */
export const PRESENCE_HEX = [
	"#2f7f86",
	"#b4539a",
	"#c98a1c",
	"#4e7bd3",
	"#6a8f3a",
	"#8c5bd6",
	"#3f8f6b",
	"#a0643a",
] as const;

export function presenceHex(index: number, theme: MapTheme = "light"): string {
	const base =
		PRESENCE_HEX[
			((index % PRESENCE_HEX.length) + PRESENCE_HEX.length) %
				PRESENCE_HEX.length
		] ?? PRESENCE_HEX[0];
	return theme === "dark" ? mixHex(base, "#ffffff", 0.15) : base;
}

/** Linear mix in sRGB (t = share of `b`). Good enough for tints. */
export function mixHex(a: string, b: string, t: number): string {
	const pa = [1, 3, 5].map((i) => Number.parseInt(a.slice(i, i + 2), 16));
	const pb = [1, 3, 5].map((i) => Number.parseInt(b.slice(i, i + 2), 16));
	return `#${pa
		.map((v, i) => Math.round(v * (1 - t) + (pb[i] ?? 0) * t))
		.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0"))
		.join("")}`;
}

/** Valid `#rrggbb` (segment colours come from providers and users). */
export const isHex = (s: unknown): s is string =>
	typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
