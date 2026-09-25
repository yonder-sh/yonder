/**
 * WP-Places' editable days-per-city table (`DaysPerCityTable`, ADDENDUM §10),
 * mounted in the trip overview's "Still to plan" panel. Integration turned
 * the round-2 build-time lookup into a plain import; the panel keeps its
 * read-only fallback for a null table.
 */
import type { ComponentType } from "react";
import { DaysPerCityTable } from "@/features/places/DaysPerCityTable";

export type DaysPerCityTableProps = {
	/** A country or region; null/omitted = the whole trip with the unallocated total. */
	scopeId?: string | null;
	compact?: boolean;
	className?: string;
};

export const PlacesDaysTable: ComponentType<DaysPerCityTableProps> | null =
	DaysPerCityTable;
