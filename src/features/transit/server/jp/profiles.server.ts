// Speed, wait and transfer model. Every number here is a tunable estimate, not a timetable.
// Tuned against the reference legs in src/benchmarks.ts (see scripts/accuracy.ts).
import { LINE_NAMES_EN } from "./line-names.server";
import type { LineRecord } from "./types.server";

export type RailClass =
	| "shinkansen"
	| "jr"
	| "private"
	| "subway"
	| "monorail"
	| "agt"
	| "maglev"
	| "tram"
	| "cable"
	| "trolleybus";

/** Mode names from SPEC §6 `SegmentMode`. */
export type SegmentMode =
	| "walk"
	| "bus"
	| "subway"
	| "train"
	| "rail"
	| "high_speed"
	| "tram"
	| "ferry"
	| "cable"
	| "other";

export const MODE_BY_CLASS: Record<RailClass, SegmentMode> = {
	shinkansen: "high_speed",
	jr: "train",
	private: "train",
	subway: "subway",
	monorail: "rail",
	agt: "rail",
	maglev: "rail",
	tram: "tram",
	cable: "cable",
	trolleybus: "bus",
};

/**
 * Effective speed (km/h, dwell included) as a piecewise-linear function of the length of the
 * *run* — the distance ridden without getting off (through-running included). Longer runs on
 * JR and private lines are usually made on rapid/express/limited-express trains, so they are
 * faster; this stands in for service tiers N02 does not have.
 */
export type Curve = readonly (readonly [km: number, kmh: number])[];

export interface Profile {
	curve: Curve;
	/**
	 * All-stops timing (subways, trams, AGT, Linimo…): minutes = km / cruiseKmh × 60 + stops × lossMin,
	 * counting every station passed. Replaces `curve` when set: station spacing, not run length,
	 * is what makes a Ginza Line hop slower than an Oedo Line hop.
	 */
	stops?: { cruiseKmh: number; lossMin: number };
	/**
	 * Skip-stop timing (experimental "hybrid" model for JR/private lines without a tuned curve):
	 * minutes = km / cruiseKmh × 60 + stations passed × lossMin × share(runKm), where share is the
	 * fraction of stations a typical train of that run length stops at (locals 1.0 → limited express ≈ 0.1).
	 */
	express?: { cruiseKmh: number; lossMin: number; share: Curve };
	/** Mean wait when boarding this line after a transfer (≈ half the headway), minutes. */
	boardWaitMin: number;
	/** Shinkansen: rides whose both ends are "fast" stations use fastKmh (Nozomi/Hayabusa-type trains). */
	fast?: { stations: readonly string[]; kmh: number };
	/** Track sections (both end stations listed) run at this speed whatever the service, e.g. Tokyo–Shin-Yokohama. */
	zones?: readonly { stations: readonly string[]; kmh: number }[];
	/** Riding through one of these stations means changing cars (e.g. Ikoma Cable at Hozanji): + min. */
	changeAt?: { stations: readonly string[]; min: number };
	/** English line name for the UI (N02 only has Japanese). */
	en?: string;
}

export const CLASS_PROFILES: Record<RailClass, Profile> = {
	shinkansen: { curve: [[0, 170]], boardWaitMin: 6 },
	jr: {
		curve: [
			[0, 34],
			[8, 36],
			[25, 50],
			[60, 72],
			[100, 80],
		],
		boardWaitMin: 5,
	},
	private: {
		curve: [
			[0, 32],
			[8, 38],
			[20, 48],
			[35, 60],
			[50, 66],
		],
		boardWaitMin: 5,
	},
	subway: {
		curve: [[0, 32]],
		stops: { cruiseKmh: 50, lossMin: 0.75 },
		boardWaitMin: 3,
	},
	monorail: {
		curve: [[0, 30]],
		stops: { cruiseKmh: 45, lossMin: 0.75 },
		boardWaitMin: 4,
	},
	agt: {
		curve: [[0, 28]],
		stops: { cruiseKmh: 42, lossMin: 0.75 },
		boardWaitMin: 4,
	},
	maglev: {
		curve: [[0, 28]],
		stops: { cruiseKmh: 45, lossMin: 0.75 },
		boardWaitMin: 4,
	},
	tram: {
		curve: [[0, 18]],
		stops: { cruiseKmh: 25, lossMin: 0.6 },
		boardWaitMin: 5,
	},
	cable: { curve: [[0, 9]], boardWaitMin: 8 },
	trolleybus: { curve: [[0, 20]], boardWaitMin: 10 },
};

