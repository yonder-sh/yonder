/**
 * docs/OVERVIEW.md §2 route strip: every stay as a bar sized by its nights,
 * coloured by country, with how you got there (plane, train, bus/car) in
 * between. A scrubber: hover (or drag a finger along it) turns the globe to
 * a stay; a click or tap opens that stay's days in the Plan
 * (`tab=plan&days=first..last`).
 */
import { cn } from "cn";
import { BusFront, Plane, TrainFront } from "lucide-react";
import type { PointerEvent } from "react";
import type { EdgeMode } from "@/lib/engine/types";
import { formatDayDate } from "@/lib/format";
import { serializeDays } from "@/lib/workspace/search";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import type { RouteStay, TripRoute } from "./lib/trip-route";
import { OVERVIEW_TESTID } from "./testids";

export function ModeIcon({
	mode,
	className,
}: {
	mode: EdgeMode;
	className?: string;
}) {
	// No mode chosen yet: a quiet dot, not a guess.
	if (mode === "unset")
		return (
			<span
				role="img"
				aria-label="Transport not chosen yet"
				className={cn(
					"flex size-3.5 shrink-0 items-center justify-center opacity-60",
					className,
				)}
			>
				<span className="size-1 rounded-full bg-current" />
			</span>
		);
	const Icon =
		mode === "flight" ? Plane : mode === "transit" ? TrainFront : BusFront;
	const label =
		mode === "flight" ? "By air" : mode === "transit" ? "By train" : "By road";
	return (
		<Icon
			role="img"
			aria-label={label}
			strokeWidth={1.75}
			className={cn("size-3.5 shrink-0 opacity-60", className)}
		/>
	);
}

const nightsText = (n: number) => `${n} ${n === 1 ? "night" : "nights"}`;
/** Night trains count toward the stay they reach (the route model's rule). */
const nightsOf = (s: RouteStay) => s.nights + s.transitNights;

export function RouteStrip({
	route,
	compact,
	focus,
	onFocus,
	hereStay,
	firstDate,
	lastDate,
}: {
	route: TripRoute;
	/** Phone: slim bars, no text inside. */
	compact: boolean;
	focus: number | null;
	onFocus: (stay: number | null) => void;
	/** During the trip: the stay you're in (earlier ones are dimmer). */
	hereStay: number | null;
	firstDate: string | null;
	lastDate: string | null;
}) {
	const { nav } = useWorkspace();
	if (!route.stays.length) return null;
	const open = (s: RouteStay) =>
		nav.setDays({ from: s.firstDate, to: s.lastDate });
	// Touch: drag along the strip to scrub (a tap still clicks).
	const scrub = (e: PointerEvent) => {
		if (e.pointerType === "mouse") return;
		const el = document
			.elementFromPoint(e.clientX, e.clientY)
			?.closest<HTMLElement>("[data-stay]");
		const i = el ? Number(el.dataset.stay) : Number.NaN;
		if (Number.isFinite(i) && i !== focus) onFocus(i);
	};
	const endHome = route.endsHome ? "home" : route.end ? route.end.name : null;
	const start = route.start?.name;
	const last = route.stays.at(-1);
	return (
		<div
			data-testid={OVERVIEW_TESTID.strip}
			data-cursor-anchor="sec:ov.route"
			className="flex flex-col gap-2"
		>
			{compact ? null : (
				<div className="flex items-baseline justify-between gap-4 text-xs text-white/55">
					<span className="truncate">
						{[firstDate ? formatDayDate(firstDate) : null, start]
							.filter(Boolean)
							.join(" · ")}
					</span>
					<span className="hidden truncate text-center md:inline">
						Every stay, sized by nights · hover to fly the globe there
					</span>
					<span className="truncate text-right">
						{[lastDate ? formatDayDate(lastDate) : null, endHome]
							.filter(Boolean)
							.join(" · ")}
					</span>
				</div>
			)}
			<ul
				aria-label="Stays"
				className={cn(
					"flex w-full items-center touch-pan-y",
					compact ? "gap-0.5" : "gap-1.5",
				)}
				onPointerMove={scrub}
				onPointerDown={scrub}
				onPointerLeave={() => onFocus(null)}
				onPointerCancel={() => onFocus(null)}
			>
				{route.stays.map((s, i) => {
					const past = hereStay !== null && i < hereStay;
					const now = hereStay === i;
					const n = nightsOf(s);
					const days = serializeDays({ from: s.firstDate, to: s.lastDate });
					// A phone fits the whole trip: only flights get an icon there.
					const icon = !compact || s.modeIn === "flight";
					return (
						<li
							key={`${s.id}-${s.firstDate}`}
							className="flex items-center"
							style={{
								flex: `${Math.max(1, n)} 1 0`,
								// Never narrower than its icon and a bar (they'd overlap).
								minWidth: compact ? (icon ? 24 : 10) : 60,
							}}
						>
							{icon ? (
								<ModeIcon
									mode={s.modeIn}
									className={cn(
										"text-white",
										compact ? "mr-0.5 size-3" : "mr-1.5",
										s.modeIn === "flight" && "rotate-45",
									)}
								/>
							) : null}
							<button
								type="button"
								data-testid={OVERVIEW_TESTID.stay}
								data-stay={i}
								data-days={days}
								aria-label={`${s.name} · ${nightsText(n)} · ${formatDayDate(s.firstDate)}. Open these days in the plan`}
								title={`${s.name} · ${nightsText(n)}`}
								onMouseEnter={() => onFocus(i)}
								onFocus={() => onFocus(i)}
								onBlur={() => onFocus(null)}
								onClick={() => open(s)}
								className={cn(
									"relative min-w-0 flex-1 cursor-pointer overflow-hidden text-left transition-[filter,opacity,box-shadow] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-white",
									compact ? "h-[30px] rounded-md" : "h-11 rounded-[9px]",
									past && "opacity-45",
									(now || focus === i) &&
										"shadow-[0_0_0_2px_#fff] brightness-110",
								)}
								style={{ background: s.color }}
							>
								{compact ? null : (
									<>
										<span className="absolute top-[5px] right-1.5 left-2 truncate text-xs font-semibold text-[#0b0b0b]">
											{s.name}
										</span>
										<span className="absolute bottom-[5px] left-2 truncate font-mono text-[10px] text-[#0b0b0b]/80">
											{nightsText(n)}
										</span>
									</>
								)}
							</button>
						</li>
					);
				})}
				{route.modeOut !== "unset" || route.end ? (
					<li className="flex shrink-0 items-center">
						<ModeIcon
							mode={route.modeOut}
							className={cn(
								"text-white",
								compact ? "ml-1 size-3" : "ml-1.5",
								route.modeOut === "flight" && "rotate-45",
							)}
						/>
					</li>
				) : null}
			</ul>
			{compact ? (
				<div className="flex justify-between gap-2 text-[11px] text-white/55">
					<span className="truncate">{route.stays[0]?.name}</span>
					{hereStay !== null ? <span>you are here</span> : null}
					<span className="truncate">
						{route.stays.length > 1 ? last?.name : null}
					</span>
				</div>
			) : null}
		</div>
	);
}
