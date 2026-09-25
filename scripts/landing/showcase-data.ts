/**
 * The showcase trip's content (`showcase.ts` writes it): places, ratings,
 * days and legs of "East Asia in autumn", following the landing page's demo
 * route. All invented. Tables stay one row per line (`biome-ignore format`).
 */
import type { GraphNode } from "../../src/lib/engine/types";

/** [key, parent key, type, name, lat, lng, category]. */
export type NodeRow = [
	key: string,
	parent: string,
	type: "country" | "region" | "city" | "area" | "place",
	name: string,
	lat: number,
	lng: number,
	category?: GraphNode["category"],
];

/** The demo tree's USA, Japan, Tokyo, Kyoto, Osaka, South Korea, Seoul, Taiwan, Taipei (and a few places) are reused. */
export const REUSE = [
	"usa",
	"japan",
	"tokyo",
	"sensoji",
	"asakusa",
	"meijiJingu",
	"harajuku",
	"shibuyaSky",
	"shibuya",
	"kyoto",
	"kiyomizu",
	"osaka",
	"kix",
	"southKorea",
	"seoul",
	"icn",
	"taiwan",
	"taipei",
	"tpe",
];

/** Zones and codes for the countries the demo tree lacks. */
export const COUNTRY_EXTRA: Record<
	string,
	{ tz: string; countryCode?: string }
> = {
	vietnam: { tz: "Asia/Ho_Chi_Minh", countryCode: "VN" },
	newYork: { tz: "America/New_York" },
};

