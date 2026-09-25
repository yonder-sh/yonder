/**
 * Ids (SPEC §6.1): app rows use UUID v7, generated in the app so raw SQL and
 * optimistic client rows can know an id before the insert.
 */
import { v7 } from "uuid";

export const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A new UUID v7 (time-ordered). */
export function newId(): string {
	return v7();
}

export function isId(v: unknown): v is string {
	return typeof v === "string" && UUID_RE.test(v);
}
