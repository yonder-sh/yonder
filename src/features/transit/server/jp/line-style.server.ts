/**
 * Line chips for estimate routes (DESIGN §7.1 "Line chips"): a short name and,
 * for lines whose colour is part of how people find them (Tokyo, Osaka and
 * Kyoto subways, the busiest JR and private lines), the operator's colour.
 * N02 has neither; everything else gets the neutral chip.
 * Keys are `${operator}|${line}` as in N02 (`lineKey`).
 */

const LINE_COLORS: Record<string, string> = {
	// JR East
	"東日本旅客鉄道|山手線": "#9ACD32",
	"東日本旅客鉄道|中央線": "#F15A22",
	"東日本旅客鉄道|総武線": "#FFD400",
	// Shinkansen
	"東海旅客鉄道|東海道新幹線": "#0072BC",
	"西日本旅客鉄道|山陽新幹線": "#0072BC",
	// Tokyo Metro
	"東京地下鉄|3号線銀座線": "#FF9500",
	"東京地下鉄|4号線丸ノ内線": "#F62E36",
	"東京地下鉄|2号線日比谷線": "#B5B5AC",
	"東京地下鉄|5号線東西線": "#009BBF",
	"東京地下鉄|9号線千代田線": "#00BB85",
	"東京地下鉄|8号線有楽町線": "#C1A470",
	"東京地下鉄|11号線半蔵門線": "#8F76D6",
	"東京地下鉄|7号線南北線": "#00AC9B",
	"東京地下鉄|13号線副都心線": "#9C5E31",
	// Toei
	"東京都|1号線浅草線": "#E85298",
	"東京都|6号線三田線": "#0079C2",
	"東京都|10号線新宿線": "#6CBB5A",
	"東京都|12号線大江戸線": "#B6007A",
	// Private (Tokyo)
	"京浜急行電鉄|本線": "#E5171F",
	"京浜急行電鉄|空港線": "#E5171F",
	"京王電鉄|京王線": "#DD0077",
	"小田急電鉄|小田原線": "#0D6FB8",
	// Osaka Metro
	"大阪市高速電気軌道|1号線(御堂筋線)": "#E5171F",
	"大阪市高速電気軌道|2号線(谷町線)": "#522886",
	"大阪市高速電気軌道|3号線(四つ橋線)": "#0078BA",
	"大阪市高速電気軌道|4号線(中央線)": "#019A66",
	"大阪市高速電気軌道|5号線(千日前線)": "#E44D93",
	"大阪市高速電気軌道|6号線(堺筋線)": "#814721",
	"大阪市高速電気軌道|7号線(長堀鶴見緑地線)": "#A9CC51",
	"大阪市高速電気軌道|8号線(今里筋線)": "#EE7B1A",
	// Kyoto
	"京都市|烏丸線": "#00AB84",
	"京都市|東西線": "#EF7D00",
};

/** Relative luminance (sRGB), for picking ink or white text on a chip. */
function luminance(hex: string): number {
	const c = [1, 3, 5].map((i) => {
		const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
}

/** The chip colours for a line, or null (neutral chip). */
export function lineColor(key: string): { bg: string; fg: string } | null {
	const bg = LINE_COLORS[key];
	if (!bg) return null;
	return { bg, fg: luminance(bg) > 0.4 ? "#181D2F" : "#FFFFFF" };
}

const PREFIXES = [
	"Tokyo Metro ",
	"Toei ",
	"Osaka Metro ",
	"Kyoto Subway ",
	"Nagoya Subway ",
];

/**
 * "Tokyo Metro Ginza Line" → "Ginza", "JR Chuo Line (Central)" → "JR Chuo",
 * "Tokaido Shinkansen" stays; Japanese-only names drop the "3号線" prefix.
 */
export function shortLineName(en: string | undefined, ja: string): string {
	if (en) {
		let s = en.replace(/\s*\(.*\)$/, "");
		for (const p of PREFIXES) if (s.startsWith(p)) s = s.slice(p.length);
		s = s.replace(/ Line$/, "").replace(/ Railway$/, "");
		return s || en;
	}
	return ja.replace(/^\d+号線/, "").replace(/^\((.*)\)$/, "$1") || ja;
}
