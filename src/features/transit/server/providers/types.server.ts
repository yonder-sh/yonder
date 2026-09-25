/**
 * The transit provider chain (SPEC §14.2, ADDENDUM §5): Google outside Japan,
 * the offline `estimate` provider (MLIT N02) in Japan, NAVITIME kept as an
 * empty stub (Q1 = no). Every provider returns `TransitRoute`s, fastest first.
 */
import type { TransitRoute } from "@/lib/schemas/legs";

export type ProviderId = "google" | "navitime" | "estimate";

export type Place = {
	lat: number;
	lng: number;
	name?: string;
	placeId?: string;
	/** ISO 3166 alpha-2, when known. */
	country?: string | null;
};

export type ProviderContext = {
	/** Countries of the two endpoints (unknown ones are omitted). */
	countries: string[];
	from: Place;
	to: Place;
	/** The origin's IANA zone (proxy dates keep its wall time). */
	tz: string;
	/** "Refresh routes": skip cached answers (a new answer is cached again). */
	fresh?: boolean;
};

export type ProviderResult = {
	routes: TransitRoute[];
	/** Times come from a proxy date (Google, §14.2.2). */
	scheduleEstimate?: boolean;
	/** Human caveats for the whole result ("A bus is probably faster"). */
	notes?: string[];
	/** Shown under the options (N02 attribution for `estimate`). */
	attribution?: string;
};

export interface TransitProvider {
	id: ProviderId;
	supports(ctx: ProviderContext): boolean | Promise<boolean>;
	fetch(
		from: Place,
		to: Place,
		departAt: Date,
		ctx: ProviderContext,
	): Promise<ProviderResult>;
}

/** A provider answered but couldn't help (HTTP 429/5xx, bad data). */
export class ProviderError extends Error {
	constructor(
		readonly kind: "rate-limited" | "unavailable" | "no-route",
		message: string,
	) {
		super(message);
		this.name = "ProviderError";
	}
}
