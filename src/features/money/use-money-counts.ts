/**
 * `useMoneyCounts()` (EXTENSIONS §1.3): expense counts per mark key
 * (`item:<id>`, `day:<id>`, `leg:<id>`, `node:<id>`, `trip`) for the Plan
 * card's `Wallet` bundle icon. `{}` for guests (they never reach money).
 * Private expenses count only for their creator (the server already hides
 * other people's).
 */
import { useMemo } from "react";
import type { MarkKey } from "@/lib/engine/proposals";
import { useMoneyData } from "./use-money";

const NONE: Record<MarkKey, number> = {} as Record<MarkKey, number>;

export function useMoneyCounts(): Record<MarkKey, number> {
	const { data, guest } = useMoneyData();
	return useMemo(() => {
		if (guest || !data) return NONE;
		const out: Partial<Record<MarkKey, number>> = {};
		for (const e of data.expenses) {
			const t = e.target;
			const key: MarkKey =
				t.kind === "trip"
					? "trip"
					: t.kind === "node"
						? `node:${t.nodeId}`
						: t.kind === "leg"
							? `leg:${t.legId}`
							: t.kind === "item"
								? `item:${t.itemId}`
								: `day:${t.dayId}`;
			out[key] = (out[key] ?? 0) + 1;
		}
		return out as Record<MarkKey, number>;
	}, [data, guest]);
}
