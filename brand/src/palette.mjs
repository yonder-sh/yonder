// Single source of truth for Yonder colors. Everything in tokens/, logo/ and
// icons/ is generated from this file by scripts/build.mjs. Edit here, rebuild.
//
// Values are OKLCH (L 0..1, C, H degrees). Token names follow shadcn/ui on
// Tailwind v4 so theme.css drops straight into src/styles.css.

/** Named brand colors. Hex equivalents are computed at build time. */
export const brand = {
  ink: 'oklch(0.235 0.035 272)', //        text on light, dark surfaces
  mist: 'oklch(0.985 0.004 265)', //       light page ground (cool, not cream)
  dusk: 'oklch(0.47 0.14 277)', //         primary: evening-sky indigo
  duskDeep: 'oklch(0.42 0.14 274)', //     app-icon gradient, bottom
  duskHigh: 'oklch(0.53 0.135 283)', //    app-icon gradient, top
  periwinkle: 'oklch(0.76 0.11 277)', //   primary on dark
  apricot: 'oklch(0.81 0.13 68)', //       the "yonder point": the one warm accent
  night: 'oklch(0.145 0 0)', //             dark page ground: neutral near-black (owner 2026-09-24: like Instagram/TikTok, no navy tint)
  white: 'oklch(1 0 0)',
};

const light = {
  background: brand.mist,
  foreground: brand.ink,
  card: 'oklch(1 0 0)',
  'card-foreground': brand.ink,
  popover: 'oklch(1 0 0)',
  'popover-foreground': brand.ink,
  primary: brand.dusk,
  'primary-foreground': 'oklch(0.985 0.008 277)',
  secondary: 'oklch(0.955 0.013 272)',
  'secondary-foreground': 'oklch(0.32 0.06 275)',
  muted: 'oklch(0.962 0.007 268)',
  'muted-foreground': 'oklch(0.5 0.03 270)',
  accent: 'oklch(0.945 0.026 277)',
  'accent-foreground': 'oklch(0.33 0.09 277)',
  destructive: 'oklch(0.54 0.19 25)',
  'destructive-foreground': 'oklch(0.985 0.005 25)',
  border: 'oklch(0.915 0.012 270)',
  input: 'oklch(0.885 0.015 270)',
  ring: 'oklch(0.6 0.13 277)',
  'chart-1': 'oklch(0.52 0.14 277)', //  dusk
  'chart-2': 'oklch(0.66 0.15 58)', //   apricot
  'chart-3': 'oklch(0.6 0.1 178)', //    sea
  'chart-4': 'oklch(0.63 0.15 8)', //    rose
  'chart-5': 'oklch(0.6 0.1 235)', //    sky
  sidebar: 'oklch(0.972 0.006 268)',
  'sidebar-foreground': brand.ink,
  'sidebar-primary': brand.dusk,
  'sidebar-primary-foreground': 'oklch(0.985 0.008 277)',
  'sidebar-accent': 'oklch(0.94 0.026 277)',
  'sidebar-accent-foreground': 'oklch(0.33 0.09 277)',
  'sidebar-border': 'oklch(0.915 0.012 270)',
  'sidebar-ring': 'oklch(0.6 0.13 277)',
  // Brand extension: the warm accent. shadcn's --accent is a hover wash, not a
  // brand color, so the apricot lives here instead.
  glow: brand.apricot,
  'glow-foreground': 'oklch(0.3 0.06 55)',
  // Map route lines per travel mode (drawn over a light basemap).
  'map-walk': 'oklch(0.56 0.12 165)',
  'map-transit': 'oklch(0.5 0.16 277)',
  'map-flight': 'oklch(0.6 0.17 42)',
  'map-casing': 'oklch(1 0 0)',
  'map-stop': 'oklch(1 0 0)',
};

