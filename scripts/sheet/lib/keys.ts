/** Fractional-indexing keys for a fresh scope, without the server's DB helpers (pure). */
import { generateNKeysBetween } from "fractional-indexing";

export function freshKeysPure(n: number): string[] {
	return n > 0 ? generateNKeysBetween(null, null, n) : [];
}
