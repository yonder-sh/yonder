/**
 * The rail estimate lists "walk the whole way" when the straight line takes
 * at most 30 minutes on foot (JAPAN_TRANSIT §3). The line can be wrong: Oishi
 * Park → Lake Kawaguchiko is 28 minutes across the water, 78 minutes and
 * 5.9 km round the shore (QA MT-06c). A walk-only option the real walk
 * contradicts (`walkFarPastEstimate`) is dropped, so it can never be saved as
 * a 28-minute "transit" leg. The real walk comes from the walk chain (Google
 * or OSRM, cached), asked only when a walk-only option is listed.
 */
import type { TransitRoute } from "@/lib/schemas/legs";
import { isWalkOnly } from "./chain.server";
import type { ProviderContext } from "./providers/types.server";
import {
	straightLineM,
	type WalkResult,
	walkFarPastEstimate,
} from "./walk.server";

export async function dropContradictedWalks(
	routes: TransitRoute[],
	ctx: Pick<ProviderContext, "from" | "to">,
	realWalk: () => Promise<WalkResult | null>,
): Promise<TransitRoute[]> {
	if (!routes.some(isWalkOnly)) return routes;
	const walk = await realWalk().catch(() => null);
	if (!walk) return routes;
	const straightM = straightLineM(ctx.from, ctx.to);
	return routes.filter(
		(r) =>
			!isWalkOnly(r) ||
			!walkFarPastEstimate(walk, {
				minutes: r.durationMin,
				hiMin: r.range?.hi,
				straightM,
			}),
	);
}
