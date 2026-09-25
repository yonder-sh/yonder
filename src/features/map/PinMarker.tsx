/**
 * One HTML pin (DESIGN §9.2): the shape per level, the number or glyph, the
 * "2×" revisit badge, the label, and its states (hover, selected ring, peer
 * halo, dimmed, E7 proposal ring + avatar). A `<button>` with an accessible
 * name, so pins work from the keyboard (DESIGN §13). Clicks never reach the map
 * (its background click clears the selection).
 */
import { Marker } from "@vis.gl/react-maplibre";
import { cn } from "cn";
import { BedDouble } from "lucide-react";
import { type CSSProperties, type MouseEvent, memo } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { useAttachDrop } from "@/features/media/use-attach-drop";
import { PLACE_CATEGORIES, pinStyle } from "@/lib/domain/taxonomy";
import { flagEmoji } from "@/lib/format";
import type { PlaceCategory } from "@/lib/schemas/enums";
import { TESTID } from "@/lib/testids";
import type { SplitStop } from "@/lib/workspace/ui-store";
import type { PinView } from "./map-data";
import { MARKER_Z, pinZIndex } from "./marker-z";
import { MAP_TESTID } from "./testids";

export type LabelSide = "right" | "left" | "above" | "below";

export type PinMarkerProps = {
	pin: PinView;
	selected: boolean;
	hovered: boolean;
	/** The next stop on a current trip day (DESIGN §9.2: an 8px glow halo). */
	next?: boolean;
	/** A peer has it selected: their presence colour (CSS). */
	peerColor: string | null;
	label: LabelSide | null;
	/** Spiderfied: pixel offset from the cluster centre. */
	offset?: [number, number];
	onSelect(repId: string): void;
	onZoomIn(repId: string): void;
	onHover(repId: string | null): void;
};

function stop(e: MouseEvent) {
	e.stopPropagation();
}

function PinFace({ pin }: { pin: PinView }) {
	const s = pin.size;
	if (pin.shape === "country") {
		return (
			<span
				className="yonder-pin-face yonder-pin-country"
				style={{ width: s, height: s }}
			>
				<span aria-hidden className="text-[14px] leading-none">
					{flagEmoji(pin.countryCode) || "•"}
				</span>
			</span>
		);
	}
	if (pin.shape === "stay") {
		return (
			<span
				className="yonder-pin-face yonder-pin-place"
				style={{
					width: s,
					height: s,
					background: "var(--fam-lodging)",
					color: "#fff",
				}}
			>
				<BedDouble
					aria-hidden
					strokeWidth={2.25}
					style={{ width: s * 0.55, height: s * 0.55 }}
				/>
			</span>
		);
	}
	if (pin.shape === "place") {
		// An unknown category (old data, an import) draws as "other", never throws.
		const cat = (
			pin.category && pin.category in PLACE_CATEGORIES ? pin.category : "other"
		) as PlaceCategory;
		const st = pinStyle({ type: "place", category: cat });
		const Icon = PLACE_CATEGORIES[cat]?.icon ?? PLACE_CATEGORIES.other.icon;
		return (
			<span
				className="yonder-pin-face yonder-pin-place"
				style={
					pin.hollow
						? { width: s, height: s, color: "var(--muted-foreground)" }
						: { width: s, height: s, background: st.fill, color: st.ink }
				}
			>
				<Icon
					aria-hidden
					strokeWidth={2.25}
					style={{ width: s * 0.55, height: s * 0.55 }}
				/>
			</span>
		);
	}
	const num = pin.hollow ? null : pin.number;
	return (
		<span
			className={cn("yonder-pin-face", `yonder-pin-${pin.shape}`)}
			style={{ width: s, height: s }}
		>
			{num != null ? <span className="yonder-pin-num">{num}</span> : null}
		</span>
	);
}

export const PinMarker = memo(function PinMarker({
	pin,
	selected,
	hovered,
	next,
	peerColor,
	label,
	offset,
	onSelect,
	onZoomIn,
	onHover,
}: PinMarkerProps) {
	const badge = pin.shape === "place" && !pin.hollow && pin.number != null;
	// Drop files on a pin to attach them to that place (DESIGN §9.2, WP-Media).
	const guard = useEditGuard("edit-only", "Photos need edit access");
	const drop = useAttachDrop(
		pin.dropped ? null : { kind: "node", nodeId: pin.repId },
		{
			label: `Attach to ${pin.name}`,
			disabled: guard.disabled || pin.dropped,
		},
	);
	const style = {
		"--pin-size": `${pin.size}px`,
		"--peer": peerColor ?? undefined,
		"--proposal": pin.proposal?.color ?? undefined,
		opacity: pin.opacity,
	} as CSSProperties;
	return (
		<Marker
			longitude={pin.lng}
			latitude={pin.lat}
			anchor="center"
			offset={offset}
			style={{ zIndex: pinZIndex(pin, selected, hovered) }}
		>
			<div
				className={cn(
					"yonder-pin",
					pin.hollow && "is-hollow",
					pin.dropped && "is-dropped",
					(pin.repMode === "coarser" || pin.approx) && "is-coarse",
					selected && "is-selected",
					hovered && "is-hovered",
					next && "is-next",
					peerColor && "has-peer",
					pin.proposal && "is-proposed",
					pin.proposal?.deleted && "is-proposed-delete",
					pin.filteredOut && "is-filtered",
					drop.isOver && "is-drop",
				)}
				style={style}
				data-shape={pin.shape}
				{...drop.rootProps}
			>
				{drop.isOver ? (
					<span className="yonder-pin-drop-tip" role="status">
						Attach to {pin.name}
					</span>
				) : null}
				<button
					type="button"
					data-testid={TESTID.pin}
					data-rep-id={pin.repId}
					data-hollow={pin.hollow || undefined}
					aria-label={pin.ariaLabel}
					aria-pressed={selected}
					className="yonder-pin-btn"
					onClick={(e) => {
						stop(e);
						onSelect(pin.repId);
					}}
					onDoubleClick={(e) => {
						stop(e);
						onZoomIn(pin.repId);
					}}
					onMouseDown={stop}
					onPointerEnter={() => onHover(pin.repId)}
					onPointerLeave={() => onHover(null)}
					onFocus={() => onHover(pin.repId)}
					onBlur={() => onHover(null)}
				>
					<span className="yonder-pin-body">
						<PinFace pin={pin} />
						{badge ? (
							<span className="yonder-pin-badge">{pin.number}</span>
						) : null}
						{pin.visits > 1 ? (
							<span
								className="yonder-pin-revisit"
								data-testid={MAP_TESTID.revisit}
							>
								{pin.visits}×
							</span>
						) : null}
						{pin.proposal ? (
							// A 14px author avatar (EXTENSIONS §1.4): one initial fits a pin.
							<span
								className="yonder-pin-author"
								aria-hidden
								title={pin.proposal.name}
							>
								{Array.from(pin.proposal.name.trim())[0]?.toUpperCase() ?? "?"}
							</span>
						) : null}
						{label ? (
							<span
								className={cn("yonder-pin-label", `is-${label}`)}
								aria-hidden
							>
								{pin.name}
							</span>
						) : null}
					</span>
				</button>
			</div>
		</Marker>
	);
});

