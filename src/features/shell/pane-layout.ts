/**
 * The desktop pane sizes, remembered as the centre's width in pixels. The
 * panel library stores percentages of the group, which drift when the
 * Outline hides or shows (the group changes width), so bringing the map back
 * would find the centre at another size. `groupWidth()` is the group's width
 * now; older percentage layouts are read as they are.
 */
import type { LayoutStorage } from "react-resizable-panels";

const round = (n: number) => Math.round(n * 1000) / 1000;

function parse(raw: string | null): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const v: unknown = JSON.parse(raw);
		return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function pixelLayoutStorage(
	base: Pick<Storage, "getItem" | "setItem"> | undefined,
	groupWidth: () => number,
): LayoutStorage {
	return {
		getItem(key) {
			let raw: string | null = null;
			try {
				raw = base?.getItem(key) ?? null;
			} catch {
				return null;
			}
			const saved = parse(raw);
			const w = groupWidth();
			if (typeof saved?.centerPx !== "number") return raw;
			if (w <= 0) return null;
			const center = round(Math.min(100, (saved.centerPx / w) * 100));
			return JSON.stringify({ center, map: round(100 - center) });
		},
		setItem(key, value) {
			const center = parse(value)?.center;
			const w = groupWidth();
			if (typeof center !== "number" || w <= 0) return;
			try {
				base?.setItem(
					key,
					JSON.stringify({ centerPx: Math.round((center / 100) * w) }),
				);
			} catch {
				// storage unavailable: the sizes just aren't remembered
			}
		},
	};
}