/** Per-line overrides keyed `${operator}|${line}` (N02_004|N02_003). Partial; merged over the class profile. */
export const LINE_OVERRIDES: Record<string, Partial<Profile>> = {
	// ── Shinkansen ──
	"東海旅客鉄道|東海道新幹線": {
		en: "Tokaido Shinkansen",
		curve: [[0, 178]], // Hikari/Kodama stations (Mishima→Nagoya Hikari ≈ 75 min)
		fast: {
			stations: ["東京", "品川", "新横浜", "名古屋", "京都", "新大阪"],
			kmh: 229,
		}, // Nozomi
		zones: [{ stations: ["東京", "品川", "新横浜"], kmh: 96 }], // Tokyo→Shin-Yokohama ≈ 18 min for 29 km
	},
	"西日本旅客鉄道|山陽新幹線": {
		en: "Sanyo Shinkansen",
		curve: [[0, 170]],
		fast: {
			stations: ["新大阪", "新神戸", "岡山", "広島", "小倉", "博多"],
			kmh: 235,
		},
	},
	"東日本旅客鉄道|東北新幹線": {
		en: "Tohoku Shinkansen",
		curve: [[0, 180]],
		fast: {
			stations: ["東京", "上野", "大宮", "仙台", "盛岡", "新青森"],
			kmh: 230,
		},
	},
	"東日本旅客鉄道|北陸新幹線": { en: "Hokuriku Shinkansen", curve: [[0, 190]] },
	"西日本旅客鉄道|北陸新幹線": { en: "Hokuriku Shinkansen", curve: [[0, 190]] },
	"東日本旅客鉄道|上越新幹線": { en: "Joetsu Shinkansen", curve: [[0, 190]] },
	"九州旅客鉄道|九州新幹線": { en: "Kyushu Shinkansen", curve: [[0, 190]] },
	// ── JR conventional ──
	"東日本旅客鉄道|中央線": {
		en: "JR Chuo Line",
		curve: [
			[0, 34],
			[10, 40],
			[25, 50],
			[50, 65],
			[85, 74],
		],
	},
	"東日本旅客鉄道|山手線": {
		en: "JR Yamanote Line",
		curve: [[0, 33]],
		boardWaitMin: 3,
	},
	"東日本旅客鉄道|東海道線": { en: "JR Tokaido Line (Tokyo)" },
	"東日本旅客鉄道|東北線": { en: "JR Tohoku Line (Keihin-Tohoku/Utsunomiya)" },
	"東日本旅客鉄道|総武線": { en: "JR Sobu Line" },
	"西日本旅客鉄道|東海道線": {
		en: "JR Kyoto/Kobe Line",
		curve: [
			[0, 40],
			[8, 45],
			[20, 62],
			[40, 84],
		],
	},
	"西日本旅客鉄道|大阪環状線": {
		en: "JR Osaka Loop Line",
		// loop trains ≈ 31 km/h; Haruka / Kansai Airport Rapid running through on long runs are faster
		curve: [
			[0, 31],
			[15, 31],
			[40, 55],
		],
		boardWaitMin: 3,
	},
	"西日本旅客鉄道|奈良線": { en: "JR Nara Line" },
	"西日本旅客鉄道|関西線": { en: "JR Yamatoji (Kansai) Line" },
	"西日本旅客鉄道|山陰線": { en: "JR Sagano (San'in) Line" },
	"西日本旅客鉄道|阪和線": { en: "JR Hanwa Line" },
	"西日本旅客鉄道|関西空港線": { en: "JR Kansai Airport Line" },
	"東海旅客鉄道|東海道線": { en: "JR Tokaido Line (Central)" },
	"東海旅客鉄道|身延線": {
		en: "JR Minobu Line",
		curve: [[0, 40]],
		boardWaitMin: 20,
	}, // rural: long runs are not fast
	"東海旅客鉄道|中央線": { en: "JR Chuo Line (Central)" },
	// ── Private ──
	// local ≈ 29 km/h; Fuji Excursion / Fujisan View Express running through from the Chuo Line ≈ 33
	"富士山麓電気鉄道|大月線": {
		en: "Fujikyu Railway (Otsuki Line)",
		curve: [
			[0, 29],
			[30, 29],
			[80, 33],
		],
		boardWaitMin: 12,
	},
	"富士山麓電気鉄道|河口湖線": {
		en: "Fujikyu Railway (Kawaguchiko Line)",
		curve: [
			[0, 29],
			[30, 29],
			[80, 33],
		],
		boardWaitMin: 12,
	},
	"京浜急行電鉄|本線": {
		en: "Keikyu Main Line",
		curve: [
			[0, 34],
			[6, 45],
			[12, 62],
			[30, 66],
		],
	},
	"京浜急行電鉄|空港線": {
		en: "Keikyu Airport Line",
		curve: [
			[0, 30],
			[6, 45],
			[12, 62],
		],
	},
	"東京モノレール|東京モノレール羽田空港線": {
		en: "Tokyo Monorail",
		stops: undefined, // rapid services: run-length curve instead
		curve: [
			[0, 36],
			[10, 44],
			[17, 50],
		],
	},
	"京王電鉄|京王線": { en: "Keio Line" },
	"京王電鉄|井の頭線": { en: "Keio Inokashira Line" },
	"小田急電鉄|小田原線": { en: "Odakyu Odawara Line" },
	"南海電気鉄道|南海本線": { en: "Nankai Main Line" },
	"南海電気鉄道|空港線": { en: "Nankai Airport Line" },
	"近畿日本鉄道|奈良線": {
		en: "Kintetsu Nara Line",
		curve: [
			[0, 32],
			[6, 36],
			[15, 50],
			[35, 53],
		],
	},
	"近畿日本鉄道|難波線": { en: "Kintetsu Namba Line" },
	"近畿日本鉄道|大阪線": { en: "Kintetsu Osaka Line" },
	"近畿日本鉄道|京都線": { en: "Kintetsu Kyoto Line" },
	"近畿日本鉄道|橿原線": { en: "Kintetsu Kashihara Line" },
	"近畿日本鉄道|生駒鋼索線": {
		en: "Ikoma Cable Line",
		changeAt: { stations: ["宝山寺"], min: 8 },
	},
	"京阪電気鉄道|京阪本線": { en: "Keihan Main Line" },
	"京阪電気鉄道|鴨東線": { en: "Keihan Oto Line" },
	"京阪電気鉄道|宇治線": { en: "Keihan Uji Line" },
	"阪急電鉄|京都線": { en: "Hankyu Kyoto Line" },
	"阪急電鉄|嵐山線": { en: "Hankyu Arashiyama Line" },
	"阪急電鉄|宝塚線": { en: "Hankyu Takarazuka Line" },
	"阪急電鉄|箕面線": {
		en: "Hankyu Minoo Line",
		stops: { cruiseKmh: 55, lossMin: 0.75 },
	},
	"阪急電鉄|神戸線": { en: "Hankyu Kobe Line" },
	// closely spaced stops with short dwells: Shijo-Omiya→Arashiyama 7.2 km ≈ 22 min
	"京福電気鉄道|嵐山本線": {
		en: "Randen Arashiyama Line",
		stops: { cruiseKmh: 24, lossMin: 0.35 },
		boardWaitMin: 5,
	},
	"京福電気鉄道|北野線": {
		en: "Randen Kitano Line",
		stops: { cruiseKmh: 24, lossMin: 0.35 },
		boardWaitMin: 6,
	},
	"愛知高速交通|東部丘陵線": { en: "Linimo", boardWaitMin: 4 },
	// ── Subways ──
	"東京地下鉄|3号線銀座線": { en: "Tokyo Metro Ginza Line" },
	"東京地下鉄|4号線丸ノ内線": { en: "Tokyo Metro Marunouchi Line" },
	"東京地下鉄|2号線日比谷線": { en: "Tokyo Metro Hibiya Line" },
	"東京地下鉄|5号線東西線": { en: "Tokyo Metro Tozai Line" },
	"東京地下鉄|9号線千代田線": { en: "Tokyo Metro Chiyoda Line" },
	"東京地下鉄|8号線有楽町線": { en: "Tokyo Metro Yurakucho Line" },
	"東京地下鉄|11号線半蔵門線": { en: "Tokyo Metro Hanzomon Line" },
	"東京地下鉄|7号線南北線": { en: "Tokyo Metro Namboku Line" },
	"東京地下鉄|13号線副都心線": { en: "Tokyo Metro Fukutoshin Line" },
	"東京都|1号線浅草線": { en: "Toei Asakusa Line" },
	"東京都|6号線三田線": { en: "Toei Mita Line" },
	"東京都|10号線新宿線": { en: "Toei Shinjuku Line" },
	"東京都|12号線大江戸線": { en: "Toei Oedo Line" },
	"名古屋市|1号線東山線": { en: "Nagoya Subway Higashiyama Line" },
	"名古屋市|2号線名城線": { en: "Nagoya Subway Meijo Line" },
	"名古屋市|4号線名城線": { en: "Nagoya Subway Meijo Line" },
	"名古屋市|3号線鶴舞線": { en: "Nagoya Subway Tsurumai Line" },
	"名古屋市|6号線桜通線": { en: "Nagoya Subway Sakura-dori Line" },
	"京都市|烏丸線": { en: "Kyoto Subway Karasuma Line" },
	"京都市|東西線": { en: "Kyoto Subway Tozai Line" },
	"大阪市高速電気軌道|1号線(御堂筋線)": {
		en: "Osaka Metro Midosuji Line",
		curve: [[0, 33]],
	},
	"大阪市高速電気軌道|2号線(谷町線)": { en: "Osaka Metro Tanimachi Line" },
	"大阪市高速電気軌道|3号線(四つ橋線)": { en: "Osaka Metro Yotsubashi Line" },
	"大阪市高速電気軌道|4号線(中央線)": { en: "Osaka Metro Chuo Line" },
	"大阪市高速電気軌道|5号線(千日前線)": { en: "Osaka Metro Sennichimae Line" },
	"大阪市高速電気軌道|6号線(堺筋線)": { en: "Osaka Metro Sakaisuji Line" },
	"大阪市高速電気軌道|7号線(長堀鶴見緑地線)": {
		en: "Osaka Metro Nagahori Tsurumi-ryokuchi Line",
	},
	"大阪市高速電気軌道|8号線(今里筋線)": { en: "Osaka Metro Imazatosuji Line" },
};

