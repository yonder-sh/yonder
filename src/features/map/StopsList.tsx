/**
 * The map's text alternative (QA A11Y-03, DESIGN §13): an ordered "Stops"
 * list with the pins and the legs between them, inside the map region.
 * Visually hidden until it takes keyboard focus, then it shows as a card over
 * the map; a stop selects its pin and a leg its edge (the inspector opens),
 * and focusing either lights it on the map.
 */
import "./stops.css";
import { cn } from "cn";
import { useMemo } from "react";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { buildStops } from "./stops";
import { MAP_TESTID } from "./testids";

export function StopsList({ variant }: { variant: "desktop" | "mobile" }) {
	const { model, ix, schedule, nav } = useWorkspace();
	const setHover = useUi((s) => s.setHover);
	const stops = useMemo(
		() => buildStops(model, ix, schedule),
		[model, ix, schedule],
	);
	if (stops.length === 0) return null;
	const legs = stops.filter((s) => s.next).length;
	return (
		<div
			className={cn("yonder-stops", variant === "mobile" && "is-mobile")}
			data-testid={MAP_TESTID.stops}
		>
			<p className="yonder-stops-title">
				{stops.length} {stops.length === 1 ? "stop" : "stops"}
				{legs ? `, ${legs} ${legs === 1 ? "leg" : "legs"}` : ""}, in order
			</p>
			<ol aria-label="Stops">
				{stops.map((s) => (
					<li key={s.key}>
						<button
							type="button"
							className="yonder-stops-stop"
							onClick={() => nav.select({ kind: "node", id: s.repId })}
							onFocus={() => setHover({ kind: "rep", id: s.repId })}
							onBlur={() => setHover(null)}
						>
							{s.label}
						</button>
						{s.next ? (
							<button
								type="button"
								className="yonder-stops-leg"
								onClick={() => s.next && nav.select(s.next.sel)}
								onFocus={() =>
									s.next && setHover({ kind: "pair", id: s.next.pairKey })
								}
								onBlur={() => setHover(null)}
							>
								{s.next.label}
							</button>
						) : null}
					</li>
				))}
			</ol>
		</div>
	);
}