// biome-ignore format: a table, one place per line
export const NODES: NodeRow[] = [
	["hnd", "tokyo", "place", "Haneda Airport (HND)", 35.5494, 139.7798, "airport"],
	["shinjukuGyoen", "tokyo", "place", "Shinjuku Gyoen", 35.6852, 139.7101, "park"],
	["omoide", "tokyo", "place", "Omoide Yokocho", 35.6931, 139.6995, "food_drink"],
	["ghibli", "tokyo", "place", "Ghibli Museum", 35.6962, 139.5704, "museum"],
	["tsukiji", "tokyo", "place", "Tsukiji Outer Market", 35.6655, 139.7707, "market"],
	["teamlab", "tokyo", "place", "teamLab Planets", 35.6492, 139.7898, "museum"],
	["yanaka", "tokyo", "place", "Yanaka Ginza", 35.7278, 139.7657, "shopping"],
	["tokyoSt", "tokyo", "place", "Tokyo Station", 35.6812, 139.7671, "station"],
	["kyotoSt", "kyoto", "place", "Kyoto Station", 34.9858, 135.7588, "station"],
	["gion", "kyoto", "area", "Gion", 35.0037, 135.7788],
	["machiya", "gion", "place", "Machiya in Gion", 35.0027, 135.7751, "lodging"],
	["pontocho", "kyoto", "place", "Pontocho Alley", 35.0056, 135.7707, "restaurant"],
	["fushimi", "kyoto", "place", "Fushimi Inari Taisha", 34.9671, 135.7727, "temple_shrine"],
	["nishiki", "kyoto", "place", "Nishiki Market", 35.005, 135.7649, "market"],
	["arashiyama", "kyoto", "place", "Arashiyama Bamboo Grove", 35.017, 135.6713, "nature"],
	["kinkakuji", "kyoto", "place", "Kinkaku-ji", 35.0394, 135.7292, "temple_shrine"],
	["uji", "kyoto", "area", "Uji", 34.8844, 135.7998],
	["tokichi", "uji", "place", "Nakamura Tokichi", 34.8893, 135.8077, "cafe"],
	["nara", "japan", "city", "Nara", 34.6851, 135.8048],
	["naraPark", "nara", "place", "Nara Park", 34.685, 135.843, "park"],
	["dotonbori", "osaka", "place", "Dotonbori", 34.6687, 135.5013, "nightlife"],
	["osakaCastle", "osaka", "place", "Osaka Castle", 34.6873, 135.5262, "sight"],
	["gyeongbokgung", "seoul", "place", "Gyeongbokgung Palace", 37.5796, 126.977, "sight"],
	["bukchon", "seoul", "place", "Bukchon Hanok Village", 37.5826, 126.9831, "sight"],
	["gwangjang", "seoul", "place", "Gwangjang Market", 37.57, 126.9996, "market"],
	["namsan", "seoul", "place", "N Seoul Tower", 37.5512, 126.9882, "viewpoint"],
	["seongsu", "seoul", "place", "Seongsu cafés", 37.5446, 127.0557, "cafe"],
	["hongdae", "seoul", "place", "Hongdae", 37.5563, 126.9236, "nightlife"],
	["seoulSt", "seoul", "place", "Seoul Station", 37.5547, 126.9707, "station"],
	["busan", "southKorea", "city", "Busan", 35.1796, 129.0756],
	["busanSt", "busan", "place", "Busan Station", 35.1151, 129.0422, "station"],
	["gamcheon", "busan", "place", "Gamcheon Culture Village", 35.0975, 129.0106, "sight"],
	["gwangalli", "busan", "place", "Gwangalli Beach", 35.1532, 129.1186, "beach"],
	["jagalchi", "busan", "place", "Jagalchi Fish Market", 35.0966, 129.0306, "market"],
	["pus", "busan", "place", "Gimhae Airport (PUS)", 35.1795, 128.9382, "airport"],
	["taipei101", "taipei", "place", "Taipei 101", 25.0339, 121.5645, "viewpoint"],
	["raohe", "taipei", "place", "Raohe Night Market", 25.0504, 121.5773, "market"],
	["palaceMuseum", "taipei", "place", "National Palace Museum", 25.1024, 121.5485, "museum"],
	["jiufen", "taipei", "place", "Jiufen Old Street", 25.1097, 121.8452, "sight"],
	["elephant", "taipei", "place", "Elephant Mountain", 25.0271, 121.5764, "nature"],
	["vietnam", "", "country", "Vietnam", 14.0583, 108.2772],
	["hanoi", "vietnam", "city", "Hanoi", 21.0278, 105.8342],
	["han", "hanoi", "place", "Noi Bai Airport (HAN)", 21.2187, 105.8042, "airport"],
	["hoanKiem", "hanoi", "place", "Hoan Kiem Lake", 21.0288, 105.8525, "park"],
	["trainStreet", "hanoi", "place", "Train Street", 21.0272, 105.8438, "sight"],
	["literature", "hanoi", "place", "Temple of Literature", 21.0293, 105.8356, "temple_shrine"],
	["hanoiSt", "hanoi", "place", "Hanoi Station", 21.0245, 105.8412, "station"],
	["halong", "vietnam", "region", "Ha Long Bay", 20.9101, 107.1839],
	["halongCruise", "halong", "place", "Ha Long Bay overnight cruise", 20.9101, 107.1839, "activity"],
	["hoian", "vietnam", "city", "Hội An", 15.8801, 108.338],
	["danangSt", "hoian", "place", "Da Nang Station", 16.0717, 108.2094, "station"],
	["oldTown", "hoian", "place", "Hội An Old Town", 15.8773, 108.3267, "sight"],
	["anBang", "hoian", "place", "An Bang Beach", 15.9142, 108.3413, "beach"],
	["goldenBridge", "hoian", "place", "Golden Bridge, Bà Nà Hills", 15.995, 107.9966, "sight"],
	["cooking", "hoian", "place", "Cooking class in Cẩm Thanh", 15.8723, 108.3616, "activity"],
	["saigon", "vietnam", "city", "Saigon", 10.7769, 106.7009],
	["sgn", "saigon", "place", "Tan Son Nhat Airport (SGN)", 10.8188, 106.6519, "airport"],
	["saigonSt", "saigon", "place", "Saigon Station", 10.7822, 106.6772, "station"],
	["newYork", "usa", "city", "New York", 40.7128, -74.006],
	["jfk", "newYork", "place", "JFK Airport", 40.6413, -73.7781, "airport"],
	["postOffice", "saigon", "place", "Saigon Central Post Office", 10.7799, 106.6999, "sight"],
	["benThanh", "saigon", "place", "Ben Thanh Market", 10.7725, 106.698, "market"],
	["warMuseum", "saigon", "place", "War Remnants Museum", 10.7795, 106.692, "museum"],
	["cuChi", "saigon", "place", "Cu Chi Tunnels", 11.1415, 106.4624, "sight"],
	// Ideas nobody has scheduled yet (the Places tab's shortlist and ideas).
	["kappabashi2", "tokyo", "place", "Kappabashi Street", 35.7126, 139.7876, "shopping"],
	["shimokita", "tokyo", "place", "Shimokitazawa", 35.6613, 139.6681, "shopping"],
	["goldenGai", "tokyo", "place", "Golden Gai", 35.6938, 139.7036, "bar"],
	["disneySea", "tokyo", "place", "Tokyo DisneySea", 35.6267, 139.885, "activity"],
	["philosophers", "kyoto", "place", "Philosopher's Path", 35.0269, 135.7948, "nature"],
	["lotteWorld", "seoul", "place", "Lotte World", 37.5111, 127.0982, "activity"],
	["dmz", "seoul", "place", "DMZ day tour", 37.9557, 126.6772, "activity"],
	["haedong", "busan", "place", "Haedong Yonggungsa", 35.1884, 129.2233, "temple_shrine"],
	["beitou", "taipei", "place", "Beitou hot springs", 25.1368, 121.5068, "onsen"],
	["yehliu", "taipei", "place", "Yehliu Geopark", 25.2064, 121.6906, "nature"],
	["marbleMts", "hoian", "place", "Marble Mountains", 16.0036, 108.2634, "nature"],
	["mekong", "saigon", "place", "Mekong Delta day trip", 10.36, 106.36, "activity"],
];

