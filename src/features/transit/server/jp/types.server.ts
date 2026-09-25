import type { LngLat } from "./geo.server";

// ── N02 input ────────────────────────────────────────────────────────────────
// MLIT 国土数値情報 鉄道データ (N02). Attribute names from the dataset page:
//   N02_001 鉄道区分 (railway type), N02_002 事業者種別 (operator type),
//   N02_003 路線名 (line), N02_004 運営会社 (operator),
//   station only: N02_005 駅名, N02_005c 駅コード, N02_005g グループコード
//   (stations with the same name within 300 m share a group code).
// https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html
export interface N02Props {
	N02_001: string;
	N02_002: string;
	N02_003: string;
	N02_004: string;
	N02_005?: string;
	N02_005c?: string;
	N02_005g?: string;
}

export interface N02Feature {
	type: "Feature";
	properties: N02Props;
	geometry:
		| { type: "LineString"; coordinates: LngLat[] }
		| { type: "MultiLineString"; coordinates: LngLat[][] };
}

export interface N02Collection {
	type: "FeatureCollection";
	features: N02Feature[];
}

// ── Serialized graph (data/graph.json) ───────────────────────────────────────
export interface LineRecord {
	/** N02_003 */
	name: string;
	/** N02_004 */
	operator: string;
	/** dominant N02_001 by length */
	railType: string;
	/** N02_002 */
	operatorType: string;
}

export interface NodeRecord {
	/** line index */
	l: number;
	lat: number;
	lng: number;
	/** station name (absent for junction nodes) */
	n?: string;
	/** N02_005c */
	c?: string;
	/** N02_005g */
	g?: string;
}

export interface EdgeRecord {
	a: number;
	b: number;
	/** metres along the track */
	m: number;
	/** simplified geometry as flat [lng, lat, lng, lat, …] from a to b */
	geom?: number[];
}

export interface GraphData {
	format: "yonder-n02-graph@1";
	source: {
		dataset: string;
		url: string;
		license: string;
		attribution: string;
		builtAt: string;
	};
	stats: Record<string, number>;
	lines: LineRecord[];
	nodes: NodeRecord[];
	edges: EdgeRecord[];
}