/**
 * Through services: riding from line a to line b at station `at` without changing trains.
 * `costMin` is the extra dwell (0 = seamless). Order-insensitive. Keys `${operator}|${line}`.
 * Anything not listed is a transfer, except the generic "terminal continuation" rule in graph.ts.
 */
export const THROUGH_RUNNING: readonly {
	a: string;
	b: string;
	at: string;
	costMin: number;
}[] = [
	// Tokyo
	{
		a: "京浜急行電鉄|空港線",
		b: "京浜急行電鉄|本線",
		at: "京急蒲田",
		costMin: 0,
	},
	{ a: "京浜急行電鉄|本線", b: "東京都|1号線浅草線", at: "泉岳寺", costMin: 0 },
	{ a: "東京都|1号線浅草線", b: "京成電鉄|押上線", at: "押上", costMin: 0 },
	{
		a: "東日本旅客鉄道|山手線",
		b: "東日本旅客鉄道|東海道線",
		at: "品川",
		costMin: 0,
	},
	{
		a: "東日本旅客鉄道|山手線",
		b: "東日本旅客鉄道|東北線",
		at: "田端",
		costMin: 0,
	},
	{
		a: "東日本旅客鉄道|東北線",
		b: "東日本旅客鉄道|東海道線",
		at: "東京",
		costMin: 0,
	},
	{
		a: "東日本旅客鉄道|中央線",
		b: "東日本旅客鉄道|総武線",
		at: "御茶ノ水",
		costMin: 0,
	},
	{
		a: "東日本旅客鉄道|中央線",
		b: "東日本旅客鉄道|東北線",
		at: "神田",
		costMin: 0,
	}, // Chuo Rapid: Tokyo–Kanda is officially the Tohoku Line
	{
		a: "小田急電鉄|小田原線",
		b: "東京地下鉄|9号線千代田線",
		at: "代々木上原",
		costMin: 0,
	},
	// Fuji Excursion / Fujikyu
	{
		a: "東日本旅客鉄道|中央線",
		b: "富士山麓電気鉄道|大月線",
		at: "大月",
		costMin: 2,
	},
	{
		a: "富士山麓電気鉄道|大月線",
		b: "富士山麓電気鉄道|河口湖線",
		at: "富士山",
		costMin: 3,
	}, // switchback
	// Kansai
	{
		a: "南海電気鉄道|南海本線",
		b: "南海電気鉄道|空港線",
		at: "泉佐野",
		costMin: 0,
	},
	{
		a: "西日本旅客鉄道|阪和線",
		b: "西日本旅客鉄道|関西空港線",
		at: "日根野",
		costMin: 0,
	},
	{
		a: "西日本旅客鉄道|大阪環状線",
		b: "西日本旅客鉄道|阪和線",
		at: "天王寺",
		costMin: 0,
	},
	{
		a: "西日本旅客鉄道|東海道線",
		b: "西日本旅客鉄道|山陽線",
		at: "神戸",
		costMin: 0,
	},
	{
		a: "西日本旅客鉄道|東海道線",
		b: "西日本旅客鉄道|大阪環状線",
		at: "福島",
		costMin: 0,
	}, // Haruka via Osaka (Umekita) branch
	{
		a: "西日本旅客鉄道|奈良線",
		b: "西日本旅客鉄道|関西線",
		at: "木津",
		costMin: 0,
	}, // Miyakoji Rapid Kyoto→Nara
	{ a: "阪急電鉄|京都線", b: "阪急電鉄|神戸線", at: "十三", costMin: 0 }, // N02 assigns Juso–Umeda tracks to the Kobe/Takarazuka lines
	{ a: "阪急電鉄|京都線", b: "阪急電鉄|宝塚線", at: "十三", costMin: 0 },
	{
		a: "近畿日本鉄道|難波線",
		b: "近畿日本鉄道|大阪線",
		at: "大阪上本町",
		costMin: 0,
	},
	{
		a: "近畿日本鉄道|大阪線",
		b: "近畿日本鉄道|奈良線",
		at: "布施",
		costMin: 0,
	},
	{
		a: "近畿日本鉄道|難波線",
		b: "阪神電気鉄道|阪神なんば線",
		at: "大阪難波",
		costMin: 0,
	},
	{
		a: "近畿日本鉄道|京都線",
		b: "近畿日本鉄道|橿原線",
		at: "大和西大寺",
		costMin: 0,
	},
	{ a: "近畿日本鉄道|京都線", b: "京都市|烏丸線", at: "竹田", costMin: 0 },
	{ a: "京都市|東西線", b: "京阪電気鉄道|京津線", at: "御陵", costMin: 0 },
	{
		a: "京阪電気鉄道|京阪本線",
		b: "京阪電気鉄道|鴨東線",
		at: "三条",
		costMin: 0,
	},
	{
		a: "京阪電気鉄道|京阪本線",
		b: "京阪電気鉄道|中之島線",
		at: "天満橋",
		costMin: 0,
	},
	{
		a: "大阪市高速電気軌道|1号線(御堂筋線)",
		b: "北大阪急行電鉄|南北線",
		at: "江坂",
		costMin: 0,
	},
	{
		a: "大阪市高速電気軌道|4号線(中央線)",
		b: "近畿日本鉄道|けいはんな線",
		at: "長田",
		costMin: 0,
	},
	{
		a: "阪急電鉄|神戸線",
		b: "阪急電鉄|神戸高速線",
		at: "神戸三宮",
		costMin: 0,
	},
	// Shinkansen and JR company boundaries
	{
		a: "東海旅客鉄道|東海道新幹線",
		b: "西日本旅客鉄道|山陽新幹線",
		at: "新大阪",
		costMin: 0,
	},
	{
		a: "東日本旅客鉄道|東海道線",
		b: "東海旅客鉄道|東海道線",
		at: "熱海",
		costMin: 3,
	},
	{
		a: "東海旅客鉄道|東海道線",
		b: "西日本旅客鉄道|東海道線",
		at: "米原",
		costMin: 3,
	},
	{
		a: "東日本旅客鉄道|中央線",
		b: "東海旅客鉄道|中央線",
		at: "塩尻",
		costMin: 3,
	},
];

