/**
 * ADDENDUM §8 free-text people: a name typed into any people picker becomes
 * a placeholder member (no account; claimable later, ADDENDUM §10).
 * Isomorphic (used by `addPlaceholder`'s validator and the pickers).
 */
import { z } from "zod";

export const PLACEHOLDER_NAME_MAX = 80;

/** Trimmed, inner whitespace collapsed, 1–80 characters. */
export const PlaceholderName = z
	.string()
	.trim()
	.min(1)
	.max(PLACEHOLDER_NAME_MAX)
	.transform((s) => s.replace(/\s+/g, " "));

export function normalizePersonName(name: string): string {
	return name.trim().replace(/\s+/g, " ");
}
