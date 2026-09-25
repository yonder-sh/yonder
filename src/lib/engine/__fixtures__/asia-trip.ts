/**
 * Ported from spikes/core/test/fixtures/trip.ts (node zones renamed `timezone` → `tz`).
 *
 * The real Asia 2027 shape (from seed/data: Cities, Places, Itinerary tabs), trimmed to
 * representative days. Coordinates are approximate. Deliberately includes the messy
 * parts of real data:
 *  - places directly under a city (teamLab Planets, Fushimi Inari, KIX, Ghibli Park)
 *  - a place directly under a country (ICN, TPE)
 *  - regions only where they exist (Yamanashi, Quang Nam, Lao Cai; none for Tokyo)
 *  - time zones only on countries, except the US (zone on the New Jersey region)
 *  - items without a node ("Lunch", "Dinner") and items on area/city nodes
 */
import type { HierarchyNode } from "../hierarchy";
import type { TimelineInput } from "../timeline";

/** The spike's nodes carry a free-form sheet category ("Airport", "Bar"…), which the hierarchy ignores. */
export type FixtureNode = HierarchyNode & { category?: string };
type N = Omit<FixtureNode, "lat" | "lng"> & { at: [number, number] };
const n = (x: N): FixtureNode => {
	const { at, ...rest } = x;
	return { ...rest, lat: at[0], lng: at[1] };
};