export function ClusterMarker({
	lng,
	lat,
	count,
	proposalColor = null,
	onClick,
}: {
	lng: number;
	lat: number;
	count: number;
	/** E7: a pin inside carries a suggestion: the lead author's colour. */
	proposalColor?: string | null;
	onClick(): void;
}) {
	return (
		<Marker
			longitude={lng}
			latitude={lat}
			anchor="center"
			style={{ zIndex: MARKER_Z.cluster }}
		>
			<button
				type="button"
				data-testid={MAP_TESTID.cluster}
				data-count={count}
				aria-label={`Cluster of ${count} places${proposalColor ? ", with a suggested change" : ""}`}
				className={cn("yonder-cluster", proposalColor && "is-proposed")}
				style={
					proposalColor
						? ({ "--proposal": proposalColor } as CSSProperties)
						: undefined
				}
				onClick={(e) => {
					e.stopPropagation();
					onClick();
				}}
				onDoubleClick={stop}
				onMouseDown={stop}
			>
				{count}
			</button>
		</Marker>
	);
}

/** Hairline legs from a spiderfied cluster's centre to each pin. */
export function SpiderLegs({
	lng,
	lat,
	offsets,
}: {
	lng: number;
	lat: number;
	offsets: [number, number][];
}) {
	const r = Math.max(...offsets.map(([x, y]) => Math.hypot(x, y)), 1) + 4;
	return (
		<Marker
			longitude={lng}
			latitude={lat}
			anchor="center"
			style={{ zIndex: MARKER_Z.spider, pointerEvents: "none" }}
		>
			<svg
				width={r * 2}
				height={r * 2}
				viewBox={`${-r} ${-r} ${r * 2} ${r * 2}`}
				aria-hidden
				className="yonder-spider"
			>
				{offsets.map(([x, y]) => (
					<line key={`${x},${y}`} x1={0} y1={0} x2={x} y2={y} />
				))}
				<circle r={3} cx={0} cy={0} />
			</svg>
		</Marker>
	);
}

export function EdgeChipMarker({
	lng,
	lat,
	kind,
	count,
	onClick,
}: {
	lng: number;
	lat: number;
	kind: "count" | "stay";
	count: number;
	onClick(): void;
}) {
	return (
		<Marker
			longitude={lng}
			latitude={lat}
			anchor="center"
			style={{ zIndex: MARKER_Z.edgeChip }}
		>
			<button
				type="button"
				className={cn("yonder-edge-chip", kind === "stay" && "is-stay")}
				data-testid={MAP_TESTID.edgeChip}
				aria-label={kind === "stay" ? "Stay" : `${count} trips`}
				onClick={(e) => {
					e.stopPropagation();
					onClick();
				}}
				onMouseDown={stop}
			>
				{kind === "stay" ? (
					<BedDouble aria-hidden strokeWidth={1.75} className="size-3" />
				) : (
					count
				)}
			</button>
		</Marker>
	);
}

/** A city's stop(s) on the route while the days per city change: "1 · 4d" over it. */
export function SplitStopMarker({ stops }: { stops: readonly SplitStop[] }) {
	const s = stops[0];
	if (!s) return null;
	return (
		<Marker
			longitude={s.lng}
			latitude={s.lat}
			anchor="bottom"
			offset={[0, -18]}
			style={{ zIndex: MARKER_Z.splitStop }}
		>
			<div
				role="img"
				data-testid={MAP_TESTID.splitStop}
				data-city={s.cityId}
				data-stop={stops.map((x) => x.stop).join(",")}
				aria-label={stops
					.map(
						(x) =>
							`${x.stop}. ${x.name}, ${x.days} ${x.days === 1 ? "day" : "days"}`,
					)
					.join("; ")}
				className="yonder-split-stop"
			>
				{stops.map((x) => (
					<span key={x.stop}>
						<b>{x.stop}</b>
						{x.days}d
					</span>
				))}
			</div>
		</Marker>
	);
}