export const TRANSFER = {
	/** Max straight-line distance between two platforms for a walking transfer, metres. */
	nearM: 500,
	/** Fixed penalty (stairs, gates, finding the platform) within one operator family, minutes. */
	sameFamilyMin: 2,
	/** Fixed penalty between different operators (fare gates), minutes. */
	otherOperatorMin: 4,
	/** Same station, same operator, one line ends there: the train often continues (flagged "likely"). */
	terminalContinuationMin: 3,
	/** …only when the two platforms are this close (metres). */
	continuationMaxM: 80,
} as const;

export const WALK = { kmh: 4.5, detour: 1.3 } as const;

/** Routing (not reporting) evaluates curves at this run length. */
export const ROUTING_RUN_KM = 20;

// Operators whose rail lines are subways (N02 codes them as 普通鉄道 12, 軌道 21 or 案内軌条 16).
const SUBWAY_OPERATORS = new Set([
	"東京地下鉄",
	"東京都",
	"大阪市高速電気軌道",
	"名古屋市",
	"京都市",
	"横浜市",
	"札幌市",
	"仙台市",
	"神戸市",
	"福岡市",
	"北大阪急行電鉄",
]);
const NOT_SUBWAY = new Set([
	"荒川線",
	"日暮里・舎人ライナー",
	"南港ポートタウン線",
]);

