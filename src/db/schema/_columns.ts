/**
 * Column builders shared by every app table (SPEC §6.1, §6.3).
 * Column names come from the TS keys through `casing: 'snake_case'`.
 */
import { sql } from "drizzle-orm";
import { customType, timestamp, uuid } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

/**
 * Fractional-indexing sort key. `COLLATE "C"` makes Postgres compare bytes, which
 * is the order `fractional-indexing` generates keys in. Order by `(position, id)`.
 */
export const sortKey = customType<{ data: string }>({
	dataType: () => 'text COLLATE "C"',
});

/** Yjs state (`Y.encodeStateAsUpdate`). `pg` returns bytea as a Buffer. */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
	dataType: () => "bytea",
	toDriver: (value) => Buffer.from(value),
	fromDriver: (value) =>
		new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
});

/** App ids are UUID v7, generated in the app, so raw SQL inserts must supply them. */
export const pk = () =>
	uuid()
		.primaryKey()
		.$defaultFn(() => uuidv7());

export const createdAt = () =>
	timestamp({ withTimezone: true }).notNull().defaultNow();

/** `$onUpdate` only fires for Drizzle `update()` calls; raw SQL must set it itself. */
export const updatedAt = () =>
	timestamp({ withTimezone: true })
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date());

/** Soft delete: only trips, nodes, items, attachments and list_items have it. */
export const deletedAt = () => timestamp({ withTimezone: true });

/** `HH:mm`, 00:00–23:59, as a SQL literal for CHECK constraints (matches `HHmm` in src/lib/schemas). */
export const HHMM_PATTERN = sql.raw(`'^([01][0-9]|2[0-3]):[0-5][0-9]$'`);

/** http(s) URLs only (SPEC §6.3 "http(s) only"), as a SQL literal for CHECK constraints. */
export const HTTP_URL_PATTERN = sql.raw(`'^https?://'`);
