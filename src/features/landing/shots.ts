/**
 * The product screenshots on the landing page, as `pnpm landing:shots`
 * (`e2e/landing-shots.mjs`) writes them to `public/landing/`: each in AVIF
 * and WebP, at `width` and (`half`) at half that width; `themes` lists the
 * variants (`<name>-light`, `<name>-dark`). Every one is of the invented
 * showcase trip (`scripts/landing/showcase.ts`), never real data.
 */
export type ShotTheme = "light" | "dark";

export interface Shot {
	name: string;
	width: number;
	height: number;
	themes: readonly ShotTheme[];
	/** Also written at half the width (for phones). */
	half: boolean;
	alt: string;
}

const both = ["light", "dark"] as const;

export const SHOTS = {
	places: {
		name: "places",
		width: 1600,
		height: 1000,
		themes: both,
		half: true,
		alt: "The Places tab as a table: each place with everyone's rating, the group score, and whether it's suggested for the shortlist, still an idea or already scheduled.",
	},
	rate: {
		name: "rate",
		width: 780,
		height: 1688,
		// The Rate feed is dark in both themes.
		themes: ["dark"],
		half: true,
		alt: "The Rate feed on a phone: a photo of Nara Park and six buttons, from Must to Nah.",
	},
	plan: {
		name: "plan",
		width: 1600,
		height: 1000,
		themes: both,
		half: true,
		alt: "The Plan tab: a day in Kyoto as a timeline with travel times between the stops, next to a map of the day's route.",
	},
	flight: {
		name: "flight",
		width: 780,
		height: 1688,
		themes: both,
		half: true,
		alt: "A travel day on a phone: the flight from Taipei to Hanoi, and the day switching from Taiwan's time zone to Vietnam's.",
	},
	overview: {
		name: "overview",
		width: 1600,
		height: 1000,
		themes: ["dark"],
		half: true,
		alt: "The trip's Overview: the route on a globe, the countdown, and counts of days, cities, flights and kilometres.",
	},
	card: {
		name: "card",
		width: 540,
		height: 960,
		themes: ["dark"],
		half: false,
		alt: "A share card sized for a story: the dates, the route on a globe and every country with its nights.",
	},
	live: {
		name: "live",
		width: 1600,
		height: 1000,
		themes: both,
		half: true,
		alt: "Alex's screen while Maya is in the trip: her face in the top bar, her cursor on Fushimi Inari Taisha with a message next to it, and her selection outlined.",
	},
	media: {
		name: "media",
		width: 1200,
		height: 750,
		themes: both,
		half: true,
		alt: "Photos kept with the trip's places: Meiji Jingu, Dotonbori at night, Senso-ji and the deer of Nara.",
	},
	lists: {
		name: "lists",
		width: 1200,
		height: 750,
		themes: both,
		half: true,
		alt: "To-dos with booking dates, like when the train tickets to Busan go on sale.",
	},
	notes: {
		name: "notes",
		width: 1200,
		height: 750,
		themes: both,
		half: true,
		alt: "The trip's shared note: packing light, the travel cards for each country and other reminders.",
	},
	money: {
		name: "money",
		width: 1200,
		height: 750,
		themes: both,
		half: true,
		alt: "Shared expenses in US dollars: what's planned and paid, your share, and who owes whom.",
	},
	offline: {
		name: "offline",
		width: 780,
		height: 1688,
		themes: both,
		half: true,
		alt: "Yonder installed on a phone, showing the next trip.",
	},
} as const satisfies Record<string, Shot>;

export type ShotName = keyof typeof SHOTS;

/** `/landing/<name>-<theme>[-half].<ext>`. */
export function shotSrc(
	shot: Shot,
	theme: ShotTheme,
	ext: "avif" | "webp",
	half = false,
): string {
	return `/landing/${shot.name}-${theme}${half ? "-half" : ""}.${ext}`;
}