/** N02_001 鉄道区分 / N02_002 事業者種別 → class. */
export function classify(l: LineRecord): RailClass {
	if (l.operatorType === "1") return "shinkansen";
	if (
		SUBWAY_OPERATORS.has(l.operator) &&
		!NOT_SUBWAY.has(l.name) &&
		["12", "16", "21"].includes(l.railType)
	)
		return "subway";
	switch (l.railType) {
		case "11":
			return "jr";
		case "12":
			return "private";
		case "13":
			return "cable";
		case "14":
		case "15":
		case "22":
		case "23":
			return "monorail";
		case "16":
		case "24":
			return "agt";
		case "25":
			return "maglev";
		case "17":
			return "trolleybus";
		case "21":
			return "tram";
		default:
			return "private";
	}
}

export const lineKey = (l: Pick<LineRecord, "operator" | "name">) =>
	`${l.operator}|${l.name}`;

export type TimingModel = "curve" | "hybrid";

const STOP_SHARE: Curve = [
	[0, 1],
	[5, 1],
	[15, 0.6],
	[30, 0.35],
	[60, 0.2],
	[100, 0.12],
];
export const EXPRESS_DEFAULTS: Record<
	"jr" | "private",
	NonNullable<Profile["express"]>
> = {
	jr: { cruiseKmh: 85, lossMin: 1.0, share: STOP_SHARE },
	private: { cruiseKmh: 75, lossMin: 0.9, share: STOP_SHARE },
};