/**
 * Ratings by Alex, Maya, Jonas and Priya, in that order: M(ust), R(eally
 * want), W(ant), S(ure), E (meh), N(ah); "-" not rated yet.
 */
// biome-ignore format: a table
export const RATINGS: Record<string, string> = {
	sensoji: "RMWR", meijiJingu: "WRSW", shibuyaSky: "RWMR", shinjukuGyoen: "WMWS",
	omoide: "MRWR", ghibli: "MMRW", tsukiji: "RRMW", teamlab: "WRMM", yanaka: "SWEW",
	kappabashi2: "RWS-", shimokita: "SMRE", goldenGai: "RMWR", disneySea: "EMNS",
	fushimi: "MMMR", kiyomizu: "RMRW", nishiki: "RWRM", arashiyama: "MRWR", kinkakuji: "WRSW",
	tokichi: "RMWR", philosophers: "WRW-", naraPark: "-MRM", dotonbori: "RRMM", osakaCastle: "SWEW",
	gyeongbokgung: "RMRW", bukchon: "WRWM", gwangjang: "MMRR", namsan: "SRWW", seongsu: "RMSW",
	hongdae: "RWMR", lotteWorld: "NESR", dmz: "RWMW",
	gamcheon: "RWRM", gwangalli: "-RWM", jagalchi: "WREW", haedong: "WRMW",
	taipei101: "RWMR", raohe: "MMRR", palaceMuseum: "WRSW", jiufen: "MRRM", elephant: "RWMR",
	beitou: "RMWR", yehliu: "WSW-",
	hoanKiem: "WRWR", trainStreet: "RWME", literature: "WSRW", halongCruise: "MRMR",
	oldTown: "MMRM", anBang: "RWRM", goldenBridge: "WRMR", cooking: "RMRM", marbleMts: "SWRW",
	postOffice: "WRWR", benThanh: "RWRM", warMuseum: "RWMW", cuChi: "RMWR", mekong: "RRMW",
};

/** [item key, node key, minutes, pinned start, title]. */
export type ItemRow = [
	key: string,
	node?: string,
	min?: number,
	pin?: string,
	title?: string,
];
export type DayRow = { night?: string; start?: string; items: ItemRow[] };

export const FIRST_DATE = "2026-10-16";

