/**
 * One transit option (DESIGN §8.2): times (or the likely range of an
 * estimate) · minutes · transfers · walk · fare, then the 8px segment strip
 * and the line chips. "Fastest" (outline chip) on the fastest; the chosen one
 * has the primary ring. Hover previews it on the map. Every Japan option
 * carries "Open in Google Maps" (ADDENDUM §5; walking directions for "walk
 * the whole way", FB-03). Google options offer "Lock these times"; manual
 * ones Edit/Delete.
 */
import { cn } from "cn";
import type { Feature, LineString as GeoLine } from "geojson";
import { Lock, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { EditGuard } from "@/components/common/edit-guard";
import { LineChip } from "@/components/common/glyphs";
import { useDisplayPrefs } from "@/components/common/time";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDuration } from "@/lib/format";
import type { TransitRoute } from "@/lib/schemas/legs";
import { useUi } from "@/lib/workspace/ui-store";
import type { MapsTravelMode } from "../lib/endpoints";
import {
	formatMoney,
	isWalkOnlyRoute,
	rangeText,
	rides,
	routeTimes,
	segmentName,
} from "../lib/route-view";
import { TRANSIT_TESTID } from "../testids";
import { GoogleMapsLink, SegmentStrip } from "./bits";

const SOURCE_LABEL: Record<TransitRoute["source"], string> = {
	google: "Google",
	navitime: "NAVITIME",
	manual: "Custom",
	estimate: "Estimate",
};

export function RouteOptionCard({
	route,
	chosen,
	fastest,
	fromTz,
	toTz,
	mapsUrl,
	mapsMode = "transit",
	disabled,
	onChoose,
	onEdit,
	onDelete,
	onLock,
}: {
	route: TransitRoute;
	chosen: boolean;
	fastest: boolean;
	fromTz: string;
	toTz: string;
	/** Japan: the "Open in Google Maps" link for this leg. */
	mapsUrl?: string | null;
	/** The link's travel mode (walking for a walk-only option). */
	mapsMode?: MapsTravelMode;
	disabled?: boolean;
	onChoose: () => void;
	onEdit?: () => void;
	onDelete?: () => void;
	onLock?: () => void;
}) {
	const setPreview = useUi((s) => s.setPreviewRoute);
	useDisplayPrefs(); // re-render on a 12/24 h switch
	const times = routeTimes(route, fromTz, toTz);
	const range = route.source === "estimate" ? rangeText(route) : null;
	const chips = rides(route).slice(0, 4);
	const preview = () => {
		if (!route.geometry) return;
		const color = chips[0]?.color;
		const f: Feature<GeoLine, { color?: string }> = {
			type: "Feature",
			geometry: route.geometry as GeoLine,
			properties: color ? { color } : {},
		};
		setPreview([f]);
	};
	const meta = [
		route.transfers
			? `${route.transfers} transfer${route.transfers > 1 ? "s" : ""}`
			: rides(route).length
				? "direct"
				: null,
		route.walkMin && rides(route).length
			? `${formatDuration(route.walkMin, { compact: true })} walk`
			: null,
		route.fare ? formatMoney(route.fare.amount, route.fare.currency) : null,
	].filter(Boolean);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: hover previews only; the choose button is inside.
		<div
			data-testid={TRANSIT_TESTID.transitOption}
			data-source={route.source}
			data-chosen={chosen || undefined}
			data-fastest={fastest || undefined}
			data-walk-only={isWalkOnlyRoute(route) || undefined}
			onMouseEnter={preview}
			onMouseLeave={() => setPreview(null)}
			onFocus={preview}
			onBlur={() => setPreview(null)}
			className={cn(
				"group relative grid gap-2 rounded-lg border bg-card px-3 py-2.5 transition-[border-color,box-shadow] duration-150",
				chosen
					? "border-transparent outline-2 outline-primary"
					: "hover:border-foreground/20",
			)}
		>
			<button
				type="button"
				data-testid={TRANSIT_TESTID.transitOptionChoose}
				aria-pressed={chosen}
				aria-label={`${chosen ? "Chosen: " : "Choose "}${route.label ?? meta.join(", ")}`}
				disabled={disabled || chosen}
				onClick={onChoose}
				className="absolute inset-0 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default"
			/>
			<div className="pointer-events-none relative flex min-w-0 items-baseline gap-2">
				<span className="font-mono text-sm font-semibold tnum">
					{times ?? formatDuration(route.durationMin)}
				</span>
				<span className="min-w-0 truncate font-mono text-xs text-muted-foreground tnum">
					{times
						? formatDuration(route.durationMin)
						: range
							? `likely ${range}`
							: null}
				</span>
				{fastest ? (
					<span
						data-testid={TRANSIT_TESTID.fastestBadge}
						className="ml-auto inline-flex h-5 shrink-0 items-center rounded-full border border-foreground/25 px-1.5 text-[11px] font-medium text-foreground"
					>
						Fastest
					</span>
				) : null}
			</div>
			<SegmentStrip
				route={route}
				dashed={route.source === "estimate"}
				className="pointer-events-none relative"
			/>
			{chips.length ? (
				<div className="pointer-events-none relative flex min-w-0 flex-wrap items-center gap-1">
					{chips.map((seg, i) => (
						<LineChip
							// biome-ignore lint/suspicious/noArrayIndexKey: segments have no id.
							key={i}
							name={segmentName(seg)}
							color={seg.color}
							textColor={seg.textColor}
						/>
					))}
				</div>
			) : null}
			<div className="relative flex min-w-0 items-center gap-1.5">
				<span className="pointer-events-none min-w-0 flex-1 truncate text-xs text-muted-foreground">
					{[
						route.source === "manual"
							? (route.label ??
								(route.segments.length ? null : "Duration only"))
							: !chips.length
								? "Walk"
								: null,
						...meta,
						SOURCE_LABEL[route.source],
					]
						.filter(Boolean)
						.join(" · ")}
				</span>
				{mapsUrl ? (
					<GoogleMapsLink
						href={mapsUrl}
						mode={mapsMode}
						compact
						className="relative"
					/>
				) : null}
				{route.source === "manual" && (onEdit || onDelete) ? (
					<span className="relative flex items-center">
						{onEdit ? (
							<EditGuard>
								<Button
									variant="ghost"
									size="icon"
									className="size-7"
									aria-label="Edit route"
									data-testid={TRANSIT_TESTID.transitOptionEdit}
									onClick={onEdit}
								>
									<Pencil className="size-3.5" />
								</Button>
							</EditGuard>
						) : null}
						{onDelete ? (
							<EditGuard>
								<Button
									variant="ghost"
									size="icon"
									className="size-7"
									aria-label="Delete route"
									data-testid={TRANSIT_TESTID.transitOptionDelete}
									onClick={onDelete}
								>
									<Trash2 className="size-3.5" />
								</Button>
							</EditGuard>
						) : null}
					</span>
				) : null}
				{route.source === "google" && onLock && route.departAt ? (
					<DropdownMenu>
						<EditGuard kind="edit-only" reason="Suggesters can't lock times">
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="relative size-7"
									aria-label="Route options"
								>
									<MoreHorizontal className="size-3.5" />
								</Button>
							</DropdownMenuTrigger>
						</EditGuard>
						<DropdownMenuContent align="end">
							<DropdownMenuItem
								data-testid={TRANSIT_TESTID.transitOptionLock}
								onSelect={onLock}
							>
								<Lock className="size-3.5" /> Lock these times
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
			</div>
		</div>
	);
}