/**
 * Resolve a line's profile. timing "curve" (default): run-length speed curves everywhere.
 * "hybrid": JR/private lines whose override does not pin a curve use the skip-stop model instead.
 */
export function profileFor(
	l: LineRecord,
	timing: TimingModel = "curve",
): Profile & { cls: RailClass } {
	const cls = classify(l);
	const o = LINE_OVERRIDES[lineKey(l)];
	const p: Profile & { cls: RailClass } = { ...CLASS_PROFILES[cls], ...o, cls };
	// English names for the lines without a tuned override (QA MT-06).
	const en = p.en ?? LINE_NAMES_EN[lineKey(l)];
	if (en) p.en = en;
	if (
		timing === "hybrid" &&
		(cls === "jr" || cls === "private") &&
		!o?.curve &&
		!o?.stops
	)
		p.express = EXPRESS_DEFAULTS[cls];
	return p;
}

/** JR group companies count as one family for transfer penalties. */
export function operatorFamily(op: string): string {
	return op.endsWith("旅客鉄道") ? "JR" : op;
}

export function curveAt(c: Curve, km: number): number {
	const first = c[0] as readonly [number, number];
	if (c.length === 1 || km <= first[0]) return first[1];
	for (let i = 1; i < c.length; i++) {
		const [x1, y1] = c[i] as readonly [number, number];
		if (km <= x1) {
			const [x0, y0] = c[i - 1] as readonly [number, number];
			return y0 + ((km - x0) / (x1 - x0)) * (y1 - y0);
		}
	}
	return (c[c.length - 1] as readonly [number, number])[1];
}

/** Is the track section a–b inside one of the profile's slow/fast zones? Returns that zone's km/h. */
export function zoneKmh(
	p: Profile,
	a?: string,
	b?: string,
): number | undefined {
	if (!p.zones || !a || !b) return undefined;
	for (const z of p.zones)
		if (z.stations.includes(a) && z.stations.includes(b)) return z.kmh;
	return undefined;
}

/** Effective km/h for one leg of a run. */
export function legSpeedKmh(
	p: Profile,
	runKm: number,
	fromName?: string,
	toName?: string,
): number {
	if (
		p.fast &&
		fromName &&
		toName &&
		p.fast.stations.includes(fromName) &&
		p.fast.stations.includes(toName)
	)
		return p.fast.kmh;
	return curveAt(p.curve, runKm);
}

export function walkMinutes(m: number, walkKmh: number = WALK.kmh): number {
	return (m * WALK.detour) / ((walkKmh * 1000) / 60);
}