export const nodes: FixtureNode[] = [
	// --- United States (zone lives on the region; the country spans many zones) ---
	n({ id: "us", parentId: null, type: "country", name: "United States", at: [39.83, -98.58] }),
	n({ id: "nj", parentId: "us", type: "region", name: "New Jersey", tz: "America/New_York", at: [40.06, -74.41] }),
	n({ id: "newark", parentId: "nj", type: "city", name: "Newark", at: [40.7357, -74.1724] }),
	n({ id: "ewr", parentId: "newark", type: "place", category: "Airport", name: "Newark Liberty (EWR)", at: [40.6895, -74.1745] }),

	// --- Japan ---
	n({ id: "jp", parentId: null, type: "country", name: "Japan", tz: "Asia/Tokyo", at: [36.2048, 138.2529] }),
	n({ id: "tokyo", parentId: "jp", type: "city", name: "Tokyo", at: [35.6762, 139.6503] }),
	n({ id: "haneda", parentId: "tokyo", type: "area", name: "Haneda", at: [35.5494, 139.7798] }),
	n({ id: "hnd", parentId: "haneda", type: "place", category: "Airport", name: "Haneda Airport (HND)", at: [35.5494, 139.7798] }),
	n({ id: "anamori-inari", parentId: "haneda", type: "place", category: "Temple/Shrine", name: "Anamori Inari Shrine", at: [35.5497, 139.7539] }),
	n({ id: "jal-sky-museum", parentId: "haneda", type: "place", category: "Museum", name: "JAL Sky Museum", at: [35.5566, 139.7612] }),
	n({ id: "shibuya", parentId: "tokyo", type: "area", name: "Shibuya", at: [35.658, 139.7016] }),
	n({ id: "shibuya-crossing", parentId: "shibuya", type: "place", category: "Sight", name: "Shibuya Crossing", at: [35.6595, 139.7005] }),
	n({ id: "shibuya-sky", parentId: "shibuya", type: "place", category: "Sight", name: "Shibuya Sky", at: [35.6584, 139.7022] }),
	n({ id: "shinjuku", parentId: "tokyo", type: "area", name: "Shinjuku", at: [35.6938, 139.7034] }),
	n({ id: "golden-gai", parentId: "shinjuku", type: "place", category: "Bar", name: "Golden Gai", at: [35.694, 139.7046] }),
	n({ id: "bar-benfiddich", parentId: "shinjuku", type: "place", category: "Bar", name: "Bar Benfiddich", at: [35.6897, 139.6961] }),
	n({ id: "yodobashi-shinjuku", parentId: "shinjuku", type: "place", category: "Shopping", name: "Yodobashi Camera", at: [35.6907, 139.6982] }),
	n({ id: "omoide-yokocho", parentId: "shinjuku", type: "place", category: "Food/Drink", name: "Omoide Yokocho", at: [35.6931, 139.6995] }),
	n({ id: "hotel-gracery", parentId: "shinjuku", type: "place", category: "Hotel", name: "Hotel Gracery Shinjuku", at: [35.6955, 139.702] }),
	n({ id: "asakusa", parentId: "tokyo", type: "area", name: "Asakusa", at: [35.7148, 139.7967] }),
	n({ id: "sensoji", parentId: "asakusa", type: "place", category: "Temple/Shrine", name: "Senso-ji", at: [35.7148, 139.7967] }),
	n({ id: "kappabashi", parentId: "asakusa", type: "place", category: "Shopping", name: "Kappabashi Street", at: [35.7127, 139.788] }),
	n({ id: "nakano", parentId: "tokyo", type: "area", name: "Nakano", at: [35.7074, 139.6638] }),
	n({ id: "nakano-broadway", parentId: "nakano", type: "place", category: "Shopping", name: "Nakano Broadway", at: [35.709, 139.6658] }),
	n({ id: "teamlab-planets", parentId: "tokyo", type: "place", category: "Museum", name: "teamLab Planets", at: [35.6491, 139.7897] }),
	n({ id: "yamanashi", parentId: "jp", type: "region", name: "Yamanashi", at: [35.6636, 138.5684] }),
	n({ id: "fujikawaguchiko", parentId: "yamanashi", type: "city", name: "Fujikawaguchiko (Mt. Fuji)", at: [35.4973, 138.7555] }),
	n({ id: "kawaguchiko", parentId: "fujikawaguchiko", type: "area", name: "Lake Kawaguchi", at: [35.5171, 138.7519] }),
	n({ id: "oishi-park", parentId: "kawaguchiko", type: "place", category: "Nature", name: "Oishi Park", at: [35.526, 138.744] }),
	n({ id: "fuji-ropeway", parentId: "kawaguchiko", type: "place", category: "Sight", name: "Mt. Fuji Panoramic Ropeway", at: [35.502, 138.764] }),
	n({ id: "ryokan-kawaguchiko", parentId: "kawaguchiko", type: "place", category: "Hotel", name: "Ryokan (Kawaguchiko)", at: [35.51, 138.76] }),
	n({ id: "fujiyoshida", parentId: "yamanashi", type: "city", name: "Fujiyoshida", at: [35.4875, 138.8077] }),
	n({ id: "chureito", parentId: "fujiyoshida", type: "place", category: "Temple/Shrine", name: "Chureito Pagoda", at: [35.5011, 138.8015] }),
	n({ id: "nagoya", parentId: "jp", type: "city", name: "Nagoya", at: [35.1815, 136.9066] }),
	n({ id: "ghibli-park", parentId: "nagoya", type: "place", category: "Activity", name: "Ghibli Park", at: [35.1747, 137.0876] }),
	n({ id: "kyoto", parentId: "jp", type: "city", name: "Kyoto", at: [35.0116, 135.7681] }),
	n({ id: "gion", parentId: "kyoto", type: "area", name: "Gion", at: [35.0037, 135.7788] }),
	n({ id: "fushimi-inari", parentId: "kyoto", type: "place", category: "Temple/Shrine", name: "Fushimi Inari", at: [34.9671, 135.7727] }),
	n({ id: "osaka", parentId: "jp", type: "city", name: "Osaka", at: [34.6937, 135.5023] }),
	n({ id: "namba", parentId: "osaka", type: "area", name: "Namba", at: [34.6661, 135.5] }),
	n({ id: "dotonbori", parentId: "namba", type: "place", category: "Sight", name: "Dotonbori", at: [34.6687, 135.5013] }),
	n({ id: "kix", parentId: "osaka", type: "place", category: "Airport", name: "Kansai Airport (KIX)", at: [34.432, 135.2304] }),

	// --- South Korea ---
	n({ id: "kr", parentId: null, type: "country", name: "South Korea", tz: "Asia/Seoul", at: [35.9078, 127.7669] }),
	n({ id: "icn", parentId: "kr", type: "place", category: "Airport", name: "Incheon Airport (ICN)", at: [37.4602, 126.4407] }),
	n({ id: "seoul", parentId: "kr", type: "city", name: "Seoul", at: [37.5665, 126.978] }),
	n({ id: "myeongdong", parentId: "seoul", type: "area", name: "Myeongdong", at: [37.5636, 126.9869] }),
	n({ id: "hotel-myeongdong", parentId: "myeongdong", type: "place", category: "Hotel", name: "Hotel (Myeongdong)", at: [37.5632, 126.9851] }),
	n({ id: "gyeongbokgung", parentId: "seoul", type: "place", category: "Sight", name: "Gyeongbokgung Palace", at: [37.5796, 126.977] }),
	n({ id: "busan", parentId: "kr", type: "city", name: "Busan", at: [35.1796, 129.0756] }),
	n({ id: "haeundae", parentId: "busan", type: "area", name: "Haeundae", at: [35.1587, 129.1604] }),
	n({ id: "pus", parentId: "busan", type: "place", category: "Airport", name: "Gimhae Airport (PUS)", at: [35.1795, 128.9382] }),

	// --- Vietnam ---
	n({ id: "vn", parentId: null, type: "country", name: "Vietnam", tz: "Asia/Ho_Chi_Minh", at: [14.0583, 108.2772] }),
	n({ id: "hcmc", parentId: "vn", type: "city", name: "Ho Chi Minh City", at: [10.8231, 106.6297] }),
	n({ id: "district-1", parentId: "hcmc", type: "area", name: "District 1", at: [10.7756, 106.7019] }),
	n({ id: "ben-thanh", parentId: "district-1", type: "place", category: "Shopping", name: "Ben Thanh Market", at: [10.7725, 106.698] }),
	n({ id: "sgn", parentId: "hcmc", type: "place", category: "Airport", name: "Tan Son Nhat (SGN)", at: [10.8185, 106.6588] }),
	n({ id: "da-nang", parentId: "vn", type: "city", name: "Da Nang", at: [16.0544, 108.2022] }),
	n({ id: "dad", parentId: "da-nang", type: "place", category: "Airport", name: "Da Nang Airport (DAD)", at: [16.0439, 108.1994] }),
	n({ id: "quang-nam", parentId: "vn", type: "region", name: "Quang Nam", at: [15.5394, 108.0191] }),
	n({ id: "hoi-an", parentId: "quang-nam", type: "city", name: "Hoi An", at: [15.8801, 108.338] }),
	n({ id: "hoi-an-ancient-town", parentId: "hoi-an", type: "area", name: "Ancient Town", at: [15.8772, 108.3269] }),
	n({ id: "japanese-bridge", parentId: "hoi-an-ancient-town", type: "place", category: "Sight", name: "Japanese Covered Bridge", at: [15.877, 108.3259] }),
	n({ id: "hanoi", parentId: "vn", type: "city", name: "Hanoi", at: [21.0278, 105.8342] }),
	n({ id: "old-quarter", parentId: "hanoi", type: "area", name: "Old Quarter", at: [21.034, 105.85] }),
	n({ id: "hanoi-station", parentId: "hanoi", type: "place", category: "Station", name: "Hanoi Station", at: [21.0245, 105.8412] }),
	n({ id: "han", parentId: "hanoi", type: "place", category: "Airport", name: "Noi Bai (HAN)", at: [21.2187, 105.8042] }),
	n({ id: "lao-cai-province", parentId: "vn", type: "region", name: "Lao Cai", at: [22.4809, 103.9755] }),
	n({ id: "lao-cai", parentId: "lao-cai-province", type: "city", name: "Lao Cai (city)", at: [22.4856, 103.9707] }),
	n({ id: "lao-cai-station", parentId: "lao-cai", type: "place", category: "Station", name: "Lao Cai Station", at: [22.4953, 103.9716] }),
	n({ id: "sa-pa", parentId: "lao-cai-province", type: "city", name: "Sa Pa", at: [22.3364, 103.8438] }),
	n({ id: "ninh-binh", parentId: "vn", type: "city", name: "Ninh Binh", at: [20.2506, 105.9745] }),
	n({ id: "trang-an", parentId: "ninh-binh", type: "place", category: "Nature", name: "Trang An", at: [20.2544, 105.8995] }),

	// --- Taiwan ---
	n({ id: "tw", parentId: null, type: "country", name: "Taiwan", tz: "Asia/Taipei", at: [23.6978, 120.9605] }),
	n({ id: "tpe", parentId: "tw", type: "place", category: "Airport", name: "Taoyuan Airport (TPE)", at: [25.0797, 121.2342] }),
	n({ id: "taipei", parentId: "tw", type: "city", name: "Taipei", at: [25.033, 121.5654] }),
	n({ id: "ximending", parentId: "taipei", type: "area", name: "Ximending", at: [25.0421, 121.5081] }),
	n({ id: "new-taipei", parentId: "tw", type: "city", name: "New Taipei", at: [25.012, 121.4657] }),
	n({ id: "jiufen", parentId: "new-taipei", type: "area", name: "Jiufen", at: [25.1092, 121.8446] }),
];