const dark = {
  background: brand.night,
  foreground: 'oklch(0.97 0 0)',
  card: 'oklch(0.205 0 0)',
  'card-foreground': 'oklch(0.97 0 0)',
  popover: 'oklch(0.22 0 0)',
  'popover-foreground': 'oklch(0.97 0 0)',
  primary: brand.periwinkle,
  'primary-foreground': 'oklch(0.2 0.05 277)',
  secondary: 'oklch(0.269 0 0)',
  'secondary-foreground': 'oklch(0.97 0 0)',
  muted: 'oklch(0.235 0 0)',
  'muted-foreground': 'oklch(0.72 0 0)',
  accent: 'oklch(0.269 0 0)',
  'accent-foreground': 'oklch(0.97 0 0)',
  destructive: 'oklch(0.68 0.17 22)',
  'destructive-foreground': 'oklch(0.2 0.05 22)',
  border: 'oklch(0.285 0 0)',
  input: 'oklch(0.33 0 0)',
  ring: 'oklch(0.64 0.11 277)',
  'chart-1': 'oklch(0.72 0.12 277)',
  'chart-2': 'oklch(0.8 0.13 68)',
  'chart-3': 'oklch(0.74 0.11 175)',
  'chart-4': 'oklch(0.72 0.14 10)',
  'chart-5': 'oklch(0.78 0.08 230)',
  sidebar: 'oklch(0.18 0 0)',
  'sidebar-foreground': 'oklch(0.97 0 0)',
  'sidebar-primary': brand.periwinkle,
  'sidebar-primary-foreground': 'oklch(0.2 0.05 277)',
  'sidebar-accent': 'oklch(0.269 0 0)',
  'sidebar-accent-foreground': 'oklch(0.97 0 0)',
  'sidebar-border': 'oklch(0.285 0 0)',
  'sidebar-ring': 'oklch(0.64 0.11 277)',
  glow: 'oklch(0.82 0.125 70)',
  'glow-foreground': 'oklch(0.3 0.06 55)',
  'map-walk': 'oklch(0.78 0.13 165)',
  'map-transit': 'oklch(0.76 0.12 277)',
  'map-flight': 'oklch(0.8 0.14 55)',
  'map-casing': brand.night,
  'map-stop': brand.night,
};

export const modes = { light, dark };

/**
 * Line styling per travel mode. Color alone never carries the mode: each one
 * also has its own dash pattern and width, so the map reads for color-blind
 * viewers and in grayscale. Dash arrays are in line-width units (MapLibre
 * `line-dasharray` semantics); widths are CSS px at zoom ~12.
 */
export const mapModes = {
  walk: { token: 'map-walk', width: 3, dash: [0, 2], cap: 'round', note: 'dotted' },
  transit: { token: 'map-transit', width: 4.5, dash: null, cap: 'round', note: 'solid' },
  flight: { token: 'map-flight', width: 2.5, dash: [2.5, 2], cap: 'butt', note: 'dashed great-circle arc' },
};

/** Basemap grounds the map colors are checked against (typical light/dark vector tiles). */
export const basemaps = {
  light: ['#f2efe9', '#e8eef3', '#dfe9d8'], // land, water, park
  dark: ['#141414', '#141c26', '#141a16'],
};

export const fonts = {
  // Parkinsans is Latin-only: use it for our own words (marketing, section
  // titles, empty states, big numbers), never for trip or place names.
  display: { family: 'Parkinsans', weights: [500, 600, 700], role: 'Wordmark, fixed headings, big numbers' },
  // Commissioner covers Vietnamese, Greek and Cyrillic, so place names like
  // Hội An, Θεσσαλονίκη or Москва never fall back mid-word.
  body: { family: 'Commissioner', weights: [400, 500, 600, 700], role: 'UI, reading text, and any user or place content' },
  // Distinct 0/O, 1/l/I: booking refs and flight numbers are where misreads cost money.
  mono: { family: 'Atkinson Hyperlegible Mono', weights: [400, 500], role: 'Times, booking refs, flight numbers, coordinates' },
};

export const radius = '0.75rem';
