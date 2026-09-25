/**
 * Primitive zod schemas shared by every input and JSONB shape (SPEC §6.5).
 * zod 4 only: `z.url()`, `z.uuid()`, `z.looseObject()`; never the deprecated
 * `z.string().url()`, `.uuid()` or `.passthrough()`.
 */
import { z } from "zod";

function isValidTimeZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat("en", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

/** An IANA zone the runtime's ICU knows (e.g. `Asia/Tokyo`). Validate every zone that enters the system. */
export const Tz = z
	.string()
	.min(1)
	.refine(isValidTimeZone, "invalid time zone");

/** A wall-clock date-time with no zone: `2027-10-03T09:30`. */
export const LocalDT = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "expected YYYY-MM-DDTHH:mm");

/** A local clock time `HH:mm`, 00:00–23:59. The DB CHECKs use the same pattern (`HHMM_PATTERN`). */
export const HHmm = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:mm");

/** A calendar date `YYYY-MM-DD` (Postgres `date`, mode string). */
export const IsoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** http(s) only: never `javascript:`, `data:` and friends. */
export const HttpUrl = z.url({ protocol: /^https?$/ });

/** App-table ids are UUID v7 strings. */
export const Id = z.uuid();

/** Better Auth ids (`user.id`, `session.id`) are opaque text, not UUIDs. */
export const UserId = z.string().min(1).max(255);