// biome-ignore format: a table, one day per line
export const DAYS: DayRow[] = [
	// Fri 16 Oct: out of New York (the night is on the plane)
	{ start: "08:30", items: [["jfk1", "jfk", 150, "09:00"]] },
	// Tokyo: Sat 17 Oct – Wed 21 Oct
	{ night: "tokyo", start: "14:00", items: [["hnd1", "hnd", 60, "14:30"], ["gyoen", "shinjukuGyoen", 90], ["omoide1", "omoide", 90, "19:00"]] },
	{ night: "tokyo", start: "07:30", items: [["tsukiji1", "tsukiji", 90, "08:00"], ["teamlab1", "teamlab", 120], ["sky1", "shibuyaSky", 90, "17:00"]] },
	{ night: "tokyo", items: [["ghibli1", "ghibli", 120, "10:00"], ["lunch3", undefined, 60, undefined, "Lunch in Kichijōji"], ["meiji1", "meijiJingu", 75]] },
	{ night: "tokyo", start: "08:00", items: [["sensoji1", "sensoji", 90, "08:30"], ["yanaka1", "yanaka", 90]] },
	{ night: "tokyo", items: [["free5", undefined, 180, "10:00", "Free morning"], ["shimo1", "shimokita", 150]] },
	// Kyoto: Thu 22 – Sun 25 Oct
	{ night: "machiya", items: [["tokyoSt1", "tokyoSt", 30, "09:00"], ["kyotoSt1", "kyotoSt", 20], ["nishiki1", "nishiki", 90], ["kiyo1", "kiyomizu", 90]] },
	{ night: "machiya", start: "07:00", items: [["fushimi1", "fushimi", 120, "07:30"], ["tokichi1", "tokichi", 60], ["arashi1", "arashiyama", 90], ["kinkaku1", "kinkakuji", 60], ["ponto1", "pontocho", 90, "19:00"]] },
	{ night: "machiya", items: [["nara1", "naraPark", 180, "09:30"], ["gion1", "gion", 90, "18:00"]] },
	{ night: "machiya", items: [["castle1", "osakaCastle", 90, "10:00"], ["doto1", "dotonbori", 150, "17:30"]] },
	// Seoul: Mon 26 – Thu 29 Oct
	{ night: "seoul", start: "07:30", items: [["kix1", "kix", 120, "08:30"], ["icn1", "icn", 60], ["gwangjang1", "gwangjang", 90, "18:30"]] },
	{ night: "seoul", items: [["gyeong1", "gyeongbokgung", 120, "09:30"], ["bukchon1", "bukchon", 90], ["namsan1", "namsan", 90, "18:00"]] },
	{ night: "seoul", start: "07:00", items: [["dmz1", "dmz", 420, "07:30"]] },
	{ night: "seoul", items: [["seongsu1", "seongsu", 180, "11:00"], ["hongdae1", "hongdae", 180, "18:00"]] },
	// Busan: Fri 30 – Sat 31 Oct
	{ night: "busan", items: [["seoulSt1", "seoulSt", 30, "09:00"], ["busanSt1", "busanSt", 20], ["gamcheon1", "gamcheon", 120], ["gwangalli1", "gwangalli", 120, "18:00"]] },
	{ night: "busan", items: [["haedong1", "haedong", 120, "09:00"], ["jagalchi1", "jagalchi", 90]] },
	// Taipei: Sun 1 – Tue 3 Nov
	{ night: "taipei", items: [["pus1", "pus", 120, "11:00"], ["tpe1", "tpe", 60], ["raohe1", "raohe", 120, "19:00"]] },
	{ night: "taipei", items: [["palace1", "palaceMuseum", 150, "09:30"], ["t101", "taipei101", 90, "19:30"]] },
	{ night: "taipei", items: [["jiufen1", "jiufen", 240, "10:00"], ["elephant1", "elephant", 90, "17:00"]] },
	// Hanoi: Wed 4 – Fri 6 Nov
	{ night: "hanoi", start: "05:00", items: [["tpe2", "tpe", 120, "06:00"], ["han1", "han", 60], ["hoan1", "hoanKiem", 90, "16:00"]] },
	{ night: "hanoi", items: [["lit1", "literature", 90, "09:00"], ["train1", "trainStreet", 60], ["hoan2", undefined, 90, "19:00", "Water puppet show"]] },
	{ night: "hanoi", start: "06:30", items: [["halong1", "halongCruise", 600, "07:00"]] },
	// Hội An: Sat 7 – Mon 9 Nov
	{ night: "hoian", start: "05:15", items: [["hanoiSt1", "hanoiSt", 30, "06:00"], ["danangSt1", "danangSt", 30], ["oldTown1", "oldTown", 120]] },
	{ night: "hoian", start: "08:00", items: [["cooking1", "cooking", 240, "08:30"], ["anbang1", "anBang", 150]] },
	{ night: "hoian", start: "07:00", items: [["golden1", "goldenBridge", 300, "08:00"]] },
	// Saigon: Tue 10 – Wed 11 Nov
	{ night: "saigon", start: "05:15", items: [["danangSt2", "danangSt", 30, "06:00"], ["saigonSt1", "saigonSt", 30]] },
	{ night: "saigon", start: "07:30", items: [["cuchi1", "cuChi", 300, "08:00"], ["war1", "warMuseum", 90], ["post1", "postOffice", 60]] },
	// Thu 12 Nov: home to New York
	{ start: "08:30", items: [["benthanh2", "benThanh", 60, "09:00"], ["sgn2", "sgn", 150, "13:00"], ["jfk2", "jfk", 30]] },
];

