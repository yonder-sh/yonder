/**
 * Walk (DESIGN §8.2): a large mono "12m" plus "0.9 km", the source line
 * ("est. · OSRM"), "Set time", and after an override the "edited" dot with
 * "Reset to 12m". "Recalculate" runs the walk chain (edit-only: providers).
 * "Open in Google Maps" opens walking directions (FB-03).
 */
import { RotateCcw } from "lucide-react";
import { EditGuard } from "@/components/common/edit-guard";
import { DurationInput } from "@/components/common/time";
import { Button } from "@/components/ui/button";
import { formatDistance, formatDuration } from "@/lib/format";
import { TRANSIT_TESTID } from "../testids";
import type { LegEditor } from "../use-leg-editor";
import { GoogleMapsLink } from "./bits";

const SOURCE: Record<string, string> = {
	osrm: "est. · OSRM",
	google: "Google",
	estimate: "est.",
	manual: "Set by hand",
	navitime: "NAVITIME",
};

export function WalkPanel({ ed }: { ed: LegEditor }) {
	const { leg, sched } = ed;
	const minutes =
		leg?.mode === "walk"
			? (leg.durationMin ?? leg.estimateMin ?? sched?.minutes ?? 0)
			: ((sched?.suggestion?.mode === "walk"
					? sched.suggestion.estimateMin
					: null) ??
				sched?.minutes ??
				0);
	const edited = !!leg?.isEdited && leg.mode === "walk";
	const estimate = leg?.estimateMin ?? null;
	const km = leg?.distanceM ?? null;
	return (
		<div data-testid={TRANSIT_TESTID.walkPanel} className="grid gap-3">
			<div className="flex items-end gap-3">
				<span
					data-testid={TRANSIT_TESTID.walkMinutes}
					className="font-mono text-[22px] leading-7 font-semibold tnum"
				>
					{formatDuration(minutes, { compact: true })}
				</span>
				{km ? (
					<span className="pb-0.5 font-mono text-[13px] text-muted-foreground tnum">
						{formatDistance(km)}
					</span>
				) : null}
				{edited ? (
					<span
						className="mb-2 size-1.5 rounded-full bg-primary"
						title="Edited"
						role="img"
						aria-label="Edited"
					/>
				) : null}
			</div>
			<p
				data-testid={TRANSIT_TESTID.walkSource}
				className="-mt-2 text-xs text-muted-foreground"
			>
				{leg?.mode === "walk"
					? edited
						? `Set by hand${estimate ? ` · estimate ${formatDuration(estimate, { compact: true })}` : ""}`
						: (SOURCE[leg.source] ?? "est.")
					: "est. — not saved yet"}
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs text-muted-foreground">Set time</span>
				<EditGuard>
					<DurationInput
						value={minutes}
						onChange={(m) =>
							ed.patch.mutate({
								patch: {
									mode: "walk",
									durationMin: m,
									isEdited: true,
									...(leg?.mode === "walk" ? {} : { estimateMin: minutes }),
								},
							})
						}
					/>
				</EditGuard>
				{edited && estimate !== null ? (
					<EditGuard>
						<Button
							variant="ghost"
							size="sm"
							className="h-7 gap-1 px-2 text-xs"
							data-testid={TRANSIT_TESTID.walkReset}
							onClick={() => ed.reset.mutate()}
						>
							<RotateCcw className="size-3.5" />
							Reset to {formatDuration(estimate, { compact: true })}
						</Button>
					</EditGuard>
				) : null}
				{ed.live && !edited ? (
					<EditGuard kind="edit-only" reason="Suggesters can't fetch routes">
						<Button
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-xs"
							disabled={ed.walk.isPending}
							onClick={() => ed.walk.mutate()}
						>
							{ed.walk.isPending ? "Measuring…" : "Recalculate"}
						</Button>
					</EditGuard>
				) : null}
				<GoogleMapsLink ends={ed.ends} mode="walking" className="ml-auto" />
			</div>
		</div>
	);
}