/**
 * Representative days of the itinerary (dates in October/November 2027).
 * Not every day is present: gaps between dates are fine.
 */
export const timeline: TimelineInput = {
	days: [
		{
			id: "d0",
			date: "2027-10-07",
			items: [{ id: "ewr-checkin", nodeId: "ewr", title: "Check in at EWR", durationMin: 120, pinnedStart: "08:30" }],
		},
		{
			id: "d1",
			date: "2027-10-08",
			items: [
				{ id: "hnd-arrival", nodeId: "hnd", title: "Arrive HND, immigration, Suica", durationMin: 60 },
				{ id: "anamori", nodeId: "anamori-inari", title: "Anamori Inari Shrine", durationMin: 45 },
				{ id: "crossing", nodeId: "shibuya-crossing", title: "Shibuya crossing", durationMin: 30 },
				{ id: "sky", nodeId: "shibuya-sky", title: "Shibuya Sky (sunset slot)", durationMin: 60, pinnedStart: "17:30" },
				{ id: "d1-dinner", title: "Dinner", durationMin: 90 },
				{ id: "d1-hotel", nodeId: "hotel-gracery", title: "Check in Hotel Gracery", durationMin: 30 },
			],
		},
		{
			id: "d3",
			date: "2027-10-10",
			items: [
				{ id: "d3-breakfast", title: "Breakfast", durationMin: 30 },
				{ id: "nakano-bw", nodeId: "nakano-broadway", title: "Nakano Broadway", durationMin: 150 },
				{ id: "d3-lunch", title: "Lunch", durationMin: 60 },
				{ id: "yodobashi", nodeId: "yodobashi-shinjuku", title: "Yodobashi Camera", durationMin: 120 },
				{ id: "omoide", nodeId: "omoide-yokocho", title: "Dinner at Omoide Yokocho", durationMin: 90, pinnedStart: "18:30" },
				{ id: "benfiddich", nodeId: "bar-benfiddich", title: "Bar Benfiddich", durationMin: 60, pinnedStart: "21:00" },
				{ id: "golden-gai", nodeId: "golden-gai", title: "Golden Gai", durationMin: 150 },
			],
		},
		{
			id: "d5",
			date: "2027-10-12",
			items: [
				{ id: "d5-breakfast", nodeId: "shinjuku", title: "Breakfast (Shinjuku)", durationMin: 30 },
				{ id: "ryokan-drop", nodeId: "ryokan-kawaguchiko", title: "Drop bags at ryokan", durationMin: 30 },
				{ id: "d5-lunch", title: "Lunch", durationMin: 60 },
				{ id: "oishi", nodeId: "oishi-park", title: "Oishi Park", durationMin: 30 },
				{ id: "ropeway", nodeId: "fuji-ropeway", title: "Panoramic Ropeway", durationMin: 90 },
				{ id: "ryokan-checkin", nodeId: "ryokan-kawaguchiko", title: "Ryokan check-in + onsen", durationMin: 60 },
				{ id: "kaiseki", nodeId: "ryokan-kawaguchiko", title: "Dinner (ryokan kaiseki)", durationMin: 120, pinnedStart: "18:00" },
			],
		},
		{
			id: "d6",
			date: "2027-10-13",
			items: [
				{ id: "chureito", nodeId: "chureito", title: "Chureito Pagoda (sunrise)", durationMin: 90, pinnedStart: "05:30" },
				{ id: "ryokan-breakfast", nodeId: "ryokan-kawaguchiko", title: "Breakfast (ryokan)", durationMin: 60 },
				{ id: "nagoya-hotel", nodeId: "nagoya", title: "Check in (Nagoya)", durationMin: 30 },
			],
		},
		{
			id: "d10",
			date: "2027-10-17",
			startTime: "06:45",
			items: [
				{ id: "namba-checkout", nodeId: "namba", title: "Check out (Namba)", durationMin: 30 },
				{ id: "kix-checkin", nodeId: "kix", title: "KIX check-in", durationMin: 90 },
				{ id: "icn-arrival", nodeId: "icn", title: "Arrive ICN, immigration", durationMin: 60 },
				{ id: "seoul-hotel", nodeId: "hotel-myeongdong", title: "Hotel (Myeongdong)", durationMin: 30 },
				{ id: "gyeongbokgung", nodeId: "gyeongbokgung", title: "Gyeongbokgung Palace", durationMin: 120 },
			],
		},
		{
			id: "d15",
			date: "2027-10-22",
			startTime: "07:00",
			items: [
				{ id: "busan-checkout", nodeId: "haeundae", title: "Check out (Haeundae)", durationMin: 30 },
				{ id: "pus-checkin", nodeId: "pus", title: "PUS check-in", durationMin: 90 },
				{ id: "sgn-arrival", nodeId: "sgn", title: "Arrive SGN", durationMin: 60 },
				{ id: "ben-thanh", nodeId: "ben-thanh", title: "Ben Thanh Market", durationMin: 90 },
			],
		},
		{
			id: "d22",
			date: "2027-10-29",
			items: [
				{ id: "hanoi-dinner", nodeId: "old-quarter", title: "Dinner (Old Quarter)", durationMin: 90, pinnedStart: "19:00" },
				{ id: "hanoi-station", nodeId: "hanoi-station", title: "Board night train", durationMin: 30 },
			],
		},
		{
			id: "d23",
			date: "2027-10-30",
			items: [
				{ id: "lao-cai-arrival", nodeId: "lao-cai-station", title: "Arrive Lao Cai", durationMin: 30 },
				{ id: "sapa-breakfast", nodeId: "sa-pa", title: "Breakfast in Sa Pa", durationMin: 60 },
			],
		},
		{
			id: "d28",
			date: "2027-11-04",
			items: [
				{ id: "hanoi-coffee", nodeId: "old-quarter", title: "Egg coffee (Old Quarter)", durationMin: 60 },
				{ id: "han-checkin", nodeId: "han", title: "HAN check-in", durationMin: 120 },
				{ id: "tpe-arrival", nodeId: "tpe", title: "Arrive TPE", durationMin: 45 },
				{ id: "ximending-dinner", nodeId: "ximending", title: "Dinner (Ximending)", durationMin: 90 },
			],
		},
		{
			id: "d31",
			date: "2027-11-06",
			items: [{ id: "tpe-checkin", nodeId: "tpe", title: "TPE check-in", durationMin: 120, pinnedStart: "20:00" }],
		},
		{
			id: "d32",
			date: "2027-11-07",
			items: [
				{ id: "ewr-arrival", nodeId: "ewr", title: "Arrive EWR", durationMin: 60 },
				{ id: "drive-home", title: "Drive home to Havertown", durationMin: 120 },
			],
		},
	],
	legs: [
		// Outbound: EWR (EDT, -04:00) -> HND (+09:00), arriving the next local date.
		{
			id: "L-ewr-hnd",
			fromItemId: "ewr-checkin",
			toItemId: "hnd-arrival",
			mode: "flight",
			label: "EWR→HND",
			departure: { at: "10:55" },
			arrival: { at: "13:55" },
		},
		{ id: "L-hnd-anamori", fromItemId: "hnd-arrival", toItemId: "anamori", mode: "transit", durationMin: 10 },
		{ id: "L-anamori-crossing", fromItemId: "anamori", toItemId: "crossing", mode: "transit", durationMin: 50 },
		{ id: "L-crossing-sky", fromItemId: "crossing", toItemId: "sky", mode: "walk", durationMin: 5 },
		{ id: "L-sky-dinner", fromItemId: "sky", toItemId: "d1-dinner", mode: "walk", durationMin: 5 },
		{ id: "L-dinner-hotel", fromItemId: "d1-dinner", toItemId: "d1-hotel", mode: "transit", durationMin: 20 },

		{ id: "L-breakfast-nakano", fromItemId: "d3-breakfast", toItemId: "nakano-bw", mode: "transit", durationMin: 15 },
		{ id: "L-lunch-yodobashi", fromItemId: "d3-lunch", toItemId: "yodobashi", mode: "transit", durationMin: 20 },
		{ id: "L-yodobashi-omoide", fromItemId: "yodobashi", toItemId: "omoide", mode: "walk", durationMin: 10 },
		{ id: "L-omoide-benfiddich", fromItemId: "omoide", toItemId: "benfiddich", mode: "walk", durationMin: 10 },
		{ id: "L-benfiddich-gg", fromItemId: "benfiddich", toItemId: "golden-gai", mode: "walk", durationMin: 15 },

		// Fuji Excursion limited express: a scheduled train leg.
		{
			id: "L-fuji-excursion",
			fromItemId: "d5-breakfast",
			toItemId: "ryokan-drop",
			mode: "transit",
			label: "Fuji Excursion 7",
			departure: { at: "08:30" },
			arrival: { at: "10:26" },
		},
		{ id: "L-lunch-oishi", fromItemId: "d5-lunch", toItemId: "oishi", mode: "walk", durationMin: 15 },
		{ id: "L-oishi-ropeway", fromItemId: "oishi", toItemId: "ropeway", mode: "transit", durationMin: 15 },
		{ id: "L-ropeway-ryokan", fromItemId: "ropeway", toItemId: "ryokan-checkin", mode: "walk", durationMin: 10 },

		{ id: "L-chureito-ryokan", fromItemId: "chureito", toItemId: "ryokan-breakfast", mode: "transit", durationMin: 25 },
		{ id: "L-fuji-nagoya", fromItemId: "ryokan-breakfast", toItemId: "nagoya-hotel", mode: "transit", durationMin: 240 },

		{ id: "L-namba-kix", fromItemId: "namba-checkout", toItemId: "kix-checkin", mode: "transit", durationMin: 45, label: "Nankai Rapi:t" },
		// Osaka -> Seoul: same UTC offset, different zone.
		{
			id: "L-kix-icn",
			fromItemId: "kix-checkin",
			toItemId: "icn-arrival",
			mode: "flight",
			label: "KIX→ICN",
			durationMin: 120,
			departure: { at: "10:05" },
			arrival: { at: "12:05" },
		},
		{ id: "L-icn-hotel", fromItemId: "icn-arrival", toItemId: "seoul-hotel", mode: "transit", durationMin: 60, label: "AREX" },
		{ id: "L-hotel-palace", fromItemId: "seoul-hotel", toItemId: "gyeongbokgung", mode: "transit", durationMin: 20 },

		{ id: "L-haeundae-pus", fromItemId: "busan-checkout", toItemId: "pus-checkin", mode: "transit", durationMin: 50 },
		// Busan (+09:00) -> Ho Chi Minh City (+07:00): -2h.
		{
			id: "L-pus-sgn",
			fromItemId: "pus-checkin",
			toItemId: "sgn-arrival",
			mode: "flight",
			label: "PUS→SGN",
			departure: { at: "10:25" },
			arrival: { at: "13:20" },
		},
		{ id: "L-sgn-benthanh", fromItemId: "sgn-arrival", toItemId: "ben-thanh", mode: "transit", durationMin: 30 },

		{ id: "L-dinner-station", fromItemId: "hanoi-dinner", toItemId: "hanoi-station", mode: "walk", durationMin: 20 },
		// Overnight train Hanoi -> Lao Cai: crosses days.
		{
			id: "L-night-train",
			fromItemId: "hanoi-station",
			toItemId: "lao-cai-arrival",
			mode: "transit",
			label: "Night train to Lao Cai",
			departure: { at: "21:40" },
			arrival: { at: "05:30" },
		},
		{ id: "L-laocai-sapa", fromItemId: "lao-cai-arrival", toItemId: "sapa-breakfast", mode: "transit", durationMin: 60 },

		{ id: "L-coffee-han", fromItemId: "hanoi-coffee", toItemId: "han-checkin", mode: "transit", durationMin: 45 },
		// Hanoi (+07:00) -> Taipei (+08:00).
		{
			id: "L-han-tpe",
			fromItemId: "han-checkin",
			toItemId: "tpe-arrival",
			mode: "flight",
			label: "HAN→TPE",
			departure: { at: "14:25" },
			arrival: { at: "18:20" },
		},
		{ id: "L-tpe-ximending", fromItemId: "tpe-arrival", toItemId: "ximending-dinner", mode: "transit", durationMin: 50 },

		// Return via Istanbul; lands after the US DST change (EST, -05:00).
		{
			id: "L-tpe-ewr",
			fromItemId: "tpe-checkin",
			toItemId: "ewr-arrival",
			mode: "flight",
			label: "TPE→IST→EWR",
			departure: { at: "22:30" },
			arrival: { at: "2027-11-07T13:40" },
		},
		{ id: "L-ewr-home", fromItemId: "ewr-arrival", toItemId: "drive-home", mode: "other", durationMin: 0 },
	],
};