type Airport = readonly [
	iata: string,
	tz: string,
	country: string,
	at: readonly [number, number],
];

/** Flights between the day's airport items (local times). */
// biome-ignore format: a table
export const FLIGHTS: readonly { from: string; to: string; number: string; a: Airport; b: Airport; dep: string; arr: string }[] = [
	{ from: "jfk1", to: "hnd1", number: "NH 109", a: ["JFK", "America/New_York", "US", [40.6413, -73.7781]], b: ["HND", "Asia/Tokyo", "JP", [35.5494, 139.7798]], dep: "2026-10-16T11:30", arr: "2026-10-17T14:30" },
	{ from: "kix1", to: "icn1", number: "KE 722", a: ["KIX", "Asia/Tokyo", "JP", [34.432, 135.2304]], b: ["ICN", "Asia/Seoul", "KR", [37.4602, 126.4407]], dep: "2026-10-26T10:40", arr: "2026-10-26T12:45" },
	{ from: "pus1", to: "tpe1", number: "BR 169", a: ["PUS", "Asia/Seoul", "KR", [35.1795, 128.9382]], b: ["TPE", "Asia/Taipei", "TW", [25.0797, 121.2342]], dep: "2026-11-01T13:20", arr: "2026-11-01T15:05" },
	{ from: "tpe2", to: "han1", number: "CI 791", a: ["TPE", "Asia/Taipei", "TW", [25.0797, 121.2342]], b: ["HAN", "Asia/Ho_Chi_Minh", "VN", [21.2187, 105.8042]], dep: "2026-11-04T08:10", arr: "2026-11-04T10:15" },
	{ from: "sgn2", to: "jfk2", number: "VN 98", a: ["SGN", "Asia/Ho_Chi_Minh", "VN", [10.8188, 106.6519]], b: ["JFK", "America/New_York", "US", [40.6413, -73.7781]], dep: "2026-11-12T15:30", arr: "2026-11-12T20:30" },
];

/** Trains between cities (the rest the app estimates). */
// biome-ignore format: a table
export const GROUND = [
	{ from: "tokyoSt1", to: "kyotoSt1", mode: "transit", min: 135 },
	{ from: "seoulSt1", to: "busanSt1", mode: "transit", min: 163 },
	{ from: "hanoiSt1", to: "danangSt1", mode: "transit", min: 990 },
	{ from: "danangSt2", to: "saigonSt1", mode: "transit", min: 1000 },
] as const;

/** Public domain (CC0) photos from `seed/media`: [node key, file, caption]. */
// biome-ignore format: a table
export const PHOTOS: [node: string, file: string, caption: string][] = [
	["sensoji", "place--tokyo--senso-ji-temple.jpg", "Senso-ji"],
	["meijiJingu", "place--tokyo--meiji-jingu.jpg", "Meiji Jingu"],
	["tokichi", "city--uji--nakamura-tokichi-matcha.jpg", "Matcha in Uji"],
	["naraPark", "place--nara--nara-park.jpg", "The deer of Nara"],
	["dotonbori", "place--osaka--dotonbori.jpg", "Dotonbori at night"],
	["gwangalli", "place--busan--gwangalli-beach.jpg", "Gwangalli Beach"],
	["goldenBridge", "place--da-nang--golden-bridge.jpg", "Golden Bridge"],
	["postOffice", "place--ho-chi-minh-city--saigon-central-post-office.jpg", "Saigon Central Post Office"],
];
