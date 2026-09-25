/**
 * Small visual atoms (SPEC §12.6, DESIGN §2.3–§2.4): node-type and category
 * glyphs, family dots, travel-mode glyphs, line chips and flags. All icons use
 * `strokeWidth 1.5` and are decorative unless given a label.
 */
import { cn } from "cn";
import {
	BedDouble,
	Car,
	Footprints,
	type LucideIcon,
	Moon,
	Plane,
	Ship,
	TrainFront,
	TramFront,
} from "lucide-react";
import type { CSSProperties } from "react";
import {
	nodeIcon,
	PIN_FAMILIES,
	PLACE_CATEGORIES,
	pinStyle,
} from "@/lib/domain/taxonomy";
import { flagEmoji } from "@/lib/format";
import type { LegMode, NodeType, PlaceCategory } from "@/lib/schemas/enums";

type GlyphProps = { className?: string; label?: string };

function a11y(label: string | undefined) {
	return label
		? { role: "img" as const, "aria-label": label }
		: { "aria-hidden": true as const };
}

/** The node's glyph: its category icon for places (tinted by family), else its type icon (muted). */
export function TypeGlyph({
	type,
	category,
	className,
	label,
	tinted = true,
}: GlyphProps & {
	type: NodeType;
	category?: PlaceCategory | null;
	/** Places tint the glyph in the family colour (default). */
	tinted?: boolean;
}) {
	const Icon = nodeIcon({ type, category });
	const style: CSSProperties | undefined =
		tinted && type === "place"
			? { color: pinStyle({ type, category }).fill }
			: undefined;
	return (
		<Icon
			strokeWidth={1.5}
			className={cn(
				"size-3.5 shrink-0",
				!style && "text-muted-foreground",
				className,
			)}
			style={style}
			{...a11y(label)}
		/>
	);
}

/** A place category's icon, in the current text colour. */
export function CategoryIcon({
	category,
	className,
	label,
}: GlyphProps & { category: PlaceCategory }) {
	const Icon = PLACE_CATEGORIES[category].icon;
	return (
		<Icon
			strokeWidth={1.5}
			className={cn("size-3.5 shrink-0", className)}
			{...a11y(label)}
		/>
	);
}

/** A 6px dot in the category's family colour (with a ground ring on dark surfaces). */
export function CategoryDot({
	category,
	className,
}: {
	category: PlaceCategory;
	className?: string;
}) {
	const fam = PIN_FAMILIES[PLACE_CATEGORIES[category].family];
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-block size-1.5 shrink-0 rounded-full dark:ring-1 dark:ring-background",
				className,
			)}
			style={{ backgroundColor: fam.hex }}
		/>
	);
}

const MODE_ICON: Record<
	LegMode | "stay" | "overnight" | "rail" | "ferry",
	LucideIcon
> = {
	walk: Footprints,
	transit: TramFront,
	rail: TrainFront,
	flight: Plane,
	other: Car,
	ferry: Ship,
	stay: BedDouble,
	overnight: Moon,
};

const MODE_COLOR: Partial<Record<keyof typeof MODE_ICON, string>> = {
	walk: "text-mode-walk",
	transit: "text-mode-transit",
	rail: "text-mode-transit",
	flight: "text-mode-flight",
	other: "text-mode-other",
	ferry: "text-mode-other",
	stay: "text-mode-other",
};

/** Travel-mode glyph in its mode colour (colour is never the only carrier: the glyph is). */
export function ModeGlyph({
	mode,
	className,
	label,
	colored = true,
}: GlyphProps & {
	mode: keyof typeof MODE_ICON | null;
	colored?: boolean;
}) {
	const Icon = mode ? MODE_ICON[mode] : Footprints;
	return (
		<Icon
			strokeWidth={1.5}
			className={cn(
				"size-3.5 shrink-0",
				mode && colored ? MODE_COLOR[mode] : "text-muted-foreground",
				!mode && "opacity-60",
				className,
			)}
			{...a11y(label)}
		/>
	);
}

/** A transit line chip ("Ginza Ln") in the line's own colours. */
export function LineChip({
	name,
	color,
	textColor,
	className,
}: {
	name: string;
	color?: string | null;
	textColor?: string | null;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 text-[11px] leading-none font-medium whitespace-nowrap",
				!color && "bg-muted text-foreground",
				className,
			)}
			style={
				color
					? { backgroundColor: color, color: textColor ?? "#fff" }
					: undefined
			}
		>
			{name}
		</span>
	);
}

/** A country flag (emoji), with the country code as its accessible name. */
export function FlagEmoji({
	code,
	className,
}: {
	code: string | null | undefined;
	className?: string;
}) {
	const flag = flagEmoji(code);
	if (!flag) return null;
	return (
		<span
			role="img"
			aria-label={code ?? undefined}
			className={cn("leading-none", className)}
		>
			{flag}
		</span>
	);
}

export { Kbd, KbdGroup } from "@/components/ui/kbd";