/** Entity-attached things (todos / shopping / attachments), keyed by entity. */
export interface Attachment {
	id: string;
	kind: "todo" | "shopping" | "attachment";
	title: string;
	entity: { type: "node" | "item" | "leg" | "day" | "trip"; id: string };
}

export const attachments: Attachment[] = [
	{ id: "a-insurance", kind: "todo", title: "Buy travel insurance", entity: { type: "trip", id: "asia-2027" } },
	{ id: "a-jr-pass", kind: "todo", title: "Decide on JR pass", entity: { type: "node", id: "jp" } },
	{ id: "a-ic-card", kind: "todo", title: "Get an IC card", entity: { type: "node", id: "tokyo" } },
	{ id: "a-jal-tour", kind: "todo", title: "Reserve JAL Sky Museum tour", entity: { type: "node", id: "jal-sky-museum" } },
	{ id: "a-tax-free", kind: "todo", title: "Bring passport for tax-free", entity: { type: "node", id: "shinjuku" } },
	{ id: "a-camera", kind: "shopping", title: "Camera body", entity: { type: "node", id: "yodobashi-shinjuku" } },
	{ id: "a-knife", kind: "shopping", title: "Gyuto knife", entity: { type: "node", id: "kappabashi" } },
	{ id: "a-gg-cash", kind: "todo", title: "Bring cash (cover charges)", entity: { type: "item", id: "golden-gai" } },
	{ id: "a-sky-ticket", kind: "attachment", title: "Shibuya Sky ticket.pdf", entity: { type: "item", id: "sky" } },
	{ id: "a-suica", kind: "todo", title: "Add Suica to phone", entity: { type: "day", id: "d1" } },
	{ id: "a-fuji-tickets", kind: "todo", title: "Buy Fuji Excursion tickets", entity: { type: "leg", id: "L-fuji-excursion" } },
	{ id: "a-kix-icn-eticket", kind: "attachment", title: "KIX→ICN e-ticket.pdf", entity: { type: "leg", id: "L-kix-icn" } },
	{ id: "a-d10-sim", kind: "todo", title: "Activate Korean eSIM", entity: { type: "day", id: "d10" } },
	{ id: "a-train-tickets", kind: "todo", title: "Book night train berths", entity: { type: "leg", id: "L-night-train" } },
	{ id: "a-suit", kind: "shopping", title: "Tailored suit", entity: { type: "node", id: "hoi-an" } },
	{ id: "a-ghost", kind: "todo", title: "Refers to a deleted place", entity: { type: "node", id: "deleted-node" } },
	{ id: "a-ghost-item", kind: "todo", title: "Refers to a deleted item", entity: { type: "item", id: "deleted-item" } },
];
