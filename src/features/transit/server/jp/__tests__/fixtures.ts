// Tiny synthetic N02-shaped data for unit tests.
import type { LngLat } from "../geo.server";
import type { N02Collection, N02Feature } from "../types.server";

export function sec(
	op: string,
	line: string,
	coords: LngLat[],
	railType = "12",
	opType = "4",
): N02Feature {
	return {
		type: "Feature",
		properties: {
			N02_001: railType,
			N02_002: opType,
			N02_003: line,
			N02_004: op,
		},
		geometry: { type: "LineString", coordinates: coords },
	};
}

export function sta(
	op: string,
	line: string,
	name: string,
	code: string,
	coords: LngLat[],
	group = code,
	railType = "12",
	opType = "4",
): N02Feature {
	return {
		type: "Feature",
		properties: {
			N02_001: railType,
			N02_002: opType,
			N02_003: line,
			N02_004: op,
			N02_005: name,
			N02_005c: code,
			N02_005g: group,
		},
		geometry: { type: "LineString", coordinates: coords },
	};
}

export const fc = (features: N02Feature[]): N02Collection => ({
	type: "FeatureCollection",
	features,
});

/** A straight east-west line along lat 35.0 with stations every `spacingKm`, like N02 does it:
 *  station segments (also emitted as sections) + inter-station sections sharing endpoints. */
export function straightLine(o: {
	op: string;
	line: string;
	names: string[];
	lng0: number;
	lat?: number;
	spacingKm: number;
	codePrefix: string;
	railType?: string;
	opType?: string;
	groups?: Record<string, string>;
}): { sections: N02Feature[]; stations: N02Feature[] } {
	const lat = o.lat ?? 35;
	const dLng = o.spacingKm / (111.32 * Math.cos((lat * Math.PI) / 180));
	const half = 0.1 / (111.32 * Math.cos((lat * Math.PI) / 180)); // 100 m platforms
	const sections: N02Feature[] = [];
	const stations: N02Feature[] = [];
	o.names.forEach((name, i) => {
		const x = o.lng0 + i * dLng;
		const a: LngLat = [x - half, lat];
		const b: LngLat = [x + half, lat];
		const code = `${o.codePrefix}${String(i).padStart(3, "0")}`;
		stations.push(
			sta(
				o.op,
				o.line,
				name,
				code,
				[a, b],
				o.groups?.[name] ?? code,
				o.railType,
				o.opType,
			),
		);
		sections.push(sec(o.op, o.line, [a, b], o.railType, o.opType));
		if (i < o.names.length - 1) {
			const nx = o.lng0 + (i + 1) * dLng;
			sections.push(
				sec(
					o.op,
					o.line,
					[b, [(x + nx) / 2, lat + 0.001], [nx - half, lat]],
					o.railType,
					o.opType,
				),
			);
		}
	});
	return { sections, stations };
}
