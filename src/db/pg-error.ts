/** A Postgres error's SQLSTATE; drizzle wraps it in a DrizzleQueryError with the pg error on `cause`. */
export function pgErrorCode(e: unknown): string | undefined {
	const err = e as { cause?: { code?: unknown }; code?: unknown } | null;
	const code = err?.cause?.code ?? err?.code;
	return typeof code === "string" ? code : undefined;
}
